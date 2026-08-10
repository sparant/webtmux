// Verification driver for "pushed off the strip is not closed".
//
// The node tests (test/recents-strip.test.mjs) pin the pure rules — where a demoted
// entry goes, which entry a freed slot takes, what a cap change does. This driver
// covers the half they cannot reach: that those rules are wired to the controls the
// user presses, against a real tmux server, a real toolbar and the real shared blob.
//
// The bug it exists for: a sixth window used to DESTROY the least-recently-used tab,
// so closing a tab afterwards left a hole nothing could fill — even though the window
// that had just been pushed out was still running and was the obvious thing to put
// there. Closing a tab (×) and running out of room have to end differently.
//
//   1. Visiting more windows than the cap draws exactly `cap` tabs — and REMEMBERS
//      all of them, the surplus queued in most-recently-used order.
//   2. Clicking × on a tab (the real button, in the real DOM) frees a slot, and the
//      head of that queue slides into it.
//   3. …and the window the user dismissed does NOT come back, however many slots free
//      up afterwards. That is the whole distinction.
//   4. Switching to a queued window gives it a tab back, rather than leaving the user
//      on a window the strip denies.
//   5. The tab-count control is reversible: 5 -> 3 -> 5 lands on the same five tabs,
//      in the same order. Lowering it queues, it does not delete.
//   6. A reload restores the queue too — otherwise every browser refresh would
//      quietly close the tabs that were waiting for a slot.
//
// Run exactly like run.sh does, with DRIVER=verify-recents-queue.js.
const { chromium } = require('playwright');

const URL = 'http://localhost:8090/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let page;
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

// Shadow-root reach-ins: every control is one shadow root down, so a document-level
// querySelector never sees it.
const toolbar = (fn, arg) => page.evaluate(([f, a]) => {
  const el = document.querySelector('webtmux-toolbar');
  return eval(f)(el, el.shadowRoot, a);
}, [fn.toString(), arg]);
const mgr = (fn, arg) => page.evaluate(([f, a]) => eval(f)(window.splitManager, a), [fn.toString(), arg]);

// What is drawn, what is remembered, and what is waiting — the whole feature is the
// difference between the three, so every assertion below reads all of them.
const strip = () => mgr((m) => ({
  tabs: (m.toolbar.recent || []).map((e) => e.id),      // drawn
  entries: m.recentWindows.map((e) => e.id),            // remembered
  queued: m.offStripRecents().map((e) => e.id),         // waiting for a slot
  max: m.recentsMax,
}));
// …and the DOM, so a strip that only exists in the property bag can't pass.
const rtabs = () => toolbar((el, rr) => [...rr.querySelectorAll('.rtab .tab')].map((b) => b.textContent.trim()));
const current = () => mgr((m) => m.focusedUnit?.layout?.activeWindowId);

// Visit `n` windows the strip does not already hold, newest last, and return them in
// visit order. Driven through goToWindow rather than the sidebar so the RECENCY order
// is known: the assertions below are all about which entry is stalest.
async function visitFresh(n) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const landed = await mgr(async (m) => {
      const held = new Set(m.recentWindows.map((e) => e.id));
      // Also skip the window the pane is already showing: switching to where you
      // already are is not an access, so the strip would never grow and this loop
      // would hand back the same id `n` times.
      held.add(m.focusedUnit?.layout?.activeWindowId);
      const fresh = (m._placements || []).find((p) => !held.has(p.id));
      if (!fresh) return null;
      m.goToWindow(fresh.id, fresh.session);
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 200));
        if (m.focusedUnit?.layout?.activeWindowId === fresh.id) break;
      }
      return fresh.id;
    });
    await sleep(800);
    if (landed) ids.push(landed);
  }
  return ids;
}

// Click the × on the tab for `id` — the real button, so the wiring is under test too.
async function closeTab(id) {
  const index = await mgr((m, wid) => (m.toolbar.recent || []).findIndex((e) => e.id === wid), id);
  if (index < 0) return false;
  await toolbar((el, rr, i) => rr.querySelectorAll('.rtab .close')[i].click(), index);
  await sleep(800);
  return true;
}

async function setCap(n) {
  await mgr((m, v) => m.setRecentsMax(v), n);
  await sleep(600);
}

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

  // The strip, the preview and the cap all ride the shared @wt_state blob, so start
  // from a known state rather than from whatever the last driver left in tmux.
  await mgr((m) => {
    for (const id of [...m.pip.windowIds()]) m.pip.removeWindow(id);
    m.pip.setHidden(false);
    for (const e of [...m.recentWindows]) m.removeRecent(e);
    m.setRecentsMax(5);
  });
  await sleep(800);

  // ---- 1. more windows than tabs: drawn 5, remembered 7 -----------------------
  const seen = await visitFresh(7);
  const full = await strip();
  check('setup: seven distinct windows visited',
    seen.length === 7 && new Set(seen).size === 7, seen.join(' '));
  check('the strip draws exactly the cap',
    full.tabs.length === 5 && (await rtabs()).length === 5,
    `${full.tabs.length} tabs, ${(await rtabs()).length} drawn`);
  check('…and remembers every window, the surplus queued rather than destroyed',
    full.entries.length === 7 && full.queued.length === 2,
    `entries=${full.entries.join(' ')} queued=${full.queued.join(' ')}`);
  // The two stalest visits are the two that lost their slot, most recent of them first.
  check('the queue is in most-recently-used order',
    full.queued[0] === seen[1] && full.queued[1] === seen[0],
    `queued=${full.queued.join(' ')} visited=${seen.join(' ')}`);

  // ---- 2. × frees a slot; the head of the queue takes it ----------------------
  const nextUp = full.queued[0];
  const dismissed = full.tabs[full.tabs.length - 1];
  await closeTab(dismissed);
  const after = await strip();
  check('closing a tab hands its slot to the window at the head of the queue',
    after.tabs.includes(nextUp) && after.tabs.length === 5,
    `tabs=${after.tabs.join(' ')} expected ${nextUp}`);
  check('…and the DOM strip is still full, not one short',
    (await rtabs()).length === 5, `${(await rtabs()).length} drawn`);
  check('the queue is one shorter and the dismissed window is gone from it',
    after.queued.length === 1 && !after.queued.includes(dismissed) && after.entries.length === 6,
    `entries=${after.entries.length} queued=${after.queued.join(' ')}`);

  // ---- 3. an explicit close is permanent -------------------------------------
  const secondUp = after.queued[0];
  await closeTab(after.tabs[0]);
  const later = await strip();
  check('a second freed slot brings back the rest of the queue',
    later.tabs.includes(secondUp) && later.queued.length === 0,
    `tabs=${later.tabs.join(' ')}`);
  check('the window the user dismissed never comes back on its own',
    !later.entries.includes(dismissed),
    `entries=${later.entries.join(' ')} dismissed=${dismissed}`);

  // ---- 4. visiting a queued window gives it a tab back ------------------------
  await visitFresh(2);                       // refill the queue
  const queuedNow = (await strip()).queued;
  const target = queuedNow[queuedNow.length - 1];   // the stalest one, deepest in line
  await mgr(async (m, id) => {
    const e = m.recentWindows.find((x) => x.id === id);
    m.goToWindow(id, e ? e.session : '');
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 200));
      if (m.focusedUnit?.layout?.activeWindowId === id) break;
    }
  }, target);
  await sleep(900);
  const promoted = await strip();
  check('switching to a queued window gives it a tab again',
    !!target && promoted.tabs.includes(target) && (await current()) === target,
    `target=${target} tabs=${promoted.tabs.join(' ')}`);
  check('…without losing the window it displaced',
    promoted.entries.length === promoted.entries.length && promoted.entries.includes(target)
      && promoted.queued.length === queuedNow.length,
    `entries=${promoted.entries.join(' ')} queued=${promoted.queued.join(' ')}`);

  // ---- 5. the tab-count control is reversible --------------------------------
  const beforeCap = await strip();
  await setCap(3);
  const narrow = await strip();
  check('lowering the cap draws three tabs and queues the rest, deleting nothing',
    narrow.tabs.length === 3 && (await rtabs()).length === 3
      && narrow.entries.length === beforeCap.entries.length,
    `tabs=${narrow.tabs.join(' ')} entries=${narrow.entries.length}`);
  await setCap(5);
  const back = await strip();
  check('…and raising it again lands on exactly the tabs it started with',
    back.tabs.join() === beforeCap.tabs.join(),
    `${back.tabs.join(' ')} vs ${beforeCap.tabs.join(' ')}`);

  // ---- 6. the queue survives a reload ----------------------------------------
  const beforeReload = await strip();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(5000);
  const reloaded = await strip();
  check('a reload restores the tabs AND the windows queued behind them',
    reloaded.entries.join() === beforeReload.entries.join()
      && reloaded.tabs.join() === beforeReload.tabs.join(),
    `entries=${reloaded.entries.join(' ')} vs ${beforeReload.entries.join(' ')}`);

  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
