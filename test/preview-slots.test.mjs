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
  placeWindow, tileControls, winsFromState, barWins, dropInBar,
  PREVIEW_DRAG_TYPE, previewDragPayload, parsePreviewDrag, carriesPreviewDrag,
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

// ---- drag to place: the bar's ORDER ------------------------------------------
//
// The bar draws its tiles in set order and nothing reshuffles them, so that order is
// the user's to arrange. dropInBar is where a pointer's answer — an insertion gap
// among the tiles the bar is drawing NOW — becomes a new set. Two things it must get
// right are invisible in the happy case: the gap-to-slot translation (removing the
// dragged tile shifts its followers down one), and the corner entries that share the
// array with the bar tiles but have no tile in it.
const ids = (wins) => wins.map((x) => x.windowId);
const bar = (wins) => wins.filter((x) => x.slot === BAR).map((x) => x.windowId);

test('a bar tile dropped in an earlier gap lands in it', () => {
  const wins = [w('@1'), w('@2'), w('@3')];
  assert.deepEqual(bar(dropInBar(wins, '@3', 0)), ['@3', '@1', '@2']);
  assert.deepEqual(bar(dropInBar(wins, '@3', 1)), ['@1', '@3', '@2']);
});

test('…and one dropped in a LATER gap accounts for its own removal', () => {
  // Gap 2 means "between @2 and @3" while @1 is still drawn. Taking @1 out first
  // shifts @2 and @3 down one, so the final slot is 1 — not 2, which would put @1
  // past @3 and make the drop land one tile further than the line promised.
  const wins = [w('@1'), w('@2'), w('@3')];
  assert.deepEqual(bar(dropInBar(wins, '@1', 2)), ['@2', '@1', '@3']);
  assert.deepEqual(bar(dropInBar(wins, '@1', 3)), ['@2', '@3', '@1']);
});

test('a drop that changes nothing is a no-op, not a new set', () => {
  const wins = [w('@1'), w('@2'), w('@3')];
  assert.equal(dropInBar(wins, '@2', 1), null);   // the gap it already sits in
  assert.equal(dropInBar(wins, '@2', 2), null);   // …and the one just after it
  assert.equal(dropInBar([w('@1')], '@1', 0), null);
  assert.equal(dropInBar([w('@1')], '@1', 9), null);
});

test('a gap past the end is the end, and a negative one is the front', () => {
  const wins = [w('@1'), w('@2'), w('@3')];
  assert.deepEqual(bar(dropInBar(wins, '@1', 99)), ['@2', '@3', '@1']);
  assert.deepEqual(bar(dropInBar(wins, '@3', -5)), ['@3', '@1', '@2']);
});

test('a drag that names no window, or no gap, moves nothing', () => {
  const wins = [w('@1'), w('@2')];
  assert.equal(dropInBar(wins, '@nope', 0), null);
  assert.equal(dropInBar(wins, '@1', undefined), null);
  assert.equal(dropInBar(wins, '@1', NaN), null);
  assert.equal(dropInBar(null, '@1', 0), null);
});

test('reordering the bar leaves the pinned windows pinned', () => {
  const wins = [w('@1'), w('@2', 'tl'), w('@3'), w('@4', 'br'), w('@5')];
  const out = dropInBar(wins, '@5', 0);
  assert.deepEqual(bar(out), ['@5', '@1', '@3']);
  assert.deepEqual(slots(out), { '@1': BAR, '@2': 'tl', '@3': BAR, '@4': 'br', '@5': BAR });
});

test('…and does not renumber them: they hold their own places in the set', () => {
  // The array is what the persisted blob stores, so a corner entry that slides around
  // while the bar is rearranged would make "unpin it later" land somewhere arbitrary.
  const wins = [w('@1'), w('@2', 'tl'), w('@3')];
  assert.deepEqual(ids(dropInBar(wins, '@3', 0)), ['@3', '@1', '@2']);
  assert.equal(dropInBar(wins, '@3', 0)[2].slot, 'tl');
});

test('a corner box dropped into the bar docks AT the gap it was dropped in', () => {
  const wins = [w('@1'), w('@2'), w('@3', 'tr')];
  assert.deepEqual(bar(dropInBar(wins, '@3', 0)), ['@3', '@1', '@2']);
  assert.deepEqual(bar(dropInBar(wins, '@3', 1)), ['@1', '@3', '@2']);
  assert.deepEqual(bar(dropInBar(wins, '@3', 2)), ['@1', '@2', '@3']);
});

test('…with no gap-shift applied to it — it was drawing no tile to remove', () => {
  // The translation that a moving BAR tile needs is exactly wrong for a corner box:
  // gap 2 with two tiles drawn means "after both", and shifting it down would drop
  // the box between them.
  const wins = [w('@1'), w('@2'), w('@3', 'tr')];
  assert.deepEqual(bar(dropInBar(wins, '@3', 2)), ['@1', '@2', '@3']);
});

test('a corner box dropped into an EMPTY bar simply joins it', () => {
  const wins = [w('@1', 'tl'), w('@2', 'br')];
  const out = dropInBar(wins, '@2', 0);
  assert.deepEqual(bar(out), ['@2']);
  assert.deepEqual(slots(out), { '@1': 'tl', '@2': BAR });
});

test('an end-gap drop lands after the last TILE, not after the last entry', () => {
  // '@3' is pinned and trails the bar in the array. The end gap means "after @2", and
  // stepping over @3 to the end of the array would be a different set on reload.
  const wins = [w('@1'), w('@2'), w('@3', 'tr')];
  const out = dropInBar(wins, '@1', 2);
  assert.deepEqual(bar(out), ['@2', '@1']);
  assert.deepEqual(ids(out), ['@2', '@1', '@3']);
});

test('the set handed in is never mutated', () => {
  const wins = [w('@1'), w('@2')];
  const out = dropInBar(wins, '@2', 0);
  assert.deepEqual(ids(wins), ['@1', '@2']);
  assert.notEqual(out, wins);
});

test('barWins is the bar in draw order, and only the bar', () => {
  const wins = [w('@1', 'tl'), w('@2'), w('@3'), w('@4', 'br')];
  assert.deepEqual(barWins(wins).map((x) => x.windowId), ['@2', '@3']);
  assert.deepEqual(barWins([]), []);
  assert.deepEqual(barWins(null), []);
  // An unknown slot is a bar tile everywhere else (normalizeSlot), so it is one here.
  assert.deepEqual(barWins([{ windowId: '@9', slot: 'nowhere' }]).map((x) => x.windowId), ['@9']);
});

test('a preview drag is recognised only by its own private type', () => {
  assert.equal(PREVIEW_DRAG_TYPE, 'application/x-webtmux-preview');
  assert.equal(previewDragPayload('@7'), '@7');
  assert.equal(parsePreviewDrag(previewDragPayload('@7')), '@7');
  assert.equal(parsePreviewDrag(''), null);
  assert.equal(parsePreviewDrag(null), null);
  assert.equal(carriesPreviewDrag({ types: [PREVIEW_DRAG_TYPE] }), true);
  // A recents tab dropped on the bar is a different gesture, and a dragged link is
  // nobody's — neither may light the bar up as a target.
  assert.equal(carriesPreviewDrag({ types: ['application/x-webtmux-recent'] }), false);
  assert.equal(carriesPreviewDrag({ types: ['text/plain'] }), false);
  assert.equal(carriesPreviewDrag(null), false);
  assert.equal(carriesPreviewDrag({}), false);
});
