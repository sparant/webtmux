// Unit tests for the access-recency pruner. Run with:
//
//     node --test test/
//
// capture-cache.js imports only state-store.js (itself import-free), so it loads
// under node; pruneRecency is deliberately pure so the POLICY can be tested without
// a tmux server, a capture, or a clock.
//
// The policy is the interesting part, and it is a trade between two unpleasant
// failures. Forget a window's recency too eagerly and the Exposé "Last accessed"
// sort silently reshuffles — an absent directory, a server mid-restart, or a lost
// list-windows race is enough, and the information is not recoverable. Never forget
// and the 'recent' section grows for the life of the tmux server, inside a blob that
// rides EVERY 500ms layout push to EVERY connected browser. Hence a timestamped
// tombstone plus a hard cap: nothing is dropped on first sight of a miss, and
// nothing accumulates forever either.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pruneRecency, RECENCY_TTL_MS, RECENCY_CAP } from '../resources/js/capture-cache.js';

const map = (...pairs) => new Map(pairs);

test('a window that is present keeps its recency and loses any tombstone', () => {
  const out = pruneRecency({
    accessed: map(['@1', 5]),
    gone: map(['@1', 1000]),          // it was missing on an earlier push
    liveIds: new Set(['@1']),
    now: 2000,
  });
  assert.equal(out.accessed.get('@1'), 5);
  assert.equal(out.gone.has('@1'), false, 'coming back clears the clock');
  assert.equal(out.changed, true);
});

test('a newly-missing window is tombstoned, not forgotten', () => {
  const out = pruneRecency({
    accessed: map(['@1', 5], ['@2', 6]),
    gone: map(),
    liveIds: new Set(['@2']),
    now: 1000,
  });
  assert.equal(out.accessed.get('@1'), 5, 'still ranked — one absent push is not death');
  assert.equal(out.gone.get('@1'), 1000, 'but the clock has started');
  assert.equal(out.changed, true);
});

test('a window missing for longer than the TTL is forgotten', () => {
  const first = 1_000_000;
  const out = pruneRecency({
    accessed: map(['@1', 5], ['@2', 6]),
    gone: map(['@1', first]),
    liveIds: new Set(['@2']),
    now: first + RECENCY_TTL_MS + 1,
  });
  assert.equal(out.accessed.has('@1'), false);
  assert.equal(out.gone.has('@1'), false, 'the tombstone goes with it');
  assert.equal(out.accessed.get('@2'), 6, 'the live window is untouched');
});

test('a window missing for LESS than the TTL is kept', () => {
  const first = 1_000_000;
  const out = pruneRecency({
    accessed: map(['@1', 5]),
    gone: map(['@1', first]),
    liveIds: new Set(['@2']),
    now: first + RECENCY_TTL_MS - 1,
  });
  assert.equal(out.accessed.has('@1'), true);
  assert.equal(out.changed, false, 'a push that changes nothing must not write the blob');
});

test('an empty directory changes nothing at all', () => {
  // The case that would be catastrophic to get wrong: "the server told us nothing"
  // is not "every window on the server died".
  for (const liveIds of [undefined, null, new Set(), []]) {
    const out = pruneRecency({ accessed: map(['@1', 5]), gone: map(), liveIds, now: 9 });
    assert.equal(out.accessed.size, 1, `empty directory: ${String(liveIds)}`);
    assert.equal(out.changed, false);
  }
});

test('tombstones for windows no longer in the map are swept up', () => {
  const out = pruneRecency({
    accessed: map(['@1', 5]),
    gone: map(['@1', 100], ['@ancient', 100]),   // @ancient was forgotten long ago
    liveIds: new Set(['@1']),
    now: 200,
  });
  assert.deepEqual([...out.gone.keys()], [], 'no litter left behind');
  assert.equal(out.changed, true);
});

test('the section is capped, least-recently-accessed first', () => {
  const big = new Map();
  for (let i = 0; i < RECENCY_CAP + 25; i++) big.set(`@${i}`, i);   // seq i = access order
  const out = pruneRecency({
    accessed: big,
    gone: map(),
    liveIds: new Set(big.keys()),
    now: 1,
  });
  assert.equal(out.accessed.size, RECENCY_CAP);
  assert.equal(out.accessed.has('@0'), false, 'the oldest access is evicted');
  assert.equal(out.accessed.has(`@${RECENCY_CAP + 24}`), true, 'the newest survives');
  assert.equal(out.changed, true);
});

test('pruneRecency does not mutate what it is given', () => {
  const accessed = map(['@1', 5]);
  const gone = map();
  pruneRecency({ accessed, gone, liveIds: new Set(['@2']), now: 1 });
  assert.equal(accessed.size, 1);
  assert.equal(gone.size, 0, 'the caller decides whether to adopt the result');
});
