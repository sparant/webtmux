// The client half of the write-authority matrix, and what a read-only connection
// does to the shared StateStore. Run with:
//
//     node --test test/
//
// Two things are worth pinning here.
//
// 1. The client's matrix must MIRROR the server's (webtty/authority.go). It is a
//    duplicate by necessity — the browser has to decide before it sends — and a
//    duplicate that drifts is worse than none: the UI would grey out a control
//    that works, or offer one that is silently dropped. So the message types are
//    listed here explicitly, in the same two groups, as an assertion rather than
//    as a comment.
//
// 2. A read-only StateStore must not spin. @wt_state is a tmux write, so it is
//    refused; the naive consequence of rule 4 ("a send that did not leave is
//    still pending") would be a change held dirty forever and re-flushed on every
//    reconnect against a server that can never accept it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  writeAuthority, requiresWrite, VIEW_ONLY, READ_ONLY_NOTICE,
  MSG_INPUT, MSG_PING, MSG_RESIZE, MSG_SET_ENCODING,
  MSG_CAPTURE_REQUEST, MSG_SAVE_INFO_REQUEST, MSG_HISTORY_INFO_REQUEST, MSG_REFRESH,
} from '../resources/js/write-guard.js';
import { StateStore } from '../resources/js/state-store.js';

// The tmux message types, as terminal-unit.js's MSG has them. Restated so this
// file is a decision table, not a re-import of the thing under test.
const MUTATING = {
  input: MSG_INPUT,
  selectPane: '5',
  selectWindow: '6',
  splitPane: '7',
  closePane: '8',
  copyMode: '9',
  sendCommand: 'A',
  scrollUp: 'B',
  scrollDown: 'C',
  newWindow: 'D',
  switchSession: 'E',
  renameWindow: 'F',
  moveWindow: 'H',
  newSession: 'I',
  renameSession: 'J',
  killWindow: 'K',
  killSession: 'L',
  linkWindow: 'M',
  unlinkWindow: 'N',
  savePaneFile: 'O',
  setState: 'P',
  // Changing a scrollback buffer: a resize REBUILDS panes (killing what runs in
  // them) and a clear discards history nobody can get back.
  historyAction: 'U',
};

const VIEWING = {
  ping: MSG_PING,
  resize: MSG_RESIZE,
  setEncoding: MSG_SET_ENCODING,
  captureRequest: MSG_CAPTURE_REQUEST,
  saveInfoRequest: MSG_SAVE_INFO_REQUEST,
  // Reading how big a scrollback is, and how full — a `list-panes`/`show-options`
  // read. The action that CHANGES it sits in MUTATING above.
  historyInfoRequest: MSG_HISTORY_INFO_REQUEST,
  refresh: MSG_REFRESH,
};

test('every mutating message type requires -w', () => {
  for (const [name, type] of Object.entries(MUTATING)) {
    assert.equal(requiresWrite(type), true, `${name} (${type}) must require -w`);
  }
});

test('the viewing message types do not', () => {
  for (const [name, type] of Object.entries(VIEWING)) {
    assert.equal(requiresWrite(type), false, `${name} (${type}) must work read-only`);
  }
  // …and the allowlist holds exactly those, so a type added to VIEW_ONLY without
  // a decision shows up here.
  assert.deepEqual([...VIEW_ONLY].sort(), Object.values(VIEWING).sort());
});

test('an unknown message type fails closed', () => {
  // Same rule as the server: a control nobody classified does nothing rather
  // than everything.
  assert.equal(requiresWrite('~'), true);
});

test('authority defaults to permitted until the handshake answers', () => {
  // Assuming read-only before the preferences frame arrives would flash every
  // control greyed on every page load.
  const a = new writeAuthority.constructor();
  assert.equal(a.permitWrite, true);
  assert.equal(a.known, false);
  a.set(false);
  assert.equal(a.readOnly, true);
  assert.equal(a.known, true);
});

test('a read-only authority allows viewing and refuses mutation', () => {
  const a = new writeAuthority.constructor();
  a.set(false);
  assert.equal(a.allows(MSG_CAPTURE_REQUEST), true);
  assert.equal(a.allows(MSG_REFRESH), true);
  assert.equal(a.allows(MUTATING.killSession), false);
  assert.equal(a.allows(MUTATING.setState), false);

  a.set(true);
  assert.equal(a.allows(MUTATING.killSession), true);
});

test('subscribers learn the answer, once, on change', () => {
  const a = new writeAuthority.constructor();
  const seen = [];
  a.subscribe((v) => seen.push(v));
  assert.deepEqual(seen, []);       // nothing known yet — nothing claimed
  a.set(false);
  a.set(false);                     // idempotent
  a.set(true);
  assert.deepEqual(seen, [false, true]);
  // A late subscriber gets the current answer immediately.
  const late = [];
  a.subscribe((v) => late.push(v));
  assert.deepEqual(late, [true]);
});

test('the notice names the flag that turns writing on', () => {
  assert.match(READ_ONLY_NOTICE, /-w/);
});

// ---- StateStore in read-only mode ---------------------------------------------

// A store wired to a sender that records what it was asked to send.
function storeWithSender() {
  const sent = [];
  const s = new StateStore();
  s.setSender((json) => { sent.push(JSON.parse(json)); return true; });
  s.load(null, 'srv1');   // release the first-load gate (rule 1)
  return { s, sent };
}

test('a read-only store never writes @wt_state', async () => {
  const { s, sent } = storeWithSender();
  s.setReadOnly(true);
  s.patchSection('sidebar', { pinned: true });
  await new Promise((r) => setTimeout(r, 600)); // past the 400ms debounce
  assert.deepEqual(sent, [], 'a read-only client must not write the shared blob');
  // …but the change is live locally: a viewer can still arrange their own UI.
  assert.equal(s.section('sidebar').pinned, true);
});

test('a read-only store holds nothing pending, so reconnects do not retry', async () => {
  const { s, sent } = storeWithSender();
  s.patchSection('sidebar', { pinned: true });   // queued before we learn the mode
  s.setReadOnly(true);
  await new Promise((r) => setTimeout(r, 600));
  s.resync();                                     // a reconnect
  await new Promise((r) => setTimeout(r, 600));
  assert.deepEqual(sent, []);
  assert.equal(s._pending.length, 0, 'un-sendable patches must not accumulate');
  assert.equal(s._dirty, false);
});

test('a read-only store still adopts the servers blob', () => {
  const { s } = storeWithSender();
  s.setReadOnly(true);
  s.load(JSON.stringify({ v: 1, rev: 7, sidebar: { pinned: true } }), 'srv1');
  assert.equal(s.section('sidebar').pinned, true);
  assert.equal(s.appliedRev, 7);
});

test('leaving read-only mode flushes what is still local', async () => {
  const { s, sent } = storeWithSender();
  s.setReadOnly(true);
  s.patchSection('sidebar', { pinned: true });
  await new Promise((r) => setTimeout(r, 600));
  assert.deepEqual(sent, []);

  s.setReadOnly(false);
  s.patchSection('sidebar', { overlay: false });
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(sent.length, 1);
  // The local change made while read-only is part of the blob that finally goes.
  assert.equal(sent[0].sidebar.pinned, true);
  assert.equal(sent[0].sidebar.overlay, false);
});
