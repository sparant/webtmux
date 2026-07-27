// Verification driver for the mouse click/drag mode toggle ("sel app / buf / auto
// / auto+"). The claim under test cannot be checked from source or from node: it is
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

const reportCount = async () => (await screenText()).split('^[[<').length - 1;

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

// Cycle the "sel" button until it reads `want`. Second .tbtn.text in the toolbar.
async function setMouseMode(want) {
  for (let i = 0; i < 5; i++) {
    if (await mouseMode() === want) return true;
    await toolbar((el, rr) => { rr.querySelectorAll('.tbtn.text')[1].click(); });
    await sleep(200);
  }
  return await mouseMode() === want;
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

  check('the toolbar has a second mode button', await toolbar((el, rr) => rr.querySelectorAll('.tbtn.text').length) === 2);
  check('it defaults to auto+', await mouseMode() === 'adaptive-probe', `got ${await mouseMode()}`);
  check('its label says so', (await toolbar((el, rr) => rr.querySelectorAll('.tbtn.text')[1].textContent)).includes('auto+'));

  // Quiet pane to work in, with a wide line of known text to drag across.
  await typeLine('clear; printf "SELECTME-%s\\n" AAAA BBBB CCCC DDDD EEEE FFFF');
  await sleep(500);

  // ---- 1. plain shell: nothing grabs the mouse, xterm selects natively --------
  check('a plain shell reports no mouse tracking', await tracking() === 'none', `got ${await tracking()}`);
  await clearSel();
  let row = await rowOf('SELECTME-CCCC');
  await dragAcross(row, 0.02, 0.30);
  let sel = await selection();
  // The drag starts a few columns in, so the selection is the tail of the marker.
  check('drag-selects in a plain shell (native path untouched)', /CTME-CCCC/.test(sel), JSON.stringify(sel));

  // A second drag must be a FRESH selection, not an extension of the first — the
  // trap a blanket shift-synthesis would fall into (_handleIncrementalClick).
  await dragAcross(await rowOf('SELECTME-EEEE'), 0.02, 0.20);
  sel = await selection();
  check('a second drag starts over instead of extending the first',
    /EEEE/.test(sel) && !/CCCC/.test(sel), JSON.stringify(sel));

  // ---- 2. make the pane grab the mouse, like Claude/vim do -------------------
  await clearSel();
  await typeLine('printf "\\033[?1000h\\033[?1006h"; cat -v');
  await sleep(900);
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
  check('auto+ : selecting did NOT force the pane into copy mode',
    (await unit((u) => u.inCopyMode)) === false);

  // ---- 5. sel app : everything is the program's ------------------------------
  check('the button cycles to app', await setMouseMode('app'));
  await clearSel();
  before = await reportCount();
  await dragAcross(await rowOf('SELECTME-CCCC'), 0.02, 0.30);
  after = await reportCount();
  check('app : a drag selects nothing', !(await selection()), JSON.stringify(await selection()));
  check('app : and the program gets it', after > before, `reports ${before} -> ${after}`);

  // ---- 6. sel buf : nothing is ----------------------------------------------
  check('the button cycles to buffer', await setMouseMode('buffer'));
  await clearSel();
  before = await reportCount();
  await clickOn(await rowOf('SELECTME-CCCC'), 0.35);
  after = await reportCount();
  check('buf : not even a bare click reaches the program', after === before, `reports ${before} -> ${after}`);
  await clearSel();
  await dragAcross(await rowOf('SELECTME-CCCC'), 0.02, 0.30);
  check('buf : a drag selects', /CTME-CCCC/.test(await selection()), JSON.stringify(await selection()));

  // ---- 7. sel auto : follows the mouse grab ----------------------------------
  check('the button cycles to auto', await setMouseMode('adaptive-mode'));
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
  check('and the toolbar label came back with it',
    (await toolbar((el, rr) => rr.querySelectorAll('.tbtn.text')[1].textContent)).includes('auto'));

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
