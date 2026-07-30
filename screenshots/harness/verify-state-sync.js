// Verification driver for the @wt_state sync protocol (plan-webtmux-harden-state.md).
//
// TWO REAL BROWSERS, ONE TMUX SERVER. Everything this plan fixed is invisible to a
// single client: the store converges with itself trivially. The failures only exist
// when a SECOND browser — with its own localStorage, its own rev counter and its own
// idea of what the UI looks like — writes to the same @wt_state. So this driver
// opens two isolated Playwright contexts (separate localStorage, which is what makes
// browser B's cache genuinely COLD) and drives them against each other:
//
//   1. B, opening for the first time, must not erase the split A arranged. This is
//      the live-data-loss path a normal user can hit today: B boots holding {},
//      restores "no split" from its empty cache, and publishes that.
//   2. B must CONVERGE on A's split rather than sitting on its own emptiness.
//   3. B's FIRST navigation must write the regions it adopted, not `regions: []` —
//      the same erasure one debounce later.
//   4. A must still be showing its own two regions when B is done.
//   5. The preview set adopts the same way.
//   6. A window killed in tmux must leave the recents strip and STAY gone. The
//      resurrection loop was: client prunes the dead tab, the prune is swallowed
//      because it happens inside a remote apply, the blob still holds it, the next
//      push hands it back — twice a second, forever.
//
// Run exactly like run.sh does, with DRIVER=verify-state-sync.js.
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');

const URL = 'http://localhost:8090/';
const SOCK = '/tmp/wt.sock';
const CREDS = { username: 'wt', password: 'wt' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

const tmux = (...args) => execFileSync('tmux', ['-S', SOCK, ...args], { encoding: 'utf8' });

// The shared blob, straight out of the tmux server — the ground truth both browsers
// are arguing about. Never read through either page, or a bug that only affects what
// gets WRITTEN would be invisible.
function serverState() {
  try {
    const raw = tmux('show', '-gv', '@wt_state').trim();
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

// Reach into a page's SplitManager. `window.splitManager` is the app's own handle.
const mgr = (page, fn, arg) => page.evaluate(
  ([f, a]) => eval(f)(window.splitManager, a), [fn.toString(), arg],
);

// Poll until `fn()` is truthy (or we run out of patience). Layout pushes are 500ms
// and the store's write debounce is 400ms, so nothing here can be asserted the tick
// after it is triggered; every wait is explicit rather than a blanket sleep.
async function until(what, fn, timeoutMs = 15000, stepMs = 250) {
  const t0 = Date.now();
  for (;;) {
    let v;
    try { v = await fn(); } catch (e) { v = false; }
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(stepMs);
  }
}

async function openBrowserTab(browser) {
  // A fresh CONTEXT, not just a tab: that is what gives the second browser its own
  // empty localStorage, i.e. the cold cache the whole plan is about.
  const ctx = await browser.newContext({
    httpCredentials: CREDS, viewport: { width: 1400, height: 800 },
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await until('the app to boot', () => page.evaluate(
    () => !!(window.splitManager && window.splitManager.units[0]?.layout),
  ));
  return { ctx, page };
}

const regionCount = (page) => mgr(page, (m) => m.units.length);
const recentIds = (page) => mgr(page, (m) => m.recentWindows.map((e) => e.id));

async function main() {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });

  // ---- browser A: arrange a split, a preview and a recents strip -------------
  const a = await openBrowserTab(browser);
  check('A boots with a single region', await regionCount(a.page) === 1,
    `units=${await regionCount(a.page)}`);

  // Visit a couple of windows so the strip is non-empty, then split.
  const windows = await mgr(a.page, (m) => (m.units[0].layout.windows || []).map((w) => w.id));
  await mgr(a.page, (m, ids) => m.goToWindow(ids[1], m.logicalSession(m.units[0])), windows);
  await sleep(1200);
  await mgr(a.page, (m, ids) => m.goToWindow(ids[2], m.logicalSession(m.units[0])), windows);
  await sleep(1200);
  await a.page.keyboard.press('Control+Alt+Enter');       // splitAdd
  await until('A to have two regions', async () => await regionCount(a.page) === 2);
  // The preview, through the same entry point ⌃⌥I calls. (The chord itself is
  // verify-ux5/6's business; what is under test here is that the SET is shared.)
  // It needs a focused region that HAS a layout — the brand-new split region does
  // not for its first push, and toggleFocusedInPreview is a deliberate no-op then.
  await until('A\'s focused region to have a window', () => mgr(a.page, (m) => {
    m.focus(m.units[0]);
    return !!m.focusedUnit?.layout?.activeWindowId;
  }));
  await mgr(a.page, (m) => m.toggleFocusedInPreview());
  await sleep(1500);

  const published = await until('A to publish its split', () => {
    const s = serverState();
    return s && s.split && Array.isArray(s.split.regions) && s.split.regions.length === 1 ? s : false;
  });
  check('A published its split to @wt_state', true,
    `regions=${JSON.stringify(published.split.regions)}`);
  const aRecents = await recentIds(a.page);
  check('A built a recents strip', aRecents.length >= 2, aRecents.join(','));
  const previewCount = await mgr(a.page, (m) => m.pip?.count || 0);
  check('A put a window in the preview', previewCount >= 1, `count=${previewCount}`);

  // ---- browser B: first ever visit, empty localStorage -----------------------
  const b = await openBrowserTab(browser);

  // (1) The clobber window: for the next few seconds, A's split must survive
  //     everything B's boot writes.
  let erased = null;
  for (let i = 0; i < 24 && !erased; i++) {
    const s = serverState();
    if (!s || !s.split || !Array.isArray(s.split.regions) || s.split.regions.length !== 1) {
      erased = JSON.stringify(s && s.split);
    }
    await sleep(250);
  }
  check("B's cold boot did not erase A's split", erased === null, erased || '');

  // (2) …and B converged on it instead.
  let bRegions = 0;
  try {
    await until('B to adopt the split', async () => (bRegions = await regionCount(b.page)) === 2);
  } catch (e) { /* reported by the check below */ }
  check('B adopted A\'s split from the shared blob', bRegions === 2, `units=${bRegions}`);

  const bRecents = await recentIds(b.page);
  check('B adopted the recents strip too',
    bRecents.length >= 2 && aRecents.every((id) => bRecents.includes(id)),
    `A=${aRecents.join(',')} B=${bRecents.join(',')}`);

  const bPreview = await mgr(b.page, (m) => m.pip?.count || 0);
  check('B adopted the preview set', previewCount > 0 && bPreview === previewCount,
    `A=${previewCount} B=${bPreview}`);

  // (3) B's FIRST navigation must publish what it is showing, never `regions: []`.
  const bWindows = await mgr(b.page, (m) => (m.units[0].layout.windows || []).map((w) => w.id));
  await mgr(b.page, (m, ids) => m.goToWindow(ids[0], m.logicalSession(m.units[0])), bWindows);
  await sleep(2500);
  const afterNav = serverState();
  check("B's first navigation kept the regions it adopted",
    !!afterNav && afterNav.split && afterNav.split.regions.length === 1,
    JSON.stringify(afterNav && afterNav.split));

  // (4) …and A never lost its own view.
  const aAfter = await regionCount(a.page);
  check('A still shows both of its regions', aAfter === 2, `units=${aAfter}`);

  // (6) Kill a window that is in the strip; it must leave and stay gone.
  const doomed = (await recentIds(a.page)).find((id) => id !== bWindows[0]);
  tmux('kill-window', '-t', doomed);
  let gone = false;
  try {
    await until('the dead tab to leave the strip', async () => {
      const inA = (await recentIds(a.page)).includes(doomed);
      const s = serverState();
      const inBlob = !!(s && s.recentTabs && (s.recentTabs.windows || []).some((e) => e.id === doomed));
      return (gone = !inA && !inBlob);
    });
  } catch (e) { /* reported below */ }
  check('a killed window leaves the recents strip and the blob', gone, `window=${doomed}`);

  // The resurrection loop was a per-push event, so a few seconds of pushes is a
  // real test of it: if the prune is being swallowed, the tab comes straight back.
  await sleep(4000);
  const resurrected = (await recentIds(a.page)).includes(doomed)
    || (await recentIds(b.page)).includes(doomed)
    || ((serverState() || {}).recentTabs?.windows || []).some((e) => e.id === doomed);
  check('and it does not come back on the next pushes', !resurrected, `window=${doomed}`);

  // The rev must still be advancing sanely rather than ping-ponging: two clients
  // idling should not be bumping it once per push each.
  const rev1 = (serverState() || {}).rev || 0;
  await sleep(5000);
  const rev2 = (serverState() || {}).rev || 0;
  check('an idle pair of browsers does not churn the blob', rev2 - rev1 <= 2,
    `rev ${rev1} -> ${rev2}`);

  await browser.close();
  const bad = results.filter((r) => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} passed`);
  process.exit(bad.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
