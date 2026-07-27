// Unit tests for buildMruOrder — the ⌃⌥L / ⌘⌥L recent-window walk order. Run with:
//
//     node --test test/
//
// mru-order.js has no imports, so it loads cleanly under node (split-manager.js, which
// consumes it, imports lit and never could).
//
// The reason this file exists is the first test below. The walk used to be built from
// the live capture cache, which is EMPTY right after a browser reload unless something
// happens to be polling captures — so the chord did nothing at all, and nothing in the
// code that had the bug hinted at it. Every other test here is a rule that was already
// implicit in the old four-liner and would otherwise be free to regress silently.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMruOrder } from '../resources/js/mru-order.js';

// A window directory entry, shaped like SplitManager._placements (layout.allWindows).
const win = (id, session = 'services', index = 1) => ({ id, session, index, name: id });
// A capture-cache placement, which uses the other field names.
const cap = (id, sessionName = 'services', index = 1) => ({ windowId: id, sessionName, index });

const ids = (order) => order.map((e) => e.id);

test('works with an EMPTY capture cache — the after-reload bug', () => {
  // Exactly the reported state: recency survived the reload (it lives in @wt_state),
  // the window directory arrived with the first layout push, and no capture has been
  // requested because the sidebar is collapsed.
  const order = buildMruOrder({
    placements: [win('@1'), win('@2'), win('@3')],
    captures: [],
    accessed: new Map([['@1', 9], ['@2', 7], ['@3', 3]]),
    currentId: '@1',
    currentSession: 'services',
  });
  assert.deepEqual(ids(order), ['@1', '@2', '@3']);
  // The point of the fix: there IS somewhere to go, so the chord acts.
  assert.ok(order.length >= 2, 'the walk must not be empty after a reload');
});

test('the current window is pinned to slot 0 so the first tap goes to the previous one', () => {
  const order = buildMruOrder({
    placements: [win('@1'), win('@2'), win('@3')],
    accessed: new Map([['@1', 5], ['@2', 9], ['@3', 7]]),
    currentId: '@1',
  });
  assert.equal(order[0].id, '@1', 'current first');
  assert.equal(order[1].id, '@2', 'then the most recently accessed of the rest');
});

test('a current window missing from every source is still pinned in', () => {
  const order = buildMruOrder({
    placements: [win('@2'), win('@3')],
    accessed: new Map([['@2', 4]]),
    currentId: '@9',
    currentSession: 'other',
  });
  assert.deepEqual(ids(order), ['@9', '@2', '@3']);
  assert.equal(order[0].session, 'other', 'pinned with the pane\'s own session');
});

test('never-accessed windows tail the walk in session/index order', () => {
  const order = buildMruOrder({
    placements: [win('@4', 'zeta', 2), win('@3', 'alpha', 1), win('@1'), win('@2')],
    accessed: new Map([['@1', 3], ['@2', 8]]),
    currentId: '@1',
  });
  assert.deepEqual(ids(order), ['@1', '@2', '@3', '@4']);
});

test('a linked window is ONE stop, preferring the focused pane\'s session', () => {
  const order = buildMruOrder({
    placements: [win('@7', 'editors', 4), win('@7', 'services', 2), win('@1')],
    accessed: new Map([['@7', 9], ['@1', 1]]),
    currentId: '@1',
    currentSession: 'services',
  });
  assert.deepEqual(ids(order), ['@1', '@7']);
  assert.equal(order[1].session, 'services', 'stays in the pane\'s session when it can');
});

test('with no placement in the pane\'s session, the lowest session/index wins', () => {
  const order = buildMruOrder({
    placements: [win('@7', 'zeta', 1), win('@7', 'editors', 9), win('@1')],
    accessed: new Map([['@7', 9], ['@1', 1]]),
    currentId: '@1',
    currentSession: 'services',
  });
  assert.equal(order[1].session, 'editors');
});

test('windows another pane is showing are skipped; the current one never is', () => {
  const order = buildMruOrder({
    placements: [win('@1'), win('@2'), win('@3')],
    accessed: new Map([['@1', 5], ['@2', 9], ['@3', 2]]),
    currentId: '@1',
    occupied: new Set(['@1', '@2']),   // @1 is occupied BY US
  });
  assert.deepEqual(ids(order), ['@1', '@3']);
});

test('captures and recents contribute candidates the directory does not list', () => {
  // A window in a session no region covers: the directory omits it, but the strip
  // remembers you were there, so the walk must still reach it.
  const order = buildMruOrder({
    placements: [win('@1')],
    captures: [cap('@5', 'editors', 3)],
    recents: [{ id: '@6', session: 'archive', index: 1 }],
    accessed: new Map([['@1', 1], ['@5', 9], ['@6', 5]]),
    currentId: '@1',
  });
  assert.deepEqual(ids(order), ['@1', '@5', '@6']);
});

test('the directory wins the session label when a capture disagrees', () => {
  // Captures carry ONE session label per window and can be a refresh behind; the
  // directory is the live listing. Both name the same placement here, and the walk
  // must not end up with two stops for one window either way.
  const order = buildMruOrder({
    placements: [win('@2', 'services', 2)],
    captures: [cap('@2', 'editors', 2)],
    accessed: new Map([['@2', 4]]),
    currentId: '@1',
    currentSession: 'services',
  });
  assert.deepEqual(ids(order), ['@1', '@2']);
  assert.equal(order[1].session, 'services');
});

test('recency can be a plain object as well as a Map (the persisted shape)', () => {
  const order = buildMruOrder({
    placements: [win('@1'), win('@2')],
    accessed: { '@2': 12, '@1': 3 },
    currentId: '@1',
  });
  assert.deepEqual(ids(order), ['@1', '@2']);
});

test('junk input degrades to a walk, never to a throw', () => {
  assert.deepEqual(buildMruOrder(), []);
  assert.deepEqual(buildMruOrder({}), []);
  assert.deepEqual(
    ids(buildMruOrder({
      placements: [null, 42, {}, { id: '' }, win('@1')],
      captures: 'nope',
      recents: null,
      accessed: 'nope',
      currentId: '@1',
    })),
    ['@1'],
  );
});

test('a single window means nowhere to go (the caller does nothing)', () => {
  const order = buildMruOrder({
    placements: [win('@1')],
    accessed: new Map([['@1', 1]]),
    currentId: '@1',
  });
  assert.equal(order.length, 1);
});
