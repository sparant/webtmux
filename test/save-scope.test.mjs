// Unit tests for save-scope.js — WHICH of a pane's two buffers a save means.
// Run with:
//
//     node --test test/
//
// The module is import-free, so it loads cleanly under node.
//
// What is under test is one decision and its blast radius: the default is the
// WHOLE buffer, and nothing — a stale value, an unknown string, a missing
// argument — is allowed to quietly resolve back to the visible screen. That
// failure would be invisible: a screenful of text looks exactly like a
// successful save of everything until you go looking for the line that mattered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCOPE_SCREEN, SCOPE_SCROLLBACK, DEFAULT_SAVE_SCOPE, SCOPE_OPTIONS,
  normalizeScope, isScrollback, downloadLabel, saveButtonLabel, fetchingText,
} from '../resources/js/save-scope.js';

test('the default is the entire buffer', () => {
  assert.equal(DEFAULT_SAVE_SCOPE, SCOPE_SCROLLBACK);
  assert.equal(isScrollback(DEFAULT_SAVE_SCOPE), true);
});

test('anything unrecognized falls back to the whole buffer, never to the screen', () => {
  for (const junk of [undefined, null, '', 'SCREEN', 'visible', 'all', 0, {}]) {
    assert.equal(normalizeScope(junk), SCOPE_SCROLLBACK, `${JSON.stringify(junk)} must not shrink the save`);
  }
});

test('the screen scope is honored when it is actually asked for', () => {
  assert.equal(normalizeScope(SCOPE_SCREEN), SCOPE_SCREEN);
  assert.equal(isScrollback(SCOPE_SCREEN), false);
});

test('the wire values are the words the server matches on', () => {
  // These strings cross to Go (webtty/tmux.go's scope constants). Renaming one
  // side only would silently save the screen forever, so they are pinned here.
  assert.equal(SCOPE_SCROLLBACK, 'scrollback');
  assert.equal(SCOPE_SCREEN, 'screen');
});

test('the options are offered whole-buffer first, and each says what it omits', () => {
  assert.equal(SCOPE_OPTIONS.length, 2);
  assert.equal(SCOPE_OPTIONS[0].value, SCOPE_SCROLLBACK);
  assert.equal(SCOPE_OPTIONS[1].value, SCOPE_SCREEN);
  for (const opt of SCOPE_OPTIONS) {
    assert.ok(opt.label.length > 0);
    assert.ok(opt.note.length > 0, `${opt.value} needs a note: neither option is wrong, so the difference has to be stated`);
  }
  // The distinction has to be legible from the labels alone — that is the entire
  // repair. A label pair that both read "download" would not be.
  assert.match(SCOPE_OPTIONS[0].label, /scrollback|entire|whole/i);
  assert.match(SCOPE_OPTIONS[1].label, /screen|visible/i);
});

test('every button label names the scope it will act on', () => {
  assert.notEqual(downloadLabel(SCOPE_SCROLLBACK), downloadLabel(SCOPE_SCREEN));
  assert.notEqual(saveButtonLabel(SCOPE_SCROLLBACK), saveButtonLabel(SCOPE_SCREEN));
  assert.notEqual(fetchingText(SCOPE_SCROLLBACK), fetchingText(SCOPE_SCREEN));
  // …and a call with no scope at all reads as the default, not as a blank.
  assert.equal(downloadLabel(undefined), downloadLabel(SCOPE_SCROLLBACK));
  assert.match(downloadLabel(SCOPE_SCROLLBACK), /buffer/i);
  assert.match(downloadLabel(SCOPE_SCREEN), /screen/i);
});
