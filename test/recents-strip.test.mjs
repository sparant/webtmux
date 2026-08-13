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
  MAX_RECENTS, RECENTS_MIN, RECENTS_MAX, RECENTS_HISTORY_MAX, clampRecentsMax,
  sanitizeRecents, recentsSignature, RecentsPersistence,
  visibleRecents, offStripRecents, admitRecent, trimRecentsHistory, reorderVisibleRecents,
  fitTabCount,
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

test('sanitizeRecents keeps the queue, and caps at the HISTORY ceiling', () => {
  // The stored list is the tabs PLUS the windows queued behind them, so a restore that
  // truncated to the tab cap would silently close every one of the latter.
  const many = Array.from({ length: MAX_RECENTS + 4 }, (_, i) => entry(`@${i}`));
  assert.equal(sanitizeRecents(many).length, many.length, 'past the tab cap is not past the ceiling');
  const flood = Array.from({ length: RECENTS_HISTORY_MAX + 7 }, (_, i) => entry(`@${i}`));
  assert.equal(sanitizeRecents(flood).length, RECENTS_HISTORY_MAX);
  assert.equal(sanitizeRecents(many, 2).length, 2, 'the bound is overridable');
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

test('the persisted list survives a reload whole, tab cap or not', () => {
  const windows = Array.from({ length: 9 }, (_, i) => entry(`@${i}`));
  const store = new StateStore();
  store.load(JSON.stringify({ v: 1, rev: 2, recentTabs: { windows } }));

  // Nine remembered windows come back as nine, whatever this client draws. The cap is
  // a property of the rendering client (two browsers can hold different ones); reading
  // the blob through it would let the narrower browser publish the wider one's queue
  // away — a reload closing tabs nobody asked to close.
  const p = new RecentsPersistence(store, 'recentTabs');
  assert.equal(p.restore().length, 9);
  assert.equal(visibleRecents(p.restore(), [], 5).length, 5, 'five of them draw tabs');
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

// ---- preview suppression --------------------------------------------------------
//
// A window in the PiP / preview bar is already on screen, so it stands down from the
// strip rather than spending one of a handful of tabs on a duplicate. Everything here
// is about the two ways that could go wrong: a suppressed entry being treated as GONE
// (it must come back, in place, when the preview lets go), or as PRESENT (it must not
// hold a slot against the cap, absorb an eviction, or shift a drag by one).

// Rank by an explicit map so the recency the eviction rules read is visible in the test
// rather than hidden in a shared cache.
const byRecency = (seqs) => (e) => seqs[e.id] ?? 0;

test('visibleRecents hides exactly the previewed windows, in strip order', () => {
  const list = [entry('@1'), entry('@2'), entry('@3')];
  assert.deepEqual(visibleRecents(list, ['@2']).map((e) => e.id), ['@1', '@3']);
  assert.deepEqual(visibleRecents(list, new Set()).map((e) => e.id), ['@1', '@2', '@3'],
    'nothing previewed (a tucked-away preview reports no windows) — every tab is back');
  assert.deepEqual(visibleRecents(list, ['@1', '@2', '@3']), [],
    'previewing every recent window empties the strip rather than half-hiding it');
});

// ---- the off-strip queue --------------------------------------------------------
//
// The bug this section exists for: a sixth window used to DESTROY the least-recently
// used entry, so closing a tab afterwards left a hole nothing could fill — even though
// the window that had just been pushed out was still right there, still live, and still
// the obvious thing to put in it. The strip is now the first `max` of a longer list.

test('the strip is the first max entries; the rest are queued, not lost', () => {
  const list = [entry('@1'), entry('@2'), entry('@3'), entry('@4'), entry('@5'), entry('@6')];
  assert.deepEqual(visibleRecents(list, [], 5).map((e) => e.id), ['@1', '@2', '@3', '@4', '@5']);
  assert.deepEqual(offStripRecents(list, [], 5).map((e) => e.id), ['@6'],
    'the sixth window is off-strip, waiting — not gone');
});

test('a freed slot is taken by the head of the queue', () => {
  const list = [entry('@1'), entry('@2'), entry('@3'), entry('@4'), entry('@5'), entry('@6')];
  // × on a tab is the only thing that deletes an entry. @6 slides in behind it.
  const closed = list.filter((e) => e.id !== '@3');
  assert.deepEqual(visibleRecents(closed, [], 5).map((e) => e.id), ['@1', '@2', '@4', '@5', '@6']);
  assert.deepEqual(offStripRecents(closed, [], 5), [], 'nothing is waiting any more');
  // Raising the cap frees a slot the same way, and lowering it is undone by raising it.
  assert.deepEqual(visibleRecents(list, [], 6).map((e) => e.id).at(-1), '@6');
  assert.deepEqual(visibleRecents(visibleRecents(list, [], 3).concat(), [], 3).length, 3);
  assert.deepEqual(visibleRecents(list, [], 3).map((e) => e.id), ['@1', '@2', '@3']);
  assert.deepEqual(offStripRecents(list, [], 3).map((e) => e.id), ['@4', '@5', '@6'],
    'a smaller cap queues the tail rather than deleting it');
});

test('a previewed window frees a drawing slot for a queued one', () => {
  const list = [entry('@1'), entry('@2'), entry('@3'), entry('@4'), entry('@5'), entry('@6')];
  // @2 is on screen in the preview, so it spends no tab — and the slot it isn't using
  // goes to the window that has been waiting for one.
  assert.deepEqual(visibleRecents(list, ['@2'], 5).map((e) => e.id), ['@1', '@3', '@4', '@5', '@6']);
  assert.deepEqual(offStripRecents(list, ['@2'], 5), [],
    'a previewed entry is held by the preview, not queued behind the cap');
  // …and the borrowed slot goes back when the preview lets go. Nothing moved.
  assert.deepEqual(visibleRecents(list, [], 5).map((e) => e.id), ['@1', '@2', '@3', '@4', '@5']);
});

test('admitRecent leaves a window that already has a tab exactly where it is', () => {
  const list = [entry('@1'), entry('@2'), entry('@3')];
  assert.equal(admitRecent(list, list[2], { previewed: [], max: 5 }), list,
    'the same array back — re-visiting a tab must not reorder the strip, or churn the blob');
});

test('admitRecent demotes the least-recently-used TAB to the head of the queue', () => {
  const list = [entry('@1'), entry('@2'), entry('@3')];
  const recency = byRecency({ '@1': 9, '@2': 2, '@3': 5 });
  const next = admitRecent(list, entry('@4'), { previewed: [], max: 3, recency });
  assert.deepEqual(next.map((e) => e.id), ['@1', '@4', '@3', '@2'],
    '@2 was the stalest tab: @4 takes its slot in place, @2 goes first in line');
  assert.deepEqual(visibleRecents(next, [], 3).map((e) => e.id), ['@1', '@4', '@3']);
  assert.deepEqual(offStripRecents(next, [], 3).map((e) => e.id), ['@2']);
});

test('a queued window that is visited again comes back as a tab', () => {
  // This is the case the old code could not express: @2 has no tab, and switching to
  // it must give it one rather than leaving the user on a window the strip denies.
  const list = [entry('@1'), entry('@4'), entry('@3'), entry('@2')];
  const recency = byRecency({ '@1': 9, '@2': 12, '@3': 5, '@4': 10 });
  const next = admitRecent(list, list[3], { previewed: [], max: 3, recency });
  assert.deepEqual(next.map((e) => e.id), ['@1', '@4', '@2', '@3'],
    '@3 was the stalest tab and steps aside; @2 takes that slot and @3 heads the queue');
  assert.deepEqual(visibleRecents(next, [], 3).map((e) => e.id), ['@1', '@4', '@2']);
});

test('admitRecent fills a free slot without disturbing anything', () => {
  const list = [entry('@1'), entry('@2')];
  const next = admitRecent(list, entry('@3'), { previewed: [], max: 5 });
  assert.deepEqual(next.map((e) => e.id), ['@1', '@2', '@3']);
  // With room to spare, a new window lands just past the last TAB — ahead of anything
  // the preview is holding, whose slot is where its tab comes back to.
  const held = [entry('@1'), entry('@9'), entry('@2')];
  assert.deepEqual(
    admitRecent(held, entry('@3'), { previewed: ['@9'], max: 5 }).map((e) => e.id),
    ['@1', '@9', '@2', '@3'],
  );
});

test('trimRecentsHistory drops from the stale end, never a tab', () => {
  const list = Array.from({ length: RECENTS_HISTORY_MAX + 3 }, (_, i) => entry(`@${i}`));
  const trimmed = trimRecentsHistory(list);
  assert.equal(trimmed.length, RECENTS_HISTORY_MAX);
  assert.equal(trimmed[0].id, '@0', 'the tabs are at the head and are never in reach');
  assert.equal(trimRecentsHistory(list.slice(0, 4)).length, 4, 'under the ceiling: untouched');
  assert.equal(trimRecentsHistory(list, 2).map((e) => e.id).join(), '@0,@1');
});

test('visibleRecents suppresses BOTH tabs of a linked window', () => {
  // One window, reached through two sessions: two legitimate tabs, but one screen —
  // and that screen is the one in the preview.
  const list = [entry('@1', { session: 'services' }), entry('@1', { session: 'editors' }), entry('@2')];
  assert.deepEqual(visibleRecents(list, ['@1']).map((e) => e.session), ['services']);
});

test('the cap counts tabs, not entries: a previewed entry holds no slot', () => {
  const list = [entry('@1'), entry('@2'), entry('@3')];
  // Cap 3, one previewed -> only 2 tabs are drawn, so there is room for a third.
  assert.deepEqual(
    admitRecent(list, entry('@4'), { previewed: ['@2'], max: 3 }).map((e) => e.id),
    ['@1', '@2', '@3', '@4'],
    'nothing steps aside — the preview was already lending its slot',
  );
});

test('demotion never takes a previewed entry, however stale it looks', () => {
  // @2 is in the preview and has not been ACCESSED in ages — the LRU rule would pick
  // it first, and picking it would free no drawing space while re-filing the tab that
  // is waiting to come back when the preview closes.
  const list = [entry('@1'), entry('@2'), entry('@3')];
  const opts = { previewed: ['@2'], max: 2, recency: byRecency({ '@1': 9, '@2': 0, '@3': 5 }) };
  assert.deepEqual(admitRecent(list, entry('@4'), opts).map((e) => e.id), ['@1', '@2', '@4', '@3'],
    '@3, the oldest TAB, steps aside instead; @2 keeps its slot for later');
});

test('an access to a previewed window records it without moving anything', () => {
  const list = [entry('@1'), entry('@2'), entry('@3')];
  const opts = { previewed: ['@2', '@9'], max: 3, recency: byRecency({ '@1': 9, '@2': 1, '@3': 5 }) };
  assert.equal(admitRecent(list, list[1], opts), list, 'already placed, and it draws nothing either way');
  assert.deepEqual(admitRecent(list, entry('@9'), opts).map((e) => e.id), ['@1', '@2', '@3', '@9'],
    'a NEW previewed window gets its entry, ready for when the preview lets go');
});

test('a drag reorders in the coordinates the user actually sees', () => {
  // Strip: @1 [@2 previewed] @3 @4 -> tabs are @1 @3 @4. Dragging @4 to the front is
  // gap 0 in TAB coordinates; read as durable coordinates it would land after @1.
  const list = [entry('@1'), entry('@2'), entry('@3'), entry('@4')];
  const next = reorderVisibleRecents(list, { previewed: ['@2'], entry: entry('@4'), toIndex: 0 });
  assert.deepEqual(visibleRecents(next, ['@2']).map((e) => e.id), ['@4', '@1', '@3']);
  assert.deepEqual(next.map((e) => e.id), ['@4', '@2', '@1', '@3'],
    'the previewed entry keeps its durable slot — the tab it comes back to is unmoved');
});

test('a drag moves tabs among themselves and leaves the queue alone', () => {
  // Cap 2: @1 @2 are tabs, @3 @4 are waiting. Dragging @2 to the front must not
  // promote, demote or reshuffle anything the user cannot see.
  const list = [entry('@1'), entry('@2'), entry('@3'), entry('@4')];
  const next = reorderVisibleRecents(list, { previewed: [], entry: entry('@2'), toIndex: 0, max: 2 });
  assert.deepEqual(next.map((e) => e.id), ['@2', '@1', '@3', '@4']);
  assert.equal(reorderVisibleRecents(list, { previewed: [], entry: entry('@3'), toIndex: 0, max: 2 }), null,
    'a queued entry has no tab, so there is nothing to drag');
});

test('a drag past the end, and a drag that changes nothing', () => {
  const list = [entry('@1'), entry('@2'), entry('@3')];
  const next = reorderVisibleRecents(list, { previewed: ['@1'], entry: entry('@2'), toIndex: 2 });
  assert.deepEqual(next.map((e) => e.id), ['@1', '@3', '@2'], 'the end gap is the last slot');
  assert.equal(reorderVisibleRecents(list, { previewed: [], entry: entry('@2'), toIndex: 1 }), null,
    'dropping a tab back where it started is not a change');
  assert.equal(reorderVisibleRecents(list, { previewed: [], entry: entry('@9'), toIndex: 0 }), null,
    'a tab that is not in the strip cannot be moved');
  assert.equal(reorderVisibleRecents(list, { previewed: [], entry: entry('@2'), toIndex: undefined }), null,
    'a drop with no gap (a dragend outside the strip) is not a change');
});

// ---- the width cap ------------------------------------------------------------
//
// fitTabCount is the arithmetic behind "don't scroll the strip, shorten it". Worth
// its own tests for the same reason the rest of this file is: every way it can be
// wrong is quiet. Over-count and a tab is clipped by the toolbar; under-count and a
// window silently loses its tab on a screen with room to spare; return 0 and the
// strip — including the "Recent ▾" menu that is the only way to get it back — is
// gone. The measuring itself (toolbar._fitStrip) is DOM work and is not tested here;
// what it hands over is a list of widths, which is exactly what this takes.

test('the strip stops at the last tab that fits', () => {
  assert.equal(fitTabCount([100, 100, 100], 1000, 6), 3, 'room for all of them');
  assert.equal(fitTabCount([100, 100, 100], 212, 6), 2, '100 + 6 + 100 = 206 fits, a third does not');
  assert.equal(fitTabCount([100, 100, 100], 204, 6), 1, 'past the slack, two no longer fit');
});

test('the gap between tabs is charged between them, not after the last one', () => {
  // 3 tabs of 100 with a 6px gap need 312, not 318: two gaps, not three. A strip that
  // charged the trailing gap would drop a tab that fits exactly.
  assert.equal(fitTabCount([100, 100, 100], 312, 6), 3);
  assert.equal(fitTabCount([100, 100, 100], 310, 6), 2, 'a third gap would have made this fit');
});

test('sub-pixel layout does not cost a tab', () => {
  // clientWidth is an integer and the tab boxes are not: a set that fits can measure
  // a fraction over. Anything inside the slack still fits.
  assert.equal(fitTabCount([100.4, 100.4], 206, 6), 2, '206.8 vs 206 is rounding, not overflow');
  assert.equal(fitTabCount([100, 100], 200, 6, { slack: 0 }), 1, 'without the slack it is a genuine overflow');
});

test('the strip never fits down to nothing', () => {
  // A tab too wide for the toolbar is still drawn — clipped. The alternative is an
  // empty strip, which takes the "Recent ▾" menu (and so the way back) off screen.
  assert.equal(fitTabCount([500, 100], 50, 6), 1);
  assert.equal(fitTabCount([500], 0, 6), 1, 'unmeasured (zero-width, never rendered) is not "nothing fits"');
  assert.equal(fitTabCount([500], NaN, 6), 1, 'nor is an unmeasurable width');
  assert.equal(fitTabCount([], 1000, 6), 0, 'but no tabs means no tabs');
});

test('junk widths are charged as nothing rather than poisoning the sum', () => {
  // An element that has not been laid out measures 0 or undefined. Counting it as NaN
  // would make every comparison false and return the whole list.
  assert.equal(fitTabCount([100, undefined, 100], 212, 6), 3, 'a zero-width tab still takes a slot');
  assert.equal(fitTabCount([100, -50, 100], 212, 6), 3);
});
