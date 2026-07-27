// Diagnostic (not an assertion driver): finds WHICH kind of TUI loses a
// click-drag selection to the copy-mode transition.
//
// The assertion driver drags in ~200ms against a mouse-1000, repaint-in-place
// program and never reproduced the bug. A person drags for a second or more, and a
// real TUI may use a different mouse mode and may repaint by SCROLLING. So this
// walks the matrix at human speed and prints, per combination, whether the
// selection survived — plus a timeline of the events that could have killed it.
const { chromium } = require('playwright');

const URL = 'http://localhost:8090/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const COMBOS = [];
for (const mode of ['1003']) {
  for (const repaint of ['inplace', 'scroll', 'fullscroll']) COMBOS.push({ mode, repaint });
}

let page;
const unit = (fn, arg) => page.evaluate(([f, a]) => {
  const u = window.splitManager?.focusedUnit || window.webtmux;
  return eval(f)(u, a);
}, [fn.toString(), arg]);

const screenText = () => unit((u) => {
  const b = u.terminal.buffer.active; const out = [];
  for (let i = 0; i < u.terminal.rows; i++) {
    const ln = b.getLine(b.viewportY + i); out.push(ln ? ln.translateToString(true) : '');
  }
  return out.join('\n');
});

async function rowOf(needle) {
  const lines = (await screenText()).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].includes(needle)) return i;
  return -1;
}

async function typeLine(s) {
  await unit((u) => { u.terminal.focus(); });
  await page.keyboard.type(s);
  await page.keyboard.press('Enter');
  await sleep(700);
}

// Kill whatever TUI is running and get back to a normal-mode shell prompt.
async function resetPane() {
  await unit((u) => { u.terminal.clearSelection(); if (u.inCopyMode) u.exitCopyMode(); });
  await sleep(400);
  await unit((u) => { u.terminal.focus(); });
  await page.keyboard.press('Control+c');
  await sleep(500);
  await typeLine('clear');
  await sleep(400);
}

async function runCombo({ mode, repaint }) {
  await resetPane();
  await typeLine(`bash /src/screenshots/harness/fake-tui.sh ${mode} ${repaint}`);
  await sleep(1800);

  const events = [];
  await page.exposeFunction(`rec_${mode}_${repaint}`, (s) => events.push(s));
  await unit((u, tag) => {
    const t0 = Date.now();
    const rec = window[`rec_${tag}`];
    window.__rec = (s) => rec(`+${String(Date.now() - t0).padStart(4)}ms ${s}`);
    window.__d = u.terminal.onSelectionChange(() => {
      const sel = u.terminal.getSelection();
      window.__rec(`selection -> ${sel ? JSON.stringify(sel.slice(0, 26)) : '(EMPTY)'}`);
    });
    let lm = u.terminal.modes.mouseTrackingMode, lc = u.inCopyMode;
    let lcls = u.terminal.element.classList.contains('enable-mouse-events');
    window.__poll = setInterval(() => {
      const m = u.terminal.modes.mouseTrackingMode;
      if (m !== lm) { window.__rec(`trackingMode ${lm} -> ${m}`); lm = m; }
      const c = u.inCopyMode;
      if (c !== lc) { window.__rec(`inCopyMode -> ${c}`); lc = c; }
      const cl = u.terminal.element.classList.contains('enable-mouse-events');
      if (cl !== lcls) { window.__rec(`xterm selection ${cl ? 'DISABLED' : 'ENABLED'}`); lcls = cl; }
    }, 15);
  }, `${mode}_${repaint}`);

  const row = await rowOf('SELECTME-CCCC');
  if (row < 0) { console.log(`  mode=${mode} repaint=${repaint}: target row not on screen`); return; }

  const box = await page.locator('.xterm-screen').first().boundingBox();
  const rows = await unit((u) => u.terminal.rows);
  const cellH = box.height / rows;
  const y = box.y + row * cellH + cellH / 2;
  const x0 = box.x + box.width * 0.02, x1 = box.x + box.width * 0.34;

  await page.mouse.move(x0, y);
  await unit(() => { window.__rec('MOUSE DOWN'); });
  await page.mouse.down();
  for (let i = 1; i <= 40; i++) {           // ~1.2s, like a hand
    await page.mouse.move(x0 + ((x1 - x0) * i) / 40, y);
    await sleep(30);
  }
  await unit(() => { window.__rec('MOUSE UP'); });
  await page.mouse.up();
  await sleep(1500);

  const sel = await unit((u) => u.terminal.getSelection());
  const copy = await unit((u) => u.inCopyMode);
  await unit(() => { clearInterval(window.__poll); window.__d?.dispose?.(); });

  const got = (sel || '').match(/SELECTME-(\w+)|CTME-(\w+)/);
  const marker = got ? (got[1] || got[2]) : '(none)';
  const ok = marker === 'CCCC';
  console.log(`\n=== mouse ${mode} / repaint ${repaint}: ${ok ? 'OK (CCCC)' : `*** WRONG/LOST: got ${marker} ***`}`);
  console.log(`    final sel=${JSON.stringify(sel)} inCopyMode=${copy}`);
  for (const e of events) console.log(`    ${e}`);
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
  await sleep(4000);

  for (const c of COMBOS) {
    try { await runCombo(c); } catch (e) { console.log(`  combo ${JSON.stringify(c)} threw: ${e.message}`); }
  }
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
