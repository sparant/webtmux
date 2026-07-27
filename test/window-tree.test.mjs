// Unit tests for window-tree.js — the sidebar's flat "all windows" view model.
// Run with:
//
//     node --test test/
//
// window-tree.js imports only search.js (itself dependency-free), so it loads
// cleanly under node with no DOM.
//
// What's worth testing here is everything that is about MORE THAN ONE SESSION: the
// same window living in two of them, a phrase narrowing rows across sessions, the
// keyboard walk crossing a session boundary, and a drag's gap-to-ordinal
// translation — all of which the single-session sidebar never had to get right.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTree, filterTree, flattenTree, stepRow, moveTargetPos, sessionCountOf, rowKey, rowText,
} from '../resources/js/window-tree.js';

const sess = (name, extra = {}) => ({ name, active: false, ...extra });
const ref = (id, session, index, name, working = '') => ({ id, session, index, name, working });

// Two sessions; @2 is linked into both (one window, two placements).
const DIR = [
  ref('@1', 'services', 0, 'logs', '1'),
  ref('@2', 'services', 1, 'claude-1', '0'),
  ref('@3', 'editors', 0, 'vim'),
  ref('@2', 'editors', 4, 'claude-1', '0'),
];
const SESSIONS = [sess('services', { active: true }), sess('editors')];

test('buildTree groups the directory under the sessions, in the order given', () => {
  const tree = buildTree({ sessions: SESSIONS, allWindows: DIR });
  assert.deepEqual(tree.map((n) => n.name), ['services', 'editors']);
  assert.deepEqual(tree[0].windows.map((w) => w.id), ['@1', '@2']);
  assert.deepEqual(tree[1].windows.map((w) => w.id), ['@3', '@2']);
  assert.equal(tree[0].active, true);

  // The session ORDER is whatever the caller passes (the sidebar's persisted one),
  // not the server's — reversing the input reverses the tree.
  const rev = buildTree({ sessions: [...SESSIONS].reverse(), allWindows: DIR });
  assert.deepEqual(rev.map((n) => n.name), ['editors', 'services']);
});

test('windows sort by tmux index, not by directory order', () => {
  const jumbled = [ref('@9', 's', 7, 'g'), ref('@8', 's', 2, 'b'), ref('@7', 's', 0, 'a')];
  const tree = buildTree({ sessions: [sess('s')], allWindows: jumbled });
  assert.deepEqual(tree[0].windows.map((w) => w.index), [0, 2, 7]);
});

test('a linked window yields one row per session, each carrying its own placement', () => {
  const tree = buildTree({ sessions: SESSIONS, allWindows: DIR });
  const rows = flattenTree(tree).filter((w) => w.id === '@2');
  assert.equal(rows.length, 2, 'linked window appears under both sessions');
  assert.deepEqual(rows.map((r) => r.session), ['services', 'editors']);
  // Distinct rows => distinct keys => individually navigable.
  assert.notEqual(rowKey(rows[0].session, rows[0].id), rowKey(rows[1].session, rows[1].id));
  // …and each row knows its OWN index in its own session (1 here, 4 there).
  assert.deepEqual(rows.map((r) => r.index), [1, 4]);
});

test('the global working map wins over the directory copy', () => {
  // The directory says @1 is red; the map (same refresh as the dots everywhere else)
  // says green. The dot in the tree must agree with the dot in the strip.
  const tree = buildTree({ sessions: SESSIONS, allWindows: DIR, working: { '@1': '1', '@2': '2' } });
  assert.equal(tree[0].windows[0].working, '1');
  assert.equal(tree[0].windows[1].working, '2');
  // A window missing from the map keeps the directory's value.
  const tree2 = buildTree({ sessions: SESSIONS, allWindows: DIR, working: {} });
  assert.equal(tree2[0].windows[0].working, '1');
});

test('sessions with no windows still get a node; unknown sessions are dropped', () => {
  const tree = buildTree({ sessions: [...SESSIONS, sess('spare')], allWindows: DIR });
  assert.equal(tree.length, 3);
  assert.deepEqual(tree[2].windows, []);
  // A directory row for a session we do not list (an ephemeral web-* shadow that
  // slipped through, or a session killed between pushes) is ignored, not invented.
  const stray = buildTree({ sessions: [sess('services')], allWindows: DIR });
  assert.deepEqual(stray.map((n) => n.name), ['services']);
  assert.deepEqual(stray[0].windows.map((w) => w.id), ['@1', '@2']);
});

test('without a directory it falls back to the current session\'s window list', () => {
  // Old server (or the first push): layout.windows only. The tree still renders —
  // the other sessions are simply empty — instead of coming up blank.
  const tree = buildTree({
    sessions: SESSIONS,
    allWindows: [],
    windows: [{ id: '@1', index: 0, name: 'logs', working: '1' }],
    ownSession: 'services',
  });
  assert.deepEqual(tree[0].windows.map((w) => w.id), ['@1']);
  assert.equal(tree[0].windows[0].session, 'services');
  assert.deepEqual(tree[1].windows, []);
});

test('filterTree narrows rows across every session, dropping sessions that lose them all', () => {
  const tree = buildTree({ sessions: SESSIONS, allWindows: DIR });
  const claude = filterTree(tree, ['claude']);
  assert.deepEqual(claude.map((n) => n.name), ['services', 'editors'], 'both placements survive');
  assert.deepEqual(claude[0].windows.map((w) => w.id), ['@2']);

  const vim = filterTree(tree, ['vim']);
  assert.deepEqual(vim.map((n) => n.name), ['editors'], 'services has no match left');

  // The session name is part of the haystack, so typing it narrows to that session.
  const svc = filterTree(tree, ['services']);
  assert.deepEqual(svc.map((n) => n.name), ['services']);
  assert.equal(svc[0].windows.length, 2);

  // Every word must match: "claude" AND "editors" leaves only that one placement.
  const both = filterTree(tree, ['claude', 'editors']);
  assert.deepEqual(both.map((n) => n.name), ['editors']);
  assert.deepEqual(both[0].windows.map((w) => w.id), ['@2']);

  assert.equal(filterTree(tree, []), tree, 'an empty phrase is a no-op');
  assert.deepEqual(filterTree(tree, ['nothing-matches-this']), []);
});

test('filtering does not mutate the tree it narrowed', () => {
  const tree = buildTree({ sessions: SESSIONS, allWindows: DIR });
  filterTree(tree, ['vim']);
  assert.equal(tree[0].windows.length, 2, 'original session node untouched');
  assert.equal(tree[1].windows.length, 2);
});

test('an empty session survives a filter that matches its name', () => {
  const tree = buildTree({ sessions: [...SESSIONS, sess('spare')], allWindows: DIR });
  const out = filterTree(tree, ['spare']);
  assert.deepEqual(out.map((n) => n.name), ['spare']);
});

test('flattenTree skips collapsed sessions', () => {
  const tree = buildTree({ sessions: SESSIONS, allWindows: DIR });
  assert.equal(flattenTree(tree).length, 4);
  const rows = flattenTree(tree, new Set(['services']));
  assert.deepEqual(rows.map((r) => r.id), ['@3', '@2']);
  assert.equal(flattenTree(tree, new Set(['services', 'editors'])).length, 0);
});

test('stepRow walks across the session boundary and wraps', () => {
  const rows = flattenTree(buildTree({ sessions: SESSIONS, allWindows: DIR }));
  const at = (i) => rowKey(rows[i].session, rows[i].id);
  // …last window of services -> first window of editors: one ↓, no session switch.
  assert.equal(stepRow(rows, at(1), 1, null), rows[2]);
  assert.equal(stepRow(rows, at(2), -1, null), rows[1]);
  // Wrap in both directions.
  assert.equal(stepRow(rows, at(3), 1, null), rows[0]);
  assert.equal(stepRow(rows, at(0), -1, null), rows[3]);
});

test('stepRow skips rows another region already shows, and gives up when all are', () => {
  const rows = flattenTree(buildTree({ sessions: SESSIONS, allWindows: DIR }));
  const at = (i) => rowKey(rows[i].session, rows[i].id);
  const busy = (r) => r.id === '@3';
  assert.equal(stepRow(rows, at(1), 1, busy), rows[3], 'hops over the busy row');
  assert.equal(stepRow(rows, at(0), 1, () => true), null, 'nothing to move to');
  assert.equal(stepRow([], '', 1, null), null);
});

test('stepRow starts at an end when the cursor row is gone (filtered away)', () => {
  const rows = flattenTree(buildTree({ sessions: SESSIONS, allWindows: DIR }));
  assert.equal(stepRow(rows, rowKey('gone', '@99'), 1, null), rows[0], '↓ lands on the first row');
  assert.equal(stepRow(rows, rowKey('gone', '@99'), -1, null), rows[rows.length - 1], '↑ lands on the last');
});

test('moveTargetPos turns an insertion gap into a tmux ordinal', () => {
  const wins = ['@a', '@b', '@c'].map((id, i) => ({ id, index: i }));
  // Dragging the first row down: gap 3 (after the last) is final position 2, because
  // removing the row first shifts the rest down one.
  assert.equal(moveTargetPos(wins, '@a', 3), 2);
  assert.equal(moveTargetPos(wins, '@a', 2), 1);
  // Dragging the last row up: gaps before the source map straight through.
  assert.equal(moveTargetPos(wins, '@c', 0), 0);
  assert.equal(moveTargetPos(wins, '@c', 1), 1);
  // No-ops: the gap either side of the row's own slot.
  assert.equal(moveTargetPos(wins, '@b', 1), -1);
  assert.equal(moveTargetPos(wins, '@b', 2), -1);
  // A window that isn't in this list (dropped into another session) is not a move.
  assert.equal(moveTargetPos(wins, '@zz', 0), -1);
});

test('sessionCountOf counts the sessions a window is linked into', () => {
  assert.equal(sessionCountOf(DIR, '@2'), 2, 'linked into services + editors');
  assert.equal(sessionCountOf(DIR, '@1'), 1);
  assert.equal(sessionCountOf(DIR, '@nope'), 1, 'unknown windows read as ordinary');
  assert.equal(sessionCountOf([], '@1'), 1, 'no directory yet: never claim "linked"');
});

test('rowText is the session + index + name haystack', () => {
  assert.equal(rowText({ session: 'services', index: 3, name: 'logs' }), 'services 3: logs');
  assert.equal(rowText({ session: 's', index: 0, name: '' }), 's 0: bash');
});
