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
  sessionCmdPayload, parseSessionCmdPayload,
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

// --- set-session-command ------------------------------------------------------
// The other two-user-typed-strings payload: a session name and a command line.
// A command line contains spaces and pipes as a matter of course, so this one
// could never have used the first-space rule at all.

test('a command line with spaces, pipes and quotes stays whole', () => {
  const cmd = `WT_WINDOW="$TMUX_PANE" docker exec -it x bash -lc "tail -F log | grep -i err"`;
  const p = sessionCmdPayload('claude-editors', cmd);
  assert.deepEqual(parseSessionCmdPayload(p), { session: 'claude-editors', cmd });
});

test('a session name with a space keeps the command intact', () => {
  const p = sessionCmdPayload('my project', 'make watch');
  assert.deepEqual(parseSessionCmdPayload(p), { session: 'my project', cmd: 'make watch' });
});

test('an empty command round-trips as empty — that is how the field CLEARS it', () => {
  assert.deepEqual(parseSessionCmdPayload(sessionCmdPayload('dev', '')), {
    session: 'dev',
    cmd: '',
  });
});

test('a separator-less payload parses as nothing, matching the server drop', () => {
  // It must NOT read as "session=the whole string, cmd=empty": that would
  // silently CLEAR the command of whatever session the payload named.
  assert.equal(parseSessionCmdPayload('claude-editors launch_new.sh'), null);
  assert.equal(parseSessionCmdPayload(''), null);
});

test('a command containing a NUL cannot smuggle a second field', () => {
  // Only the FIRST separator splits, so a NUL later in the command stays in the
  // command — the server uses IndexByte for exactly this reason.
  const p = sessionCmdPayload('dev', 'a\x00b');
  assert.deepEqual(parseSessionCmdPayload(p), { session: 'dev', cmd: 'a\x00b' });
});
