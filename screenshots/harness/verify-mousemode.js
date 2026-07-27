// Verification driver for the mouse click/drag mode (app / buf / auto / auto+ under
// "click+drag:" in the toolbar's mouse-capture dropdown). The claim under test cannot be checked from source or from node: it is
// that a click-and-drag SELECTS TEXT over a program that has grabbed the mouse,
// which depends on how xterm 5.5 actually routes a re-dispatched press.
//
// So the pane is made to grab the mouse for real — `printf '\e[?1000h\e[?1006h'`
// then `cat -v`, which prints every mouse report it receives as visible text. That
// gives both halves of the question one observable each:
//   • did the BUFFER get it?  -> terminal.getSelection() is non-empty
//   • did the PROGRAM get it? -> a new ^[[< report appears on screen
//
// Run exactly like run.sh does, with DRIVER=verify-mousemode.js.
const { chromium } = require('playwright');

const URL = 'http://localhost:8090/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let page;
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

// ---- reach-ins ---------------------------------------------------------------

const unit = (fn, arg) => page.evaluate(([f, a]) => {
  const u = window.splitManager?.focusedUnit || window.webtmux;
  return eval(f)(u, a);
}, [fn.toString(), arg]);

const toolbar = (fn, arg) => page.evaluate(([f, a]) => {
  const el = document.querySelector('webtmux-toolbar');
  return eval(f)(el, el.shadowRoot, a);
}, [fn.toString(), arg]);

const selection = () => unit((u) => u.terminal.getSelection());
const clearSel = () => unit((u) => { u.terminal.clearSelection(); });
const tracking = () => unit((u) => u.terminal.modes.mouseTrackingMode);
const mouseMode = () => unit((u) => u.mouseMode);
const inCopy = () => unit((u) => u.inCopyMode);

// Everything on screen, so a mouse report the pane printed can be counted.
const screenText = () => unit((u) => {
  const b = u.terminal.buffer.active;
  const out = [];
  for (let i = 0; i < u.terminal.rows; i++) {
    const ln = b.getLine(b.viewportY + i);
    out.push(ln ? ln.translateToString(true) : '');
  }
  return out.join('\n');
});

// The TUI keeps running counts on a fixed row (see fake-tui.sh). BUTTON events are
// the observable that matters — mouse mode 1003 reports pointer motion with no
// button down, so merely moving to the target would otherwise read as "the program
// got the click".
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

// Geometry of the xterm screen, plus the y of a given viewport row.
async function screenGeom() {
  const box = await page.locator('.xterm-screen').first().boundingBox();
  const rows = await unit((u) => u.terminal.rows);
  return { box, rows, cellH: box.height / rows };
}

// The viewport row index of the last line containing `needle` — the target to drag
// across. Returns -1 when it isn't on screen.
async function rowOf(needle) {
  const lines = (await screenText()).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].includes(needle)) return i;
  return -1;
}

async function pointOnRow(row, frac) {
  const { box, cellH } = await screenGeom();
  return { x: box.x + box.width * frac, y: box.y + row * cellH + cellH / 2 };
}

// A real press-move-release, in enough steps that the drag threshold and the
// intermediate moves behave as they would under a hand.
async function dragAcross(row, fromFrac, toFrac) {
  const a = await pointOnRow(row, fromFrac);
  const b = await pointOnRow(row, toFrac);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await sleep(30);
  await page.mouse.move(b.x, b.y, { steps: 12 });
  await sleep(120);
  await page.mouse.up();
  await sleep(180);
}

async function clickOn(row, frac) {
  const a = await pointOnRow(row, frac);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await sleep(60);
  await page.mouse.up();
  await sleep(400);   // longer than HOLD_MS, so a swallowed press has resolved
}

// Pick `want` out of the mouse-capture dropdown. The two mode buttons became one
// button with a menu, so this opens it, clicks the row for the mode by its data-mode
// attribute, and closes it again by clicking the backdrop.
// Also leaves copy mode: selecting now enters it, so without this each section
// would inherit the previous one's mode and test something other than it means to.
async function setMouseMode(want) {
  if (await mouseMode() !== want) {
    await openMouseMenu();
    await toolbar((el, rr, w) => {
      const row = rr.querySelector(`.mouse-menu .mitem[data-kind="mouse"][data-mode="${w}"]`);
      if (row) row.click();
    }, want);
    await sleep(200);
    await closeMouseMenu();
  }
  await normalMode();
  return await mouseMode() === want;
}

// The dropdown's trigger is the only .tbtn.text left in the toolbar.
async function openMouseMenu() {
  const open = await toolbar((el, rr) => !!rr.querySelector('.mouse-menu'));
  if (!open) await toolbar((el, rr) => { rr.querySelector('.tbtn.text').click(); });
  await sleep(150);
  return await toolbar((el, rr) => !!rr.querySelector('.mouse-menu'));
}

// Via the backdrop, which is the affordance a user has — it is scoped to .mouse-wrap
// so it can never pick up the recents menu's identically-classed backdrop.
async function closeMouseMenu() {
  await toolbar((el, rr) => { rr.querySelector('.mouse-wrap .label-backdrop')?.click(); });
  await sleep(150);
}

// The closed trigger's own text — it shows both current modes, click+drag first.
const triggerText = () => toolbar((el, rr) => rr.querySelector('.tbtn.text').textContent);

// Back to a pane in normal mode with nothing highlighted.
async function normalMode() {
  await unit((u) => { u.terminal.clearSelection(); if (u.inCopyMode) u.exitCopyMode(); });
  await sleep(500);
}

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

  check('the two mode buttons are now ONE mouse-capture button',
    await toolbar((el, rr) => rr.querySelectorAll('.tbtn.text').length) === 1);
  check('it defaults to auto+', await mouseMode() === 'adaptive-probe', `got ${await mouseMode()}`);
  check('its label says so', (await triggerText()).includes('auto+'));
  check('its dropdown lists both gestures, four modes each', await (async () => {
    await openMouseMenu();
    const n = await toolbar((el, rr) => ({
      mouse: rr.querySelectorAll('.mouse-menu .mitem[data-kind="mouse"]').length,
      scroll: rr.querySelectorAll('.mouse-menu .mitem[data-kind="scroll"]').length,
      titles: [...rr.querySelectorAll('.mouse-menu .mtitle')].map((t) => t.textContent),
    }));
    await closeMouseMenu();
    return n.mouse === 4 && n.scroll === 4
      && n.titles.includes('click+drag:') && n.titles.includes('copymode on scroll:');
  })());

  // Quiet pane to work in, with a wide line of known text to drag across.
  await typeLine('clear; printf "SELECTME-%s\\n" AAAA BBBB CCCC DDDD EEEE FFFF');
  await sleep(500);

  // ---- 1. plain shell: nothing grabs the mouse, xterm selects natively --------
  // tmux's own `mouse on` reports the mouse even at a bare shell prompt, so what
  // counts as "nothing is grabbing it" depends on that option, not on the shell.
  const TMUX_MOUSE = process.env.WT_TMUX_MOUSE === 'on';
  check('a bare shell tracks the mouse only if tmux itself does',
    (await tracking() === 'none') !== TMUX_MOUSE, `mouse=${TMUX_MOUSE ? 'on' : 'off'}, got ${await tracking()}`);
  await clearSel();
  let row = await rowOf('SELECTME-CCCC');
  await dragAcross(row, 0.02, 0.30);
  let sel = await selection();
  // The drag starts a few columns in, so the selection is the tail of the marker.
  check('drag-selects in a plain shell (native path untouched)', /CTME-CCCC/.test(sel), JSON.stringify(sel));
  // The native path never re-dispatches anything, so copy mode has to be entered
  // by the drag tracking rather than as a side effect of the synthetic press.
  check('a plain-shell drag also enters copy mode', await inCopy() === true);
  await normalMode();

  // A second drag must be a FRESH selection, not an extension of the first — the
  // trap a blanket shift-synthesis would fall into (_handleIncrementalClick).
  await dragAcross(await rowOf('SELECTME-EEEE'), 0.02, 0.20);
  sel = await selection();
  check('a second drag starts over instead of extending the first',
    /EEEE/.test(sel) && !/CCCC/.test(sel), JSON.stringify(sel));

  // ---- 2. make the pane grab the mouse, like Claude/vim do -------------------
  await clearSel();
  // A REAL target: alternate screen + mouse tracking + a repainting status line.
  // The old stand-in (mouse tracking on the normal screen, static output) grabbed
  // the mouse but never repainted, and so never exercised the repaint tmux does on
  // the way into copy mode — which is exactly what was wiping the first drag.
  // Mouse mode 1003 (any-event) on purpose: it is what hover-aware TUIs like Claude
  // Code ask for, and the ONLY mode in which entering copy mode changes the mouse
  // PROTOCOL rather than just switching it off — which is what made xterm clear the
  // selection mid-drag. 1000/1002 never reproduced the bug. Repaint by scrolling for
  // the same reason: be the hard case, not the convenient one.
  await typeLine('bash /src/screenshots/harness/fake-tui.sh 1003 inplace');
  await sleep(1600);
  const grabbed = await tracking();
  check('the pane now holds the mouse', grabbed !== 'none', `mouseTrackingMode=${grabbed}`);
  if (grabbed === 'none') { await finish(browser); return; }

  row = await rowOf('SELECTME-CCCC');
  if (row < 0) { check('target text still on screen', false); await finish(browser); return; }

  // ---- 3. auto+ : a CLICK is the program's ------------------------------------
  await clearSel();
  let before = await reportCount();
  await clickOn(row, 0.35);
  let after = await reportCount();
  check('auto+ : a click reaches the program', after > before, `reports ${before} -> ${after}`);
  check('auto+ : a click selects nothing', !(await selection()), JSON.stringify(await selection()));

  // ---- 4. auto+ : a DRAG is the buffer's — the whole point of the feature -----
  await clearSel();
  before = await reportCount();
  row = await rowOf('SELECTME-CCCC');
  await dragAcross(row, 0.02, 0.30);
  sel = await selection();
  after = await reportCount();
  check('auto+ : click-and-drag SELECTS over a mouse-grabbing program',
    /CTME-CCCC/.test(sel), JSON.stringify(sel));
  check('auto+ : and that drag sent the program nothing', after === before, `reports ${before} -> ${after}`);
  // The point of this change: selecting puts the pane in copy mode by itself, and
  // the highlight has to survive the redraw that tmux does on the way in.
  check('auto+ : the drag entered copy mode on its own', await inCopy() === true);
  // The regression this driver exists for: it used to take one drag to enter copy
  // mode and a SECOND to actually select, because entering the mode wiped the
  // first. So this must hold on a pane that started in normal mode, first try.
  check('auto+ : the FIRST drag selects — no drag-twice', /CTME-CCCC/.test(sel), JSON.stringify(sel));
  await sleep(800);
  check('auto+ : and the selection survived the copy-mode redraw',
    /CTME-CCCC/.test(await selection()), JSON.stringify(await selection()));
  check('auto+ : tmux agrees the pane is in a mode',
    await unit((u) => !!u.layout?.activePaneInMode) === true);

  // ...and clicking away must get the pane OUT of copy mode, or one drag-select
  // would strand every later click in the buffer. tmux stops reporting the mouse
  // while in copy mode, so the exit is a round-trip and this first click can only
  // dismiss; the point is that the click AFTER it reaches the program again.
  await clickOn(await rowOf('SELECTME-DDDD'), 0.35);
  check('auto+ : a click while in copy mode leaves copy mode', await inCopy() === false);
  check('auto+ : and clears the highlight', !(await selection()), JSON.stringify(await selection()));
  await sleep(900);   // let tmux restore the program's mouse reporting
  check('auto+ : mouse reporting comes back after the exit',
    await tracking() !== 'none', `mouseTrackingMode=${await tracking()}`);
  before = await reportCount();
  await clickOn(await rowOf('SELECTME-DDDD'), 0.35);
  after = await reportCount();
  check('auto+ : and the next click reaches the program again',
    after > before, `reports ${before} -> ${after}`);
  check('auto+ : a drag still selects after all that',
    await (async () => { await clearSel();
      await dragAcross(await rowOf('SELECTME-CCCC'), 0.02, 0.30);
      return /CTME-CCCC/.test(await selection()); })());
  await normalMode();

  // ---- 5. sel app : everything is the program's ------------------------------
  check('the dropdown picks app', await setMouseMode('app'));
  await clearSel();
  before = await reportCount();
  await dragAcross(await rowOf('SELECTME-CCCC'), 0.02, 0.30);
  after = await reportCount();
  check('app : a drag selects nothing', !(await selection()), JSON.stringify(await selection()));
  check('app : and the program gets it', after > before, `reports ${before} -> ${after}`);

  // ---- 6. sel buf : nothing is ----------------------------------------------
  check('the dropdown picks buffer', await setMouseMode('buffer'));
  await clearSel();
  before = await reportCount();
  await clickOn(await rowOf('SELECTME-CCCC'), 0.35);
  after = await reportCount();
  check('buf : not even a bare click reaches the program', after === before, `reports ${before} -> ${after}`);
  check('buf : a bare click does NOT enter copy mode', await inCopy() === false);
  await clearSel();
  await dragAcross(await rowOf('SELECTME-CCCC'), 0.02, 0.30);
  check('buf : a drag selects', /CTME-CCCC/.test(await selection()), JSON.stringify(await selection()));
  check('buf : and the drag entered copy mode', await inCopy() === true);
  await normalMode();

  // ---- 7. sel auto : follows the mouse grab ----------------------------------
  check('the dropdown picks auto', await setMouseMode('adaptive-mode'));
  await clearSel();
  before = await reportCount();
  await dragAcross(await rowOf('SELECTME-CCCC'), 0.02, 0.30);
  after = await reportCount();
  check('auto : hands a grabbing program the drag', after > before && !(await selection()),
    `reports ${before} -> ${after}, sel=${JSON.stringify(await selection())}`);

  // ---- 8. the choice is shared state, not a per-tab whim ---------------------
  // Checked the only way that proves it: reload and see whether the mode came back
  // from tmux's @wt_state rather than resetting to the default.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(4000);
  check('the mode survives a reload (it rides the shared renderer pref)',
    await mouseMode() === 'adaptive-mode', `after reload: ${await mouseMode()}`);
  check('and the toolbar label came back with it', (await triggerText()).includes('auto'));

  // ---- 9. the hold path — a press held still is handed over, not swallowed ---
  // This is the path the "Illegal invocation" timer bug silently disabled.
  await setMouseMode('adaptive-probe');
  await unit((u) => { u.terminal.clearSelection(); });
  const beforeHold = await reportCount();
  const pt = await pointOnRow(await rowOf('SELECTME-CCCC'), 0.35);
  await page.mouse.move(pt.x, pt.y);
  await page.mouse.down();
  await sleep(600);                       // well past HOLD_MS, without moving
  const midHold = await reportCount();
  await page.mouse.up();
  await sleep(200);
  check('auto+ : a motionless hold reaches the program before the release',
    midHold > beforeHold, `reports ${beforeHold} -> ${midHold} while still held`);

  await finish(browser);
}

async function finish(browser) {
  await browser.close();
  const bad = results.filter((r) => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} passed`);
  process.exit(bad.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
