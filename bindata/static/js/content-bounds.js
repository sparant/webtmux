// content-bounds — "show the content, not the blank screen".
//
// A tmux window is a fixed cols×rows grid, and a TUI that draws nine rows of a
// sixty-row window leaves fifty-one rows of nothing. Every preview surface we have
// (PiP tiles, Exposé thumbnails, the hover preview) scales that WHOLE grid to fit
// its frame, so most of the pixels go to the nothing and the part you actually
// wanted to read comes out a few pixels tall.
//
// Nothing can be done about that upstream. Re-rendering the window at a smaller
// size means resizing the real tmux client, which reflows what everyone attached
// to it is looking at — a preview must never touch the thing it is previewing. So
// the fix is entirely on this side of the wire: find the rectangle the window
// actually drew in, and scale THAT into the frame instead of the grid. The capture
// is unchanged, the window is unchanged; only the crop of the picture moves.
//
// Three pieces, deliberately separate so the policy is testable without a browser:
//
//   terminalContentBox()  where the ink is        — reads an xterm buffer
//   cropBox()             what to show of it      — pure policy (pad, zoom floor)
//   fitTransform()        how to put it in a frame— pure geometry
//   CropTracker           when to change it       — pure hysteresis over time
//
// No imports: this file loads under `node --test` as-is.

// How many blank cells to keep around the content. A crop flush against the ink
// reads as a rendering bug; one cell of margin reads as a small screen.
export const CROP_PAD = 1;

// The most a crop may magnify the content beyond what the uncropped grid would
// get. Without a ceiling, a window showing a single shell prompt would zoom that
// one line to fill the tile — technically "just the content", and useless: you
// lose all sense of which window you are looking at, and every idle window's
// thumbnail becomes a giant `$`. 4× is enough to rescue a nine-row TUI in a
// sixty-row window (the case this exists for) without turning a prompt into a
// billboard.
export const MAX_ZOOM = 4;

// Above this fraction of the grid in BOTH axes, don't crop at all. The crop would
// be a rounding difference nobody can see, and not cropping keeps the transform
// byte-identical to the pre-crop behaviour for the ordinary full-screen window.
export const NEAR_FULL = 0.9;

// Hysteresis: grow the crop the instant content appears outside it, but wait this
// long before shrinking it back. See CropTracker for why the two are not symmetric.
export const SHRINK_AFTER_MS = 2000;

// A shrink smaller than this many cells isn't worth re-scaling for — it would just
// make the preview breathe in and out as a status line comes and goes.
export const SHRINK_SLACK = 2;

// ---- where the ink is --------------------------------------------------------

// True when a cell contributes nothing visible.
//
// A blank is not just "a space": TUIs draw bars, gauges, selected rows and status
// lines as SPACES WITH A BACKGROUND, and a progress bar cropped off because it
// holds no characters is exactly the content the caller asked to zoom in on. So a
// non-default background counts as ink, and so does reverse video (which paints
// the foreground colour into the cell whatever the background says).
function isBlankCell(cell) {
  const chars = cell.getChars();
  if (chars && chars !== ' ') return false;
  if (!cell.isBgDefault()) return false;
  if (cell.isInverse()) return false;
  return true;
}

// The bounding box, in CELLS, of everything a terminal has actually drawn.
// Returns null for an entirely blank screen (there is nothing to crop TO) or for a
// terminal we can't read.
//
// Reads the buffer rather than the ANSI we wrote, because the buffer is the thing
// on screen: it has already resolved wrapping, wide characters, overdraw and the
// clear that precedes every repaint. Costs one pass over cols×rows cells per
// capture — a few thousand array reads on the 500ms poll, well under the cost of
// the xterm write that precedes it.
export function terminalContentBox(term) {
  const buf = term && term.buffer && term.buffer.active;
  const cols = term ? term.cols | 0 : 0;
  const rows = term ? term.rows | 0 : 0;
  if (!buf || !cols || !rows) return null;
  // Preview terminals run scrollback: 0, so baseY is 0 — but read it anyway rather
  // than assume, so this stays correct if a caller ever points it at a real region.
  const base = buf.baseY || 0;
  let x0 = cols;
  let x1 = -1;
  let y0 = rows;
  let y1 = -1;
  let cell;
  for (let y = 0; y < rows; y++) {
    const line = buf.getLine(base + y);
    if (!line) continue;
    let first = -1;
    let last = -1;
    for (let x = 0; x < cols; x++) {
      cell = line.getCell(x, cell);
      if (!cell || isBlankCell(cell)) continue;
      if (first < 0) first = x;
      // A wide character occupies the cell it reports plus the zero-width one after
      // it; count the whole glyph or the crop clips its right half.
      last = x + Math.max(1, cell.getWidth()) - 1;
    }
    if (first < 0) continue;
    if (first < x0) x0 = first;
    if (last > x1) x1 = last;
    if (y < y0) y0 = y;
    y1 = y;
  }
  if (x1 < 0) return null;
  return {
    col: x0,
    row: y0,
    cols: Math.min(cols - 1, x1) - x0 + 1,
    rows: y1 - y0 + 1,
  };
}

// ---- what to show of it ------------------------------------------------------

// Widen/heighten a box to at least minCols×minRows, keeping it centred on what it
// already holds and clamped inside the grid.
function growTo(box, minCols, minRows, gridCols, gridRows) {
  let { col, row, cols, rows } = box;
  if (cols < minCols) {
    const want = Math.min(minCols, gridCols);
    col = Math.max(0, Math.min(gridCols - want, col - Math.floor((want - cols) / 2)));
    cols = want;
  }
  if (rows < minRows) {
    const want = Math.min(minRows, gridRows);
    row = Math.max(0, Math.min(gridRows - want, row - Math.floor((want - rows) / 2)));
    rows = want;
  }
  return { col, row, cols, rows };
}

// The rectangle a preview should actually show, given where the ink is.
// Returns null for "show the whole grid" — no ink, or so nearly full that cropping
// would change nothing.
export function cropBox(content, gridCols, gridRows, opts = {}) {
  const pad = opts.pad === undefined ? CROP_PAD : opts.pad;
  const maxZoom = opts.maxZoom === undefined ? MAX_ZOOM : opts.maxZoom;
  const nearFull = opts.nearFull === undefined ? NEAR_FULL : opts.nearFull;
  if (!content || !gridCols || !gridRows) return null;
  if (!content.cols || !content.rows) return null;

  const left = Math.min(pad, content.col);
  const top = Math.min(pad, content.row);
  const right = Math.min(pad, gridCols - (content.col + content.cols));
  const bottom = Math.min(pad, gridRows - (content.row + content.rows));
  let box = {
    col: content.col - left,
    row: content.row - top,
    cols: content.cols + left + right,
    rows: content.rows + top + bottom,
  };

  // The zoom floor. Magnification is bounded by the ratio of grid to box in each
  // axis, so holding the box to gridN/maxZoom holds the zoom to maxZoom.
  box = growTo(
    box,
    Math.ceil(gridCols / maxZoom),
    Math.ceil(gridRows / maxZoom),
    gridCols,
    gridRows,
  );

  if (box.cols >= gridCols * nearFull && box.rows >= gridRows * nearFull) return null;
  return box;
}

// ---- how to put it in a frame ------------------------------------------------

// The CSS transform that letterboxes `box` into a frame, for a screen element that
// is exactly the grid's size and anchored top-left (`transform-origin: top left`).
//
// Order matters: `scale(k) translate(tx, ty)` translates in the element's OWN
// unscaled coordinates and then scales the result, so the offsets are plain cell
// arithmetic — no measuring the element after a transform is already on it, which
// is the feedback loop that makes this kind of code drift a pixel per frame.
//
// A null box means the whole grid, and yields the same `scale(k) translate(0,0)`
// the surfaces did before any of this existed.
export function fitTransform(spec) {
  const {
    box, gridCols, gridRows, screenW, screenH, frameW, frameH,
  } = spec;
  const gc = gridCols || 1;
  const gr = gridRows || 1;
  const cw = (screenW || 1) / gc;
  const ch = (screenH || 1) / gr;
  const b = box || { col: 0, row: 0, cols: gc, rows: gr };
  const bw = Math.max(1, b.cols * cw);
  const bh = Math.max(1, b.rows * ch);
  const scale = Math.min((frameW || 1) / bw, (frameH || 1) / bh);
  // `-0` is a real value in JS and it propagates into comparisons callers make;
  // an offset of nothing is 0.
  const tx = b.col ? -b.col * cw : 0;
  const ty = b.row ? -b.row * ch : 0;
  return { scale, tx, ty, css: `scale(${scale}) translate(${tx}px, ${ty}px)` };
}

// ---- when to change it -------------------------------------------------------

function norm(box, gridCols, gridRows) {
  if (!box) return { col: 0, row: 0, cols: gridCols, rows: gridRows };
  return { col: box.col, row: box.row, cols: box.cols, rows: box.rows };
}

function contains(outer, inner) {
  return inner.col >= outer.col
    && inner.row >= outer.row
    && inner.col + inner.cols <= outer.col + outer.cols
    && inner.row + inner.rows <= outer.row + outer.rows;
}

function union(a, b) {
  const col = Math.min(a.col, b.col);
  const row = Math.min(a.row, b.row);
  return {
    col,
    row,
    cols: Math.max(a.col + a.cols, b.col + b.cols) - col,
    rows: Math.max(a.row + a.rows, b.row + b.rows) - row,
  };
}

function smallerBy(cur, want, slack) {
  return (cur.cols - want.cols) >= slack || (cur.rows - want.rows) >= slack;
}

export function sameBox(a, b) {
  if (!a || !b) return a === b;
  return a.col === b.col && a.row === b.row && a.cols === b.cols && a.rows === b.rows;
}

// Decides which crop to APPLY, given the one measured from the latest capture.
//
// Captures land every 500ms, and the ink moves on most of them — a spinner line
// appears, a log line scrolls in, a status bar comes and goes. Following the
// measurement frame-for-frame would re-scale the preview twice a second, and a
// thumbnail that breathes is worse than one that wastes space. So the two
// directions are deliberately asymmetric:
//
//   GROW immediately. Content outside the crop is content the user cannot see, and
//   "wait two seconds before showing you the line that just printed" is not a
//   trade anyone would take. Grows to the UNION, so the box only ever has to
//   expand once for content that arrives in pieces.
//
//   SHRINK late, and only when it is worth it. A shrink is pure cosmetics — nothing
//   is hidden by a crop that is too big — so it waits for the content to STAY small
//   (the pending target unions everything seen while waiting, so one tall frame
//   during the wait cancels the shrink), and ignores changes below `slack` cells.
//
// One tracker per previewed window; the caller keeps it alive across captures.
export class CropTracker {
  constructor(opts = {}) {
    this.shrinkAfterMs = opts.shrinkAfterMs === undefined ? SHRINK_AFTER_MS : opts.shrinkAfterMs;
    this.slack = opts.slack === undefined ? SHRINK_SLACK : opts.slack;
    this.current = null;
    this.gridCols = 0;
    this.gridRows = 0;
    this._pending = null;
    this._pendingSince = 0;
  }

  // box: the crop measured from this capture (null = the whole grid).
  // Returns the box to apply, always a concrete rectangle.
  update(box, gridCols, gridRows, now = Date.now()) {
    const want = norm(box, gridCols, gridRows);
    // A geometry change (the window was resized) invalidates everything we were
    // holding: the old box is in cells that no longer mean the same thing.
    if (!this.current || this.gridCols !== gridCols || this.gridRows !== gridRows) {
      this.gridCols = gridCols;
      this.gridRows = gridRows;
      this._reset(want);
      return this.current;
    }
    if (!contains(this.current, want)) {
      this._reset(union(this.current, want));
      return this.current;
    }
    if (!smallerBy(this.current, want, this.slack)) {
      this._pending = null;
      this._pendingSince = 0;
      return this.current;
    }
    this._pending = this._pending ? union(this._pending, want) : want;
    if (!this._pendingSince) this._pendingSince = now;
    if (now - this._pendingSince >= this.shrinkAfterMs) this._reset(this._pending);
    return this.current;
  }

  _reset(box) {
    this.current = box;
    this._pending = null;
    this._pendingSince = 0;
  }
}

// ---- the plain-text variant --------------------------------------------------

// The same idea for Exposé's overflow tiles, which are a <pre> of stripped text
// rather than a terminal: there is no scaling to do, so "crop" just means don't
// spend the tile's first lines on blank ones. Drops leading/trailing blank rows and
// any blank left margin every row shares.
export function trimBlankMargins(text) {
  const lines = String(text == null ? '' : text).split('\n');
  let top = 0;
  let bot = lines.length;
  while (top < bot && !lines[top].trim()) top++;
  while (bot > top && !lines[bot - 1].trim()) bot--;
  const body = lines.slice(top, bot);
  if (!body.length) return '';
  let indent = Infinity;
  for (const l of body) {
    if (!l.trim()) continue;
    indent = Math.min(indent, l.length - l.trimStart().length);
  }
  if (!Number.isFinite(indent) || indent <= 0) return body.join('\n');
  return body.map((l) => l.slice(indent)).join('\n');
}
