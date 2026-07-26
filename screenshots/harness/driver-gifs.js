// Record per-feature demo videos (one browser context each); run-gifs.sh turns
// them into the animated gifs the README embeds. Each scene replays its README
// section's bullet list in order, so the gif IS the section's script: split ->
// drag divider -> close; hover row -> live preview -> commit; add preview ->
// PiP -> second window docks -> hide/show; scroll -> select -> copy -> typing
// drops back; reload -> the whole view restores; lights change -> tabs flash
// until viewed.
const { chromium } = require('playwright');
const { execSync } = require('child_process');

const VIDEO_DIR = process.env.VIDEO_DIR || '/tmp/videos';
const URL = 'http://localhost:8090/';
const SOCK = '/tmp/wt.sock';
const W = 1280, H = 760;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmux = (args) => execSync(`tmux -u -S ${SOCK} ${args}`, { encoding: 'utf8' });

let page; // current scene's page
const failures = [];

const chord = (key) => page.keyboard.press(`Control+Alt+${key}`);

async function exposeState() {
  return page.evaluate(() => {
    const el = document.querySelector('webtmux-expose');
    if (!el) return { open: false, filtering: false };
    const rr = el.shadowRoot || el;
    return { open: el.hasAttribute('open'), filtering: !!rr.querySelector('.head .filter') };
  });
}

async function closeExpose() {
  for (let i = 0; i < 4; i++) {
    if (!(await exposeState()).open) return;
    await page.keyboard.press('Escape');
    await sleep(350);
  }
}

async function goTo(name) {
  await closeExpose();
  await chord('e');
  await sleep(600);
  let s = await exposeState();
  if (!s.open) { await chord('e'); await sleep(600); s = await exposeState(); }
  if (s.filtering) { await page.keyboard.press('Escape'); await sleep(350); }
  await page.keyboard.type(name, { delay: 40 });
  await sleep(500);
  await page.keyboard.press('Enter');
  await sleep(700);
  if ((await exposeState()).open) { await closeExpose(); throw new Error(`goTo(${name}) failed`); }
  await sleep(900);
}

const tabOf = (n) => page.locator('webtmux-toolbar').getByText(n, { exact: true }).first();

// A visible fake cursor: playwright videos don't render the pointer, and hover
// demos are meaningless without one. Tracks the synthetic mousemove events.
const CURSOR = () => {
  const attach = () => {
    const d = document.createElement('div');
    d.style.cssText = 'position:fixed;width:16px;height:16px;border-radius:50%;' +
      'background:rgba(255,214,0,.9);border:2px solid rgba(0,0,0,.65);' +
      'box-shadow:0 0 6px rgba(0,0,0,.5);z-index:2147483647;pointer-events:none;' +
      'left:-40px;top:-40px;transition:transform .12s';
    document.body.appendChild(d);
    window.addEventListener('mousemove', (e) => {
      d.style.left = (e.clientX - 8) + 'px'; d.style.top = (e.clientY - 8) + 'px';
    }, true);
    window.addEventListener('mousedown', () => { d.style.transform = 'scale(1.6)'; }, true);
    window.addEventListener('mouseup', () => { d.style.transform = 'scale(1)'; }, true);
  };
  if (document.readyState !== 'loading') attach();
  else window.addEventListener('DOMContentLoaded', attach);
};

// Run fn in a throwaway UNRECORDED context — used to reset UI state between
// scenes so janitor navigation doesn't bloat the recordings.
async function offCamera(browser, fn) {
  const ctx = await browser.newContext({
    viewport: { width: W, height: H },
    httpCredentials: { username: 'wt', password: 'wt' },
  });
  page = await ctx.newPage();
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.xterm', { timeout: 30000 });
  await sleep(2500);
  try { await fn(); } finally { await ctx.close(); }
}

async function scene(browser, name, fn, cleanup) {
  console.log(`--- ${name}`);
  const ctx = await browser.newContext({
    viewport: { width: W, height: H },
    httpCredentials: { username: 'wt', password: 'wt' },
    recordVideo: { dir: VIDEO_DIR, size: { width: W, height: H } },
  });
  try {
    const p = await ctx.newPage();
    await p.addInitScript(CURSOR);
    p.on('dialog', (d) => { console.log(`!! dialog: ${d.message()}`); d.dismiss().catch(() => {}); });
    await p.goto(URL, { waitUntil: 'domcontentloaded' });
    await p.waitForSelector('.xterm', { timeout: 30000 });
    await p.mouse.move(640, 500);
    await sleep(2500);
    // a fresh client starts with the sidebar expanded in hover-overlay mode;
    // scenes that want it open pose it themselves
    await p.evaluate(() => { document.querySelector('webtmux-sidebar').collapsed = true; });
    await sleep(700);
    page = p;
    await fn();
    const video = p.video();
    await ctx.close();
    const path = await video.path();
    execSync(`mv "${path}" "${VIDEO_DIR}/${name}.webm"`);
    console.log(`ok  ${name}`);
  } catch (e) {
    console.log(`FAIL ${name}: ${e.message}`);
    failures.push(name);
    try { await ctx.close(); } catch {}
  }
  if (cleanup) await offCamera(browser, cleanup).catch((e) => console.log(`cleanup ${name}: ${e.message}`));
}

const clearLights = () => {
  for (const w of ['dev:build', 'dev:tests', 'dev:server', 'ops:htop', 'ops:logs', 'scratch:panes']) {
    try { tmux(`set -w -t ${w} -u @wt_working`); } catch {}
  }
};

(async () => {
  const browser = await chromium.launch();

  // ---- setup (not recorded): MRU history so recents tabs exist ---------------
  {
    const ctx = await browser.newContext({
      viewport: { width: W, height: H },
      httpCredentials: { username: 'wt', password: 'wt' },
    });
    page = await ctx.newPage();
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.xterm', { timeout: 30000 });
    await sleep(3000);
    for (const w of ['tests', 'panes', 'shell', 'logs', 'server', 'htop', 'build', 'editor']) {
      await goTo(w);
    }
    await ctx.close();
    console.log('setup done');
  }

  // ---- expose.gif: open -> 2x2 -> 3x3 -> type to filter -> Enter switches ----
  await scene(browser, 'expose', async () => {
    await chord('e');
    await sleep(1600);
    await chord('e'); // densify to 3x3
    await sleep(2000);
    await page.keyboard.type('logs', { delay: 260 });
    await sleep(1400);
    await page.keyboard.press('Enter'); // switch the focused region there
    await sleep(2400);
  }, async () => { await goTo('editor'); });

  // ---- split-view.gif: add a region (auto-picks MRU) -> drag the divider ->
  // ---- close the focused region
  await scene(browser, 'split-view', async () => {
    await chord('Enter');
    await sleep(3000);
    const div = page.locator('.divider').first();
    const box = await div.boundingBox();
    if (box) {
      const x = box.x + box.width / 2, y = box.y + box.height / 2;
      await page.mouse.move(x, y, { steps: 15 });
      await page.mouse.down();
      await page.mouse.move(x + 180, y, { steps: 30 });
      await sleep(300);
      await page.mouse.move(x - 60, y, { steps: 25 });
      await page.mouse.up();
      await sleep(1200);
    }
    await chord('x'); // close the focused (secondary) region
    await sleep(2000);
  });

  // ---- sidebar.gif: toggle open -> hover rows to preview live -> Esc restores
  // ---- -> click a row to commit
  await scene(browser, 'sidebar', async () => {
    await page.evaluate(() => {
      const sb = document.querySelector('webtmux-sidebar');
      sb.collapsed = true; sb.overlay = false; // start hidden, side-by-side pose
    });
    await sleep(800);
    await chord('w'); // toggle it open
    await sleep(1500);
    const row = (n) => page.locator('webtmux-sidebar .window-tab', { hasText: n }).first();
    await row('build').hover();
    await sleep(2000);   // live preview of build
    await row('server').hover();
    await sleep(2000);   // live preview of server
    await page.keyboard.press('Escape');
    await sleep(1800);   // Esc discards the browse: panel closes, view restored
    await chord('w');    // open it again…
    await sleep(1200);
    const target = row('build');
    await target.hover(); await sleep(900);
    await target.click(); // …and click to commit (panel auto-hides, MRU records)
    await sleep(2200);
  }, async () => {
    await page.evaluate(() => {
      const sb = document.querySelector('webtmux-sidebar');
      sb.collapsed = true; sb.overlay = true;
    });
    await sleep(600);
    await goTo('editor');
  });

  // ---- hover-preview.gif: hover a recents tab -> full-size live preview ->
  // ---- move away -> restore
  await scene(browser, 'hover-preview', async () => {
    const tab = tabOf('build');
    const box = await tab.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 30 });
    await sleep(3400); // preview paints once a right-geometry capture lands
    await page.mouse.move(640, 520, { steps: 30 });
    await sleep(2600); // restore
  });

  // ---- copy-scroll.gif: scroll up -> copy mode; drag-select; Cmd/Ctrl+C stays
  // ---- in copy mode; ordinary typing drops back to the prompt
  await scene(browser, 'copy-scroll', async () => {
    await goTo('server');
    await sleep(1200);
    await page.mouse.move(640, 420, { steps: 10 });
    await page.mouse.wheel(0, -700); // scroll up -> copy mode
    await sleep(1800);
    await page.mouse.move(180, 330);
    await page.mouse.down();
    await page.mouse.move(760, 380, { steps: 30 }); // drag selection
    await page.mouse.up();
    await sleep(1400);
    await page.keyboard.press('Control+c'); // copy; selection clears, still in copy mode
    await sleep(1800);
    await page.keyboard.type('ls', { delay: 200 }); // plain typing -> back to the prompt
    await sleep(2200);
  }, async () => {
    await page.keyboard.press('Backspace'); await page.keyboard.press('Backspace');
    await goTo('editor');
  });

  // ---- save-file.gif: open the save dropdown -> filename -> Save ------------
  await scene(browser, 'save-file', async () => {
    await goTo('server');
    const btn = page.locator('webtmux-toolbar').getByText('⤓').first();
    await btn.hover(); await sleep(800);
    await btn.click();
    await sleep(2200);
    const save = page.getByText('Save', { exact: true }).first();
    await save.hover(); await sleep(600);
    await save.click();
    await sleep(3000); // result message names where the file landed
    await page.mouse.click(640, 600);
    await sleep(800);
  }, async () => { await goTo('editor'); });

  // ---- state-persistence.gif: pose a split view -> reload the browser ->
  // ---- every region, tab and pref comes back
  await scene(browser, 'state-persistence', async () => {
    await chord('Enter'); // add a split so the restore is unmistakable
    await sleep(2800);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.xterm', { timeout: 30000 });
    await page.mouse.move(640, 700);
    await sleep(1200);
    await page.evaluate(() => { document.querySelector('webtmux-sidebar').collapsed = true; });
    await sleep(4000); // watch the split + recents strip re-assemble
    await chord('x');
    await sleep(1200);
  });

  // ---- stoplights.gif (toolbar-alerts.gif is a crop of the same take):
  // ---- lights change live; tabs/rows flash until the window is viewed
  await scene(browser, 'stoplights', async () => {
    clearLights();
    await page.evaluate(() => {
      const sb = document.querySelector('webtmux-sidebar');
      sb.collapsed = false; sb.overlay = false;
    });
    await sleep(1800);
    tmux('set -w -t dev:build @wt_working 1');   // build goes green
    tmux('set -w -t ops:htop @wt_working 1');    // htop goes green
    tmux('set -w -t dev:tests @wt_working 1');   // tests goes green (tabless)
    await sleep(2400);
    tmux('set -w -t ops:htop @wt_working 2');    // htop prompts -> amber, flashes
    await sleep(2600);
    tmux('set -w -t dev:tests @wt_working 0');   // tests drops to red -> attention arrow
    await sleep(3200);
    const htopTab = tabOf('htop');
    await htopTab.hover(); await sleep(900);
    await htopTab.click();                        // viewing htop stops its flash
    await sleep(3000);
  }, async () => {
    await page.evaluate(() => {
      const sb = document.querySelector('webtmux-sidebar');
      sb.collapsed = true; sb.overlay = true;
    });
    await sleep(600);
    clearLights();
  });

  // ---- preview-pip.gif: one window -> corner PiP; a second -> docked bar;
  // ---- hide/show; PiP blanks while you view its window
  await scene(browser, 'preview-pip', async () => {
    await goTo('htop');
    await chord('i');              // htop joins the preview
    await sleep(1000);
    await tabOf('editor').click(); // away -> corner PiP paints htop
    await sleep(3200);
    await tabOf('server').click();
    await sleep(1500);             // let the switch land before toggling
    await chord('i');              // server joins too -> tiles dock as an edge bar
    await sleep(800);
    await tabOf('editor').click();
    await sleep(3200);
    await chord('h');              // hide the preview…
    await sleep(1600);
    await chord('h');              // …and bring it back, windows intact
    await sleep(2200);
  }); // last scene: nothing after this needs a clean toolbar


  await browser.close();
  console.log(failures.length ? `DONE with failures: ${failures.join(', ')}` : 'DONE all ok');
  process.exit(failures.length ? 2 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
