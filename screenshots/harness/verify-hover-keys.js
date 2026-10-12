// Verification driver: Escape and Enter answer a hover preview wherever it came from,
// not only the sidebar's keyboard browse.
//
//   1. Pointing at a recents tab opens a preview; Escape puts the region back (tmux
//      never switched) and Enter, on a second preview, switches tmux to that window.
//   2. The same from a docked preview-bar tile.
//   3. With focus left on a toolbar BUTTON after a click (⛁ opened and closed), the
//      keys still answer the preview.
//   4. With no preview up, Enter still reaches the shell — the keys are only taken
//      while a preview is actually drawn.
//
// Run like run.sh does, with DRIVER=verify-hover-keys.js.
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');

const URL = 'http://localhost:8090/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmux = (...a) => execFileSync('tmux', ['-S', '/tmp/wt.sock', ...a], { encoding: 'utf8' }).trim();

let page;
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}
const mgr = (fn, arg) => page.evaluate(([f, a]) => eval(f)(window.splitManager, a), [fn.toString(), arg]);
const state = () => mgr((m) => ({
  target: m.hover.windowId, drawn: !!m.hover.activeUnit,
  focused: m.focusedUnit?.layout?.activeWindowId,
}));
const winId = (t) => tmux('display', '-p', '-t', t, '#{window_id}');
const tmuxActive = () => tmux('display', '-p', '-t', 'dev', '#{window_id}');
const go = (id) => mgr((m, i) => m.goToWindow(i, m.logicalSession(m.focusedUnit)), id);

async function waitDrawn(ms = 4000) {
  for (let t = 0; t < ms; t += 150) { if ((await state()).drawn) return true; await sleep(150); }
  return false;
}
// Centre of an element one shadow root down.
const centre = (host, sel, text) => page.evaluate(([h, s, tx]) => {
  const els = [...document.querySelector(h).shadowRoot.querySelectorAll(s)];
  const el = tx ? els.find((e) => e.textContent.includes(tx)) : els[0];
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}, [host, sel, text]);

async function main() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    httpCredentials: { username: 'wt', password: 'wt' },
  });
  page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await sleep(4500);

  const editor = winId('dev:0'), build = winId('dev:1'), server = winId('dev:2');
  for (const id of [server, build, editor]) { await go(id); await sleep(1200); }
  check('setup: on editor, with build and server in the recents strip', tmuxActive() === editor);

  // ---- 1. recents tab -----------------------------------------------------------
  const tab = await centre('webtmux-toolbar', '.rtab:not(.spare)', 'build');
  await page.mouse.move(tab.x, tab.y);
  check('pointing at the build tab draws a preview', await waitDrawn());
  await page.keyboard.press('Escape');
  await sleep(500);
  let s = await state();
  check('Escape drops it', !s.drawn && !s.target, JSON.stringify(s));
  check('…and tmux never left editor', tmuxActive() === editor);

  await page.mouse.move(800, 600); await sleep(600);
  await page.mouse.move(tab.x, tab.y);
  await waitDrawn();
  await page.keyboard.press('Enter');
  await sleep(1500);
  check('Enter switches to the previewed window', tmuxActive() === build && (await state()).focused === build,
    `tmux=${tmuxActive()} want=${build}`);
  await page.mouse.move(800, 600); await sleep(600);

  // ---- 2. preview-bar tile ----------------------------------------------------
  await go(server); await sleep(1200);
  await page.keyboard.press('Control+Alt+i'); await sleep(800);   // server into the bar
  await go(editor); await sleep(2500);
  const tile = await centre('webtmux-pip', '.bar .ptile');
  check('setup: server is a tile in the preview bar', !!tile);
  await page.mouse.move(tile.x, tile.y);
  check('pointing at the tile draws a preview', await waitDrawn());
  await page.keyboard.press('Escape'); await sleep(500);
  check('Escape drops a tile preview too', !(await state()).drawn && tmuxActive() === editor);
  await page.mouse.move(800, 600); await sleep(600);
  await page.mouse.move(tile.x, tile.y);
  await waitDrawn();
  await page.keyboard.press('Enter'); await sleep(1500);
  check('Enter on a tile preview switches to it', tmuxActive() === server, `tmux=${tmuxActive()}`);
  await page.mouse.move(800, 600); await sleep(600);
  await page.keyboard.press('Control+Alt+i'); await sleep(800);   // take it back out
  await go(editor); await sleep(1500);

  // ---- 3. focus left on a toolbar button --------------------------------------
  await page.locator('webtmux-toolbar').getByLabel('Scrollback buffer').click(); await sleep(600);
  await page.mouse.click(800, 600); await sleep(600);              // the backdrop closes it
  await page.evaluate(() => document.querySelector('webtmux-toolbar').shadowRoot
    .querySelector('button[aria-label="Scrollback buffer"]').focus());
  const focusHost = await page.evaluate(() => document.activeElement?.tagName);
  await page.mouse.move(tab.x, tab.y);
  await waitDrawn();
  await page.keyboard.press('Escape'); await sleep(500);
  check('Escape still answers with focus on a toolbar button', !(await state()).drawn, `focus=${focusHost}`);
  await page.mouse.move(800, 600); await sleep(800);

  // ---- 4. no preview: Enter belongs to the shell ------------------------------
  await page.mouse.click(400, 500); await sleep(400);   // focus the terminal
  tmux('send-keys', '-t', editor, 'clear', 'Enter'); await sleep(500);
  await page.keyboard.type('echo enter-reached-shell');
  await page.keyboard.press('Enter'); await sleep(900);
  const out = tmux('capture-pane', '-p', '-t', editor);
  check('with no preview up, Enter reaches the shell', /^enter-reached-shell$/m.test(out),
    out.split('\n').filter(Boolean).slice(-2).join(' | '));

  await browser.close();
  const bad = results.filter((r) => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} passed`);
  process.exit(bad.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
