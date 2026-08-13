// Verification driver for "a preview does not leave a highlight on the window it
// borrowed".
//
// The bug: hovering a preview-bar tile shows that window's screen in a REAL region —
// the one you are working in — and the highlight you had made there was left exactly
// where it was. So a rectangle appeared over the previewed window's text (and ⌘C
// would have copied THAT), and when the preview let go the rectangle was still
// sitting on your own screen, over characters nobody chose. Over a mouse-grabbing
// program (Claude Code, vim, htop — anything asking for mouse reports) clicking
// about does not clear it either, so the only way out was entering and leaving tmux
// copy mode by hand.
//
// This is the same rule a window SWITCH already follows (viewLeftItsWindow, checked
// by verify-window-selection.js); the preview path was the one view change that
// skipped it. What cannot be checked from node is the part that matters: whether a
// real hover over a real docked bar, borrowing a real region with a real capture in
// it, ends the highlight — and whether a hover that shows nothing new leaves it be.
//
// Run exactly like run.sh does, with DRIVER=verify-preview-selection.js.
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');

const URL = 'http://localhost:8090/';
const SOCK = '/tmp/wt.sock';
const tmux = (...args) => execFileSync('tmux', ['-u', '-S', SOCK, ...args], { encoding: 'utf8' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let page;
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

// ---- navigation (same moves the other drivers make) --------------------------

const chord = (k) => page.keyboard.press(`Control+Alt+${k}`);

const exposeOpen = () => page.evaluate(() => !!document.querySelector('webtmux-expose')?.open);

async function closeExpose() {
  for (let i = 0; i < 4; i++) {
    if (!(await exposeOpen())) return;
    await page.keyboard.press('Escape');
    await sleep(400);
  }
}
async function openExpose() {
  await closeExpose();
  await chord('e');
  await sleep(700);
  if (!(await exposeOpen())) { await chord('e'); await sleep(700); }
  if (!(await exposeOpen())) throw new Error('expose did not open');
  // The type-ahead filter persists across close/reopen, so clear it before typing.
  for (let i = 0; i < 24; i++) await page.keyboard.press('Backspace');
  await sleep(400);
}
async function goTo(name) {
  await openExpose();
  await page.keyboard.type(name, { delay: 40 });
  await sleep(500);
  await page.keyboard.press('Enter');
  await sleep(1200);
  if (await exposeOpen()) { await closeExpose(); throw new Error(`goTo(${name}) did not commit`); }
  await sleep(900);
}

// ---- reach-ins ---------------------------------------------------------------

// Everything a highlight is made of, in the region the work is happening in. The
// PAINTED row count is the one that cannot be faked: xterm draws the rectangle as
// divs in .xterm-selection, and getSelection() alone reads '' for a selection over
// blank cells — which is exactly the stale rectangle this driver exists to catch.
const sel = () => page.evaluate(() => {
  const m = window.splitManager;
  const u = m?.focusedUnit || window.webtmux;
  const t = u?.terminal;
  const layer = u?.terminalEl?.querySelector('.xterm-selection');
  return {
    text: (t?.getSelection?.() || '').slice(0, 40),
    has: !!t?.hasSelection?.(),
    painted: layer ? layer.children.length : -1,
    anchor: u?._selAnchor || null,
    held: !!(m?.hover?.activeUnit && m.hover.activeUnit === u),
    previewing: !!u?.region?.classList?.contains('previewing'),
    hoverWin: m?.hover?.windowId || '',
    shown: m?._shownWindowId?.(u) || '',
  };
});

const idOf = (name) => page.evaluate((n) => {
  const all = window.splitManager?.focusedUnit?.layout?.allWindows || [];
  return (all.find((w) => w.name === n) || {}).id || null;
}, name);

const tileBox = (windowId) => page.evaluate((id) => {
  const root = document.querySelector('webtmux-pip')?.shadowRoot;
  const t = id ? root?.querySelector(`.ptile[data-window="${id}"]`) : root?.querySelector('.ptile');
  if (!t) return null;
  const r = t.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}, windowId);

async function screenGeom() {
  const box = await page.locator('.xterm-screen').first().boundingBox();
  const dims = await page.evaluate(() => {
    const t = (window.splitManager?.focusedUnit || window.webtmux).terminal;
    return { rows: t.rows, cols: t.cols };
  });
  return { box, cellH: box.height / dims.rows, cellW: box.width / dims.cols };
}

// Drag along one row of the working pane. The pane has a program grabbing the mouse,
// so this is the forced-selection path (mouse-mode.js), i.e. what a user actually
// does over Claude Code.
async function dragSelect(row = 2, fromCol = 2, toCol = 30) {
  const { box, cellH, cellW } = await screenGeom();
  const y = box.y + row * cellH + cellH / 2;
  await page.mouse.move(box.x + fromCol * cellW, y);
  await page.mouse.down();
  for (let c = fromCol + 4; c <= toCol; c += 6) {
    await page.mouse.move(box.x + c * cellW, y);
    await sleep(40);
  }
  await page.mouse.move(box.x + toCol * cellW, y);
  await page.mouse.up();
  await sleep(1200);
}

// Point at a tile long enough for the preview to open, sample, then leave and let
// the region come back.
async function hover(box) {
  await page.mouse.move(box.x, box.y);
  await sleep(400);
  await page.mouse.move(box.x + 3, box.y + 3);   // a real pointer jitters
  await sleep(1100);
  const during = await sel();
  await page.mouse.move(500, 600);
  await sleep(2500);
  return { during, after: await sel() };
}

async function main() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 950 },
    httpCredentials: { username: 'wt', password: 'wt' },
  });
  page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.log('  [page error]', m.text()); });
  await page.goto(URL);
  await page.waitForSelector('.xterm', { timeout: 30000 });
  await sleep(3000);

  // The working window: a Claude-Code-shaped TUI — alternate screen, 1003 any-event
  // mouse reporting, repainting in place. Selecting in it goes through the forced
  // path, and a press can never clear the highlight afterwards, which is what made
  // the stale rectangle stick.
  tmux('new-window', '-t', 'dev', '-n', 'claude', '/src/screenshots/harness/fake-tui.sh 1003 inplace');
  await sleep(2500);

  // A previous run's preview rides the shared @wt_state blob, so start from empty.
  // The sidebar defaults to a right-edge hover overlay and would sit ON TOP of a
  // right-docked bar, eating every hover.
  await page.evaluate(() => {
    const m = window.splitManager;
    for (const id of [...m.pip.windowIds()]) m.pip.removeWindow(id);
    m.pip.setHidden(false);
    for (const sb of document.querySelectorAll('webtmux-sidebar')) { sb.collapsed = true; sb.overlay = true; }
  });
  await sleep(600);

  // Two other windows in the preview -> bar mode, docked right (the reported setup).
  await goTo('tests');
  await chord('i');
  await sleep(600);
  await goTo('server');
  await chord('i');
  await sleep(600);
  await page.evaluate(() => document.querySelector('webtmux-pip')?.setEdge?.('right'));
  await sleep(800);

  await goTo('claude');
  await sleep(2500);

  const testsId = await idOf('tests');
  const claudeId = await idOf('claude');
  const pip = await page.evaluate(() => {
    const el = document.querySelector('webtmux-pip');
    return { mode: el?.mode, edge: el?.edge, wins: el?.windowIds?.() };
  });
  console.log(`preview: ${JSON.stringify(pip)}  tests=${testsId} claude=${claudeId}`);
  if (pip.mode !== 'bar' || pip.edge !== 'right') throw new Error('preview bar did not dock right');

  // ---- 1. a highlight exists to begin with ------------------------------------
  await dragSelect();
  const made = await sel();
  check('a drag over the mouse-grabbing pane makes a highlight',
    made.has && made.painted > 0,
    `painted=${made.painted} text=${JSON.stringify(made.text)}`);

  // ---- 2/3. the hover that borrows the region ---------------------------------
  const box = await tileBox(testsId);
  if (!box) throw new Error('no tile for the previewed window');
  const { during, after } = await hover(box);

  check('the hover really did borrow the working region',
    during.held && during.previewing && during.hoverWin === testsId,
    `held=${during.held} previewing=${during.previewing} hover=${during.hoverWin}`);
  check('nothing is highlighted over the previewed window',
    during.painted === 0 && !during.has,
    `painted=${during.painted} text=${JSON.stringify(during.text)}`);
  check('the highlight is not left behind when the region comes back',
    after.painted === 0 && !after.has && !after.anchor,
    `painted=${after.painted} text=${JSON.stringify(after.text)} anchor=${JSON.stringify(after.anchor)}`);
  check('the region is showing its own window again',
    !after.held && !after.previewing,
    `held=${after.held} previewing=${after.previewing}`);

  // ---- 4. the ghost: a hover with NOTHING selected paints nothing --------------
  // The highlight is gone by now, and every model in the terminal agrees. A resize
  // used to repaint its rectangle anyway, and the preview resizes the region it
  // borrows twice — so pointing at a thumbnail conjured the ghost of a selection
  // made minutes ago, with no selection behind it to clear.
  const ghost = await hover(box);
  check('a hover with nothing selected paints nothing',
    ghost.during.painted === 0 && ghost.after.painted === 0 && !ghost.after.has,
    `during=${ghost.during.painted} after=${ghost.after.painted}`);

  // ---- 5. the same, at the resize itself ---------------------------------------
  // The preview is only the loudest way in: the divider drag and a browser resize
  // reach the same repaint. Driven at the terminal because that is where the guard
  // now lives.
  const resized = await page.evaluate(async () => {
    const u = window.splitManager.focusedUnit;
    const t = u.terminal;
    const layer = () => u.terminalEl.querySelector('.xterm-selection')?.children.length ?? -1;
    // The layer is painted on a frame, not in the calling tick, so every reading
    // here waits for one — measured eagerly, even a real selection reads as unpainted.
    const settle = () => new Promise((r) => setTimeout(r, 300));
    const cols = t.cols, rows = t.rows;
    t.select(3, 3, 20);
    await settle();
    const withSel = layer();
    t.clearSelection();
    await settle();
    const cleared = layer();
    t.resize(cols + 20, rows - 1);
    await new Promise((r) => setTimeout(r, 400));
    const away = layer();
    t.resize(cols, rows);
    await new Promise((r) => setTimeout(r, 400));
    return { withSel, cleared, away, back: layer(), has: !!t.hasSelection() };
  });
  await sleep(600);
  check('a resize does not repaint a selection that is gone',
    resized.withSel > 0 && resized.cleared === 0 && resized.away === 0 && resized.back === 0,
    JSON.stringify(resized));

  // ---- 6. a hover that shows nothing new costs nothing -------------------------
  // The window the focused region is ALREADY on is in the preview too; pointing at
  // its tile draws nothing (rule 3 — it is on screen), so no screen is replaced and
  // the highlight must survive. This is the line between "a preview ended it" and
  // "a hover ended it".
  await chord('i');            // put the working window in the preview as well
  await sleep(800);
  await dragSelect(4, 2, 28);
  const before2 = await sel();
  check('a fresh highlight for the no-op hover', before2.has && before2.painted > 0,
    `painted=${before2.painted}`);

  const selfBox = await tileBox(claudeId);
  if (!selfBox) throw new Error('no tile for the focused window');
  const self = await hover(selfBox);
  check('pointing at the window you are already on leaves the highlight alone',
    !self.during.held && self.during.painted === before2.painted && self.after.painted === before2.painted,
    `held=${self.during.held} during=${self.during.painted} after=${self.after.painted}`);

  await page.screenshot({ path: '/src/screenshots/harness/.out/preview-selection.png' });
  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
