// Unit tests for the preview PLACEMENT model — which previewed window is drawn in the
// docked bar and which is pinned to a screen corner. Run with:
//
//     node --test test/
//
// preview-slots.js has no imports at all, so it loads cleanly under node; the component
// that consumes it (components/pip-overlay.js) imports lit and xterm and never could.
//
// These tests exist because the rules they pin down used to be EMERGENT rather than
// stated. The preview's shape was derived from the size of its set — one window meant a
// corner box, two meant a bar — so "a single window in the bar", "a second window in a
// second corner" and "this window back where it was" were not states the code could
// represent, let alone get wrong. Now they are, and each one below is a rule that would
// otherwise be free to regress silently.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BAR, CORNERS, normalizeSlot, cornerOccupancy, normalizeWins, freeCorner,
  placeWindow, tileControls, winsFromState,
} from '../resources/js/preview-slots.js';

// A preview-set entry, shaped like WebtmuxPip._wins.
const w = (windowId, slot = BAR) => ({ windowId, session: 'dev', slot });
const slots = (wins) => Object.fromEntries(wins.map((x) => [x.windowId, x.slot]));

test('an unknown slot falls back to the bar', () => {
  assert.equal(normalizeSlot('bar'), BAR);
  assert.equal(normalizeSlot('tl'), 'tl');
  assert.equal(normalizeSlot('middle'), BAR);
  assert.equal(normalizeSlot(undefined), BAR);
});

test('a single window can be a bar tile — the count no longer decides', () => {
  const wins = normalizeWins([w('@1', BAR)]);
  assert.deepEqual(slots(wins), { '@1': BAR });
  assert.equal(cornerOccupancy(wins).size, 0);
});

test('…and a single window can be a corner PiP', () => {
  const wins = normalizeWins([w('@1', 'br')]);
  assert.deepEqual(slots(wins), { '@1': 'br' });
  assert.equal(cornerOccupancy(wins).get('br'), '@1');
});

test('two windows can be pipped at once, in different corners', () => {
  const wins = normalizeWins([w('@1', 'tl'), w('@2', 'br')]);
  assert.deepEqual(slots(wins), { '@1': 'tl', '@2': 'br' });
  assert.equal(cornerOccupancy(wins).size, 2);
});

test('a corner holds ONE window — a doubled-up set sends the loser to the bar', () => {
  // Only reachable from a malformed/raced persisted blob; the controls never offer a
  // taken corner. Normalizing rather than drawing two boxes on top of each other.
  const wins = normalizeWins([w('@1', 'tl'), w('@2', 'tl'), w('@3', 'tl')]);
  assert.deepEqual(slots(wins), { '@1': 'tl', '@2': BAR, '@3': BAR });
});

test('freeCorner prefers the corner you last used, then reading order', () => {
  assert.equal(freeCorner([], 'br'), 'br');
  assert.equal(freeCorner([w('@1', 'br')], 'br'), 'tl');
  assert.equal(freeCorner([w('@1', 'tl'), w('@2', 'tr')], null), 'bl');
  assert.equal(freeCorner(CORNERS.map((c, i) => w(`@${i}`, c)), 'tl'), null);
});

test('placing a window in a taken corner bumps the occupant to the bar', () => {
  const wins = placeWindow([w('@1', 'tl'), w('@2', BAR)], '@2', 'tl');
  assert.deepEqual(slots(wins), { '@1': BAR, '@2': 'tl' });
});

test('a round trip to a corner and back keeps the window in its bar position', () => {
  // Bar tiles are drawn in set order. Sending the middle tile to a corner and back has
  // to put it back between its neighbours — a window that reappeared at the end would
  // reshuffle the bar every time you looked at one window closely.
  const start = [w('@1'), w('@2'), w('@3')];
  const out = placeWindow(placeWindow(start, '@2', 'tr'), '@2', BAR);
  assert.deepEqual(out.map((x) => x.windowId), ['@1', '@2', '@3']);
  assert.deepEqual(slots(out), { '@1': BAR, '@2': BAR, '@3': BAR });
});

test('placing a window leaves every other window alone', () => {
  const out = placeWindow([w('@1', 'tl'), w('@2', BAR), w('@3', 'br')], '@2', 'bl');
  assert.deepEqual(slots(out), { '@1': 'tl', '@2': 'bl', '@3': 'br' });
});

test('a bar tile offers all four corners and no "back to bar"', () => {
  const ctl = tileControls([w('@1', BAR)], '@1');
  assert.deepEqual(ctl.corners.map((c) => c.corner), CORNERS);
  assert.equal(ctl.corners.some((c) => c.active), false);
  assert.equal(ctl.toBar, false);
});

test('a corner tile marks its own corner active and offers the way back', () => {
  const ctl = tileControls([w('@1', 'tr')], '@1');
  assert.deepEqual(ctl.corners.filter((c) => c.active).map((c) => c.corner), ['tr']);
  assert.equal(ctl.toBar, true);
});

test('corners another window occupies are not offered at all', () => {
  // "if another window is pipped in a corner, we don't need the control to go there."
  const wins = [w('@1', 'tl'), w('@2', 'br'), w('@3', BAR)];
  assert.deepEqual(tileControls(wins, '@3').corners.map((c) => c.corner), ['tr', 'bl']);
  // …but the tile's OWN corner is still drawn, as the active one.
  assert.deepEqual(tileControls(wins, '@1').corners.map((c) => c.corner), ['tl', 'tr', 'bl']);
});

test('a window that is not in the preview has no controls', () => {
  assert.deepEqual(tileControls([w('@1')], '@nope'), { corners: [], toBar: false });
});

test('a legacy one-window blob restores as the corner box it was drawn as', () => {
  // Pre-slot state: no slot field, and the shape came from the count. One window WAS a
  // corner box at the shared pip.corner, so that is what the user is looking at and
  // what has to survive the upgrade.
  const wins = winsFromState({ corner: 'bl', wins: [{ windowId: '@1', session: 'dev' }] });
  assert.deepEqual(slots(wins), { '@1': 'bl' });
});

test('…defaulting to the top-right corner the old box defaulted to', () => {
  const wins = winsFromState({ wins: [{ windowId: '@1' }] });
  assert.deepEqual(slots(wins), { '@1': 'tr' });
});

test('a legacy multi-window blob restores as the bar it was drawn as', () => {
  const wins = winsFromState({ corner: 'bl', wins: [{ windowId: '@1' }, { windowId: '@2' }] });
  assert.deepEqual(slots(wins), { '@1': BAR, '@2': BAR });
});

test('a blob that already carries slots is taken as written', () => {
  const wins = winsFromState({
    corner: 'bl',
    wins: [{ windowId: '@1', slot: 'tr' }, { windowId: '@2', slot: BAR }],
  });
  assert.deepEqual(slots(wins), { '@1': 'tr', '@2': BAR });
});

test('junk in a persisted blob is dropped rather than drawn', () => {
  assert.deepEqual(winsFromState(null), []);
  assert.deepEqual(winsFromState({ wins: 'nope' }), []);
  assert.deepEqual(winsFromState({ wins: [null, { session: 'dev' }] }), []);
  assert.deepEqual(slots(winsFromState({ wins: [{ windowId: '@1', slot: 'nowhere' }] })), { '@1': BAR });
});
