// DIAGNOSTIC 4 — is the ghost rectangle the PREVIEW's fault, or the RESIZE's?
//
// Diagnostic 3 showed the empty highlight layer refilling at the exact moment the
// held region is resized back, with every selection model reporting nothing selected.
// If a bare resize of a terminal whose selection was cleared does the same, the bug
// is not in the preview path at all — it is in every path that resizes an xterm
// after a selection has existed (the preview, the split divider, a window resize).
//
// Run exactly like run.sh does, with DRIVER=diag-resize-ghost.js.
const { chromium } = require('playwright');

const URL = 'http://localhost:8090/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let page;

const snap = (tag) => page.evaluate((t) => {
  const u = window.splitManager.focusedUnit;
  const term = u.terminal;
  const layer = u.terminalEl.querySelector('.xterm-selection');
  return {
    tag: t,
    painted: layer ? layer.children.length : -1,
    has: !!term.hasSelection?.(),
    text: (term.getSelection?.() || '').slice(0, 24),
    grid: `${term.cols}x${term.rows}`,
  };
}, tag);

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

  // A selection made through xterm's own API — no mouse, no preview, no tmux.
  await page.evaluate(() => {
    const t = window.splitManager.focusedUnit.terminal;
    t.select(2, 2, 24);
  });
  await sleep(400);
  console.log(JSON.stringify(await snap('selected')));

  await page.evaluate(() => window.splitManager.focusedUnit.terminal.clearSelection());
  await sleep(400);
  console.log(JSON.stringify(await snap('cleared')));

  // Resize away and back — what the preview hold does to the region it borrows.
  await page.evaluate(() => {
    const t = window.splitManager.focusedUnit.terminal;
    window.__grid = { cols: t.cols, rows: t.rows };
    t.resize(t.cols + 24, t.rows - 1);
  });
  await sleep(600);
  console.log(JSON.stringify(await snap('resized away')));

  await page.evaluate(() => {
    const t = window.splitManager.focusedUnit.terminal;
    t.resize(window.__grid.cols, window.__grid.rows);
  });
  await sleep(600);
  console.log(JSON.stringify(await snap('resized back')));
  await sleep(1500);
  console.log(JSON.stringify(await snap('resized back +1.5s')));

  // And does a clear AFTER the resize hold, or does the next frame bring it back?
  await page.evaluate(() => window.splitManager.focusedUnit.terminal.clearSelection());
  await sleep(300);
  console.log(JSON.stringify(await snap('cleared after resize')));
  await sleep(2000);
  console.log(JSON.stringify(await snap('cleared after resize +2s')));

  // A clear issued in the SAME tick as the resize is the cheap fix — does it stick?
  await page.evaluate(() => {
    const t = window.splitManager.focusedUnit.terminal;
    t.select(4, 4, 20);
    t.clearSelection();
    t.resize(t.cols + 24, t.rows - 1);
    t.resize(window.__grid.cols, window.__grid.rows);
    t.clearSelection();
  });
  await sleep(1200);
  console.log(JSON.stringify(await snap('clear in the same tick as the resize')));

  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
