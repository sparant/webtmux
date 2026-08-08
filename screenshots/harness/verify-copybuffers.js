// Verification driver for the COPY BUFFER panel. The node tests
// (test/copy-buffers.test.mjs) pin the ring's rules; everything here is the
// WIRING — that those rules are reachable from the controls a person touches, in
// a real browser, against a real tmux:
//
//   1. ⌃⌥= opens/closes the panel, and it starts closed with one empty buffer.
//   2. A real ⌘C over a real xterm selection fills that buffer AND the system
//      clipboard (the two halves of "the focused buffer is the clipboard").
//   3. Copying again BEFORE pasting keeps both — the list grows, newest focused.
//   4. Clicking a row makes it the clipboard, so ⌘V in the pane types THAT one.
//   5. Copying again AFTER a paste reuses the spent slot — ordinary copy-paste
//      never grows the list.
//   6. "+" adds an empty focused buffer; Clear asks, then keeps only the focused
//      one; a row's × removes just that row.
//   7. The toolbar's mode pill opens the panel (and counts the buffers); the
//      panel's own button is what flips copy/normal mode.
//   8. Both right-edge panels can be open at once without covering each other.
//   9. The buffers survive a reload (per-tab store), and the restored ring still
//      treats its focused buffer as unpasted.
//
// Run exactly like run.sh does, with DRIVER=verify-copybuffers.js.
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');

const URL = 'http://localhost:8090/';
const SOCK = '/tmp/wt.sock';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let page;
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

// Every control lives one shadow root down, so document.querySelector never sees it.
const el = (tag) => (fn, arg) => page.evaluate(([t, f, a]) => {
  const node = document.querySelector(t);
  if (!node) return null;
  return eval(f)(node, node.shadowRoot, a);
}, [tag, fn.toString(), arg]);

const copyPanel = el('webtmux-copy-sidebar');
const winPanel = el('webtmux-sidebar');
const toolbar = el('webtmux-toolbar');
const mgr = (fn, arg) => page.evaluate(([f, a]) => eval(f)(window.splitManager, a), [fn.toString(), arg]);

const tmux = (...args) => execFileSync('tmux', ['-S', SOCK, ...args], { encoding: 'utf8' });

// The panel's rows, as the user sees them: preview text, which one is focused,
// and the dim meta line that says what the next copy will do.
const rows = () => copyPanel((n, rr) => [...rr.querySelectorAll('.brow')].map((row) => ({
  text: row.querySelector('.btext')?.textContent.trim() || '',
  meta: row.querySelector('.bmeta')?.textContent.trim() || '',
  focused: row.querySelector('.buf')?.classList.contains('focused') || false,
  onClipboard: row.querySelector('.clip')?.classList.contains('on') || false,
})));

const clipboard = () => page.evaluate(() => navigator.clipboard.readText());

// Print a marker into a pane, then select it in xterm exactly as a drag would and
// press ⌘C — the real key handler, on a real selection, over real tmux output.
async function copyMarker(mark) {
  tmux('send-keys', '-t', 'dev', `echo ${mark}`, 'Enter');
  await sleep(900);
  const selected = await mgr((m, want) => {
    const t = m.focusedUnit.terminal;
    const buf = t.buffer.active;
    // Search from the bottom: the marker was just printed, and the ECHOED COMMAND
    // line above it contains the same string.
    for (let y = buf.length - 1; y >= 0; y--) {
      const line = buf.getLine(y)?.translateToString(true) || '';
      const i = line.indexOf(want);
      if (i === -1 || /echo/.test(line)) continue;
      t.select(i, y, want.length);
      t.focus();
      return t.getSelection();
    }
    return null;
  }, mark);
  if (selected !== mark) return { selected, copied: false };
  await page.keyboard.press('Control+c');
  await sleep(500);
  return { selected, copied: true };
}

async function openPanel() {
  const open = await copyPanel((n) => !n.collapsed);
  if (!open) { await page.keyboard.press('Control+Alt+Equal'); await sleep(500); }
}

async function main() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    httpCredentials: { username: 'wt', password: 'wt' },
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await sleep(4500);

  // ---- 1. the panel, its chord, and its resting state -------------------------
  const born = await copyPanel((n) => ({ exists: true, collapsed: n.collapsed }));
  check('the copy panel exists and starts closed', born?.exists === true && born.collapsed === true,
    JSON.stringify(born));

  await page.keyboard.press('Control+Alt+Equal');
  await sleep(600);
  const opened = await copyPanel((n) => !n.collapsed);
  check('⌃⌥= opens it', opened === true);

  const start = await rows();
  check('it rests at exactly one empty buffer',
    start.length === 1 && /empty/.test(start[0].text) && start[0].focused,
    JSON.stringify(start));

  const controls = await copyPanel((n, rr) => ({
    mode: rr.querySelector('.mode-toggle')?.textContent.trim() || '',
    pair: [...rr.querySelectorAll('.mode-pair .mode-btn')].map((b) => b.textContent.trim()),
    pairTops: [...rr.querySelectorAll('.mode-pair .mode-btn')].map((b) => b.offsetTop),
    actions: [...rr.querySelectorAll('.actions .mode-btn')].map((b) => b.textContent.trim()),
    clearDisabled: rr.querySelector('.clear-btn')?.disabled,
  }));
  check('it has the same float/pin pair as the windows panel, on one line',
    controls.pair.length === 2 && /float|mount/.test(controls.pair[0])
      && /pinned|auto hide/.test(controls.pair[1])
      && Math.abs(controls.pairTops[0] - controls.pairTops[1]) < 2,
    JSON.stringify(controls.pair));
  check('the copy/normal mode button lives INSIDE the panel',
    /NORMAL mode|COPY mode/.test(controls.mode), controls.mode);
  check('"+" and "Clear" are both there, Clear inert with nothing to clear',
    controls.actions.length === 2 && /buffer/.test(controls.actions[0])
      && /Clear/.test(controls.actions[1]) && controls.clearDisabled === true,
    JSON.stringify(controls));

  await page.keyboard.press('Control+Alt+Equal');
  await sleep(500);
  check('⌃⌥= closes it again', (await copyPanel((n) => n.collapsed)) === true);

  // ---- 2. a real copy fills the buffer AND the clipboard ----------------------
  const one = await copyMarker('CB-ONE');
  check('setup: a real xterm selection of the first marker', one.copied, JSON.stringify(one));
  await openPanel();
  let r = await rows();
  check('the copy lands in the one buffer, not a new one',
    r.length === 1 && r[0].text === 'CB-ONE' && r[0].focused, JSON.stringify(r));
  check('and it is on the system clipboard', (await clipboard()) === 'CB-ONE');
  check('the focused row is the one marked as the clipboard', r[0].onClipboard === true);
  check('the row says the next copy will ADD a buffer', /adds a buffer/.test(r[0].meta), r[0].meta);

  // ---- 3. gathering: copy again before pasting -------------------------------
  const two = await copyMarker('CB-TWO');
  check('setup: a second selection, no paste in between', two.copied, JSON.stringify(two));
  r = await rows();
  check('copying again BEFORE a paste keeps both, newest focused',
    r.length === 2 && r[0].text === 'CB-ONE' && r[1].text === 'CB-TWO'
      && r[1].focused && !r[0].focused,
    JSON.stringify(r.map((x) => x.text + (x.focused ? '*' : ''))));
  check('the clipboard follows the newest', (await clipboard()) === 'CB-TWO');

  // ---- 4. clicking a row chooses what ⌘V pastes ------------------------------
  await copyPanel((n, rr) => { rr.querySelectorAll('.buf')[0].click(); });
  await sleep(400);
  r = await rows();
  check('clicking the first row focuses it', r[0].focused && !r[1].focused);
  check('…and puts it on the clipboard', (await clipboard()) === 'CB-ONE');

  // Paste it into the pane for real and read back what the shell saw.
  tmux('send-keys', '-t', 'dev', 'clear', 'Enter');
  await sleep(600);
  await mgr((m) => m.focusedUnit.terminal.focus());
  await page.keyboard.press('Control+v');
  await sleep(1200);
  const pane = tmux('capture-pane', '-p', '-t', 'dev');
  check('⌘V in the pane types the FOCUSED buffer', pane.includes('CB-ONE') && !pane.includes('CB-TWO'),
    pane.trim().split('\n').slice(-2).join(' / '));
  r = await rows();
  check('and the panel now says the next copy will REPLACE that buffer',
    /replaces this/.test(r[0].meta), r[0].meta);

  // ---- 5. a copy after a paste reuses the slot -------------------------------
  await page.keyboard.press('Control+u');   // clear the pasted line off the prompt
  await sleep(300);
  const three = await copyMarker('CB-THREE');
  check('setup: a third selection, this time after a paste', three.copied, JSON.stringify(three));
  r = await rows();
  check('copying AFTER a paste replaces the used buffer instead of growing the list',
    r.length === 2 && r[0].text === 'CB-THREE' && r[1].text === 'CB-TWO',
    JSON.stringify(r.map((x) => x.text)));

  // ---- 6. "+", ×, and Clear ---------------------------------------------------
  // The list is CB-THREE (focused), CB-TWO. A new entry lands NEXT TO the focused
  // one, exactly as a gathered copy does — the ordering rule is one rule, not two.
  await copyPanel((n, rr) => { rr.querySelectorAll('.actions .mode-btn')[0].click(); });
  await sleep(400);
  r = await rows();
  check('"+" adds an empty buffer beside the focused one, and focuses it',
    r.length === 3 && r[0].text === 'CB-THREE' && /empty/.test(r[1].text) && r[1].focused
      && r[2].text === 'CB-TWO',
    JSON.stringify(r.map((x) => x.text + (x.focused ? '*' : ''))));

  await copyPanel((n, rr) => { rr.querySelectorAll('.buf .kill')[1].click(); });
  await sleep(400);
  r = await rows();
  check('a row\'s × removes just that row',
    r.length === 2 && r[0].text === 'CB-THREE' && r[1].text === 'CB-TWO',
    JSON.stringify(r.map((x) => x.text)));

  // Focus CB-TWO, then clear: the survivor must be the one the clipboard holds.
  await copyPanel((n, rr) => { rr.querySelectorAll('.buf')[1].click(); });
  await sleep(300);
  check('setup: the clipboard follows the row that was clicked', (await clipboard()) === 'CB-TWO');
  await copyPanel((n, rr) => { rr.querySelector('.clear-btn').click(); });
  await sleep(400);
  const asked = await copyPanel((n, rr) => rr.querySelector('.wt-confirm')?.textContent.trim() || '');
  check('Clear asks before destroying anything', /Clear 1 buffer/.test(asked), asked);
  await copyPanel((n, rr) => {
    [...rr.querySelectorAll('.wt-confirm button')].find((b) => /Clear/.test(b.textContent))?.click();
  });
  await sleep(400);
  r = await rows();
  check('Clear keeps the FOCUSED buffer, and the clipboard with it',
    r.length === 1 && r[0].text === 'CB-TWO' && (await clipboard()) === 'CB-TWO',
    JSON.stringify(r.map((x) => x.text)));

  // ---- 7. the toolbar pill ----------------------------------------------------
  await page.keyboard.press('Control+Alt+Equal');   // close, so the pill has to open it
  await sleep(400);
  // Gather a second buffer (no paste in between) so the count badge has something
  // to report — it stays hidden while there is only one, which is the point of it.
  const four = await copyMarker('CB-FOUR');
  check('setup: a fourth selection gathered onto CB-TWO', four.copied, JSON.stringify(four));
  const pill = await toolbar((n, rr) => {
    const b = rr.querySelector('.mode');
    return { text: b?.textContent.trim() || '', badge: b?.querySelector('.bufn')?.textContent || '' };
  });
  check('the toolbar pill shows the mode and the buffer count',
    /NORMAL|COPY/.test(pill.text) && pill.badge === '2', JSON.stringify(pill));
  await toolbar((n, rr) => { rr.querySelector('.mode').click(); });
  await sleep(500);
  check('clicking the pill opens the copy panel', (await copyPanel((n) => !n.collapsed)) === true);

  const modeBefore = await mgr((m) => !!m.focusedUnit?.layout?.activePaneInMode);
  await copyPanel((n, rr) => { rr.querySelector('.mode-toggle').click(); });
  await sleep(1500);
  const modeAfter = await mgr((m) => !!m.focusedUnit?.layout?.activePaneInMode);
  check('the panel\'s mode button really flips the pane\'s tmux mode',
    modeAfter !== modeBefore, `${modeBefore} -> ${modeAfter}`);
  await copyPanel((n, rr) => { rr.querySelector('.mode-toggle').click(); });
  await sleep(1200);

  // ---- 8. the two panels share the right edge --------------------------------
  await winPanel((n) => { n.collapsed = false; n.pinned = true; });
  await copyPanel((n) => { n.pinned = true; });
  await sleep(700);
  const geom = await page.evaluate(() => {
    const a = document.querySelector('webtmux-sidebar').getBoundingClientRect();
    const b = document.querySelector('webtmux-copy-sidebar').getBoundingClientRect();
    return { winL: Math.round(a.left), winR: Math.round(a.right), copyL: Math.round(b.left), copyR: Math.round(b.right) };
  });
  check('both panels open at once without covering each other',
    geom.copyR <= geom.winL + 2 && geom.copyL < geom.copyR, JSON.stringify(geom));

  // ---- 9. the buffers survive a reload ---------------------------------------
  const beforeReload = (await rows()).map((x) => x.text);
  check('setup: two buffers to carry across the reload', beforeReload.length === 2,
    JSON.stringify(beforeReload));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(4500);
  await openPanel();
  const afterReload = await rows();
  check('the buffers survive a reload',
    JSON.stringify(afterReload.map((x) => x.text)) === JSON.stringify(beforeReload),
    `${JSON.stringify(beforeReload)} -> ${JSON.stringify(afterReload.map((x) => x.text))}`);
  check('and the restored focus is treated as unpasted, so the next copy adds',
    /adds a buffer/.test(afterReload.find((x) => x.focused)?.meta || ''),
    afterReload.find((x) => x.focused)?.meta || '(no focused row)');

  await browser.close();
  const bad = results.filter((r2) => !r2.ok);
  console.log(`\n${results.length - bad.length}/${results.length} passed`);
  process.exit(bad.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
