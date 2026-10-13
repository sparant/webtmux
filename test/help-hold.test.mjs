// Unit tests for HelpHold — when the help overlay appears and goes away.
// Run with: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HelpHold } from '../resources/js/help-hold.js';

// A fake clock: setTimeout records, fire() runs everything due.
function fakeTimers() {
  let id = 0; const q = new Map();
  return {
    setTimeout(fn) { q.set(++id, fn); return id; },
    clearTimeout(i) { q.delete(i); },
    fire() { const fns = [...q.values()]; q.clear(); fns.forEach((f) => f()); },
    pending() { return q.size; },
  };
}
const ev = (key, mods = {}) => ({ key, ctrlKey: false, altKey: false, metaKey: false, ...mods });
const both = { ctrlKey: true, altKey: true };

function setup() {
  const t = fakeTimers();
  const modes = [];
  const h = new HelpHold((m) => modes.push(m), { timers: t });
  return { h, t, modes };
}
const press = (h) => { h.keydown(ev('Control', { ctrlKey: true })); h.keydown(ev('Alt', both)); };

test('holding the chord with no key shows the overlay after the delay', () => {
  const { h, t, modes } = setup();
  press(h);
  assert.equal(h.mode, null);
  t.fire();
  assert.equal(h.mode, 'hold');
  assert.deepEqual(modes, ['hold']);
});

test('releasing either modifier hides it', () => {
  const { h, t } = setup();
  press(h); t.fire();
  h.keyup(ev('Alt', { ctrlKey: true }));
  assert.equal(h.mode, null);
});

test('a hotkey during the hold cancels the pending reveal', () => {
  const { h, t } = setup();
  press(h);
  h.keydown(ev('f', { ...both, code: 'KeyF' }));
  t.fire();
  assert.equal(h.mode, null);
});

test('Shift does not cancel (it is half of ⇧I, ⇧N…)', () => {
  const { h, t } = setup();
  press(h);
  h.keydown(ev('Shift', { ...both, shiftKey: true }));
  t.fire();
  assert.equal(h.mode, 'hold');
});

test('a click during the hold cancels it', () => {
  const { h, t } = setup();
  press(h);
  h.pointerdown(ev(undefined, both));
  t.fire();
  assert.equal(h.mode, null);
});

test('hotkeys pressed while the overlay is up keep it up', () => {
  const { h, t } = setup();
  press(h); t.fire();
  h.keydown(ev('f', both));
  assert.equal(h.mode, 'hold');
});

test('releasing before the delay never shows it', () => {
  const { h, t } = setup();
  press(h);
  h.keyup(ev('Control', { altKey: true }));
  t.fire();
  assert.equal(h.mode, null);
});

test('Cmd and AltGr are not the chord', () => {
  const { h, t } = setup();
  h.keydown(ev('Alt', { ...both, metaKey: true }));
  t.fire();
  assert.equal(h.mode, null);
  h.keydown({ ...ev('Alt', both), getModifierState: (m) => m === 'AltGraph' });
  t.fire();
  assert.equal(h.mode, null);
});

test('blur and a modifier-less pointer move count as a release', () => {
  const { h, t } = setup();
  press(h); t.fire();
  h.blur();
  assert.equal(h.mode, null);
  press(h); t.fire();
  h.pointermove(ev(undefined, {}));
  assert.equal(h.mode, null);
});

test('sticky (first-run) mode survives a hotkey hold, dismissed by a clean tap', () => {
  const { h, t } = setup();
  h.showSticky();
  press(h); h.keydown(ev('f', both)); h.keyup(ev('Alt', { ctrlKey: true }));
  assert.equal(h.mode, 'sticky');
  press(h); h.keyup(ev('Alt', { ctrlKey: true }));
  assert.equal(h.mode, null);
  assert.equal(t.pending(), 0);
});
