// Drive the real webtmux UI and capture one screenshot per README fork-feature.
const { chromium } = require('playwright');
const { execSync } = require('child_process');

const OUT = process.env.SHOT_DIR || '/src/screenshots';
const URL = 'http://localhost:8090/';
const SOCK = '/tmp/wt.sock';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmux = (args) => execSync(`tmux -u -S ${SOCK} ${args}`, { encoding: 'utf8' });

let page;
const failures = [];

async function chord(key) {
  await page.keyboard.press(`Control+Alt+${key}`);
}

// Exposé DOM state: is it open, and is a type-ahead filter active? (The filter
// persists across close/reopen by design, so we must observe, not assume.)
async function exposeState() {
  return page.evaluate(() => {
    const el = document.querySelector('webtmux-expose');
    if (!el) return { open: false, filtering: false, header: '' };
    const rr = el.shadowRoot || el;
    const head = rr.querySelector('.head');
    return {
      open: el.hasAttribute('open'),
      filtering: !!rr.querySelector('.head .filter'),
      header: head ? head.textContent.trim().slice(0, 80) : '',
    };
  });
}

async function closeExpose() {
  for (let i = 0; i < 4; i++) {
    const s = await exposeState();
    if (!s.open) return;
    await page.keyboard.press('Escape'); // clears filter first, then closes
    await sleep(350);
  }
}

// Open Exposé with an empty filter, whatever state it was left in.
async function openExpose() {
  await closeExpose();
  await chord('e');
  await sleep(600);
  let s = await exposeState();
  if (!s.open) { await chord('e'); await sleep(600); s = await exposeState(); }
  if (!s.open) throw new Error('expose did not open');
  if (s.filtering) { await page.keyboard.press('Escape'); await sleep(350); }
}

// Navigate the focused region via Exposé's type-to-filter + Enter.
async function goTo(name) {
  await openExpose();
  await page.keyboard.type(name, { delay: 40 });
  await sleep(500);
  await page.keyboard.press('Enter');
  await sleep(700);
  const s = await exposeState();
  if (s.open) {
    await closeExpose();
    throw new Error(`goTo(${name}) did not commit (header: ${s.header})`);
  }
  await sleep(900);
}

async function shot(name, fn) {
  try {
    console.log(`--- ${name}`);
    await fn();
    console.log(`ok  ${name}`);
  } catch (e) {
    console.log(`FAIL ${name}: ${e.message}`);
    failures.push(name);
    try { await page.screenshot({ path: `${OUT}/_debug-${name}.jpg`, type: 'jpeg', quality: 80 }); } catch {}
    // try to reset transient UI
    try { await page.keyboard.press('Escape'); await sleep(400); } catch {}
  }
}

const jpg = (name) => ({ path: `${OUT}/${name}.jpg`, type: 'jpeg', quality: 90 });

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 950 },
    deviceScaleFactor: 2,
    httpCredentials: { username: 'wt', password: 'wt' },
  });
  page = await ctx.newPage();
  page.on('dialog', (d) => { console.log(`!! native dialog: ${d.message()}`); d.dismiss().catch(() => {}); });
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[console.error] ${m.text()}`); });

  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.xterm', { timeout: 30000 });
  await sleep(3500);
  console.log('page up');

  // ---- build MRU history: visit windows oldest-first --------------------------
  for (const w of ['tests', 'panes', 'shell', 'logs', 'htop', 'server', 'build', 'editor']) {
    await goTo(w);
  }
  await sleep(1000);

  // ---- stoplights: green build, amber htop, and invisible windows dropping ----
  tmux('set -w -t dev:build @wt_working 1');
  tmux('set -w -t ops:htop @wt_working 1');
  tmux('set -w -t dev:tests @wt_working 1');
  tmux('set -w -t scratch:panes @wt_working 1');
  await sleep(1500); // let the UI see them green
  tmux('set -w -t ops:htop @wt_working 2');  // amber: prompting (visible tab -> flash)
  tmux('set -w -t dev:tests @wt_working 0'); // red, no tab anywhere -> attention arrow
  tmux('set -w -t scratch:panes @wt_working 0'); // second arrow candidate... has a tab? visited early, likely evicted
  await sleep(1800);

  await shot('toolbar-recents', async () => {
    await page.locator('webtmux-toolbar').screenshot(jpg('toolbar-recents'));
  });

  // The sidebar defaults to hover-overlay + auto-hide (invisible until you hover
  // the edge), so pose it side-by-side via its own state for a legible shot.
  const setSidebar = (collapsed, overlay) => page.evaluate(([c, o]) => {
    const sb = document.querySelector('webtmux-sidebar');
    sb.collapsed = c; sb.overlay = o;
  }, [collapsed, overlay]);

  await shot('stoplights', async () => {
    await setSidebar(false, false);
    await sleep(1200);
    await page.screenshot(jpg('stoplights'));
  });

  await shot('sidebar', async () => {
    // sidebar open side-by-side; hover a row to show the kill/unlink ×
    const row = page.locator('webtmux-sidebar').getByText('logs', { exact: true }).first();
    await row.hover().catch(() => {});
    await sleep(700);
    const sbBox = await page.locator('webtmux-sidebar').boundingBox();
    await page.screenshot({
      ...jpg('sidebar'),
      clip: { x: sbBox.x, y: sbBox.y, width: sbBox.width, height: Math.min(sbBox.height, 560) },
    });
    await page.mouse.move(700, 500);
    await setSidebar(true, true); // back to default look for later shots
    await sleep(600);
  });

  await shot('split-view', async () => {
    await chord('Enter');
    await sleep(2500);
    await page.screenshot(jpg('split-view'));
  });

  await shot('expose', async () => {
    // keep the split open — Exposé over a split shows region context; close split after
    await openExpose();
    await chord('e'); // 2x2 -> 3x3 so all 9 windows show
    await sleep(1500);
    await page.screenshot(jpg('expose'));
  });

  await shot('capture-infra', async () => {
    // close-up of live Exposé thumbnails (the client capture cache at work)
    // clip to the union of the first 2x2 block of tiles for a clean close-up
    const clip = await page.evaluate(() => {
      const el = document.querySelector('webtmux-expose');
      const rr = el.shadowRoot || el;
      const tiles = [...rr.querySelectorAll('.tile')].slice(0, 5).map((t) => t.getBoundingClientRect());
      if (!tiles.length) return null;
      const wanted = tiles.length >= 5 ? [tiles[0], tiles[1], tiles[3], tiles[4]] : tiles;
      const x = Math.min(...wanted.map((r) => r.x)) - 6;
      const y = Math.min(...wanted.map((r) => r.y)) - 6;
      return {
        x, y,
        width: Math.max(...wanted.map((r) => r.right)) + 6 - x,
        height: Math.max(...wanted.map((r) => r.bottom)) + 6 - y,
      };
    });
    if (!clip) throw new Error('no tiles');
    await page.screenshot({ ...jpg('capture-infra'), clip });
    await closeExpose();
    await sleep(500);
  });

  // close the split region again
  await shot('close-split', async () => {
    await chord('x');
    await sleep(1200);
  });

  await shot('preview-pip', async () => {
    await goTo('htop');
    await chord('i'); // add htop to preview
    await sleep(600);
    await goTo('editor'); // move away -> corner PiP paints htop
    await sleep(2000);
    await page.screenshot(jpg('preview-pip'));
  });

  await shot('preview-bar', async () => {
    await goTo('server');
    await chord('i');
    await sleep(600);
    await goTo('editor');
    await sleep(2000);
    await page.screenshot(jpg('preview-bar'));
    await chord('h'); // hide preview for later shots
    await sleep(600);
  });

  await shot('hover-preview', async () => {
    const tab = page.locator('webtmux-toolbar').getByText('build', { exact: true }).first();
    await tab.hover();
    await sleep(1800); // preview waits for a fresh right-geometry capture
    await page.screenshot(jpg('hover-preview'));
    await page.mouse.move(800, 600);
    await sleep(1200);
  });

  await shot('copy-scroll', async () => {
    await goTo('server'); // continuous output -> scrollback
    await sleep(1500);
    await page.mouse.move(700, 500);
    await page.mouse.wheel(0, -600); // scroll up -> copy mode
    await sleep(1200);
    // drag-select a couple of log lines
    await page.mouse.move(240, 420);
    await page.mouse.down();
    await page.mouse.move(950, 470, { steps: 12 });
    await page.mouse.up();
    await sleep(800);
    await page.screenshot(jpg('copy-scroll'));
    await page.keyboard.press('Control+c'); // copy — also clears the selection highlight
    await sleep(400);
    await chord('['); // leave copy mode
    await sleep(800);
  });

  await shot('save-file', async () => {
    await closeExpose();
    const btn = page.locator('webtmux-toolbar').getByText('⤓').first();
    await btn.click();
    await sleep(1200);
    await page.screenshot(jpg('save-file'));
    await page.mouse.click(700, 700); // click outside the dropdown to close it
    await sleep(600);
  });

  await shot('keyboard-shortcuts', async () => {
    await chord('/');
    await sleep(1000);
    await page.screenshot(jpg('keyboard-shortcuts'));
    await page.keyboard.press('Escape');
    await sleep(600);
  });

  await shot('terminal-rendering', async () => {
    await goTo('panes');
    await sleep(1500);
    await page.screenshot(jpg('terminal-rendering'));
  });

  await shot('build-reliability', async () => {
    await chord('b');
    await sleep(700);
    await page.locator('webtmux-toolbar').screenshot(jpg('build-reliability'));
    await chord('b');
    await sleep(400);
  });

  await shot('state-persistence', async () => {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.xterm', { timeout: 30000 });
    await page.mouse.move(700, 800); // park the mouse so no tooltip pops
    await sleep(4000); // restore + recents strip back
    await goTo('state');
    tmux(`send-keys -t scratch:state "clear; bash /tmp/state-dump.sh" Enter`);
    await sleep(2500);
    await page.screenshot(jpg('state-persistence'));
  });

  console.log(failures.length ? `DONE with failures: ${failures.join(', ')}` : 'DONE all ok');
  await browser.close();
  process.exit(failures.length ? 2 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
