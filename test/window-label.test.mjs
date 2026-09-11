// Unit tests for window-label.js — the short name a window goes by on a recents tab
// AND on a preview tile's label strip, shaped by the Recent ▾ "Labels" toggles.
// Run with:
//
//     node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LABEL_DEFAULTS, labelPrefs, trimWindowName, windowLabel,
} from '../resources/js/window-label.js';

test('defaults: session hidden, name trimmed', () => {
  assert.deepEqual(LABEL_DEFAULTS, { showSession: false, trimName: true });
  assert.deepEqual(labelPrefs({}), LABEL_DEFAULTS);
  assert.deepEqual(labelPrefs(undefined), LABEL_DEFAULTS);
});

test('stored prefs are read from the toolbar section; anything but true is off', () => {
  assert.deepEqual(labelPrefs({ recentShowSession: true, recentTrimName: false }),
    { showSession: true, trimName: false });
  assert.deepEqual(labelPrefs({ recentShowSession: 'yes', recentTrimName: 1 }),
    { showSession: false, trimName: false });
});

test('trimWindowName drops through the first space, and only when something is left', () => {
  assert.equal(trimWindowName('ssh web-01'), 'web-01');
  assert.equal(trimWindowName('claude fix the thing'), 'fix the thing');
  assert.equal(trimWindowName('editor'), 'editor');
  assert.equal(trimWindowName('ssh '), 'ssh ');
  assert.equal(trimWindowName(''), '');
});

test('windowLabel follows both toggles', () => {
  const w = { session: 'services', name: 'ssh web-01' };
  assert.equal(windowLabel(w, { showSession: false, trimName: true }), 'web-01');
  assert.equal(windowLabel(w, { showSession: false, trimName: false }), 'ssh web-01');
  assert.equal(windowLabel(w, { showSession: true, trimName: true }), 'services: web-01');
  assert.equal(windowLabel(w, { showSession: true, trimName: false }), 'services: ssh web-01');
});

test('windowLabel: an untrimmed nameless window is "bash"; no session means no prefix', () => {
  assert.equal(windowLabel({ session: 'dev' }, { showSession: false, trimName: false }), 'bash');
  assert.equal(windowLabel({ name: 'ssh x' }, { showSession: true, trimName: true }), 'x');
});
