// Unit tests for copy-buffers.js — the ring behind "copy several things, then
// paste them one at a time". Run with:
//
//     node --test test/
//
// The module is import-free, so it loads cleanly under node.
//
// What is under test is one rule and everything that hangs off it: a copy APPENDS
// while the focused buffer is unpasted and OVERWRITES once it has been used. Get
// that backwards in either direction and the failure is silent — either the list
// fills with junk from ordinary copy-paste, or a buffer you gathered is destroyed
// by the next copy with nothing on screen to say so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CopyBuffers, previewText, entryMeta, isEmptyEntry, PREVIEW_CHARS, PERSIST_BUDGET,
} from '../resources/js/copy-buffers.js';

const texts = (r) => r.entries.map((e) => e.text);

test('a fresh ring is one empty focused buffer', () => {
  const r = new CopyBuffers();
  assert.equal(r.length, 1);
  assert.equal(r.text, '');
  assert.equal(r.focusId, r.entries[0].id);
  assert.equal(r.pristine, true);
});

test('the first copy fills the empty buffer rather than adding one', () => {
  const r = new CopyBuffers();
  r.copy('alpha');
  assert.deepEqual(texts(r), ['alpha']);
  assert.equal(r.text, 'alpha');
  assert.equal(r.pristine, false);
});

test('gathering: copies without a paste in between accumulate, newest focused', () => {
  const r = new CopyBuffers();
  r.copy('alpha');
  r.copy('beta');
  r.copy('gamma');
  // In copy order, top to bottom — the order they will be pasted back out in.
  assert.deepEqual(texts(r), ['alpha', 'beta', 'gamma']);
  assert.equal(r.text, 'gamma');
});

test('ordinary copy-paste-copy-paste never grows the list', () => {
  const r = new CopyBuffers();
  for (const s of ['one', 'two', 'three']) {
    r.copy(s);
    r.notePaste();
  }
  assert.deepEqual(texts(r), ['three'], 'a spent buffer is reused, not kept');
});

test('a copy after a paste replaces the buffer that was pasted, and only that one', () => {
  const r = new CopyBuffers();
  r.copy('keep-me');
  r.copy('used');          // gathering: a second buffer
  r.notePaste();           // …which is now spent
  r.copy('replacement');
  assert.deepEqual(texts(r), ['keep-me', 'replacement']);
});

test('the same text arriving twice is one buffer, not two', () => {
  // Real cause: ⌘C copies the xterm selection AND tmux emits OSC 52 for the same
  // copy moments later. Without this guard half the copies in the app double up.
  const r = new CopyBuffers();
  r.copy('dup');
  r.copy('dup');
  assert.deepEqual(texts(r), ['dup']);
});

test('re-copying the focused text un-spends it, so the next copy still appends', () => {
  const r = new CopyBuffers();
  r.copy('a');
  r.notePaste();
  r.copy('a');            // the user asserts they want this text again
  r.copy('b');
  assert.deepEqual(texts(r), ['a', 'b'], 'a re-copy must not license destroying it');
});

test('an empty copy records nothing', () => {
  const r = new CopyBuffers();
  assert.equal(r.copy(''), null);
  assert.equal(r.copy(null), null);
  assert.equal(r.copy(undefined), null);
  assert.equal(r.pristine, true);
});

test('a new copy lands next to the focused buffer, not at the end', () => {
  const r = new CopyBuffers();
  r.copy('a');
  r.copy('b');
  r.copy('c');
  r.focus(r.entries[0].id);   // back to 'a'
  r.copy('a2');
  assert.deepEqual(texts(r), ['a', 'a2', 'b', 'c']);
});

test('focusing protects a buffer from the next copy', () => {
  // Reaching for an entry by hand says it matters; letting the next copy land on
  // top of the row you just picked is the one destructive surprise to avoid.
  const r = new CopyBuffers();
  r.copy('wanted');
  r.notePaste();                 // spent…
  r.focus(r.entries[0].id);      // …but deliberately re-focused
  r.copy('new');
  assert.deepEqual(texts(r), ['wanted', 'new']);
});

test('focus ignores an id that is not in the ring', () => {
  const r = new CopyBuffers();
  r.copy('a');
  const before = r.focusId;
  assert.equal(r.focus('nope'), null);
  assert.equal(r.focusId, before);
});

test('step clamps at both ends instead of wrapping', () => {
  // Wrapping would silently change what ⌘V pastes when an arrow key overshoots.
  const r = new CopyBuffers();
  r.copy('a'); r.copy('b'); r.copy('c');
  assert.equal(r.step(1), null, 'already at the last row');
  r.step(-1); assert.equal(r.text, 'b');
  r.step(-1); assert.equal(r.text, 'a');
  assert.equal(r.step(-1), null, 'already at the first row');
});

test('"+" adds an empty focused buffer, and refuses to add a second one', () => {
  const r = new CopyBuffers();
  r.copy('a');
  r.add();
  assert.deepEqual(texts(r), ['a', '']);
  assert.equal(isEmptyEntry(r.focused), true);
  r.add();
  assert.deepEqual(texts(r), ['a', ''], 'two blank rows are indistinguishable');
});

test('a copy into an added empty buffer fills it', () => {
  const r = new CopyBuffers();
  r.copy('a');
  r.add();
  r.copy('b');
  assert.deepEqual(texts(r), ['a', 'b']);
});

test('removing a buffer moves the focus to the row that slid into the gap', () => {
  const r = new CopyBuffers();
  r.copy('a'); r.copy('b'); r.copy('c');
  r.focus(r.entries[1].id);
  r.remove(r.entries[1].id);
  assert.deepEqual(texts(r), ['a', 'c']);
  assert.equal(r.text, 'c');
});

test('removing the last row focuses the new tail', () => {
  const r = new CopyBuffers();
  r.copy('a'); r.copy('b');
  r.remove(r.entries[1].id);
  assert.deepEqual(texts(r), ['a']);
  assert.equal(r.text, 'a');
});

test('removing a non-focused buffer leaves the focus where it was', () => {
  const r = new CopyBuffers();
  r.copy('a'); r.copy('b'); r.copy('c');   // focused on 'c'
  r.remove(r.entries[0].id);
  assert.deepEqual(texts(r), ['b', 'c']);
  assert.equal(r.text, 'c');
});

test('the ring can never become empty', () => {
  const r = new CopyBuffers();
  r.copy('only');
  r.remove(r.focusId);
  assert.equal(r.length, 1);
  assert.equal(r.pristine, true, 'a ring with nowhere to put the next copy is not a ring');
});

test('removing an unknown id changes nothing', () => {
  const r = new CopyBuffers();
  r.copy('a');
  assert.equal(r.remove('nope'), null);
  assert.deepEqual(texts(r), ['a']);
});

test('clear keeps the FOCUSED buffer — the one the clipboard holds', () => {
  const r = new CopyBuffers();
  r.copy('a'); r.copy('b'); r.copy('c');
  r.focus(r.entries[1].id);
  r.clear();
  assert.deepEqual(texts(r), ['b'], 'keeping any other one would desync the clipboard');
  assert.equal(r.text, 'b');
  assert.equal(r.focusId, r.entries[0].id);
});

// --- the row label ------------------------------------------------------------

test('the preview collapses whitespace so a multi-line copy is identifiable', () => {
  assert.equal(previewText('  git   status\n\n  # note '), 'git status # note');
});

test('the preview ellipsizes rather than running past the row', () => {
  const long = 'x'.repeat(PREVIEW_CHARS + 40);
  const p = previewText(long);
  assert.equal(p.length, PREVIEW_CHARS + 1, 'cut to the limit plus the ellipsis');
  assert.ok(p.endsWith('…'));
});

test('text that fits is shown whole, with no ellipsis', () => {
  assert.equal(previewText('short'), 'short');
});

test('the meta says how big a buffer is, and says nothing when the preview is all of it', () => {
  assert.deepEqual(entryMeta('one line'), { lines: 1, chars: 8, whole: true });
  const multi = entryMeta('a\nb\nc');
  assert.equal(multi.lines, 3);
  assert.equal(multi.chars, 5);
  assert.equal(multi.whole, false, 'a preview that hides two lines must not claim to be whole');
  assert.equal(entryMeta('x'.repeat(PREVIEW_CHARS + 1)).whole, false);
  assert.equal(entryMeta('').chars, 0);
});

// --- persistence ---------------------------------------------------------------

test('a ring survives a round trip through toJSON', () => {
  const r = new CopyBuffers();
  r.copy('a'); r.copy('b');
  r.focus(r.entries[0].id);
  const back = new CopyBuffers(r.toJSON());
  assert.deepEqual(texts(back), ['a', 'b']);
  assert.equal(back.text, 'a', 'the restored ring points at the same buffer');
});

test('a restored ring treats its focused buffer as unpasted', () => {
  // Nobody can say after a reload whether the text still sitting there was used.
  // Assuming it was NOT loses nothing; assuming it was loses a buffer.
  const r = new CopyBuffers();
  r.copy('gathered');
  r.notePaste();
  const back = new CopyBuffers(r.toJSON());
  back.copy('next');
  assert.deepEqual(texts(back), ['gathered', 'next']);
});

test('restored ids never collide with newly minted ones', () => {
  const r = new CopyBuffers();
  r.copy('a'); r.copy('b'); r.copy('c');
  const back = new CopyBuffers(r.toJSON());
  back.add();
  const ids = back.entries.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('an over-budget ring drops whole buffers, never half of one', () => {
  const r = new CopyBuffers();
  r.copy('a'.repeat(100));
  r.copy('b'.repeat(100));
  r.copy('c'.repeat(100));
  const kept = new CopyBuffers(r.toJSON({ budget: 250 })).entries;
  // Two of the three fit; each kept one is intact. Half a buffer would still look
  // complete in the panel and paste half a command into a shell.
  assert.equal(kept.length, 2);
  for (const e of kept) assert.equal(e.text.length, 100);
});

test('the focused buffer is persisted whatever its size — it is the clipboard', () => {
  const r = new CopyBuffers();
  r.copy('small');
  r.copy('X'.repeat(500));
  const blob = r.toJSON({ budget: 10 });
  assert.deepEqual(blob.entries.map((e) => e.text.length), [500]);
  assert.equal(blob.focus, r.focusId);
});

test('the default budget is generous enough for ordinary use', () => {
  assert.ok(PERSIST_BUDGET >= 64 * 1024);
});

test('a malformed blob reads as a fresh ring rather than throwing', () => {
  // It is restored from a browser store on boot; a bad blob must not blank the page.
  for (const junk of [undefined, null, 'nope', 42, {}, { entries: 'no' },
                      { entries: [null, { text: 5 }] }, { entries: [], focus: 'gone' }]) {
    const r = new CopyBuffers(junk);
    assert.equal(r.length, 1);
    assert.equal(r.pristine, true);
    assert.equal(r.focusId, r.entries[0].id);
  }
});

test('a blob pointing at a focus that is not in its entries falls back to the first', () => {
  const r = new CopyBuffers({ entries: [{ id: 'b1', text: 'a' }, { id: 'b2', text: 'b' }], focus: 'b9' });
  assert.equal(r.focusId, 'b1');
});
