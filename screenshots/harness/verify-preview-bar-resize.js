// Verification driver for the drag-resizable preview BAR.
//
// The node tests (test/preview-bar-size.test.mjs) pin the clamp and the per-instance
// keying in the abstract; this drives the real grip with a real pointer:
//
//   1. Dragging the bar's inner edge resizes it live, and the reserved #app edge follows.
//   2. The tiles scale with the bar (a bottom bar's tile is 1.5× its height wide).
//   3. Each axis keeps its own size: a side bar has its own width, and the bottom bar's
//      height comes back when it is docked at the bottom again.
//   4. The drag is clamped: it cannot take more than 75% of the viewport.
//   5. The size lands in tmux's @wt_state under pip.barSize[<instance port>].
//   6. It survives a reload.
//   7. Double-clicking the grip resets it to the default.
//
// Run exactly like run.sh does, with DRIVER=verify-preview-bar-resize.js.
const { chromium } = require('playwright');
const { execSync } = require('child_process');

const URL = 'http://localhost:8090/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let page;
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

const mgr = (fn, arg) => page.evaluate(([f, a]) => eval(f)(window.splitManager, a), [fn.toString(), arg]);
const pip = (fn, arg) => page.evaluate(([f, a]) => {
  const el = document.querySelector('webtmux-pip');
  return eval(f)(el, el.shadowRoot, a);
}, [fn.toString(), arg]);

const measure = () => pip((el, rr) => {
  const bar = rr.querySelector('.bar').getBoundingClientRect();
  const tile = rr.querySelector('.bar .ptile');
  const grip = rr.querySelector('.bar .grip');
  const css = getComputedStyle(document.documentElement);
  const g = grip && grip.getBoundingClientRect();
  return {
    edge: el.edge,
    h: Math.round(bar.height), w: Math.round(bar.width),
    tileW: tile ? Math.round(tile.getBoundingClientRect().width) : 0,
    tileH: tile ? Math.round(tile.getBoundingClientRect().height) : 0,
    grip: g ? { x: g.x + g.width / 2, y: g.y + g.height / 2 } : null,
    reserved: ['top', 'bottom', 'left', 'right'].map((e) => css.getPropertyValue('--wt-preview-' + e).trim()),
    instance: window.webtmux_instance,
  };
});

async function drag(dx, dy) {
  const m = await measure();
  await page.mouse.move(m.grip.x, m.grip.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(m.grip.x + (dx * i) / 8, m.grip.y + (dy * i) / 8);
  await page.mouse.up();
  await sleep(600);
}

const wtState = () => JSON.parse(execSync('tmux -S /tmp/wt.sock show-options -gqv @wt_state').toString() || '{}');

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

  await mgr((m) => {
    for (const id of [...m.pip.windowIds()]) m.pip.removeWindow(id);
    m.pip.setHidden(false);
    m.pip.setEdge('bottom');
    for (const sb of document.querySelectorAll('webtmux-sidebar')) { sb.collapsed = true; sb.overlay = true; }
  });
  await sleep(800);
  await page.keyboard.press('Control+Alt+i');
  await sleep(1500);

  let m = await measure();
  check('config.js names this instance by its port', m.instance === '8090', String(m.instance));
  check('the bar starts at the default 200px', m.h === 200 && m.reserved[1] === '200px', JSON.stringify(m));
  check('…with a grip on its inner edge', !!m.grip && Math.abs(m.grip.y - (900 - 200)) <= 4, JSON.stringify(m.grip));

  // 1+2. drag the bottom bar's top edge up by 120px
  await drag(0, -120);
  m = await measure();
  check('dragging the grip up grows a bottom bar', m.h === 320, `h=${m.h}`);
  check('…and the reserved edge follows', m.reserved[1] === '320px', JSON.stringify(m.reserved));
  check('…and its tiles scale with it (1.5× wide)', Math.abs(m.tileW - 480) <= 2, `tileW=${m.tileW}`);

  // 3. side axis keeps its own size
  await mgr((m2) => m2.pip.setEdge('left'));
  await sleep(800);
  m = await measure();
  check('a left bar starts at its own default width', m.w === 200 && m.reserved[2] === '200px', JSON.stringify(m));
  await drag(100, 0);
  m = await measure();
  check('dragging a left bar\'s right edge widens it', m.w === 300 && m.reserved[2] === '300px', JSON.stringify(m));
  await mgr((m2) => m2.pip.setEdge('bottom'));
  await sleep(800);
  m = await measure();
  check('back at the bottom, the bottom height is remembered', m.h === 320, `h=${m.h}`);

  // 4. clamp
  await drag(0, -2000);
  m = await measure();
  check('a drag is clamped to 75% of the viewport', m.h === 675, `h=${m.h}`);
  await drag(0, m.h - 320);   // back to 320
  m = await measure();
  check('setup: back to 320', m.h === 320, `h=${m.h}`);

  // 5. persisted in tmux, keyed by instance
  await sleep(1500);
  const st = wtState();
  const bs = st.pip && st.pip.barSize;
  check('@wt_state holds pip.barSize keyed by instance port',
    bs && bs['8090'] && bs['8090'].tb === 320 && bs['8090'].lr === 300, JSON.stringify(bs));

  // 6. reload
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(4500);
  m = await measure();
  check('the size survives a reload', m.h === 320 && m.reserved[1] === '320px', JSON.stringify(m));

  // 7. reset
  await page.mouse.dblclick(m.grip.x, m.grip.y);
  await sleep(1500);
  m = await measure();
  check('double-clicking the grip resets to 200', m.h === 200, `h=${m.h}`);
  check('…and the reset is persisted', wtState().pip.barSize['8090'].tb === 200, JSON.stringify(wtState().pip.barSize));

  if (process.env.SHOTS) {
    require('fs').mkdirSync('/src/screenshots/verify', { recursive: true });
    await page.screenshot({ path: '/src/screenshots/verify/bar-resize.png' });
  }
  await browser.close();
  const bad = results.filter((r) => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} passed`);
  process.exit(bad.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
