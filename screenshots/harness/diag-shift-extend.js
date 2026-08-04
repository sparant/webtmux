// Scratch diagnostic for the shift-click extend work: prints the coordinate
// mapping (screen box, cell size, computed cell) alongside what xterm reports, so a
// selection that lands in the wrong place can be traced to the step that moved it.
const { chromium } = require('playwright');
const URL = 'http://localhost:8090/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let page;

const unit = (fn, arg) => page.evaluate(([f, a]) => {
  const u = window.splitManager?.focusedUnit || window.webtmux;
  return eval(f)(u, a);
}, [fn.toString(), arg]);

const screenText = () => unit((u) => {
  const b = u.terminal.buffer.active;
  const out = [];
  for (let i = 0; i < u.terminal.rows; i++) {
    const ln = b.getLine(b.viewportY + i);
    out.push(ln ? ln.translateToString(true) : '');
  }
  return out.join('\n');
});

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

  await unit((u) => { u.terminal.focus(); });
  await page.keyboard.type(`clear; { printf 'EXTLINE'; for i in 1 2 3 4 5 6 7; do printf '%s' "$i-abcdefgh"; done; printf 'END\\n'; }`);
  await page.keyboard.press('Enter');
  await sleep(1200);

  console.log('geom(unit):', JSON.stringify(await unit((u) => {
    const el = u._xtermScreen();
    const b = el.getBoundingClientRect();
    const buf = u.terminal.buffer.active;
    return { cols: u.terminal.cols, rows: u.terminal.rows, box: { x: b.x, y: b.y, w: b.width, h: b.height },
             buflen: buf.length, viewportY: buf.viewportY,
             nScreens: document.querySelectorAll('.xterm-screen').length };
  })));
  const pwBox = await page.locator('.xterm-screen').first().boundingBox();
  console.log('geom(playwright first .xterm-screen):', JSON.stringify(pwBox));

  const lines = (await screenText()).split('\n');
  let row = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].includes('EXTLINE')) { row = i; break; }
  console.log('row', row, JSON.stringify(lines[row]));

  const cols = await unit((u) => u.terminal.cols);
  const cellW = pwBox.width / cols, cellH = pwBox.height / (await unit((u) => u.terminal.rows));
  const at = (col) => ({ x: pwBox.x + (col + 0.75) * cellW, y: pwBox.y + row * cellH + cellH / 2 });

  for (const col of [2, 12, 30]) {
    const p = at(col);
    console.log(`col ${col} -> point ${JSON.stringify(p)} -> _cellAtPoint`,
      JSON.stringify(await unit((u, a) => u._cellAtPoint(a.x, a.y), p)));
  }

  const a = at(2), b = at(12);
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await sleep(30);
  await page.mouse.move(b.x, b.y, { steps: 10 }); await sleep(120); await page.mouse.up();
  await sleep(400);
  console.log('after drag: sel=', JSON.stringify(await unit((u) => u.terminal.getSelection())));
  console.log('  pos=', JSON.stringify(await unit((u) => u.terminal.getSelectionPosition())),
              ' anchor=', JSON.stringify(await unit((u) => u._selAnchor)));

  const c = at(30);
  await page.keyboard.down('Shift');
  await page.mouse.move(c.x, c.y); await page.mouse.down(); await sleep(60); await page.mouse.up();
  await page.keyboard.up('Shift');
  await sleep(400);
  console.log('after shift-click: sel=', JSON.stringify(await unit((u) => u.terminal.getSelection())));
  console.log('  pos=', JSON.stringify(await unit((u) => u.terminal.getSelectionPosition())),
              ' anchor=', JSON.stringify(await unit((u) => u._selAnchor)));

  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
