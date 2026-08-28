// Unit tests for the structured tmux message payloads. Run:
//
//     node --test test/
//
// tmux-payloads.js is import-free, so it loads cleanly under node.
//
// This is a wire contract with webtty/tmux.go: the browser encodes, the server
// decodes, and nothing in between validates. The failure mode of getting it wrong
// is silent — the server parses SOMETHING out of the payload and renames a session
// nobody asked it to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FIELD_SEP, renameSessionPayload, parseRenameSessionPayload,
  sessionCmdsPayload, parseSessionCmdsPayload, newWindowPayload,
} from '../resources/js/tmux-payloads.js';

test('the payload is NUL-delimited, not space-delimited', () => {
  assert.equal(renameSessionPayload('services', 'ops'), 'services\x00ops');
  assert.equal(FIELD_SEP, '\x00');
});

test('the reported case: a session name with a space stays whole', () => {
  // The old "<old> <new>" form split here, so the server aimed at "my" — and
  // resolves a session target by PREFIX, so it renamed whatever started with it.
  const p = renameSessionPayload('my project', 'my other project');
  assert.deepEqual(parseRenameSessionPayload(p), {
    oldName: 'my project',
    newName: 'my other project',
  });
});

test('every other punctuation a session name can carry survives too', () => {
  for (const name of ['a, b | c', 'ops|staging', '-dashed', 'x  y', '  padded  ']) {
    const p = renameSessionPayload(name, name + '2');
    assert.deepEqual(parseRenameSessionPayload(p), { oldName: name, newName: name + '2' });
  }
});

test('an empty new name still round-trips as empty (the server refuses it)', () => {
  assert.deepEqual(parseRenameSessionPayload(renameSessionPayload('dev', '')), {
    oldName: 'dev',
    newName: '',
  });
});

test('a payload with no separator parses as nothing, matching the server drop', () => {
  assert.equal(parseRenameSessionPayload('old new'), null);
  assert.equal(parseRenameSessionPayload(''), null);
});

// --- set-session-menu + new-window ------------------------------------------

test('the menu rides as JSON after the session name', () => {
  const cmds = [{ label: 'shell', cmd: '' }, { label: 'claude', cmd: 'run me | tee log' }];
  const p = sessionCmdsPayload('claude-editors', cmds);
  assert.deepEqual(parseSessionCmdsPayload(p), { session: 'claude-editors', cmds });
});

test('a session name with a space keeps the menu intact', () => {
  const p = sessionCmdsPayload('my project', [{ label: '', cmd: 'make watch' }]);
  assert.deepEqual(parseSessionCmdsPayload(p), {
    session: 'my project',
    cmds: [{ label: '', cmd: 'make watch' }],
  });
});

test('an empty menu round-trips as empty — that is how a menu CLEARS', () => {
  assert.deepEqual(parseSessionCmdsPayload(sessionCmdsPayload('dev', [])), { session: 'dev', cmds: [] });
  assert.deepEqual(parseSessionCmdsPayload(sessionCmdsPayload('dev', null)), { session: 'dev', cmds: [] });
});

test('a separator-less payload parses as nothing, matching the server drop', () => {
  // It must NOT read as "session = the whole string, menu = empty": that would
  // silently CLEAR the menu of whatever session the payload named.
  assert.equal(parseSessionCmdsPayload('claude-editors []'), null);
  assert.equal(parseSessionCmdsPayload(''), null);
});

test('a non-array or unparseable menu is rejected, not half-read', () => {
  assert.equal(parseSessionCmdsPayload('dev\u0000{"cmd":"x"}'), null);
  assert.equal(parseSessionCmdsPayload('dev\u0000not json'), null);
});

test('new-window puts the machine-shaped index first and the session last', () => {
  assert.equal(newWindowPayload('', 0), '0 ');
  assert.equal(newWindowPayload('editors', 2), '2 editors');
  // A session name with a space is the last field, so it survives whole.
  assert.equal(newWindowPayload('my session', 1), '1 my session');
  // Junk index degrades to the first entry rather than to NaN on the wire.
  assert.equal(newWindowPayload('dev', undefined), '0 dev');
  assert.equal(newWindowPayload('dev', 'x'), '0 dev');
});
