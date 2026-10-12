// Verification driver for the content-zoom crop — "show the content, not the blank
// screen". The node tests cover the pure policy (content-bounds.test.mjs); this
// covers the WIRING, in a real browser, against real captures:
//
//   1. A window whose TUI fills a fraction of its grid gets a CROPPED PiP tile —
//      and the crop really magnifies (a bigger scale than the whole grid would get).
//   2. The crop never clips the ink. This is the claim that matters: a preview that
//      zooms is worthless if it can cut the thing you were reading in half. Measured
//      by re-running the bounds finder in the page against the APPLIED crop.
//   3. A window that fills its grid is NOT cropped — the transform stays the plain
//      letterbox scale it has always been, translate included, so nothing changed
//      for the ordinary full-screen window.
//   4. Exposé thumbnails follow the same two rules.
//   5. The crop HOLDS STILL on a window whose content changes constantly. A preview
//      that re-scales twice a second is worse than one that wastes space, and the
//      hysteresis that stops it is the part of this change most likely to rot.
//   6. The hover preview, which borrows a real region rather than building a
//      throwaway terminal, is never made SMALLER by the crop.
//
// `tests` comes from boot-tmux.sh unmodified — it prints a dozen lines and sleeps,
// which is the claude-limits shape this change came from. The FULL-SCREEN fixture is
// staged here instead: nothing boot-tmux.sh starts actually fills its grid (even the
// rolling log only reaches ~70 of 188 columns, and cropping that is the feature
// working, not failing), so the no-crop claim needs a window built to fill.
//
// Run exactly like run.sh does, with DRIVER=verify-content-zoom.js.
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');

const URL = 'http://localhost:8090/';
const SOCK = '/tmp/wt.sock';
const tmux = (...args) => execFileSync('tmux', ['-u', '-S', SOCK, ...args], { encoding: 'utf8' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let page;
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

// ---- navigation (same moves driver.js makes) --------------------------------

const chord = (k) => page.keyboard.press(`Control+Alt+${k}`);

async function exposeState() {
  return page.evaluate(() => {
    const el = document.querySelector('webtmux-expose');
    return { open: !!el?.open, header: el?.shadowRoot?.querySelector('.count')?.textContent || '' };
  });
}

async function closeExpose() {
  for (let i = 0; i < 4; i++) {
    if (!(await exposeState()).open) return;
    await page.keyboard.press('Escape');
    await sleep(400);
  }
}

async function openExpose() {
  await closeExpose();
  await chord('f');
  await sleep(700);
  let s = await exposeState();
  if (!s.open) { await chord('f'); await sleep(700); s = await exposeState(); }
  if (!s.open) throw new Error('expose did not open');
  // The type-ahead filter persists across close/reopen, so clear it before typing.
  for (let i = 0; i < 24; i++) await page.keyboard.press('Backspace');
  await sleep(400);
}

async function goTo(name) {
  await openExpose();
  await page.keyboard.type(name, { delay: 40 });
  await sleep(500);
  await page.keyboard.press('Enter');
  await sleep(900);
  if ((await exposeState()).open) { await closeExpose(); throw new Error(`goTo(${name}) did not commit`); }
  await sleep(900);
}

// ---- reach-ins ---------------------------------------------------------------

// Everything a crop decision is made of, per PiP tile: the grid it was measured on,
// the crop that was applied, the transform that came out, and — measured FRESH in
// the page from the same buffer — where the ink actually is.
const pipTiles = () => page.evaluate(async () => {
  const { terminalContentBox } = await import('/js/content-bounds.js');
  const el = document.querySelector('webtmux-pip');
  const out = [];
  for (const [id, rec] of (el?._terms || new Map())) {
    const frame = el.shadowRoot.querySelector(`.ptile[data-window="${id}"] .pframe`)
      || el.shadowRoot.querySelector('.pframe');
    out.push({
      id,
      cols: rec.term.cols,
      rows: rec.term.rows,
      crop: rec.crop,
      ink: terminalContentBox(rec.term),
      transform: rec.screen.style.transform,
      screenW: rec.screen.offsetWidth,
      screenH: rec.screen.offsetHeight,
      frameW: frame ? frame.clientWidth : 0,
      frameH: frame ? frame.clientHeight : 0,
    });
  }
  return out;
});

const exposeTiles = () => page.evaluate(async () => {
  const { terminalContentBox } = await import('/js/content-bounds.js');
  const el = document.querySelector('webtmux-expose');
  return (el?._tiles || []).filter((r) => r.term).map((rec) => ({
    id: rec.windowId,
    name: rec.tileEl?.textContent || '',
    cols: rec.term.cols,
    rows: rec.term.rows,
    crop: rec.crop,
    ink: terminalContentBox(rec.term),
    transform: rec.screen.style.transform,
    screenW: rec.screen.offsetWidth,
    screenH: rec.screen.offsetHeight,
    frameW: rec.frame.clientWidth,
    frameH: rec.frame.clientHeight,
  }));
});

// windowId of a window by name, from the server-wide directory.
const idOf = (name) => page.evaluate((n) => {
  const all = window.splitManager?.focusedUnit?.layout?.allWindows || [];
  return (all.find((w) => w.name === n) || {}).id || null;
}, name);

const scaleOf = (t) => {
  const m = /scale\(([-\d.e+]+)\)/.exec(t || '');
  return m ? Number(m[1]) : null;
};
const translateOf = (t) => {
  const m = /translate\(([-\d.e+]+)px,\s*([-\d.e+]+)px\)/.exec(t || '');
  return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
};
// What the scale WOULD be with no crop — the behaviour this change replaces.
const uncroppedScale = (t) => Math.min(t.frameW / (t.screenW || 1), t.frameH / (t.screenH || 1));

// Is every cell of ink inside the applied crop?
function inkInside(t) {
  if (!t.ink) return true;                       // nothing drawn — nothing to clip
  const c = t.crop || { col: 0, row: 0, cols: t.cols, rows: t.rows };
  return t.ink.col >= c.col
    && t.ink.row >= c.row
    && t.ink.col + t.ink.cols <= c.col + c.cols
    && t.ink.row + t.ink.rows <= c.row + c.rows;
}

// ---- the run -----------------------------------------------------------------

async function main() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 950 },
    httpCredentials: { username: 'wt', password: 'wt' },
  });
  page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.log('  [page error]', m.text()); });
  await page.goto(URL);
  await page.waitForSelector('.xterm', { timeout: 30000 });
  await sleep(3000);

  // Stage the full-screen fixture: every cell of the window's CURRENT grid inked,
  // so "don't crop a window that fills its screen" has something to be true of.
  tmux('new-window', '-t', 'dev', '-n', 'fullscr', 'bash -c \'clear; c=$(tput cols); r=$(tput lines); '
    + 'for ((i=1;i<r;i++)); do printf "%${c}s\\n" | tr " " "#"; done; '
    + 'printf "%${c}s" | tr " " "#"; sleep infinity\'');
  await sleep(2500);

  const sparseId = await idOf('tests');
  const denseId = await idOf('fullscr');
  const churnId = await idOf('server');
  console.log(`fixtures: tests=${sparseId} fullscr=${denseId} server=${churnId}`);

  // ---- 1..3: the PiP -----------------------------------------------------------
  // Put BOTH windows in the preview, then park the focus somewhere else so neither
  // tile is the self-preview (which shrinks to a mini hint).
  await goTo('tests');
  await chord('i');
  await sleep(600);
  await goTo('fullscr');
  await chord('i');
  await sleep(600);
  await goTo('server');
  await chord('i');
  await sleep(600);
  await goTo('editor');
  await sleep(3000);           // several capture polls, so the crop has settled

  const pip = await pipTiles();
  console.log('  pip tiles:', JSON.stringify(pip.map((t) => ({
    id: t.id, grid: `${t.cols}x${t.rows}`, ink: t.ink, crop: t.crop, transform: t.transform,
  })), null, 1));

  // SHOTS=1 writes a before/after pair of the preview bar to /src/.zoomshots. The
  // checks below are geometric and stand on their own; this is for a human to look
  // at, because "the numbers say it zoomed" and "you can read it now" are not the
  // same claim. "Before" is produced by clearing the crop and re-scaling — the exact
  // behaviour this change replaces — and is grabbed immediately, before the next
  // capture puts the crop back.
  if (process.env.SHOTS) {
    const fs = require('fs');
    fs.mkdirSync('/src/.zoomshots', { recursive: true });
    // The host itself is display:contents (it holds the bar AND the corner boxes, which
    // position themselves), so it has no box of its own — clip to the BAR, which is
    // where ⌃⌥I put these tiles. Playwright's css engine pierces the open shadow root.
    const box = await page.locator('webtmux-pip .bar').boundingBox();
    if (box) {
      await page.screenshot({ path: '/src/.zoomshots/pip-after.png', clip: box });
      await page.evaluate(() => {
        const el = document.querySelector('webtmux-pip');
        for (const [id, rec] of el._terms) { rec.crop = null; el._rescale(id); }
      });
      await page.screenshot({ path: '/src/.zoomshots/pip-before.png', clip: box });
      await sleep(2000);   // let the poll put the crop back before the checks below
    }
  }

  const sparse = pip.find((t) => t.id === sparseId);
  const dense = pip.find((t) => t.id === denseId);

  check('the sparse window has a preview tile', !!sparse);
  check('the dense window has a preview tile', !!dense);

  if (sparse) {
    check('sparse PiP tile is cropped', !!sparse.crop,
      `ink ${JSON.stringify(sparse.ink)} of ${sparse.cols}x${sparse.rows}, crop ${JSON.stringify(sparse.crop)}`);
    const got = scaleOf(sparse.transform);
    const plain = uncroppedScale(sparse);
    check('the crop actually magnifies the content', got !== null && got > plain * 1.25,
      `scale ${got?.toFixed(3)} vs uncropped ${plain.toFixed(3)} (${(got / plain).toFixed(2)}×)`);
    check('the crop clips no ink (PiP, sparse)', inkInside(sparse),
      `ink ${JSON.stringify(sparse.ink)} vs crop ${JSON.stringify(sparse.crop)}`);
    // …and the zoomed crop still fits the frame it was scaled into.
    const cw = sparse.screenW / sparse.cols;
    const ch = sparse.screenH / sparse.rows;
    const c = sparse.crop || { cols: sparse.cols, rows: sparse.rows };
    check('the zoomed crop still fits its frame',
      c.cols * cw * got <= sparse.frameW + 1 && c.rows * ch * got <= sparse.frameH + 1,
      `${(c.cols * cw * got).toFixed(0)}x${(c.rows * ch * got).toFixed(0)} into ${sparse.frameW}x${sparse.frameH}`);
  }

  if (dense) {
    check('the full-screen window is NOT cropped', dense.crop === null,
      `ink ${JSON.stringify(dense.ink)} of ${dense.cols}x${dense.rows}`);
    check('the full-screen fixture really does fill its grid',
      !!dense.ink && dense.ink.cols === dense.cols && dense.ink.rows === dense.rows,
      `ink ${JSON.stringify(dense.ink)} of ${dense.cols}x${dense.rows}`);
    const tr = translateOf(dense.transform);
    check('an uncropped tile is the plain letterbox scale it always was',
      !!tr && tr.x === 0 && tr.y === 0
        && Math.abs(scaleOf(dense.transform) - uncroppedScale(dense)) < 1e-6,
      dense.transform);
  }

  // ---- 4: Exposé ---------------------------------------------------------------
  await openExpose();
  await sleep(3000);
  const tiles = await exposeTiles();
  const eSparse = tiles.find((t) => t.id === sparseId);
  const eDense = tiles.find((t) => t.id === denseId);
  console.log('  expose tiles:', JSON.stringify(tiles.map((t) => ({
    id: t.id, ink: t.ink, crop: t.crop, transform: t.transform,
  })), null, 1));

  check('the sparse window has an Exposé thumbnail', !!eSparse);
  if (eSparse) {
    check('sparse Exposé thumbnail is cropped', !!eSparse.crop, JSON.stringify(eSparse.crop));
    const got = scaleOf(eSparse.transform);
    const plain = uncroppedScale(eSparse);
    check('the Exposé crop magnifies too', got !== null && got > plain * 1.25,
      `scale ${got?.toFixed(3)} vs uncropped ${plain.toFixed(3)}`);
    check('the crop clips no ink (Exposé, sparse)', inkInside(eSparse));
  }
  if (eDense) {
    check('a full-screen Exposé thumbnail is NOT cropped', eDense.crop === null,
      `ink ${JSON.stringify(eDense.ink)}`);
  }
  await closeExpose();
  await sleep(600);

  // ---- 5: the crop holds still under churn ------------------------------------
  // `server` prints a log line twice a second at a width that varies by ~40 columns.
  // Following the measurement would re-scale the tile on most of those; the tracker
  // is supposed to settle on the widest it has seen and then stop moving.
  const seen = [];
  let clipped = 0;
  for (let i = 0; i < 10; i++) {
    const t = (await pipTiles()).find((x) => x.id === churnId);
    if (t && !inkInside(t)) clipped++;
    seen.push(JSON.stringify(t?.crop || null));
    await sleep(700);
  }
  const changes = seen.filter((v, i) => i && v !== seen[i - 1]).length;
  console.log('  crops over 7s:', [...new Set(seen)].join(' | '));
  // ~14 captures land in this window. A couple of moves is the tracker doing its job
  // — a long log line arrives, the crop GROWS to it immediately rather than clipping
  // it. Moving on most of them would be the jitter the hysteresis exists to prevent,
  // and there is no threshold between the two that isn't a judgement: this one says
  // "on a minority of captures".
  check('the crop does not move on most captures', changes <= 3,
    `${changes} changes across 10 samples (${[...new Set(seen)].length} distinct)`);
  check('and never clips the churning window\'s ink', clipped === 0,
    `${clipped} of 10 samples clipped`);

  // ---- 5: the hover preview ----------------------------------------------------
  // Hovering a recents tab previews that window INTO a real region — the one path
  // that resizes a live terminal instead of building a throwaway one.
  await page.evaluate(() => { const el = document.querySelector('webtmux-pip'); el?.setHidden?.(true); });
  // SPLIT first, so the borrowed region is genuinely narrower than the capture. Un-split,
  // a 188-column window previewed into a 188-column region fits whole at native size and
  // the crop has nothing to do — the check would pass without exercising anything.
  await chord('Enter');
  await sleep(2500);
  const tab = page.locator('webtmux-toolbar').getByText('tests', { exact: true }).first();
  if (await tab.count()) {
    await tab.hover();
    await sleep(2500);
    const hov = await page.evaluate(() => {
      const hp = window.splitManager?.hover;
      const held = hp?._held;
      if (!held) return null;
      const host = held.unit.terminalEl;
      return {
        transform: host.style.transform,
        heldCols: held.cols,
        heldRows: held.rows,
        termCols: held.unit.terminal.cols,
        termRows: held.unit.terminal.rows,
      };
    });
    if (!hov) {
      check('the hover preview took a region', false, 'no region held after 2.5s');
    } else {
      console.log('  hover:', JSON.stringify(hov));
      const got = scaleOf(hov.transform) ?? 1;
      const plain = Math.min(1, hov.heldCols / hov.termCols, hov.heldRows / hov.termRows);
      check('the hover preview into a NARROWER region is really shrunk without a crop',
        plain < 0.95, `uncropped scale would be ${plain.toFixed(3)}`);
      check('the crop rescues it — the preview is never shrunk MORE', got >= plain - 1e-6,
        `scale ${got.toFixed(3)} vs uncropped ${plain.toFixed(3)}`);
      check('the hover preview never magnifies past native size', got <= 1 + 1e-6, `scale ${got}`);
    }
    await page.mouse.move(800, 700);
    await sleep(1000);
  } else {
    check('a recents tab for the sparse window exists', false, 'no tab named tests');
  }

  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
