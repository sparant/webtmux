// Unit tests for readSplitState — the shared blob's 'split' section. Run with:
//
//     node --test test/
//
// split-state.js has no imports, so it loads cleanly under node.
//
// The case that matters most is the compatibility one. `regions` predates the
// primary's window being persisted and has always meant "extra regions only";
// every live tmux server still holds blobs in that shape. If the primary were
// folded in as regions[0], an old blob with one extra split region would read back
// as "primary, no splits" and that region would silently disappear on load. The
// tests below pin the separate-field shape so a future tidy-up can't collapse it.
//
// The second thing pinned here is that a saved view is a PAIR — (session, window).
// A window id alone is not restorable: a pane's window list covers only the session
// it is attached to, so an id saved in another session is not found and the restore
// silently no-ops, parking the primary on the base session's current window on every
// reload. Three blob generations therefore have to read correctly: regions-only,
// window-without-session, and the full pair.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSplitState } from '../resources/js/split-state.js';

test('an OLD blob (regions only) keeps every extra region and leaves the primary alone', () => {
  // Exactly what earlier builds wrote: one extra split region, no primaryWindowId.
  const { regions, primaryWindowId } = readSplitState({ regions: [{ windowId: '@3' }] });
  assert.deepEqual(regions, [{ windowId: '@3', session: null }],
    'the extra region survives — it is NOT read as the primary');
  assert.equal(primaryWindowId, null, 'no saved primary -> stay on the base session current window');
});

test('a blob with a window but no session reads as "session unknown", not as a crash', () => {
  // Written by the builds between "primary window persisted" and "view persisted".
  // A null session means the caller honors the id only within the pane's CURRENT
  // session — the exact behavior those blobs were written under.
  const { primaryWindowId, primarySession, regions } = readSplitState({
    primaryWindowId: '@1',
    regions: [{ windowId: '@2' }],
  });
  assert.equal(primaryWindowId, '@1');
  assert.equal(primarySession, null);
  assert.deepEqual(regions, [{ windowId: '@2', session: null }]);
});

test('a NEW blob restores the full view — session and window — for every region', () => {
  const { regions, primaryWindowId, primarySession } = readSplitState({
    primaryWindowId: '@1',
    primarySession: 'claude-editors',
    regions: [
      { windowId: '@2', session: 'services' },
      { windowId: '@3', session: 'pi-editors' },
    ],
  });
  assert.equal(primaryWindowId, '@1');
  assert.equal(primarySession, 'claude-editors',
    'the session is half the address — without it a cross-session view cannot be found');
  assert.deepEqual(regions, [
    { windowId: '@2', session: 'services' },
    { windowId: '@3', session: 'pi-editors' },
  ]);
});

test('region count is preserved even when an entry has no window', () => {
  // The LENGTH decides how many regions to recreate, so an empty entry must not be
  // dropped — losing it would silently drop a split rather than MRU-auto-picking for it.
  const { regions } = readSplitState({ regions: [{ windowId: '@2' }, {}, { windowId: null }] });
  assert.equal(regions.length, 3, 'three regions are recreated');
  assert.deepEqual(regions, [
    { windowId: '@2', session: null },
    { windowId: null, session: null },
    { windowId: null, session: null },
  ]);
});

test('a primary-only blob restores the primary and creates no regions', () => {
  const { regions, primaryWindowId, primarySession } = readSplitState({
    primaryWindowId: '@9',
    primarySession: 'services',
  });
  assert.equal(primaryWindowId, '@9');
  assert.equal(primarySession, 'services');
  assert.deepEqual(regions, [], 'no extra regions to recreate');
});

test('readSplitState is total for junk input', () => {
  for (const junk of [undefined, null, 0, 'x', [], { regions: 'nope' }, { regions: {} }]) {
    const out = readSplitState(junk);
    assert.deepEqual(out.regions, [], `junk: ${JSON.stringify(junk)}`);
    assert.equal(out.primaryWindowId, null, `junk: ${JSON.stringify(junk)}`);
    assert.equal(out.primarySession, null, `junk: ${JSON.stringify(junk)}`);
  }
});

test('malformed entries degrade to "no saved view", never to a crash', () => {
  const { regions, primaryWindowId, primarySession } = readSplitState({
    primaryWindowId: 42,                       // wrong type
    primarySession: { name: 'services' },      // wrong type
    regions: [null, 'string', { windowId: 7 }, { windowId: '' }, { windowId: '@4', session: 9 }],
  });
  assert.equal(primaryWindowId, null, 'a non-string primary id is ignored');
  assert.equal(primarySession, null, 'a non-string primary session is ignored');
  assert.deepEqual(regions, [
    { windowId: null, session: null },
    { windowId: null, session: null },
    { windowId: null, session: null },
    { windowId: null, session: null },
    { windowId: '@4', session: null },   // a bad session degrades to "current session"
  ], 'each bad entry becomes an auto-pick, and a bad session never poisons a good window');
});
