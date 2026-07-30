// Unit tests for the recents-strip persistence helpers. Run with:
//
//     node --test test/
//
// recents-strip.js has no imports at all, so it loads cleanly under node; the
// round-trip test below also pulls in StateStore, which is import-free for the
// same reason (see state-store.test.mjs).
//
// Worth testing because every failure here is silent rather than loud.
// sanitizeRecents sits between untrusted tmux state and a render loop that assumes
// well-formed entries. recentsSignature is the only thing standing between a 500ms
// refresh tick and a write storm on the shared blob — if it ever starts returning a
// fresh value per call, nothing breaks visibly, the strip just quietly republishes
// @wt_state twice a second forever. And RecentsPersistence enforces the ordering
// rule whose violation shipped as "recents never restore" while quietly destroying
// the saved strip (see the block at the bottom of this file).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_RECENTS, RECENTS_MIN, RECENTS_MAX, clampRecentsMax,
  sanitizeRecents, recentsSignature, RecentsPersistence,
} from '../resources/js/recents-strip.js';
import { StateStore } from '../resources/js/state-store.js';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// One persisted strip entry, shaped like the ones SplitManager._persistRecents writes.
const entry = (id, extra = {}) => ({ id, index: 1, name: id, session: 'services', ...extra });

test('sanitizeRecents preserves well-formed entries and their order', () => {
  const input = [entry('@1'), entry('@2', { index: 7, name: 'editors' }), entry('@3')];
  assert.deepEqual(sanitizeRecents(input), input);
});

test('sanitizeRecents drops entries with no usable id', () => {
  const out = sanitizeRecents([
    entry('@1'),
    { index: 1, name: 'no-id', session: 's' },   // missing id entirely
    { id: '', name: 'empty', session: 's' },      // empty string id
    { id: 42, name: 'numeric', session: 's' },    // wrong type
    null,
    'not-an-object',
    entry('@2'),
  ]);
  assert.deepEqual(out.map((e) => e.id), ['@1', '@2']);
});

test('sanitizeRecents repairs display metadata rather than dropping the tab', () => {
  // A tab with a bad name/session is still navigable, and _refreshToolbar re-derives
  // both from the live layout on the next push — so it must survive, not vanish.
  const [e] = sanitizeRecents([{ id: '@9', name: '', session: null, index: 'three' }]);
  assert.equal(e.id, '@9');
  assert.equal(e.name, 'bash', 'blank name falls back to the default');
  assert.equal(e.session, '', 'non-string session becomes the base session');
  assert.equal(e.index, undefined, 'a non-numeric index is dropped, so the strip renders "?"');
});

test('sanitizeRecents keeps a linked window once per session but de-dupes exact repeats', () => {
  const out = sanitizeRecents([
    entry('@5', { session: 'services' }),
    entry('@5', { session: 'editors' }),   // same window, other session -> its own tab
    entry('@5', { session: 'services' }),  // exact repeat -> corruption, dropped
  ]);
  assert.deepEqual(out.map((e) => e.session), ['services', 'editors']);
});

test('sanitizeRecents caps at MAX_RECENTS', () => {
  const many = Array.from({ length: MAX_RECENTS + 4 }, (_, i) => entry(`@${i}`));
  assert.equal(sanitizeRecents(many).length, MAX_RECENTS);
  assert.equal(sanitizeRecents(many, 2).length, 2, 'the cap is overridable');
});

// --- the settable cap --------------------------------------------------------
//
// The cap arrives from the same user-writable tmux blob the entries do, so it gets
// the same treatment: every input produces a usable number. The NaN case below is the
// one that matters — `list.length < NaN` is false, so a NaN cap doesn't make the strip
// unbounded, it makes noteAccess evict on every single access and pins the strip at
// whatever one tab it happens to hold, with nothing on screen to explain it.

test('clampRecentsMax falls back to the default for anything unusable', () => {
  for (const junk of [undefined, null, NaN, '', 'five', {}, [], Infinity, -Infinity]) {
    assert.equal(clampRecentsMax(junk), MAX_RECENTS, `junk cap: ${String(junk)}`);
  }
});

test('clampRecentsMax holds the bounds and takes whole tabs only', () => {
  assert.equal(clampRecentsMax(0), RECENTS_MIN, 'a zero-slot strip is unreachable, not smaller');
  assert.equal(clampRecentsMax(-7), RECENTS_MIN);
  assert.equal(clampRecentsMax(999), RECENTS_MAX);
  assert.equal(clampRecentsMax(8), 8, 'an in-range value is kept');
  assert.equal(clampRecentsMax('12'), 12, 'a numeric string (blob round-trip) is accepted');
  assert.equal(clampRecentsMax(6.9), 6, 'there is no such thing as most of a tab');
});

test('the persisted strip is truncated to the CURRENT cap, not the default', () => {
  const windows = Array.from({ length: 9 }, (_, i) => entry(`@${i}`));
  const store = new StateStore();
  store.load(JSON.stringify({ v: 1, rev: 2, recentTabs: { windows } }));

  // A client whose cap is 8 must get all 8 back — the old fixed cap of 5 would have
  // silently destroyed the extra tabs on the next persist.
  const wide = new RecentsPersistence(store, 'recentTabs', 8);
  assert.equal(wide.restore().length, 8);

  // …and one that has since been narrowed reads the narrow strip.
  wide.setMax(3);
  assert.equal(wide.adopt().length, 3, 'a narrower cap re-truncates on the next read');
});

test('sanitizeRecents is total for junk input', () => {
  for (const junk of [undefined, null, 0, 'x', {}, { windows: [] }]) {
    assert.deepEqual(sanitizeRecents(junk), [], `junk input: ${JSON.stringify(junk)}`);
  }
});

test('recentsSignature is stable across calls but changes with content', () => {
  const list = [entry('@1'), entry('@2')];
  assert.equal(recentsSignature(list), recentsSignature(list), 'same content -> same signature');
  assert.notEqual(recentsSignature(list), recentsSignature([entry('@2'), entry('@1')]),
    'reorder (a drag) must be detected');
  assert.notEqual(recentsSignature(list), recentsSignature([entry('@1'), entry('@2', { name: 'renamed' })]),
    'a tmux rename must be detected');
  assert.notEqual(recentsSignature(list), recentsSignature([entry('@1')]),
    'an eviction must be detected');
});

test('recentsSignature ignores the per-render derived flags', () => {
  // This is the whole point of the guard: active/disabled/working change on nearly
  // every 500ms push. If they leaked in, every push would look like an edit.
  const before = recentsSignature([entry('@1'), entry('@2')]);
  const after = recentsSignature([
    entry('@1', { active: true, disabled: false, working: '1' }),
    entry('@2', { active: false, disabled: true, working: '0' }),
  ]);
  assert.equal(before, after);
});

test('the strip survives a full write -> tmux -> reload round trip', async () => {
  // Client A builds up a strip and persists it.
  const a = new StateStore();
  let blob = null;
  a.setSender((json) => { blob = json; });
  a.load(undefined);   // the first layout push: this tmux server holds no blob yet
  a.patchSection('recentTabs', { windows: [entry('@1'), entry('@2', { name: 'editors' })] });
  await delay(500);
  assert.ok(blob, 'a strip change reaches the wire');

  // Client B boots fresh (empty cache) and receives that blob as @wt_state, exactly
  // as SplitManager does via layout.state -> stateStore.load().
  const b = new StateStore();
  b.load(blob);
  const restored = sanitizeRecents(b.section('recentTabs').windows);
  assert.deepEqual(restored.map((e) => [e.id, e.name]), [['@1', '@1'], ['@2', 'editors']]);

  // And the restored strip is signature-identical to what A held, so B's first
  // _refreshToolbar recognizes it as unchanged and does not echo a write back.
  assert.equal(recentsSignature(restored), recentsSignature([entry('@1'), entry('@2', { name: 'editors' })]));
});

test('an empty strip is distinguishable from an absent one', () => {
  // Clearing the last tab (× on the only recent) must persist as [] and restore as
  // [] — not silently fall back to whatever a stale offline cache still holds.
  const s = new StateStore();
  s.load(JSON.stringify({ v: 1, rev: 3, recentTabs: { windows: [] } }));
  assert.deepEqual(sanitizeRecents(s.section('recentTabs').windows), []);
  assert.equal(recentsSignature([]), '[]');
});

// --- RecentsPersistence: the write-before-read hazard -------------------------
//
// These pin the bug that made the first version of this feature look completely
// broken: the strip persisted and restored correctly in isolation, but the
// SplitManager constructor calls _refreshToolbar (via addUnit -> focus) BEFORE
// _restoreRecents, so an empty strip was written over the saved one and the
// restore then read back its own empty write. Nothing errored; the tabs just
// never came back, and the user's saved arrangement was destroyed in the process.

test('a persist before the first restore cannot clobber the saved strip', () => {
  // tmux already holds a strip the user built up in an earlier session.
  const store = new StateStore();
  store.load(JSON.stringify({
    v: 1, rev: 4, recentTabs: { windows: [entry('@1'), entry('@2', { name: 'editors' })] },
  }));

  const p = new RecentsPersistence(store);

  // The constructor's early refresh: persist([]) while nothing has been read yet.
  assert.equal(p.persist([]), false, 'the pre-restore write is refused');

  // The saved strip must have survived that, both in the blob and through restore.
  assert.equal(store.section('recentTabs').windows.length, 2, 'the blob is untouched');
  assert.deepEqual(p.restore().map((e) => e.id), ['@1', '@2'], 'the strip comes back');
});

test('persist works normally once restore has run', () => {
  const store = new StateStore();
  store.load(undefined);   // …and once the server's answer is in (see persist's guards)
  const p = new RecentsPersistence(store);
  p.restore();

  assert.equal(p.persist([entry('@7')]), true, 'a real change is written');
  assert.deepEqual(store.section('recentTabs').windows.map((e) => e.id), ['@7']);
});

test('an unchanged strip is not rewritten (the 500ms-refresh write guard)', () => {
  const store = new StateStore();
  store.load(undefined);
  const p = new RecentsPersistence(store);
  p.restore();
  p.persist([entry('@1')]);

  // _refreshToolbar fires twice a second forever; only real edits may write.
  assert.equal(p.persist([entry('@1')]), false, 'identical content does not write');
  assert.equal(
    p.persist([entry('@1', { active: true, working: '1', disabled: true })]), false,
    'per-render flags changing does not count as an edit',
  );
  assert.equal(p.persist([entry('@1'), entry('@2')]), true, 'a genuine edit still writes');
});

test('persist only writes the durable fields', () => {
  const store = new StateStore();
  store.load(undefined);
  const p = new RecentsPersistence(store);
  p.restore();
  p.persist([entry('@1', { active: true, disabled: false, working: '1' })]);

  assert.deepEqual(store.section('recentTabs').windows, [
    { id: '@1', index: 1, name: '@1', session: 'services' },
  ]);
});

test('adopt returns a remote change but ignores the echo of our own write', async () => {
  const store = new StateStore();
  let wire = null;
  store.setSender((json) => { wire = json; return true; });
  store.load(undefined);
  const p = new RecentsPersistence(store);
  p.restore();
  p.persist([entry('@1')]);
  // Let the write reach tmux and echo back. A write still sitting in the debounce is
  // a LOCAL edit the server has never seen, and the store deliberately replays those
  // on top of anything it adopts — so "our own write" only means this once it lands.
  await delay(500);
  store.load(wire);

  assert.equal(p.adopt(), null, 'our own write is not re-adopted');

  // Another browser rewrites the strip.
  store.load(JSON.stringify({ v: 1, rev: 99, recentTabs: { windows: [entry('@5')] } }));
  assert.deepEqual(p.adopt().map((e) => e.id), ['@5'], 'a remote change is adopted');
  assert.equal(p.adopt(), null, 'and only once');
});

test('the full boot order restores the strip end to end', async () => {
  // Client A arranges a strip and it reaches tmux.
  const a = new StateStore();
  let wire = null;
  a.setSender((json) => { wire = json; });
  a.load(undefined);
  const pa = new RecentsPersistence(a);
  pa.restore();
  pa.persist([entry('@1'), entry('@2', { name: 'editors' })]);
  await delay(500);
  assert.ok(wire, 'the strip reached the wire');

  // Client B reloads. Its SplitManager constructor runs the early refresh FIRST,
  // exactly as addUnit -> focus does, and only then restores.
  const b = new StateStore();
  const pb = new RecentsPersistence(b);
  pb.persist([]);                       // the constructor's premature write
  b.load(wire);                         // the first layout push carries @wt_state
  const restored = pb.restore();

  assert.deepEqual(restored.map((e) => [e.id, e.name]), [['@1', '@1'], ['@2', 'editors']],
    'the strip survives the boot sequence that used to erase it');
});

// --- the swallowed-write hazard ----------------------------------------------
//
// The second half of the same lifecycle bug. persist() is called from
// _refreshToolbar, and _refreshToolbar is ALSO what runs when another client's blob
// is adopted — inside StateStore's _applying guard, which swallows every write. If
// persist recorded its new signature anyway, the change would be remembered as
// published and never attempted again. The visible symptom was a tab for a window
// that had been killed coming back on every push: the client pruned it, the prune
// was swallowed, the blob still held it, and the next push handed it straight back.

test('a persist the store swallows is retried, not remembered as published', () => {
  const store = new StateStore();
  store.load(undefined);
  const p = new RecentsPersistence(store);
  p.restore();

  let swallowed = null;
  store.subscribe(() => { if (swallowed === null) swallowed = p.persist([entry('@1')]); });
  store.load(JSON.stringify({ v: 1, rev: 5, unrelated: 1 }));

  assert.equal(swallowed, false, 'the mid-apply write is refused');
  assert.equal(p.persist([entry('@1')]), true, 'and the same change is written on the retry');
  assert.deepEqual(store.section('recentTabs').windows.map((e) => e.id), ['@1']);
});

test('a prune during an adopt converges in one round trip', async () => {
  const store = new StateStore();
  let wire = null;
  store.setSender((json) => { wire = json; return true; });
  store.load(undefined);
  const p = new RecentsPersistence(store);
  p.restore();

  // Another client publishes a strip holding a window that has since been killed.
  store.load(JSON.stringify({
    v: 1, rev: 9, recentTabs: { windows: [entry('@1'), entry('@dead')] },
  }));
  const adopted = p.adopt();
  assert.deepEqual(adopted.map((e) => e.id), ['@1', '@dead']);

  // _refreshToolbar (deferred out of the apply by the SplitManager) prunes the dead
  // tab and persists. This is the write that used to be swallowed.
  assert.equal(p.persist(adopted.filter((e) => e.id !== '@dead')), true);
  await delay(500);
  assert.deepEqual(JSON.parse(wire).recentTabs.windows.map((e) => e.id), ['@1'],
    'the prune reaches tmux');

  // …and the echo of it does not resurrect the dead tab.
  store.load(wire);
  assert.equal(p.adopt(), null, 'nothing left to adopt — the two agree');
});
