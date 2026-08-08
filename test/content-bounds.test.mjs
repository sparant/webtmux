// Unit tests for content-bounds.js — the "show the content, not the blank screen"
// crop that PiP tiles, Exposé thumbnails and the hover preview all share. Run with:
//
//     node --test test/
//
// content-bounds.js has no imports at all, so it loads cleanly under node.
//
// Worth testing because every rule in here is a JUDGEMENT that only shows up as a
// bad picture: crop too tight and a progress bar loses its right end, crop too
// eagerly and an idle shell prompt becomes a billboard, follow the measurement
// frame-for-frame and the thumbnail breathes twice a second. None of that fails
// loudly — it just looks slightly wrong, forever.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  terminalContentBox, cropBox, fitTransform, CropTracker, sameBox, trimBlankMargins,
  MAX_ZOOM,
} from '../resources/js/content-bounds.js';

// ---- a fake xterm ------------------------------------------------------------
// Only the four buffer calls terminalContentBox makes. Screens are given as arrays
// of strings; a cell may also be given as an object to carry attributes:
//   { ch: ' ', bg: 4 }        a coloured blank (a bar, a gauge) — INK
//   { ch: ' ', inverse: 1 }   reverse video    — INK
//   { ch: '漢', width: 2 }    a wide glyph
function fakeTerm(screen, cols) {
  const rows = screen.length;
  const width = cols || Math.max(...screen.map((r) => r.length));
  const cellAt = (row, x) => {
    const raw = typeof row === 'string' ? row[x] : row[x];
    if (raw === undefined) return { ch: ' ' };
    return typeof raw === 'string' ? { ch: raw } : raw;
  };
  return {
    cols: width,
    rows,
    buffer: {
      active: {
        baseY: 0,
        getLine(y) {
          const row = screen[y];
          if (row === undefined) return undefined;
          return {
            getCell(x) {
              const c = cellAt(row, x);
              return {
                getChars: () => (c.ch === undefined ? ' ' : c.ch),
                getWidth: () => c.width || 1,
                isBgDefault: () => (c.bg ? 0 : 1),
                isInverse: () => (c.inverse ? 1 : 0),
              };
            },
          };
        },
      },
    },
  };
}

// ---- terminalContentBox ------------------------------------------------------

test('an empty screen has no content box', () => {
  assert.equal(terminalContentBox(fakeTerm(['    ', '    ', '    '])), null);
});

test('a content box is the bounding rectangle of the ink', () => {
  const term = fakeTerm([
    '          ',
    '   ab     ',
    '  c       ',
    '      d   ',
    '          ',
  ]);
  assert.deepEqual(terminalContentBox(term), { col: 2, row: 1, cols: 5, rows: 3 });
});

test('a blank cell with a background is ink — a bar is not blank space', () => {
  const bar = Array.from({ length: 6 }, () => ({ ch: ' ', bg: 4 }));
  const term = fakeTerm([
    '        ',
    [' ', ' ', ...bar],
    '        ',
  ], 8);
  assert.deepEqual(terminalContentBox(term), { col: 2, row: 1, cols: 6, rows: 1 });
});

test('reverse video counts as ink even with a default background', () => {
  const term = fakeTerm([
    '    ',
    [' ', { ch: ' ', inverse: 1 }, ' ', ' '],
  ], 4);
  assert.deepEqual(terminalContentBox(term), { col: 1, row: 1, cols: 1, rows: 1 });
});

test('a wide glyph is counted through both of its cells', () => {
  // A width-2 char at col 1 owns cols 1 AND 2; the box must not clip its right half.
  const term = fakeTerm([[' ', { ch: '漢', width: 2 }, { ch: '' }, ' ']], 4);
  assert.deepEqual(terminalContentBox(term), { col: 1, row: 0, cols: 2, rows: 1 });
});

test('a full screen of ink boxes the whole grid', () => {
  const term = fakeTerm(['abcd', 'efgh']);
  assert.deepEqual(terminalContentBox(term), { col: 0, row: 0, cols: 4, rows: 2 });
});

test('a terminal with no buffer yields no box rather than throwing', () => {
  assert.equal(terminalContentBox(null), null);
  assert.equal(terminalContentBox({ cols: 0, rows: 0 }), null);
});

// ---- cropBox -----------------------------------------------------------------

test('the crop pads the content by a cell on every side it can', () => {
  const box = cropBox({ col: 10, row: 10, cols: 20, rows: 20 }, 200, 60, { maxZoom: 100 });
  assert.deepEqual(box, { col: 9, row: 9, cols: 22, rows: 22 });
});

test('padding does not run off the grid', () => {
  const box = cropBox({ col: 0, row: 0, cols: 40, rows: 10 }, 200, 60, { maxZoom: 100 });
  assert.deepEqual(box, { col: 0, row: 0, cols: 41, rows: 11 });
});

test('the claude-limits case: a nine-row panel in a sixty-row window is cropped', () => {
  // The report this change came from: a TUI drawing ~78×9 into a 200×60 window.
  const box = cropBox({ col: 0, row: 0, cols: 78, rows: 9 }, 200, 60);
  // Rows are floored by the zoom ceiling (60/4 = 15), width is content + padding.
  assert.deepEqual(box, { col: 0, row: 0, cols: 79, rows: 15 });
  // …and that is a real magnification: 200/79 ≈ 2.5× more pixels per cell.
  assert.ok(200 / box.cols > 2.4);
});

test('a nearly-empty screen is floored so it cannot magnify past MAX_ZOOM', () => {
  const box = cropBox({ col: 0, row: 0, cols: 2, rows: 1 }, 200, 60);
  assert.ok(200 / box.cols <= MAX_ZOOM + 1e-9, 'width zoom within ceiling');
  assert.ok(60 / box.rows <= MAX_ZOOM + 1e-9, 'height zoom within ceiling');
});

test('the floor grows around the content, keeping it inside the grid', () => {
  // Content at the far right: the floored box must not start past the grid edge.
  const box = cropBox({ col: 197, row: 58, cols: 3, rows: 2 }, 200, 60);
  assert.ok(box.col >= 0 && box.col + box.cols <= 200);
  assert.ok(box.row >= 0 && box.row + box.rows <= 60);
  assert.equal(box.col + box.cols, 200);
});

test('a nearly-full screen is not cropped at all', () => {
  assert.equal(cropBox({ col: 0, row: 0, cols: 200, rows: 60 }, 200, 60), null);
  assert.equal(cropBox({ col: 0, row: 0, cols: 195, rows: 58 }, 200, 60), null);
});

test('no content means no crop', () => {
  assert.equal(cropBox(null, 200, 60), null);
  assert.equal(cropBox({ col: 0, row: 0, cols: 0, rows: 0 }, 200, 60), null);
});

// ---- fitTransform ------------------------------------------------------------

test('with no crop the transform is the plain letterbox scale it always was', () => {
  const t = fitTransform({
    box: null, gridCols: 100, gridRows: 50, screenW: 800, screenH: 800,
    frameW: 400, frameH: 200,
  });
  assert.equal(t.scale, 0.25);
  assert.equal(t.tx, 0);
  assert.equal(t.ty, 0);
  assert.equal(t.css, 'scale(0.25) translate(0px, 0px)');
});

test('a crop offsets by whole cells and scales the crop, not the grid', () => {
  // 100×50 grid drawn 800×500 => 8×10 px cells. Crop at (10,5), 50×10 cells
  // => 400×100 px, into a 400×200 frame => scale 1, shifted -80,-50.
  const t = fitTransform({
    box: { col: 10, row: 5, cols: 50, rows: 10 },
    gridCols: 100, gridRows: 50, screenW: 800, screenH: 500,
    frameW: 400, frameH: 200,
  });
  assert.equal(t.scale, 1);
  assert.equal(t.tx, -80);
  assert.equal(t.ty, -50);
});

test('a crop always fits inside the frame it was scaled for', () => {
  const box = { col: 3, row: 7, cols: 40, rows: 12 };
  const t = fitTransform({
    box, gridCols: 200, gridRows: 60, screenW: 1600, screenH: 1200,
    frameW: 300, frameH: 150,
  });
  const cw = 1600 / 200;
  const ch = 1200 / 60;
  assert.ok(box.cols * cw * t.scale <= 300 + 1e-9);
  assert.ok(box.rows * ch * t.scale <= 150 + 1e-9);
});

// ---- CropTracker -------------------------------------------------------------

const B = (col, row, cols, rows) => ({ col, row, cols, rows });

test('the first measurement is adopted as-is', () => {
  const t = new CropTracker();
  assert.deepEqual(t.update(B(0, 0, 40, 10), 200, 60, 0), B(0, 0, 40, 10));
});

test('content appearing outside the crop grows it on the very next frame', () => {
  const t = new CropTracker();
  t.update(B(0, 0, 40, 10), 200, 60, 0);
  // A line prints below and to the right: no waiting, and the union so a second
  // piece arriving next frame doesn't grow it twice.
  assert.deepEqual(t.update(B(0, 0, 90, 20), 200, 60, 100), B(0, 0, 90, 20));
});

test('a growth that only extends one axis keeps the other', () => {
  const t = new CropTracker();
  t.update(B(10, 0, 40, 10), 200, 60, 0);
  assert.deepEqual(t.update(B(0, 0, 20, 10), 200, 60, 100), B(0, 0, 50, 10));
});

test('a shrink waits, and only lands once the content has stayed small', () => {
  const t = new CropTracker({ shrinkAfterMs: 2000 });
  t.update(B(0, 0, 90, 30), 200, 60, 0);
  assert.deepEqual(t.update(B(0, 0, 40, 10), 200, 60, 500), B(0, 0, 90, 30), 'not yet');
  assert.deepEqual(t.update(B(0, 0, 40, 10), 200, 60, 1500), B(0, 0, 90, 30), 'still not');
  assert.deepEqual(t.update(B(0, 0, 40, 10), 200, 60, 2600), B(0, 0, 40, 10), 'now');
});

test('one tall frame during the wait cancels the shrink', () => {
  // The case this rule exists for: a status line that comes and goes. Without the
  // union, the crop would shrink the moment the line was briefly absent and grow
  // back when it returned — twice a second, forever.
  const t = new CropTracker({ shrinkAfterMs: 2000 });
  t.update(B(0, 0, 90, 30), 200, 60, 0);
  t.update(B(0, 0, 40, 10), 200, 60, 500);
  t.update(B(0, 0, 40, 28), 200, 60, 1000);        // the line is back
  assert.deepEqual(t.update(B(0, 0, 40, 10), 200, 60, 2600), B(0, 0, 40, 28));
});

test('a shrink smaller than the slack is ignored entirely', () => {
  const t = new CropTracker({ shrinkAfterMs: 2000, slack: 2 });
  t.update(B(0, 0, 90, 30), 200, 60, 0);
  for (const at of [500, 1500, 5000, 9000]) {
    assert.deepEqual(t.update(B(0, 0, 89, 29), 200, 60, at), B(0, 0, 90, 30));
  }
});

test('a window resize throws the held crop away rather than reinterpreting it', () => {
  const t = new CropTracker();
  t.update(B(0, 0, 90, 30), 200, 60, 0);
  assert.deepEqual(t.update(B(0, 0, 40, 10), 100, 30, 100), B(0, 0, 40, 10));
});

test('a null box tracks as the whole grid', () => {
  const t = new CropTracker();
  assert.deepEqual(t.update(null, 200, 60, 0), B(0, 0, 200, 60));
});

test('sameBox compares by value, and treats nulls as equal', () => {
  assert.ok(sameBox(null, null));
  assert.ok(sameBox(B(1, 2, 3, 4), B(1, 2, 3, 4)));
  assert.ok(!sameBox(null, B(1, 2, 3, 4)));
  assert.ok(!sameBox(B(1, 2, 3, 4), B(1, 2, 3, 5)));
});

// ---- trimBlankMargins --------------------------------------------------------

test('blank rows above and below a plain-text preview are dropped', () => {
  assert.equal(trimBlankMargins('\n\n  hi\n\n\n'), 'hi');
});

test('a blank left margin every row shares is dropped', () => {
  assert.equal(trimBlankMargins('    a\n    bb\n     c'), 'a\nbb\n c');
});

test('a margin only some rows have is kept — it is layout, not padding', () => {
  assert.equal(trimBlankMargins('a\n    b'), 'a\n    b');
});

test('an all-blank preview trims to nothing', () => {
  assert.equal(trimBlankMargins('\n   \n\n'), '');
  assert.equal(trimBlankMargins(''), '');
  assert.equal(trimBlankMargins(null), '');
});

test('interior blank rows are kept', () => {
  assert.equal(trimBlankMargins('a\n\nb'), 'a\n\nb');
});
