// Unit tests for arrowSequence — the bytes an arrow keypress puts on the wire.
// Run with:
//
//     node --test test/
//
// arrow-keys.js is dependency-free and pure, so it loads directly under node.
// The regression these lock down: TerminalUnit's arrow intercept used to key on
// ev.key alone, so Option+→ reached the pane as a bare right-arrow and word
// navigation moved one character.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arrowSequence } from '../resources/js/arrow-keys.js';

// A keydown event, as far as this module is concerned.
const ev = (key, mods = {}) => ({ key, ...mods });

test('a plain arrow keeps its CSI form (never SS3)', () => {
  assert.equal(arrowSequence(ev('ArrowUp')), '\x1b[A');
  assert.equal(arrowSequence(ev('ArrowDown')), '\x1b[B');
  assert.equal(arrowSequence(ev('ArrowRight')), '\x1b[C');
  assert.equal(arrowSequence(ev('ArrowLeft')), '\x1b[D');
});

test('anything that is not an arrow is left alone', () => {
  assert.equal(arrowSequence(ev('a')), null);
  assert.equal(arrowSequence(ev('Enter')), null);
  assert.equal(arrowSequence(ev('Home', { altKey: true })), null);
});

test('Option+←/→ on a Mac is the meta-b / meta-f word jump', () => {
  assert.equal(arrowSequence(ev('ArrowRight', { altKey: true }), true), '\x1bf');
  assert.equal(arrowSequence(ev('ArrowLeft', { altKey: true }), true), '\x1bb');
});

test('Alt+←/→ off a Mac arrives as the Ctrl+←/→ word jump', () => {
  assert.equal(arrowSequence(ev('ArrowRight', { altKey: true }), false), '\x1b[1;5C');
  assert.equal(arrowSequence(ev('ArrowLeft', { altKey: true }), false), '\x1b[1;5D');
});

test('Alt+↑/↓ has no word-jump meaning, so it stays the plain modified CSI', () => {
  assert.equal(arrowSequence(ev('ArrowUp', { altKey: true }), true), '\x1b[1;3A');
  assert.equal(arrowSequence(ev('ArrowDown', { altKey: true }), true), '\x1b[1;3B');
});

test('other modifiers use the standard 1 + bitmask encoding', () => {
  assert.equal(arrowSequence(ev('ArrowRight', { shiftKey: true })), '\x1b[1;2C');
  assert.equal(arrowSequence(ev('ArrowRight', { ctrlKey: true })), '\x1b[1;5C');
  assert.equal(arrowSequence(ev('ArrowLeft', { ctrlKey: true })), '\x1b[1;5D');
  assert.equal(arrowSequence(ev('ArrowUp', { shiftKey: true, ctrlKey: true })), '\x1b[1;6A');
  assert.equal(arrowSequence(ev('ArrowRight', { metaKey: true })), '\x1b[1;9C');
});

test('the Mac word-jump substitution is Option ALONE, not Option plus friends', () => {
  // ⌃⌥→ is a chord the split view may claim; whatever reaches the pane must still
  // be a well-formed modified arrow, not a bare meta-f.
  assert.equal(arrowSequence(ev('ArrowRight', { altKey: true, ctrlKey: true }), true), '\x1b[1;7C');
  assert.equal(arrowSequence(ev('ArrowRight', { altKey: true, shiftKey: true }), true), '\x1b[1;4C');
});
