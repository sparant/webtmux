// Diagnostic: what happens to a text selection when you SCROLL while in copy mode?
//
// The question is whether the highlight tracks the text it was made on, or stays
// put on screen while different text slides under it. These are easy to confuse by
// eye and trivial to tell apart here: compare the selection's BUFFER COORDINATES
// and its TEXT before and after a scroll.
//
//   coordinates same + text changed -> the highlight is pinned to the screen and
//                                      is now covering something else
//   coordinates moved + text same   -> the highlight follows its content
//
// Run like run.sh does, with DRIVER=diag-selection-scroll.js.
const { chromium } = require('playwright');

const URL = 'http://localhost:8090/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let page;
const unit = (fn, arg) => page.evaluate(([f, a]) => {
  const u = window.splitManager?.focusedUnit || window.webtmux;
  return eval(f)(u, a);
}, [fn.toString(), arg]);

const snap = () => unit((u) => ({
  text: u.terminal.getSelection(),
  pos: u.terminal.getSelectionPosition(),
  copy: u.inCopyMode,
}));

const screenText = () => unit((u) => {
  const b = u.terminal.buffer.active; const out = [];
  for (let i = 0; i < u.terminal.rows; i++) {
    const ln = b.getLine(b.viewportY + i); out.push(ln ? ln.translateToString(true) : '');
  }
  return out.join('\n');
});

async function typeLine(s) {
  await unit((u) => { u.terminal.focus(); });
  await page.keyboard.type(s);
  await page.keyboard.press('Enter');
  await sleep(700);
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

  // Plenty of numbered scrollback to scroll through, so it is obvious which line
  // the highlight is sitting on at any moment.
  await typeLine('clear; for i in $(seq 1 400); do printf "HISTORY-LINE-%03d marker text\\n" $i; done');
  await sleep(1500);

  // Select a line by dragging across it.
  const lines = (await screenText()).split('\n');
  let row = -1, want = '';
  for (let i = lines.length - 3; i >= 0; i--) {
    if (/HISTORY-LINE-\d+/.test(lines[i])) { row = i; want = lines[i]; break; }
  }
  if (row < 0) { console.log('no target line found'); await browser.close(); return; }

  const box = await page.locator('.xterm-screen').first().boundingBox();
  const rows = await unit((u) => u.terminal.rows);
  const cellH = box.height / rows;
  const y = box.y + row * cellH + cellH / 2;
  await page.mouse.move(box.x + box.width * 0.02, y);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) {
    await page.mouse.move(box.x + box.width * (0.02 + 0.28 * i / 20), y);
    await sleep(20);
  }
  await page.mouse.up();
  await sleep(700);

  const before = await snap();
  console.log(`target line     : ${JSON.stringify(want.trim())}`);
  console.log(`BEFORE scroll   : text=${JSON.stringify(before.text)}`);
  console.log(`                  pos=${JSON.stringify(before.pos)} inCopyMode=${before.copy}`);

  // Scroll the copy-mode buffer the way the wheel does — five lines of history.
  await unit((u) => { u.sendMessage('B', '5'); });   // MSG.TmuxScrollUp
  await sleep(1200);

  const after = await snap();
  console.log(`AFTER scroll up : text=${JSON.stringify(after.text)}`);
  console.log(`                  pos=${JSON.stringify(after.pos)} inCopyMode=${after.copy}`);

  const posSame = JSON.stringify(before.pos) === JSON.stringify(after.pos);
  const textSame = before.text === after.text;
  console.log(`\nVERDICT: coordinates ${posSame ? 'UNCHANGED' : 'MOVED'}, text ${textSame ? 'UNCHANGED' : 'CHANGED'}`);
  console.log(posSame && !textSame
    ? '  -> the highlight is pinned to the SCREEN; scrolling slides other text under it.'
    : (!posSame && textSame
      ? '  -> the highlight FOLLOWS its content.'
      : '  -> neither: see the values above.'));

  // Is the information needed to fix it actually available? A tmux scroll of N
  // lines moves the content by N rows, and the selection is addressable in buffer
  // coordinates, so the answer should be yes.
  console.log(`\nterminal.select available: ${await unit((u) => typeof u.terminal.select === 'function')}`);
  console.log(`getSelectionPosition available: ${await unit((u) => typeof u.terminal.getSelectionPosition === 'function')}`);

  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
