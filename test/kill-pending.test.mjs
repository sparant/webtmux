// Unit tests for kill-pending.js — the "killing, hold on" state behind the
// sidebar's × affordances.
//
//     node --test test/
//
// kill-pending.js imports only window-tree.js (itself a dependency-free view
// model), so it loads cleanly under node with no DOM.
//
// What's worth testing: the bar lands on the RIGHT row (a linked window's two
// placements are separate rows), the layout push that removes a row — and only
// that one — settles its bar, and a kill the server refused comes back as a
// notice instead of a bar that silently vanishes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sessionKey, windowKey, makePending,
  pendingWindow, pendingSession, prunePending, failedKillNotice,
} from '../resources/js/kill-pending.js';
import { rowKey } from '../resources/js/window-tree.js';

const win = (id, session, index = 0, name = 'bash') => ({ id, session, index, name });

test('keys: the window half is a placement key, the session half a plain name', () => {
  assert.equal(sessionKey('services'), 's:services');
  assert.equal(windowKey('services', '@4'), 'w:' + rowKey('services', '@4'));
  // A linked window's two placements key to two different rows.
  assert.notEqual(windowKey('services', '@2'), windowKey('editors', '@2'));
});

test('makePending freezes the label at click time', () => {
  const p = makePending('window', windowKey('services', '@4'), 'window 3: logs');
  assert.equal(p.kind, 'window');
  assert.equal(p.label, 'window 3: logs');
  assert.ok(typeof p.at === 'number');
});

test('pendingWindow: the window bar lives on its own row, and nowhere else', () => {
  const m = new Map();
  m.set(windowKey('services', '@1'), makePending('window', windowKey('services', '@1'), 'window 0: logs'));
  assert.equal(pendingWindow(m, 'services', '@1').label, 'window 0: logs');
  assert.equal(pendingWindow(m, 'services', '@2'), null);   // a different row
  // A window linked into two sessions has one bar for the placement that was
  // killed; the other row is untouched.
  assert.equal(pendingWindow(m, 'editors', '@1'), null);
});

test('pendingWindow: a session kill does not scatter bars onto window rows', () => {
  const m = new Map();
  m.set(sessionKey('services'), makePending('session', sessionKey('services'), 'session “services”'));
  assert.equal(pendingWindow(m, 'services', '@1'), null);
  assert.equal(pendingSession(m, 'services').label, 'session “services”');
  assert.equal(pendingSession(m, 'editors'), null);
});

test('prunePending: a killed window is settled by the layout that loses its row', () => {
  const m = new Map();
  m.set(windowKey('services', '@1'), makePending('window', windowKey('services', '@1'), 'window 0: a'));
  m.set(windowKey('services', '@2'), makePending('window', windowKey('services', '@2'), 'window 1: b'));
  m.set(sessionKey('services'), makePending('session', sessionKey('services'), 'session “services”'));

  // @1 is gone from the directory; @2 and the session are not.
  const gone = prunePending(m, [{ name: 'services' }], [win('@2', 'services', 1)]);
  assert.deepEqual(gone.map((p) => p.key), [windowKey('services', '@1')]);
  assert.deepEqual([...m.keys()], [windowKey('services', '@2'), sessionKey('services')]);
});

test('prunePending: a killed session settles the session AND its windows', () => {
  const m = new Map();
  m.set(sessionKey('editors'), makePending('session', sessionKey('editors'), 'session “editors”'));
  m.set(windowKey('editors', '@5'), makePending('window', windowKey('editors', '@5'), 'window 0: vim'));
  // The push after a session kill: the session is gone from the list, and its
  // windows' rows are gone with it — both settle at once.
  const gone = prunePending(m, [{ name: 'services' }], [win('@1', 'services', 0)]);
  assert.equal(gone.length, 2);
  assert.deepEqual(new Set(gone.map((p) => p.kind)), new Set(['window', 'session']));
  assert.equal(m.size, 0);
});

test('prunePending: a kill-window settles its bar on the row that disappears', () => {
  // A window linked into two sessions, barred on its LAST-placement row per the
  // sidebar's own logic… is a contradiction by construction: the bar is only ever
  // marked when the row is the window's last home, and such a window cannot be
  // in two sessions. What the rule actually answers is the RACE — the count was
  // stale, another client linked it meanwhile, and the kill by @id removed it
  // from every directory anyway. The push shows no row for it: the bar settles
  // with the row. No bar is ever created on the surviving placements, so there
  // is nothing to strand.
  const m = new Map();
  m.set(windowKey('editors', '@5'), makePending('window', windowKey('editors', '@5'), 'w'));
  const gone = prunePending(m, [{ name: 'services' }, { name: 'editors' }], []);
  assert.deepEqual(gone.map((p) => p.key), [windowKey('editors', '@5')]);

  // …and the mirror image: the row is still drawn (a kill that raced and lost,
  // or a rename) — nothing settles, the bar keeps spinning until the row goes.
  const m2 = new Map();
  m2.set(windowKey('services', '@5'), makePending('window', windowKey('services', '@5'), 'w'));
  assert.deepEqual(prunePending(m2, [{ name: 'services' }], [win('@5', 'services', 0)]), []);
  assert.equal(m2.size, 1);
});

test('prunePending: the fallback directory (old servers) keys rows under ownSession', () => {
  const m = new Map();
  m.set(windowKey('services', '@1'), makePending('window', windowKey('services', '@1'), 'w'));
  // layout.windows without the directory: the rows are the pane's own session's
  // windows, under that session's name — so services/@1 is still live.
  assert.deepEqual(prunePending(m, [{ name: 'services' }], [win('@1', '')], 'services'), []);
  // …and a layout in which the session has no windows at all settles the row.
  assert.deepEqual(prunePending(m, [{ name: 'services' }], [], 'services').map((p) => p.key),
    [windowKey('services', '@1')]);
  assert.equal(m.size, 0);
});

test('prunePending: a kill that did not land leaves the bar, and the notice exists', () => {
  const m = new Map();
  m.set(windowKey('services', '@1'), makePending('window', windowKey('services', '@1'), 'window 0: a'));
  // The row is STILL in the list — the kill did not land (it raced, or the
  // server refused it). Nothing settles: the bar keeps spinning on the row that
  // is still there, and says nothing yet — refusals are not reported to the
  // client today, but if they ever are, failedKillNotice is the line to show.
  const gone = prunePending(m, [{ name: 'services' }], [win('@1', 'services', 0)]);
  assert.deepEqual(gone, []);
  assert.equal(m.size, 1);
  const note = failedKillNotice('window 0: a');
  assert.match(note, /Did not kill window 0: a/);
  assert.match(note, /still there/);
});

test('prunePending: empty state is a no-op, never an allocation of notes', () => {
  assert.deepEqual(prunePending(new Map(), [], []), []);
  assert.deepEqual(prunePending(null, [], []), []);
});

test('a session kill and a window kill pending at once settle independently', () => {
  const m = new Map();
  m.set(sessionKey('services'), makePending('session', sessionKey('services'), 's:services'));
  m.set(windowKey('editors', '@9'), makePending('window', windowKey('editors', '@9'), 'w'));
  // Only the window's row leaves (killed separately by a shortcut, say).
  const gone = prunePending(m,
    [{ name: 'services' }, { name: 'editors' }],
    [win('@1', 'services', 0)]);
  assert.deepEqual(gone.map((p) => p.kind), ['window']);
  assert.deepEqual([...m.keys()], [sessionKey('services')]);
});
