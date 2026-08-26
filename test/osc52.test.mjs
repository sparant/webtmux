// Unit tests for osc52.js — the scanner that turns a program's OSC 52 clipboard
// write into a copy. Run with:
//
//     node --test test/
//
// The module is import-free, so it loads cleanly under node.
//
// What is under test is one property: a copy is one SEQUENCE, not one frame. The
// old chunk-local scanner got the common case and silently lost every split one —
// the copy never happened AND the fragment was painted into the terminal. Both
// halves of that failure are asserted here, at every offset a split can land on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Osc52Stream, osc52, MAX_HOLD } from '../resources/js/osc52.js';

// Feed a whole string in one go.
const once = (s, opts) => new Osc52Stream(opts).feed(s);

// Feed `s` one character at a time — the worst split there is — and return the
// terminal text and copies it produced overall.
function drip(s, opts) {
  const st = new Osc52Stream(opts);
  let text = '';
  const copies = [];
  for (const ch of s) {
    const out = st.feed(ch);
    text += out.text;
    copies.push(...out.copies);
  }
  return { text, copies, pending: st.pending };
}

test('a complete sequence is copied and stripped from the output', () => {
  const { text, copies } = once('before' + osc52('hello') + 'after');
  assert.deepEqual(copies, ['hello']);
  assert.equal(text, 'beforeafter');
});

test('the ST terminator (ESC backslash) works as well as BEL', () => {
  const { text, copies } = once('a' + osc52('hello', { st: true }) + 'b');
  assert.deepEqual(copies, ['hello']);
  assert.equal(text, 'ab');
});

test('two copies in one chunk are two entries, not one', () => {
  const { text, copies } = once(osc52('one') + 'x' + osc52('two'));
  assert.deepEqual(copies, ['one', 'two']);
  assert.equal(text, 'x');
});

test('a sequence split at EVERY offset still copies exactly once', () => {
  // This is the whole point of the module. A login URL's base64 runs to hundreds
  // of bytes, so the split is routine — and a scanner that only looks inside one
  // chunk loses the copy at most of these offsets.
  const payload = 'https://example.invalid/oauth?code=' + 'z'.repeat(200);
  const stream = 'noise-' + osc52(payload) + '-tail';
  for (let cut = 0; cut <= stream.length; cut++) {
    const st = new Osc52Stream();
    const a = st.feed(stream.slice(0, cut));
    const b = st.feed(stream.slice(cut));
    const copies = [...a.copies, ...b.copies];
    assert.deepEqual(copies, [payload], `cut at ${cut}`);
    assert.equal(a.text + b.text, 'noise--tail', `cut at ${cut}`);
    assert.equal(st.pending, 0, `nothing left held, cut at ${cut}`);
  }
});

test('a byte-at-a-time stream — the worst split — copies once and prints nothing extra', () => {
  const { text, copies, pending } = drip('L' + osc52('hi there') + 'R');
  assert.deepEqual(copies, ['hi there']);
  assert.equal(text, 'LR');
  assert.equal(pending, 0);
});

test('the held bytes are not painted while a sequence is in flight', () => {
  // The fragment is part of a control sequence, not content. Emitting it "for now"
  // is what put mojibake on screen whenever a copy straddled a frame.
  const st = new Osc52Stream();
  const first = st.feed('visible\x1b]52;c;aGVs');
  assert.equal(first.text, 'visible');
  assert.deepEqual(first.copies, []);
  assert.ok(st.pending > 0);
  const second = st.feed('bG8=\x07rest');
  assert.deepEqual(second.copies, ['hello']);
  assert.equal(second.text, 'rest');
});

test('a chunk ending part way into the introducer holds only that much', () => {
  const st = new Osc52Stream();
  const a = st.feed('text\x1b]5');
  assert.equal(a.text, 'text');
  assert.equal(st.pending, 3);            // "\x1b]5"
  const b = st.feed('2;c;aGk=\x07');
  assert.deepEqual(b.copies, ['hi']);
  assert.equal(b.text, '');
});

test('a dangling introducer that turns out to be a different OSC is released as text', () => {
  // "\x1b]0;" is a title set. Holding it briefly is fine; swallowing it is not.
  const st = new Osc52Stream();
  st.feed('\x1b]');
  const out = st.feed('0;title\x07');
  assert.equal(out.text, '\x1b]0;title\x07');
  assert.deepEqual(out.copies, []);
});

test('an ESC at the very end is an incomplete ST, not a missing one', () => {
  const st = new Osc52Stream();
  const a = st.feed('\x1b]52;c;aGk=\x1b');
  assert.deepEqual(a.copies, []);
  const b = st.feed('\\');
  assert.deepEqual(b.copies, ['hi']);
  assert.equal(a.text + b.text, '');
});

test('UTF-8 survives the round trip', () => {
  const s = 'héllo — 世界 🌍';
  assert.deepEqual(once(osc52(s)).copies, [s]);
});

test('a clipboard QUERY is stripped but copies nothing', () => {
  // "?" asks what the clipboard holds. webtmux does not answer; it must also not
  // draw the question.
  const { text, copies } = once('a\x1b]52;c;?\x07b');
  assert.deepEqual(copies, []);
  assert.equal(text, 'ab');
});

test('malformed base64 is dropped, and the sequence is still not drawn', () => {
  const { text, copies } = once('a\x1b]52;c;!!!not base64!!!\x07b');
  assert.deepEqual(copies, []);
  assert.equal(text, 'ab');
});

test('any selection parameter is accepted, including an empty one', () => {
  assert.deepEqual(once(osc52('x', { selection: '' })).copies, ['x']);
  assert.deepEqual(once(osc52('x', { selection: 'p' })).copies, ['x']);
  assert.deepEqual(once(osc52('x', { selection: 's0' })).copies, ['x']);
});

test('an introducer that never terminates is released rather than held for ever', () => {
  // A hold is a pause in the terminal. Without the cap, a program printing the
  // literal text "\x1b]52;" would freeze the pane for the life of the connection.
  const st = new Osc52Stream({ maxHold: 32 });
  const a = st.feed('\x1b]52;c;' + 'A'.repeat(10));
  assert.equal(a.text, '');
  assert.ok(st.pending > 0);
  const b = st.feed('A'.repeat(40));
  assert.ok(b.text.startsWith('\x1b]52;c;'), 'the held bytes come back as text');
  assert.equal(st.pending, 0);
  assert.deepEqual(b.copies, []);
});

test('the default hold cap is big enough for a real copy', () => {
  // A copied scrollback is megabytes; a cap below that would turn a large copy
  // into terminal garbage.
  assert.ok(MAX_HOLD >= 1024 * 1024);
});

test('a large copy survives being cut into many chunks', () => {
  const big = 'x'.repeat(300 * 1024);
  const stream = osc52(big);
  const st = new Osc52Stream();
  const copies = [];
  let text = '';
  for (let i = 0; i < stream.length; i += 4096) {
    const out = st.feed(stream.slice(i, i + 4096));
    text += out.text;
    copies.push(...out.copies);
  }
  assert.equal(copies.length, 1);
  assert.equal(copies[0], big);
  assert.equal(text, '');
});
