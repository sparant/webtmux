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
