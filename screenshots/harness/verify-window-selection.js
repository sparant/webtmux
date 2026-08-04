// Verification driver for "a highlight ends when the window under it does".
//
// The bug: a selection is stored as buffer coordinates and this terminal has no
// scrollback of its own, so switching windows repainted the viewport underneath the
// highlight and left it sitting over unrelated text — in a pane where a program has
// grabbed the mouse, clicking about does not clear it either, so it stayed until
// copy mode was entered and left by hand.
//
// What cannot be checked from node is the only part that matters: whether a real
// switch in a real browser takes the highlight with it, on the path the UI uses AND
// on a switch the UI did not make — and whether an ordinary layout push (a rename,
// a new window) still leaves a selection alone.
//
// Run exactly like run.sh does, with DRIVER=verify-window-selection.js.
const { chromium } = require('playwright');

const URL = 'http://localhost:8090/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let page;
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

// ---- reach-ins (same shape as verify-shift-extend.js) ------------------------

const unit = (fn, arg) => page.evaluate(([f, a]) => {
  const u = window.splitManager?.focusedUnit || window.webtmux;
  return eval(f)(u, a);
}, [fn.toString(), arg]);

const selection = () => unit((u) => u.terminal.getSelection());
const activeWin = () => unit((u) => u.layout?.activeWindowId || '');
const windowIds = () => unit((u) => (u.layout?.windows || []).map((w) => w.id));
const tracking = () => unit((u) => u.terminal.modes.mouseTrackingMode);

// Is a highlight actually PAINTED? xterm's DOM renderer draws it as divs in
// .xterm-selection, and an empty selection must leave that layer empty — checking
// getSelection() alone would pass on a stale rectangle nobody can select out of.
const paintedRows = () => page.evaluate(() => {
  const layer = document.querySelector('.xterm-selection');
  return layer ? layer.children.length : -1;
});

const screenText = () => unit((u) => {
  const b = u.terminal.buffer.active;
  const out = [];
  for (let i = 0; i < u.terminal.rows; i++) {
    const ln = b.getLine(b.viewportY + i);
    out.push(ln ? ln.translateToString(true) : '');
  }
  return out.join('\n');
});

async function screenGeom() {
  const box = await page.locator('.xterm-screen').first().boundingBox();
  const rows = await unit((u) => u.terminal.rows);
  const cols = await unit((u) => u.terminal.cols);
  return { box, cellH: box.height / rows, cellW: box.width / cols };
}

// Drag along one row. Returns what got selected ('' if nothing did).
async function dragSelect(row, fromCol, toCol) {
  const { box, cellH, cellW } = await screenGeom();
  const y = box.y + row * cellH + cellH / 2;
  await page.mouse.move(box.x + (fromCol + 0.75) * cellW, y);
  await page.mouse.down();
  await sleep(30);
  await page.mouse.move(box.x + (toCol + 0.75) * cellW, y, { steps: 12 });
  await sleep(150);
  await page.mouse.up();
  await sleep(400);
  return selection();
}

// Drag on a row that has enough text on it to select.
async function selectSomething() {
  const lines = (await screenText()).split('\n');
  let row = lines.findIndex((l) => l.trim().length > 30);
  if (row < 0) row = 2;
  return dragSelect(row, 2, 24);
}

async function waitForWindow(id, ms = 4000) {
  for (let i = 0; i < ms / 250; i++) {
    if (await activeWin() === id) return true;
    await sleep(250);
  }
  return false;
}

async function main() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    httpCredentials: { username: 'wt', password: 'wt' },
  });
  page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await sleep(5000);

  const start = await activeWin();
  const others = (await windowIds()).filter((id) => id !== start);
  const target = others[0];
  check('the harness has somewhere to switch to', !!target, `${start} -> ${target}`);
  if (!target) { await finish(browser); return; }

  // ---- 1. the path the UI uses (sidebar / Exposé / arrow-nav all end here) ----
  const first = await selectSomething();
  check('a drag selects to begin with', !!first, JSON.stringify(first));

  await unit((u, id) => u.selectWindow(id), target);
  await waitForWindow(target);
  await sleep(800);
  const afterSwitch = await selection();
  const paintedAfter = await paintedRows();
  check('switching windows takes the highlight with it',
    afterSwitch === '', `selection is ${JSON.stringify(afterSwitch)}`);
  check('...and leaves nothing painted over the new window',
    paintedAfter === 0, `${paintedAfter} selection rows still drawn`);

  // ---- 2. a switch the UI did NOT make ---------------------------------------
  // tmux's own `prefix n`, another client, the hop a reconnect restores: nothing
  // calls selectWindow, so only the layout can catch it. Sent as the raw message to
  // reproduce that exactly.
  const second = await selectSomething();
  check('a drag selects in the window we landed on', !!second, JSON.stringify(second));

  await unit((u, id) => u.sendMessage('6', id), start);   // MSG.TmuxSelectWindow
  await waitForWindow(start);
  await sleep(800);
  const afterExternal = await selection();
  check('a switch we did not initiate drops it too',
    afterExternal === '', `selection is ${JSON.stringify(afterExternal)}`);
  check('...and paints nothing either', await paintedRows() === 0);

  // ---- 3. a layout push that is NOT a switch must leave it alone --------------
  // The regression the fix could cause: layouts arrive for renames, new windows,
  // pane activity. Dropping a highlight on any of them would make selecting in a
  // busy pane impossible.
  const third = await selectSomething();
  check('a drag selects before an unrelated layout push', !!third, JSON.stringify(third));
  await unit((u, id) => u.renameWindow(id, 'renamed-' + (Date.now() % 1000)), target);
  await sleep(1500);
  const afterRename = await selection();
  check('an unrelated layout push leaves the selection alone',
    afterRename === third, `wanted ${JSON.stringify(third)}, got ${JSON.stringify(afterRename)}`);

  // ---- 4. over a mouse-grabbing program --------------------------------------
  // Where the stale highlight was worst: a press there never reaches xterm's
  // selection service, so nothing the user could click would have cleared it.
  await unit((u) => { u.terminal.clearSelection(); u._selAnchor = null; if (u.inCopyMode) u.exitCopyMode(); });
  await sleep(500);
  await unit((u) => u.terminal.focus());
  await page.keyboard.type('bash /src/screenshots/harness/fake-tui.sh 1003 inplace');
  await page.keyboard.press('Enter');
  await sleep(2500);
  const grabbed = await tracking();
  check('the pane now holds the mouse', grabbed !== 'none', `mouseTrackingMode=${grabbed}`);
  if (grabbed !== 'none') {
    const inTui = await selectSomething();
    check('a drag selects over the grabbing program', !!inTui, JSON.stringify(inTui));
    await unit((u, id) => u.selectWindow(id), target);
    await waitForWindow(target);
    await sleep(800);
    const afterTuiSwitch = await selection();
    check('leaving that window clears the highlight it left behind',
      afterTuiSwitch === '', `selection is ${JSON.stringify(afterTuiSwitch)}`);
    check('...with nothing left painted', await paintedRows() === 0);
  }

  await finish(browser);
}

async function finish(browser) {
  await browser.close();
  const bad = results.filter((r) => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} passed`);
  process.exit(bad.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
