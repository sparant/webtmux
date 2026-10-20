// Stills for the README sections added after the first tour: the sidebar's
// all-windows tree and new-window menu, the stoplight duration badge, split
// views, file transfer, and the scrollback and link menus.
// Run with DRIVER=driver-features.js (see run.sh); writes into SHOT_DIR.
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const { annotate, clearAnnotations, rectOf } = require('./annotate.js');

const OUT = process.env.SHOT_DIR || '/src/screenshots';
const URL = 'http://localhost:8090/';
const SOCK = '/tmp/wt.sock';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmux = (args) => execSync(`tmux -u -S ${SOCK} ${args}`, { encoding: 'utf8' });

let page;
const failures = [];
const chord = (key) => page.keyboard.press(`Control+Alt+${key}`);
const jpg = (name) => ({ path: `${OUT}/${name}.jpg`, type: 'jpeg', quality: 90 });
const tb = (sel) => page.evaluate((s) => !!document.querySelector('webtmux-toolbar').shadowRoot.querySelector(s), sel);

async function exposeOpen() {
  return page.evaluate(() => {
    const el = document.querySelector('webtmux-expose');
    return !!el && el.hasAttribute('open');
  });
}
async function goTo(name) {
  for (let i = 0; i < 4 && await exposeOpen(); i++) { await page.keyboard.press('Escape'); await sleep(300); }
  await chord('f'); await sleep(600);
  if (!await exposeOpen()) { await chord('f'); await sleep(600); }
  const filtering = await page.evaluate(() => !!document.querySelector('webtmux-expose').shadowRoot.querySelector('.head .filter'));
  if (filtering) { await page.keyboard.press('Escape'); await sleep(300); }
  await page.keyboard.type(name, { delay: 40 }); await sleep(500);
  await page.keyboard.press('Enter'); await sleep(1500);
}

// SHOTS=a,b re-takes just those stills — re-shooting every one for a one-feature
// change rewrites images nobody looked at.
const ONLY = process.env.SHOTS ? process.env.SHOTS.split(',') : null;

async function shot(name, fn) {
  if (ONLY && !ONLY.includes(name)) return;
  try { console.log(`--- ${name}`); await fn(); console.log(`ok  ${name}`); }
  catch (e) {
    console.log(`FAIL ${name}: ${e.message}`); failures.push(name);
    try { await page.screenshot({ path: `${OUT}/_debug-${name}.jpg`, type: 'jpeg', quality: 80 }); } catch {}
    try { await page.keyboard.press('Escape'); await sleep(400); } catch {}
  }
}

// Crop to an element (in its host's shadow root), padded.
async function clipOf(host, sel, pad = 8, extra = {}) {
  const r = await page.evaluate(([h, s]) => {
    const el = document.querySelector(h);
    const t = s ? el.shadowRoot.querySelector(s) : el;
    const b = t.getBoundingClientRect();
    return { x: b.x, y: b.y, width: b.width, height: b.height };
  }, [host, sel]);
  return {
    x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad),
    width: r.width + 2 * pad + (extra.w || 0), height: r.height + 2 * pad + (extra.h || 0),
  };
}


// A dropdown shot that also shows WHERE it opens from: the toolbar button is
// ringed and the crop runs from the top of the toolbar down through the menu.
async function menuShot(name, buttonSel, menuSel) {
  const btn = await rectOf(page, 'webtmux-toolbar', buttonSel);
  const menu = await rectOf(page, 'webtmux-toolbar', menuSel);
  await annotate(page, [{ rect: btn, arrow: 'none' }]);
  const x = Math.max(0, Math.min(btn.x, menu.x) - 12);
  const right = Math.min(1600, Math.max(btn.x + btn.width, menu.x + menu.width) + 12);
  await page.screenshot({ ...jpg(name), clip: { x, y: 0, width: right - x, height: menu.y + menu.height + 12 } });
  await clearAnnotations(page);
}

const setSidebar = (collapsed, overlay) => page.evaluate(([c, o]) => {
  const sb = document.querySelector('webtmux-sidebar'); sb.collapsed = c; sb.overlay = o;
}, [collapsed, overlay]);

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 950 }, deviceScaleFactor: 2,
    httpCredentials: { username: 'wt', password: 'wt' },
  });
  page = await ctx.newPage();
  page.on('dialog', (d) => d.dismiss().catch(() => {}));

  // A new-window menu on the dev session, the way a launcher script declares it.
  const devId = tmux(`display -p -t dev '#{session_id}'`).trim();
  tmux(`set-option -t '${devId}' @wt_newcmds '${JSON.stringify([
    { label: 'shell', cmd: '' },
    { label: 'secure', cmd: 'docker exec -it dev-box bash' },
    { label: 'claude', cmd: 'claude' },
  ])}'`);

  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.xterm', { timeout: 30000 });
  await sleep(3500);
  for (const w of ['logs', 'htop', 'server', 'tests', 'build', 'editor']) await goTo(w);

  // Durations: each agent says when it entered its current state.
  const now = Math.floor(Date.now() / 1000);
  const light = (t, v, ago) => {
    tmux(`set -w -t ${t} @wt_working ${v}`);
    tmux(`set -w -t ${t} @wt_working_since ${now - ago}`);
  };
  light('dev:build', 1, 7 * 60);
  light('dev:tests', 0, 42 * 60);
  light('ops:htop', 2, 3 * 60);
  light('dev:server', 3, 18 * 60);
  light('dev:editor', 1, 95 * 60);
  light('ops:logs', 0, 4 * 3600);
  await sleep(2500);

  await shot('stoplight-duration', async () => {
    const tb = await rectOf(page, 'webtmux-toolbar', null);
    const ages = await page.evaluate(() => [...document.querySelector('webtmux-toolbar').shadowRoot
      .querySelectorAll('.rtab:not(.spare) .work-age')].map((e) => {
        const r = e.getBoundingClientRect(); return { t: e.textContent.trim(), x: r.x, y: r.y, width: r.width, height: r.height };
      }));
    const red = ages.find((a) => a.t === '42m') || ages[ages.length - 1];
    await annotate(page, [{ rect: red, label: 'red for 42 minutes' }], { band: { y: tb.y + tb.height, height: 92 } });
    await page.screenshot({ ...jpg('stoplight-duration'), clip: { x: 0, y: tb.y, width: tb.width, height: tb.height + 92 } });
    await clearAnnotations(page);
  });

  await shot('sidebar-newcmds', async () => {
    await setSidebar(false, false); await sleep(1200);
    const plus = page.locator('webtmux-sidebar').getByText('claude', { exact: false }).first();
    await plus.hover().catch(() => {}); await sleep(1200);
    const c = await clipOf('webtmux-sidebar', null, 0);
    await page.screenshot({ ...jpg('sidebar-newcmds'), clip: { ...c, height: Math.min(c.height, 600) } });
  });

  await shot('sidebar-tree', async () => {
    await page.mouse.move(400, 500);
    await page.evaluate(() => document.querySelector('webtmux-sidebar').toggleTree());
    await sleep(1500);
    await page.screenshot({ ...jpg('sidebar-tree'), clip: await clipOf('webtmux-sidebar', null, 0) });
    await page.evaluate(() => document.querySelector('webtmux-sidebar').toggleTree());
    await setSidebar(true, true); await sleep(800);
  });

  await shot('scrollback-menu', async () => {
    await goTo('server'); // a rolling log, so the gauge has something to show
    await page.locator('webtmux-toolbar').getByLabel('Scrollback buffer').click();
    await sleep(1800);
    await menuShot('scrollback-menu', 'button[aria-label="Scrollback buffer"]', '.save-menu');
    await page.keyboard.press('Escape'); await page.mouse.click(300, 600); await sleep(600);
    await goTo('editor');
  });

  await shot('file-transfer', async () => {
    await page.locator('webtmux-toolbar').getByText('⤓').first().click();
    await sleep(1800);
    await menuShot('file-transfer', 'button[aria-label="Save pane buffer and transfer files"]', '.save-menu');
    await page.keyboard.press('Escape'); await page.mouse.click(300, 600); await sleep(600);
  });

  await shot('link-menu', async () => {
    await page.evaluate(() => document.querySelector('webtmux-toolbar').shadowRoot.querySelector('.spin').click());
    await sleep(1500);
    await menuShot('link-menu', '.spin', '.link-menu');
    await page.keyboard.press('Escape'); await page.mouse.click(800, 600); await sleep(600);
  });

  // Three views — left | right, then the right one split top / bottom — with the
  // pointer near the top of the bottom-right view, so its header controls are up.
  await shot('split-views', async () => {
    await page.evaluate(() => { window.splitManager.sidebar.collapsed = true; });
    await chord('Enter'); await sleep(3000);
    await chord('Shift+Quote'); await sleep(3000);
    const n = await page.evaluate(() => window.splitManager.units.length);
    if (n !== 3) throw new Error(`expected 3 views, got ${n}`);
    const head = await page.evaluate(() => {
      const r = window.splitManager.focusedUnit.region.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + 12 };
    });
    await page.mouse.move(head.x, head.y + 30, { steps: 4 }); await sleep(1200);
    await page.screenshot(jpg('split-views'));
    await page.mouse.move(800, 600); await sleep(800);
    await chord('x'); await sleep(1500);
    await chord('x'); await sleep(1500);
  });

  await browser.close();
  console.log(failures.length ? `DONE with failures: ${failures.join(', ')}` : 'DONE all ok');
  process.exit(failures.length ? 2 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
