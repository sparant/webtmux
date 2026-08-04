// Verification driver for shift-click "move the end of the selection I already
// have". What cannot be checked from node is the only part that matters: whether a
// real shift-press in a real browser re-selects from the ORIGINAL anchor — and does
// it in a pane where a program has grabbed the mouse, which is where xterm's own
// incremental-click path is switched off and where the press would otherwise be
// handed to the program, taking the pane out of copy mode and the highlight with it.
//
// Everything is asserted against the actual text of the line being selected, so a
// selection that lands a column or a row out fails rather than passes by looking
// roughly right.
//
// Each gesture group runs on a frame that is checked to have held still under it
// (see onStableFrame). That is not ceremony: a selection anchor is a BUFFER
// coordinate, so a pane that repaints between the drag and the shift-click moves
// the anchor's row out from under the assertion — which is a harness problem, and
// must not be reported as a failure of the thing under test.
//
// Run exactly like run.sh does, with DRIVER=verify-shift-extend.js.
const { chromium } = require('playwright');

const URL = 'http://localhost:8090/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let page;
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

// ---- reach-ins (same shape as verify-mousemode.js) ---------------------------

const unit = (fn, arg) => page.evaluate(([f, a]) => {
  const u = window.splitManager?.focusedUnit || window.webtmux;
  return eval(f)(u, a);
}, [fn.toString(), arg]);

const selection = () => unit((u) => u.terminal.getSelection());
const clearSel = () => unit((u) => { u.terminal.clearSelection(); u._selAnchor = null; });
const tracking = () => unit((u) => u.terminal.modes.mouseTrackingMode);
const inCopy = () => unit((u) => u.inCopyMode);
const cols = () => unit((u) => u.terminal.cols);

const screenText = () => unit((u) => {
  const b = u.terminal.buffer.active;
  const out = [];
  for (let i = 0; i < u.terminal.rows; i++) {
    const ln = b.getLine(b.viewportY + i);
    out.push(ln ? ln.translateToString(true) : '');
  }
  return out.join('\n');
});

const reportCount = async () => {
  const m = (await screenText()).match(/PRESSES:\s*(\d+)/);
  return m ? Number(m[1]) : -1;
};

async function typeLine(s) {
  await unit((u) => { u.terminal.focus(); });
  await page.keyboard.type(s);
  await page.keyboard.press('Enter');
  await sleep(600);
}

async function screenGeom() {
  const box = await page.locator('.xterm-screen').first().boundingBox();
  const rows = await unit((u) => u.terminal.rows);
  return { box, rows, cellH: box.height / rows };
}

// The viewport row of the last line containing `needle`, and the text of a row.
async function rowOf(needle) {
  const lines = (await screenText()).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].includes(needle)) return i;
  return -1;
}
async function lineAt(row) {
  return (await screenText()).split('\n')[row] ?? null;
}

// A point three quarters of the way into a cell. Selection endpoints land on the
// nearest column BOUNDARY (xterm's rule, and ours), so this is unambiguously "the
// boundary AFTER column `col`" — a click here takes that column with it.
const AFTER = 0.75;
const boundaryAt = (col) => col + 1;

async function pointAtCol(row, col) {
  const { box, cellH } = await screenGeom();
  const cellW = box.width / await cols();
  return { x: box.x + (col + AFTER) * cellW, y: box.y + row * cellH + cellH / 2 };
}

async function dragCols(row, fromCol, toCol) {
  const a = await pointAtCol(row, fromCol);
  const b = await pointAtCol(row, toCol);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await sleep(30);
  await page.mouse.move(b.x, b.y, { steps: 12 });
  await sleep(120);
  await page.mouse.up();
  await sleep(250);
}

async function shiftClickCol(row, col) {
  const p = await pointAtCol(row, col);
  await page.keyboard.down('Shift');
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await sleep(60);
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await sleep(350);   // longer than HOLD_MS, so a press that was NOT claimed has resolved
}

async function shiftDragCols(row, fromCol, toCol) {
  const a = await pointAtCol(row, fromCol);
  const b = await pointAtCol(row, toCol);
  await page.keyboard.down('Shift');
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await sleep(30);
  await page.mouse.move(b.x, b.y, { steps: 12 });
  await sleep(150);
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await sleep(300);
}

async function normalMode() {
  await unit((u) => { u.terminal.clearSelection(); u._selAnchor = null; if (u.inCopyMode) u.exitCopyMode(); });
  await sleep(500);
}

// Wait until the marker's line has stopped moving (two identical readings), then
// run `body` on it and confirm it is still there, unchanged, afterwards. A pane
// that repainted mid-gesture retries rather than reporting a false failure.
async function onStableFrame(marker, body, tries = 3) {
  for (let attempt = 0; attempt < tries; attempt++) {
    let row = -1, line = null;
    for (let i = 0; i < 10; i++) {
      const r = await rowOf(marker);
      const l = r < 0 ? null : await lineAt(r);
      if (r >= 0 && r === row && l === line) break;
      row = r; line = l;
      await sleep(500);
    }
    if (row < 0) continue;
    const out = await body({ row, line });
    if (out && await rowOf(marker) === row && await lineAt(row) === line) return out;
    console.log(`  (frame moved under the gesture — retrying, attempt ${attempt + 1})`);
  }
  return null;
}

// A line long enough to have a middle, with a distinct digit every ten columns so a
// failure reads as "it stopped in group 3" rather than "the strings differ".
const MARKER = 'EXTLINE';
const PRINT_LINE =
  `clear; { printf '${MARKER}'; for i in 1 2 3 4 5 6 7; do printf '%s' "$i-abcdefgh"; done; printf 'END\\n'; }`;

// ---- the run -----------------------------------------------------------------

async function main() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    httpCredentials: { username: 'wt', password: 'wt' },
  });
  page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await sleep(4000);

  await typeLine(PRINT_LINE);
  await sleep(1500);

  // ---- 1. a plain shell: xterm selects natively, and shift-click adjusts ------
  const one = await onStableFrame(MARKER, async ({ row, line }) => {
    await clearSel();
    await dragCols(row, 2, 12);
    const first = await selection();
    const start = line.indexOf(first);
    if (!first || start < 0) return null;
    await shiftClickCol(row, 30);
    const grown = await selection();
    await shiftClickCol(row, 45);          // the pivot must not creep towards the pointer
    const grown2 = await selection();
    await shiftClickCol(row, 20);          // overshooting is the common case
    const shrunk = await selection();
    await shiftClickCol(row, 0);           // past the anchor: turn around, don't empty
    const flipped = await selection();
    return { line, start, first, grown, grown2, shrunk, flipped };
  });

  if (!one) {
    check('a drag selects to begin with', false, 'the pane would not hold still');
  } else {
    const { line, start, first, grown, grown2, shrunk, flipped } = one;
    check('a drag selects to begin with', true, JSON.stringify(first));
    check('shift-click moves the END and keeps the anchor',
      grown === line.slice(start, boundaryAt(30)),
      `wanted ${JSON.stringify(line.slice(start, boundaryAt(30)))}, got ${JSON.stringify(grown)}`);
    check('...which means it grew from the same start', grown.startsWith(first), JSON.stringify(grown));
    check('a second shift-click still pivots on the original anchor',
      grown2 === line.slice(start, boundaryAt(45)),
      `wanted ${JSON.stringify(line.slice(start, boundaryAt(45)))}, got ${JSON.stringify(grown2)}`);
    check('shift-click can shorten the selection as well as grow it',
      shrunk === line.slice(start, boundaryAt(20)),
      `wanted ${JSON.stringify(line.slice(start, boundaryAt(20)))}, got ${JSON.stringify(shrunk)}`);
    check('shift-click before the anchor extends backwards',
      flipped === line.slice(boundaryAt(0), start),
      `wanted ${JSON.stringify(line.slice(boundaryAt(0), start))}, got ${JSON.stringify(flipped)}`);
  }

  // Held and dragged, the endpoint keeps following the pointer.
  const held = await onStableFrame(MARKER, async ({ row, line }) => {
    await clearSel();
    await dragCols(row, 2, 12);
    const first = await selection();
    const start = line.indexOf(first);
    if (!first || start < 0) return null;
    await shiftDragCols(row, 25, 40);
    return { line, start, moved: await selection() };
  });
  check('shift-DRAG keeps moving the same end',
    !!held && held.moved === held.line.slice(held.start, boundaryAt(40)),
    held ? `wanted ${JSON.stringify(held.line.slice(held.start, boundaryAt(40)))}, got ${JSON.stringify(held.moved)}`
         : 'the pane would not hold still');

  // ---- 2. a selection made BACKWARDS anchors at its far end -------------------
  // The bug this catches is anchoring on whichever end sorts first: a leftward drag
  // started at the RIGHT, so extending it further left must keep the right end
  // still. Sorting would pin the left end and grow the selection the wrong way.
  const back = await onStableFrame(MARKER, async ({ row, line }) => {
    await clearSel();
    await dragCols(row, 50, 30);
    const sel = await selection();
    const start = line.indexOf(sel);
    if (!sel || start < 0) return null;
    await shiftClickCol(row, 10);
    return { line, end: start + sel.length, sel, after: await selection() };
  });
  check('a backwards drag selects', !!back, back ? JSON.stringify(back.sel) : 'the pane would not hold still');
  check('extending a backwards drag keeps the end it STARTED from',
    !!back && back.after === back.line.slice(boundaryAt(10), back.end),
    back ? `wanted ${JSON.stringify(back.line.slice(boundaryAt(10), back.end))}, got ${JSON.stringify(back.after)}`
         : 'the pane would not hold still');

  await normalMode();

  // ---- 3. over a program that has grabbed the mouse --------------------------
  // The case xterm's own shift-click cannot do at all (its selection service is
  // disabled there), and the case where a stray click costs you copy mode.
  await typeLine('bash /src/screenshots/harness/fake-tui.sh 1003 inplace');
  await sleep(2000);
  const grabbed = await tracking();
  check('the pane now holds the mouse', grabbed !== 'none', `mouseTrackingMode=${grabbed}`);
  if (grabbed === 'none') { await finish(browser); return; }

  const TUI_MARKER = 'SELECTME-CCCC';
  const grab = await onStableFrame(TUI_MARKER, async ({ row, line }) => {
    await clearSel();
    await dragCols(row, 2, 12);
    const first = await selection();
    const start = line.indexOf(first);
    if (!first || start < 0) return null;
    const copyAfterDrag = await inCopy();
    const before = await reportCount();
    await shiftClickCol(row, 35);
    const after = await reportCount();
    return { line, start, first, copyAfterDrag, before, after,
             grown: await selection(), copyAfterShift: await inCopy() };
  });

  if (!grab) {
    check('a drag selects over the grabbing program', false, 'the pane would not hold still');
  } else {
    check('a drag selects over the grabbing program', true, JSON.stringify(grab.first));
    check('and that drag entered copy mode', grab.copyAfterDrag === true);
    check('shift-click extends over a mouse-grabbing program too',
      grab.grown === grab.line.slice(grab.start, boundaryAt(35)),
      `wanted ${JSON.stringify(grab.line.slice(grab.start, boundaryAt(35)))}, got ${JSON.stringify(grab.grown)}`);
    check('...without handing the program a press',
      grab.after === grab.before, `reports ${grab.before} -> ${grab.after}`);
    // The regression that makes the feature worth having: an ordinary click here is
    // the program's, and takes the pane out of copy mode (and the highlight with it).
    check('...and without dropping out of copy mode', grab.copyAfterShift === true);
  }

  // A shift press with NOTHING selected must fall through untouched: on Linux shift
  // is also xterm's force-selection modifier, so claiming it unconditionally would
  // break the shift-drag that selects over a grabbing program in the first place.
  const fresh = await onStableFrame(TUI_MARKER, async ({ row, line }) => {
    await clearSel();
    await shiftDragCols(row, 20, 40);
    const sel = await selection();
    return sel ? { line, sel } : null;
  });
  check('shift-drag with nothing selected still selects, as it always did',
    !!fresh && fresh.line.includes(fresh.sel),
    fresh ? JSON.stringify(fresh.sel) : 'nothing was selected');

  await normalMode();
  await finish(browser);
}

async function finish(browser) {
  await browser.close();
  const bad = results.filter((r) => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} passed`);
  process.exit(bad.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
