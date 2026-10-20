// Record per-feature demo videos (one browser context each); run-gifs.sh turns
// them into the animated gifs the README embeds. Each scene replays its README
// section's bullet list in order, so the gif IS the section's script: split ->
// drag divider -> close; hover row -> live preview -> commit; add preview ->
// PiP -> second window docks -> hide/show; scroll -> select -> copy -> typing
// drops back; reload -> the whole view restores; lights change -> tabs flash
// until viewed.
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const { annotate, rectOf } = require('./annotate.js');

const VIDEO_DIR = process.env.VIDEO_DIR || '/tmp/videos';
const URL = 'http://localhost:8090/';
const SOCK = '/tmp/wt.sock';
const W = 1280, H = 760;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmux = (args) => execSync(`tmux -u -S ${SOCK} ${args}`, { encoding: 'utf8' });

let page; // current scene's page
const failures = [];

// SCENES=copy-buffers,expose records ONLY those scenes. Regenerating every gif
// for a one-feature change rewrites nine binaries that nobody looked at, and a
// diff full of unrelated re-encodes is a diff nobody can review.
const ONLY = (process.env.SCENES || '').split(',').map((s) => s.trim()).filter(Boolean);

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
  await chord('f');
  await sleep(600);
  let s = await exposeState();
  if (!s.open) { await chord('f'); await sleep(600); s = await exposeState(); }
  if (s.filtering) { await page.keyboard.press('Escape'); await sleep(350); }
  await page.keyboard.type(name, { delay: 40 });
  await sleep(500);
  await page.keyboard.press('Enter');
  await sleep(700);
  if ((await exposeState()).open) { await closeExpose(); throw new Error(`goTo(${name}) failed`); }
  await sleep(900);
}

const tabOf = (n) => page.locator('webtmux-toolbar').getByText(n, { exact: true }).first();

// Where one text CELL is on screen. A drag that is meant to grab particular
// words has to be aimed at them; guessed pixels select whatever happens to be
// under them, which makes a gif that demonstrates nothing in particular.
async function cellGeom() {
  return page.evaluate(() => {
    const t = window.splitManager.focusedUnit.terminal;
    const r = document.querySelector('.xterm-screen').getBoundingClientRect();
    return { left: r.left, top: r.top, cw: r.width / t.cols, ch: r.height / t.rows };
  });
}

// Drag across columns [from, to) of one row, as a person would, and report what
// was actually caught so a mis-aimed take is visible in the log rather than in
// the gif.
async function dragSelect(row, from, to) {
  const g = await cellGeom();
  const y = g.top + (row + 0.5) * g.ch;
  await page.mouse.move(g.left + from * g.cw + 1, y, { steps: 8 });
  await page.mouse.down();
  await page.mouse.move(g.left + to * g.cw, y, { steps: 25 });
  await page.mouse.up();
  const sel = await page.evaluate(() => window.splitManager.focusedUnit.terminal.getSelection());
  console.log(`   selected row ${row}: ${JSON.stringify(sel)}`);
  return sel;
}

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
  if (ONLY.length && !ONLY.includes(name)) { console.log(`--- ${name} (skipped)`); return; }
  console.log(`--- ${name}`);
  const ctx = await browser.newContext({
    viewport: { width: W, height: H },
    httpCredentials: { username: 'wt', password: 'wt' },
    recordVideo: { dir: VIDEO_DIR, size: { width: W, height: H } },
    // Without this, navigator.clipboard.readText() rejects and Ctrl+V does
    // NOTHING — silently, since the paste path only console.warns. A scene that
    // demonstrates pasting then records a prompt that never changes.
    permissions: ['clipboard-read', 'clipboard-write'],
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

  // ---- expose.gif: open (3×3) -> header Grid 2×2 -> back to 3×3 -> type to
  // ---- filter -> Enter switches
  await scene(browser, 'expose', async () => {
    await chord('f');
    await sleep(2000);
    const grid = async (label) => {
      const b = page.locator('webtmux-expose').getByText(label, { exact: true });
      await b.hover(); await sleep(500); await b.click(); await sleep(1800);
    };
    await grid('2×2');
    await grid('3×3');
    await page.mouse.move(640, 500);
    await page.keyboard.type('logs', { delay: 260 });
    await sleep(1400);
    await page.keyboard.press('Enter'); // switch the focused region there
    await sleep(2400);
  }, async () => { await goTo('editor'); });

  // ---- split-view.gif: split left | right from the ⊞ ▾ menu -> split top / bottom
  // ---- (Ctrl+Alt+") -> the header's controls fade in near the top of a view -> ↑
  // ---- trades two views -> a full-width view along the bottom (⊞ ▾ again) -> a
  // ---- recents tab lands in the FOCUSED view -> drag a divider -> ✕ closes views
  // ---- until one is left
  if (!ONLY.length || ONLY.includes('split-view')) {
    // Off camera: a single view and a strip with tabs to click, whatever an earlier
    // scene (or run) left behind in the shared state. Quiet windows on purpose — the
    // new views auto-pick the most recent (tests, then shell), and a gif of scrolling
    // logs is mostly the logs, at several times the size.
    await offCamera(browser, async () => {
      await page.evaluate(async () => {
        const m = window.splitManager;
        for (const u of m.units.slice(1)) m.removeUnit(u);
        for (const name of ['server', 'panes', 'shell', 'tests', 'editor']) {
          const w = (m._placements || []).find((p) => p.name === name);
          if (!w) continue;
          m.goToWindow(w.id, w.session);
          await new Promise((r) => setTimeout(r, 1500));
        }
      });
      await sleep(800);
    });
  }
  await scene(browser, 'split-view', async () => {
    const glide = async (pt, steps = 20) => { await page.mouse.move(pt.x, pt.y, { steps }); };
    const tbBox = (sel) => page.evaluate((s) => {
      const r = document.querySelector('webtmux-toolbar').shadowRoot.querySelector(s).getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, sel);
    // The centre of a header control of view n, or of view n's top strip.
    const headBox = (n, sel) => page.evaluate(([i, s]) => {
      const h = window.splitManager.units[i].head;
      const el = s ? h.shadowRoot.querySelector(s) : h;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, [n, sel]);

    // 1. Split left | right from the menu.
    await glide(await tbBox('.split-wrap .tbtn'));
    await sleep(300);
    await page.mouse.click((await tbBox('.split-wrap .tbtn')).x, (await tbBox('.split-wrap .tbtn')).y);
    await sleep(600);
    const item = await tbBox('.split-menu .mitem');
    await glide(item, 8);
    await sleep(300);
    await page.mouse.click(item.x, item.y);
    await sleep(1500);

    // 2. Split the new (right) view top / bottom from the keyboard.
    await glide({ x: 960, y: 500 });
    await chord('Shift+Quote');
    await sleep(1600);

    // 3. Near the top of the bottom-right view its controls fade in; ↑ trades it with
    // the view above.
    const strip = await headBox(2, null);
    await glide({ x: strip.x, y: strip.y + 120 }, 10);
    await sleep(300);
    await glide({ x: strip.x + 150, y: strip.y + 6 }, 12);
    await sleep(500);
    const up = await headBox(2, '.tbtn.up');
    await glide(up, 9);
    await sleep(300);
    await page.mouse.click(up.x, up.y);
    await sleep(1000);

    // 3b. Now that the screen is split the menu also adds a view across the WHOLE
    // screen: full width, along the bottom, under both halves.
    const btn = await tbBox('.split-wrap .tbtn');
    await glide(btn, 14);
    await sleep(300);
    await page.mouse.click(btn.x, btn.y);
    await sleep(700);
    const wide = await page.evaluate(() => {
      const r = document.querySelector('webtmux-toolbar').shadowRoot.querySelectorAll('.split-menu .mitem')[3].getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await glide(wide, 10);
    await sleep(500);
    await page.mouse.click(wide.x, wide.y);
    await sleep(1600);

    // 4. Focus the left view and pick a recents tab: it lands THERE.
    const left = await page.evaluate(() => {
      const r = window.splitManager.units[0].region.querySelector('.region-term').getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await glide(left, 13);
    await page.mouse.click(left.x, left.y);
    await sleep(500);
    // A tab whose window the left view is not showing — one another view has makes the
    // point best (the two views trade), but any will do.
    const tb = await page.evaluate(() => {
      const m = window.splitManager;
      const mine = m.focusedUnit.layout?.activeWindowId;
      const shown = new Set(m.units.map((u) => u.layout?.activeWindowId));
      const tabs = [...document.querySelector('webtmux-toolbar').shadowRoot.querySelectorAll('.rtab:not(.spare)')];
      const rec = m.toolbar.recent || [];
      let i = rec.findIndex((e) => e.id !== mine && shown.has(e.id));
      if (i < 0) i = rec.findIndex((e) => e.id !== mine);
      const r = tabs[i]?.getBoundingClientRect();
      return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
    });
    if (tb) {
      await glide({ x: tb.x + tb.width / 2, y: tb.y + tb.height / 2 }, 14);
      await sleep(700);
      await page.mouse.click(tb.x + tb.width / 2, tb.y + tb.height / 2);
      await sleep(1300);
    }

    // 5. Drag the left | right divider.
    const div = page.locator('.divider.row').first();
    const box = await div.boundingBox();
    if (box) {
      const x = box.x + box.width / 2, y = box.y + box.height / 2;
      await glide({ x, y }, 12);
      await page.mouse.down();
      await page.mouse.move(x - 160, y, { steps: 20 });
      await sleep(300);
      await page.mouse.move(x - 60, y, { steps: 13 });
      await page.mouse.up();
      await sleep(700);
    }

    // 6. ✕ closes views — the next one takes the focus — down to one.
    for (const n of [3, 2, 1]) {
      const s2 = await headBox(n, null);
      await glide({ x: s2.x, y: s2.y + 60 }, 10);
      await glide({ x: s2.x, y: s2.y + 4 }, 6);
      await sleep(400);
      const x2 = await headBox(n, '.tbtn.close');
      await glide(x2, 8);
      await sleep(400);
      await page.mouse.click(x2.x, x2.y);
      await sleep(1000);
    }
    await glide({ x: 640, y: 500 }, 10);
    await sleep(700);
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

  // ---- copy-buffers.gif: copy twice WITHOUT pasting -> two buffers, not one
  // ---- overwritten; each copy floats the panel in by itself; then pick a row
  // ---- and that is what ⌘V pastes — twice, from two different buffers.
  await scene(browser, 'copy-buffers', async () => {
    await goTo('shell');
    // A clean screen with two known lines, so the drags below grab exactly these
    // and the gif shows two DIFFERENT things being carried, not two selections.
    tmux(`send-keys -t scratch:shell 'clear' Enter`);
    await sleep(800);
    tmux(`send-keys -t scratch:shell 'echo deploy --target prod' Enter`);
    await sleep(500);
    tmux(`send-keys -t scratch:shell 'echo rollback --to v1.4.2' Enter`);
    await sleep(1600);

    await dragSelect(1, 0, 20);                 // "deploy --target prod"
    await sleep(600);
    await page.keyboard.press('Control+c');     // the panel floats itself in
    await sleep(2200);

    await dragSelect(3, 0, 20);                 // "rollback --to v1.4.2"
    await sleep(600);                           // (the drag also dismisses the peek early)
    await page.keyboard.press('Control+c');     // a SECOND buffer — the first is kept
    await sleep(1800);

    const rows = page.locator('webtmux-copy-sidebar .buf');
    // Hold the peek open by pointing at the HEADING. Resting on a row instead
    // pops that row's hover hint, which is a panel-wide box that covers the list
    // — exactly the two rows this beat exists to show.
    await page.locator('webtmux-copy-sidebar h3').hover();
    await sleep(1600);
    await page.locator('webtmux-copy-sidebar .mode-pair .mode-btn').nth(1).click();  // pin
    await sleep(1200);

    await rows.nth(0).click();                  // buffer 1 -> the clipboard
    await sleep(1300);
    await page.mouse.click(500, 500);           // back to the pane
    await sleep(600);
    await page.keyboard.press('Control+v');     // …pastes buffer 1
    await sleep(1600);
    await page.keyboard.type(' ');              // …so the second paste reads as a SECOND thing
    await sleep(500);

    await rows.nth(1).click();                  // buffer 2 -> the clipboard
    await sleep(1300);
    await page.mouse.click(500, 500);
    await sleep(600);
    await page.keyboard.press('Control+v');     // …pastes buffer 2, after the first
    await sleep(2600);
  }, async () => {
    try { tmux(`send-keys -t scratch:shell C-u`); } catch {}
    await page.evaluate(() => {
      const cs = document.querySelector('webtmux-copy-sidebar');
      if (cs.pinned) cs.togglePin();            // pinned is SHARED state — don't leak it
      cs.collapsed = true;
    });
    await sleep(600);
    await goTo('editor');
  });

  // ---- save-file.gif: open the save dropdown -> filename -> Save ------------
  await scene(browser, 'save-file', async () => {
    await goTo('server');
    const btn = page.locator('webtmux-toolbar').getByText('⤓').first();
    await btn.hover(); await sleep(800);
    await btn.click();
    await sleep(2200);
    const save = page.getByText('Save all', { exact: true }).first();
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
  // The strip is fitted to the toolbar width, so make htop recent enough to own a
  // tab rather than wait in the off-strip queue — off camera (recents are shared).
  if (!ONLY.length || ONLY.includes('stoplights')) {
    await offCamera(browser, async () => { await goTo('htop'); await goTo('editor'); });
  }
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

  // ---- preview-pip.gif: ⌃⌥I docks a window in the bar; ⌃⌥⇧I pins one to a corner;
  // ---- a second corner too (they don't fight); hide/show keeps both placements
  await scene(browser, 'preview-pip', async () => {
    await goTo('htop');
    await chord('i');              // htop joins the DOCKED BAR — the default placement
    await sleep(1000);
    await tabOf('editor').click(); // away, so the bar tile paints htop live
    await sleep(3000);
    await tabOf('server').click();
    await sleep(1500);             // let the switch land before toggling
    await chord('Shift+I');        // server floats as a corner PiP box instead
    await sleep(800);
    await tabOf('logs').click();
    await sleep(1500);
    await chord('Shift+I');        // …and logs takes a second corner, alongside it
    await sleep(800);
    await tabOf('editor').click();
    await sleep(3200);
    await chord('h');              // hide the preview…
    await sleep(1600);
    await chord('h');              // …and bring it back, windows and placements intact
    await sleep(2200);
  });

  // ---- connection-spinner.gif (cropped to the top-left corner): the spinner ticks
  // ---- while webtmux drives tmux, goes amber when tmux stops answering, red when
  // ---- the link is gone, and heals by itself when tmux answers again
  await scene(browser, 'connection-spinner', async () => {
    const say = async (label) => {
      const r = await rectOf(page, 'webtmux-toolbar', '.spin');
      await annotate(page, [{ rect: r, label, anchor: 'start' }], { band: { y: 44, height: 110 } });
    };
    const mute = (on) => page.evaluate((on) => {
      for (const u of window.webtmux.manager.units) {
        if (on) {
          u._realSend = u.ws.send.bind(u.ws); u._realOnMessage = u.ws.onmessage;
          u.ws.send = () => {}; u.ws.onmessage = () => {};
        } else {
          if (u._realSend) u.ws.send = u._realSend;
          if (u._realOnMessage) u.ws.onmessage = u._realOnMessage;
        }
      }
    }, on);
    // Label a state only once the spinner is really showing it.
    const until = async (cls) => {
      for (let i = 0; i < 80; i++) {
        const c = await page.evaluate(() => document.querySelector('webtmux-toolbar')
          .shadowRoot.querySelector('.spin').className.replace('spin', '').trim());
        if (c === cls) return;
        await sleep(150);
      }
    };
    await say('connected: ticks each time webtmux drives tmux');
    await sleep(800);
    for (let i = 0; i < 4; i++) { await chord('n'); await sleep(700); }
    await sleep(800);
    await mute(true);                       // a wedged link: the socket stays OPEN
    await page.keyboard.type('ls');
    await until('slow');
    await say('asked, no answer yet: amber');
    await until('lost');                    // the stall deadline (8s from the ask)
    await say('link lost: red, pulsing');
    await sleep(3500);
    await mute(false);
    await page.keyboard.type(' ');
    await until('');
    await say('tmux answers again: back to normal by itself');
    await sleep(3000);
    await page.keyboard.press('Backspace'); await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
  });

  // ---- preview-bar-resize.gif: drag the docked bar's inner edge to make the
  // ---- tiles bigger, drag it back down, double-click to reset
  await scene(browser, 'preview-bar-resize', async () => {
    const grip = () => page.evaluate(() => {
      const g = document.querySelector('webtmux-pip').shadowRoot.querySelector('.bar .grip');
      if (!g) return null;
      const b = g.getBoundingClientRect();
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    });
    if (!await grip()) { await goTo('htop'); await chord('i'); await sleep(800); await goTo('editor'); }
    await sleep(2000);
    const drag = async (dy) => {
      const g = await grip();
      await page.mouse.move(g.x, g.y); await sleep(600);
      await page.mouse.down();
      for (let i = 1; i <= 16; i++) { await page.mouse.move(g.x, g.y + (dy * i) / 16); await sleep(60); }
      await page.mouse.up(); await sleep(2200);
    };
    await drag(-170);              // taller bar, bigger tiles
    await drag(110);               // and back down
    const g = await grip();
    await page.mouse.move(g.x, g.y); await sleep(500);
    await page.mouse.dblclick(g.x, g.y);   // double-click resets the default size
    await sleep(2200);
  }); // last scene: nothing after this needs a clean toolbar


  await browser.close();
  console.log(failures.length ? `DONE with failures: ${failures.join(', ')}` : 'DONE all ok');
  process.exit(failures.length ? 2 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
