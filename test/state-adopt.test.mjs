// The cold-cache clobber, end to end. Run with:
//
//     node --test test/
//
// THE BUG THIS FILE EXISTS FOR. Two browsers, one tmux server. Browser A has a
// split arranged and a recents strip built up, all of it living in @wt_state.
// Browser B opens for the first time — empty localStorage, so its StateStore boots
// holding {}. B's SplitManager constructor runs addUnit -> focus -> _refreshToolbar
// and then _restoreSplitState, all of it BEFORE the first layout push has told it
// what the server actually holds. Every one of those steps wants to write. Writing
// `regions: []` there is a valid last-writer-wins update, so the server takes it,
// pushes it to A, and A's split disappears — from a browser that never had one.
//
// The fix is two rules, tested here against the real classes rather than a mock:
//   1. no section may flush before StateStore.loadedOnce (decision 1), and
//   2. a section that has not been TOUCHED by the user re-applies itself from the
//      first authoritative blob instead of restoring once from the cache
//      (decision 2, the "adopt" pattern the recents strip already used).
//
// Driven through the pure persistence classes — SplitPersistence and
// RecentsPersistence — because split-manager.js pulls in lit and can never load
// under `node --test`. That is exactly why the rules live in those classes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StateStore } from '../resources/js/state-store.js';
import { SplitPersistence, splitSignature } from '../resources/js/split-state.js';
import { RecentsPersistence } from '../resources/js/recents-strip.js';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// One fake tmux server: it holds the last blob written to it and hands it back on
// every "layout push". Enough to run two real stores against each other.
function fakeTmux(serverId = 'srv-1') {
  const t = {
    blob: null,
    wire(store) { store.setSender((json) => { t.blob = json; return true; }); },
    push(store) { store.load(t.blob, serverId); },
    get state() { return t.blob ? JSON.parse(t.blob) : null; },
  };
  return t;
}

// The view SplitManager would persist: extra regions + the primary's own pair.
const view = (regions, primaryWindowId = null, primarySession = null) =>
  ({ regions, primaryWindowId, primarySession });

test('a cold-cache browser cannot erase the split another browser arranged', async () => {
  const tmux = fakeTmux();

  // --- browser A: arranges a two-region split and publishes it -----------------
  const a = new StateStore();
  tmux.wire(a);
  a.load(undefined, 'srv-1');                 // first push: the server is empty
  const as = new SplitPersistence(a);
  as.restore();
  as.markTouched();
  assert.equal(as.persist(view(
    [{ windowId: '@5', session: 'services' }, { windowId: '@6', session: 'editors' }],
    '@1', 'services',
  )), true);
  await delay(500);
  assert.equal(tmux.state.split.regions.length, 2, 'A published its split');

  // --- browser B: first ever visit, empty cache --------------------------------
  const b = new StateStore();
  tmux.wire(b);
  const bs = new SplitPersistence(b);

  // The SplitManager constructor: restore reads {} (cold cache), and the eager
  // re-persist that follows region creation tries to write that emptiness back.
  const cold = bs.restore();
  assert.deepEqual(cold.regions, [], 'B genuinely has nothing cached');
  assert.equal(bs.persist(view([], null, null)), false,
    'the boot-time write is refused: B has not seen the server blob yet');
  await delay(500);
  assert.equal(tmux.state.split.regions.length, 2, "A's split is still on the server");

  // --- the first layout push reaches B -----------------------------------------
  tmux.push(b);
  assert.equal(b.loadedOnce, true);
  const adopted = bs.adopt();
  assert.ok(adopted, 'B has something to adopt');
  assert.deepEqual(adopted.regions.map((r) => r.windowId), ['@5', '@6'],
    "B adopts A's split rather than keeping its cold-cache emptiness");
  assert.equal(adopted.primaryWindowId, '@1');

  // --- B's first navigation ------------------------------------------------------
  // The regression: it must write the split B is now showing, never `regions: []`.
  bs.markTouched();
  assert.equal(bs.persist(view(adopted.regions, '@7', 'services')), true);
  await delay(500);
  assert.deepEqual(tmux.state.split.regions.map((r) => r.windowId), ['@5', '@6'],
    "B's first navigation preserves the regions it adopted");
  assert.equal(tmux.state.split.primaryWindowId, '@7', 'and records where B actually went');

  // …and A sees B's navigation without losing its own regions.
  tmux.push(a);
  assert.deepEqual(a.section('split').regions.map((r) => r.windowId), ['@5', '@6']);
});

test('a browser the user HAS touched keeps its own split instead of adopting', () => {
  const tmux = fakeTmux();
  const b = new StateStore();
  tmux.wire(b);
  const bs = new SplitPersistence(b);
  bs.restore();
  bs.markTouched();                // the user split a region within the first 500ms

  b.load(JSON.stringify({ v: 1, rev: 3, split: { regions: [{ windowId: '@5', session: 's' }] } }), 'srv-1');
  assert.equal(bs.adopt(), null, 'no yanking the view out from under a user who acted');
});

test('the recents strip adopts the same way and does not echo the adopted value back', async () => {
  const tmux = fakeTmux();

  const a = new StateStore();
  tmux.wire(a);
  a.load(undefined, 'srv-1');
  const ar = new RecentsPersistence(a);
  ar.restore();
  ar.persist([{ id: '@5', index: 1, name: 'agent', session: 'services' }]);
  await delay(500);

  const b = new StateStore();
  tmux.wire(b);
  const br = new RecentsPersistence(b);
  assert.deepEqual(br.restore(), [], 'cold cache');
  assert.equal(br.persist([]), false, 'nothing is written back before the first push');

  tmux.push(b);
  const adopted = br.adopt();
  assert.deepEqual(adopted.map((e) => e.id), ['@5']);
  // Adopting is not an edit: re-persisting exactly what we adopted must be a no-op,
  // or every push would bump the blob's rev and re-trigger every other client.
  assert.equal(br.persist(adopted), false, 'the adopted strip is not echoed back');
});

test('splitSignature ignores nothing that a restore would act on', () => {
  const base = view([{ windowId: '@5', session: 's' }], '@1', 's');
  assert.equal(splitSignature(base), splitSignature(view([{ windowId: '@5', session: 's' }], '@1', 's')));
  assert.notEqual(splitSignature(base), splitSignature(view([], '@1', 's')), 'region count matters');
  assert.notEqual(splitSignature(base), splitSignature(view([{ windowId: '@6', session: 's' }], '@1', 's')));
  assert.notEqual(splitSignature(base), splitSignature(view([{ windowId: '@5', session: 't' }], '@1', 's')),
    'the session half of a view is part of the identity');
  assert.notEqual(splitSignature(base), splitSignature(view([{ windowId: '@5', session: 's' }], '@2', 's')));
});

test('a persist that the store swallows does not advance the change signature', async () => {
  // Decision 3. If persist() recorded the new signature for a write the store
  // refused (mid-apply, or before the first load), the change would be remembered
  // as published and never written again — the recents "signature poisoning" bug.
  const tmux = fakeTmux();
  const s = new StateStore();
  tmux.wire(s);
  const sp = new SplitPersistence(s);
  sp.restore();

  const v = view([{ windowId: '@5', session: 's' }], '@1', 's');
  assert.equal(sp.persist(v), false, 'refused: no blob seen yet');
  s.load(undefined, 'srv-1');
  assert.equal(sp.persist(v), true, 'the SAME value is written once writing is allowed');
  await delay(500);
  assert.equal(tmux.state.split.regions.length, 1);
});
