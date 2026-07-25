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
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSplitState } from '../resources/js/split-state.js';

test('an OLD blob (regions only) keeps every extra region and leaves the primary alone', () => {
  // Exactly what earlier builds wrote: one extra split region, no primaryWindowId.
  const { regions, primaryWindowId } = readSplitState({ regions: [{ windowId: '@3' }] });
  assert.deepEqual(regions, ['@3'], 'the extra region survives — it is NOT read as the primary');
  assert.equal(primaryWindowId, null, 'no saved primary -> stay on the base session current window');
});

test('a NEW blob restores both the primary and the extra regions', () => {
  const { regions, primaryWindowId } = readSplitState({
    primaryWindowId: '@1',
    regions: [{ windowId: '@2' }, { windowId: '@3' }],
  });
  assert.equal(primaryWindowId, '@1');
  assert.deepEqual(regions, ['@2', '@3']);
});

test('region count is preserved even when an entry has no window', () => {
  // The LENGTH decides how many regions to recreate, so a null must not be dropped
  // — losing it would silently drop a split rather than MRU-auto-picking for it.
  const { regions } = readSplitState({ regions: [{ windowId: '@2' }, {}, { windowId: null }] });
  assert.equal(regions.length, 3, 'three regions are recreated');
  assert.deepEqual(regions, ['@2', null, null]);
});

test('a primary-only blob restores the primary and creates no regions', () => {
  const { regions, primaryWindowId } = readSplitState({ primaryWindowId: '@9' });
  assert.equal(primaryWindowId, '@9');
  assert.deepEqual(regions, [], 'no extra regions to recreate');
});

test('readSplitState is total for junk input', () => {
  for (const junk of [undefined, null, 0, 'x', [], { regions: 'nope' }, { regions: {} }]) {
    const out = readSplitState(junk);
    assert.deepEqual(out.regions, [], `junk: ${JSON.stringify(junk)}`);
    assert.equal(out.primaryWindowId, null, `junk: ${JSON.stringify(junk)}`);
  }
});

test('malformed entries degrade to "no saved window", never to a crash', () => {
  const { regions, primaryWindowId } = readSplitState({
    primaryWindowId: 42,                       // wrong type
    regions: [null, 'string', { windowId: 7 }, { windowId: '' }],
  });
  assert.equal(primaryWindowId, null, 'a non-string primary id is ignored');
  assert.deepEqual(regions, [null, null, null, null], 'each bad entry becomes an auto-pick');
});
