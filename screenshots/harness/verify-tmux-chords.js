// Verification driver for the tmux-shaped chords and Exposé's open/close + grid
// setting. Every claim about tmux is asked of tmux over its socket.
//
//   Exposé: ⌃⌥F opens at 3×3 and closes on the next press; ⌃⌥E does nothing; the
//   header's 2×2/3×3 toggle really re-lays-out the tiles and is remembered across
//   close/reopen; a trackpad spread only opens and a pinch only closes.
//   ⌃⌥0–9 selects the window with that index; ⌃⌥% and ⌃⌥" add a region; ⌃⌥O and ⌃⌥;
//   move focus between regions; ⌃⌥& asks before killing and kills on Yes; ⌃⌥] types
//   the focused copy buffer into the pane.
//
// The gesture is Mac-gated, so an init script forges a Mac platform (see os.js).
// Run like run.sh does, with DRIVER=verify-tmux-chords.js.
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
const press = async (k, ms = 900) => { await page.keyboard.press(`Control+Alt+${k}`); await sleep(ms); };
const expose = () => page.evaluate(() => {
  const n = document.querySelector('webtmux-expose');
  const tile = n.shadowRoot.querySelector('.grid > *');
  return { open: n.open, grid: n.density, w: tile ? Math.round(tile.getBoundingClientRect().width) : null };
});
const clickGrid = (label) => page.evaluate((l) => {
  const rr = document.querySelector('webtmux-expose').shadowRoot;
  [...rr.querySelectorAll('.sort button')].find((b) => b.textContent.trim() === l).click();
}, label);
async function pinch(dir) {
  await page.evaluate((d) => window.dispatchEvent(new WheelEvent('wheel',
    { deltaY: -40 * d, ctrlKey: true, bubbles: true, cancelable: true })), dir);
  await sleep(900);
}
const focusedWin = () => mgr((m) => m.focusedUnit?.layout?.activeWindowId);
const focusedIdx = () => mgr((m) => m.units.indexOf(m.focusedUnit));
const regionCount = () => mgr((m) => m.units.length);
const winId = (target) => tmux('display', '-p', '-t', target, '#{window_id}');

async function main() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    httpCredentials: { username: 'wt', password: 'wt' },
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' });
    Object.defineProperty(navigator, 'userAgentData', { get: () => ({ platform: 'macOS' }) });
  });
  page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await sleep(4500);

  // ---- Exposé -------------------------------------------------------------------
  await press('e');
  check('⌃⌥E no longer opens Exposé', !(await expose()).open);
  await press('f');
  let x = await expose();
  check('⌃⌥F opens Exposé at 3×3 by default', x.open && x.grid === 3, JSON.stringify(x));
  const w3 = x.w;
  await clickGrid('2×2'); await sleep(900);
  x = await expose();
  check('the header 2×2 toggle re-lays-out the tiles', x.grid === 2 && x.w > w3, `tile ${w3} → ${x.w}`);
  await press('f');
  check('⌃⌥F again closes it (no stop at another size first)', !(await expose()).open);
  await press('f');
  x = await expose();
  check('the chosen 2×2 is remembered on reopen', x.open && x.grid === 2, JSON.stringify(x));
  await clickGrid('3×3'); await sleep(600);
  await press('f');
  await pinch(+1);
  x = await expose();
  check('a spread opens Exposé', x.open && x.grid === 3, JSON.stringify(x));
  await pinch(+1);
  check('a second spread leaves it open', (await expose()).open);
  await pinch(-1);
  check('a pinch closes it', !(await expose()).open);

  // ---- ⌃⌥0–9 ----------------------------------------------------------------------
  await press('2', 1500);
  check('⌃⌥2 selects window 2 (server)', (await focusedWin()) === winId('dev:2'),
    `focused ${await focusedWin()}, dev:2 is ${winId('dev:2')}`);
  check('…in tmux too', tmux('display', '-p', '-t', 'dev', '#{window_index}') === '2');
  await press('0', 1500);
  check('⌃⌥0 selects window 0 (editor)', (await focusedWin()) === winId('dev:0'));

  // ---- splits + region focus ------------------------------------------------------
  const r0 = await regionCount();
  await press('Shift+Digit5', 2500);
  check('⌃⌥% adds a region', (await regionCount()) === r0 + 1);
  await press("Shift+Quote", 2500);
  check('⌃⌥" adds a region', (await regionCount()) === r0 + 2);
  const f0 = await focusedIdx();
  await press('o', 700);
  const f1 = await focusedIdx();
  check('⌃⌥O moves focus to the next region (wrapping)', f1 === (f0 + 1) % (r0 + 2), `${f0} → ${f1}`);
  await press('o', 700);
  const f2 = await focusedIdx();
  await press(';', 700);
  check('⌃⌥; goes back to the region focused before', (await focusedIdx()) === f1, `${f2} → ${await focusedIdx()}`);
  await press(';', 700);
  check('…and again flips back', (await focusedIdx()) === f2);
  await mgr((m) => { for (const u of m.units.slice(1)) m.removeUnit(u); m.focus(m.units[0]); });
  await sleep(1500);

  // ---- ⌃⌥& --------------------------------------------------------------------------
  tmux('new-window', '-d', '-t', 'dev:', '-n', 'doomed');
  await sleep(1500);
  const doomed = winId('dev:doomed');
  await mgr((m, id) => m.goToWindow(id, m.logicalSession(m.focusedUnit)), doomed);
  await sleep(1800);
  check('setup: focused on the throwaway window', (await focusedWin()) === doomed);
  await press('Shift+Digit7', 1200);
  const asking = await page.evaluate(() => !!document.querySelector('webtmux-sidebar')._confirm?.open);
  check('⌃⌥& asks before killing', asking);
  check('…and nothing is killed while it asks', tmux('list-windows', '-a', '-F', '#{window_id}').split('\n').includes(doomed));
  await page.evaluate(() => {
    const sb = document.querySelector('webtmux-sidebar');
    [...sb.shadowRoot.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Kill').click();
  });
  await sleep(2000);
  check('Yes kills the window in tmux', !tmux('list-windows', '-a', '-F', '#{window_id}').split('\n').includes(doomed));

  // ---- ⌃⌥] ----------------------------------------------------------------------------
  tmux('new-window', '-d', '-t', 'dev:', '-n', 'pastehere');
  await sleep(1500);
  const ph = winId('dev:pastehere');
  await mgr((m, id) => m.goToWindow(id, m.logicalSession(m.focusedUnit)), ph);
  await sleep(1800);
  // The page's own module instance (same URL as webtmux.js imports), so this is the
  // ring the chord reads.
  await page.evaluate(() => import('/js/copy-buffer-store.js')
    .then(({ copyBuffers }) => copyBuffers.copy('echo pasted-by-bracket')));
  await sleep(500);
  await press(']', 1500);
  const screen = tmux('capture-pane', '-p', '-t', ph);
  check('⌃⌥] types the focused copy buffer into the pane', screen.includes('echo pasted-by-bracket'), screen.split('\n').filter(Boolean).slice(-2).join(' | '));
  tmux('kill-window', '-t', ph);

  await browser.close();
  const bad = results.filter((r) => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} passed`);
  process.exit(bad.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
