// Unit tests for the recents-strip persistence helpers. Run with:
//
//     node --test test/
//
// recents-strip.js has no imports at all, so it loads cleanly under node; the
// round-trip test below also pulls in StateStore, which is import-free for the
// same reason (see state-store.test.mjs).
//
// Worth testing because both functions guard a failure that is silent rather than
// loud. sanitizeRecents sits between untrusted tmux state and a render loop that
// assumes well-formed entries, and recentsSignature is the only thing standing
// between a 500ms refresh tick and a write storm on the shared blob — if it ever
// starts returning a fresh value per call, nothing breaks visibly, the strip just
// quietly republishes @wt_state twice a second forever.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_RECENTS, sanitizeRecents, recentsSignature } from '../resources/js/recents-strip.js';
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
