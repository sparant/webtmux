// Ad-hoc verification driver for the toolbar/sidebar UX batch:
//   1. the recents strip's tab count is settable from the "Recent ▾" menu
//   2. the pin button reads auto hide / pinned, and a PINNED panel
//      survives Enter the way it already survives a row click
//   3. ↑/↓ keep working after a window row is clicked
//   4. the toolbar spinner goes red when the socket to tmux drops
//
// Run exactly like run.sh does, with DRIVER=verify-ux5.js.
const { chromium } = require('playwright');
const fs = require('fs');

// Crops land here rather than in screenshots/ proper: they are evidence from one run,
// not README assets. Gitignored — see .gitignore.
const OUT = '/src/screenshots/verify';
const URL = 'http://localhost:8090/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let page;
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

// Shadow-root reach-ins. Every component here is a Lit element, so its controls
// live one shadow root down and querySelector from the document never sees them.
const toolbar = (fn, arg) => page.evaluate(([f, a]) => {
  const el = document.querySelector('webtmux-toolbar');
  const rr = el.shadowRoot;
  return eval(f)(el, rr, a);
}, [fn.toString(), arg]);

const sidebar = (fn, arg) => page.evaluate(([f, a]) => {
  const el = document.querySelector('webtmux-sidebar');
  const rr = el.shadowRoot;
  return eval(f)(el, rr, a);
}, [fn.toString(), arg]);

async function openRecentMenu() {
  await toolbar((el, rr) => { rr.querySelector('.label').click(); });
  await sleep(250);
}

async function main() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    httpCredentials: { username: 'wt', password: 'wt' },
  });
  fs.mkdirSync(OUT, { recursive: true });
  page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await sleep(3500);

  // Build up a strip worth resizing: walk windows via the sidebar so each one is
  // really accessed (Ctrl+Alt+W opens the panel, ↓ previews, Enter commits). The
  // staged tmux has 9 windows spread over 3 sessions and ↓ only wraps within the
  // current session's list, so every few steps hop sessions with → — otherwise the
  // strip tops out at that one session's window count and never reaches the cap.
  async function walk(steps) {
    for (let i = 0; i < steps; i++) {
      await page.keyboard.press('Control+Alt+w');
      await sleep(500);
      if (i % 3 === 2) { await page.keyboard.press('ArrowRight'); await sleep(900); }
      await page.keyboard.press('ArrowDown');
      await sleep(700);
      await page.keyboard.press('Enter');
      await sleep(700);
    }
  }
  await walk(9);

  // ---- 1. settable tab count -------------------------------------------------
  const tabsNow = () => toolbar((el, rr) => rr.querySelectorAll('.rtab').length);
  const atDefault = await tabsNow();
  check('strip fills to the default cap of 5', atDefault === 5, `${atDefault} tabs`);

  await openRecentMenu();
  const menu = await toolbar((el, rr) => {
    const m = rr.querySelector('.label-menu');
    if (!m) return null;
    return {
      size: !!m.querySelector('.msize'),
      num: m.querySelector('.msize .mnum')?.textContent.trim(),
      steps: [...m.querySelectorAll('.msize .mstep')].map((b) => b.textContent.trim()),
      labels: !!m.querySelector('.mitem'),
    };
  });
  check('the Recent menu carries a tab-count stepper',
    !!menu && menu.size && menu.num === '5' && menu.steps.join('') === '−+' && menu.labels,
    JSON.stringify(menu));

  // Step it up to 8 and confirm the strip actually grows past five.
  for (let i = 0; i < 3; i++) {
    await toolbar((el, rr) => rr.querySelectorAll('.msize .mstep')[1].click());
    await sleep(200);
  }
  const shownMax = await toolbar((el, rr) => rr.querySelector('.msize .mnum').textContent.trim());
  await toolbar((el, rr) => rr.querySelector('.label-backdrop').click());
  await sleep(300);

  // Visit more windows so the wider strip has something to hold.
  await walk(7);
  const grown = await tabsNow();
  check('raising the cap to 8 lets the strip hold more than five tabs',
    shownMax === '8' && grown > 5 && grown <= 8, `cap ${shownMax}, ${grown} tabs`);

  // The cap must ride the SHARED tmux blob, not this browser only.
  const persisted = await page.evaluate(async () => {
    const r = await fetch('/', { method: 'HEAD' }); // keep the auth cookie warm
    return window.localStorage.getItem('webtmux-state');
  });
  check('the cap is written to the shared state blob',
    !!persisted && JSON.parse(persisted)?.toolbar?.recentMax === 8,
    persisted ? JSON.stringify(JSON.parse(persisted).toolbar) : 'no blob');

  // Shrink it hard and confirm it evicts down rather than merely hiding tabs.
  await openRecentMenu();
  for (let i = 0; i < 5; i++) {
    await toolbar((el, rr) => rr.querySelectorAll('.msize .mstep')[0].click());
    await sleep(200);
  }
  await toolbar((el, rr) => rr.querySelector('.label-backdrop').click());
  await sleep(500);
  const shrunk = await tabsNow();
  check('lowering the cap evicts down to it', shrunk === 3, `${shrunk} tabs`);

  // Restore a normal cap for the rest of the run.
  await openRecentMenu();
  for (let i = 0; i < 2; i++) {
    await toolbar((el, rr) => rr.querySelectorAll('.msize .mstep')[1].click());
    await sleep(200);
  }
  await toolbar((el, rr) => rr.querySelector('.label-backdrop').click());
  await sleep(300);

  // ---- 2. pin wording + pinned Enter -----------------------------------------
  await page.keyboard.press('Control+Alt+w');
  await sleep(700);

  let pin = await sidebar((el, rr) => {
    const b = [...rr.querySelectorAll('.mode-btn')].find((x) => x.textContent.includes('📌'));
    return { text: b.textContent.trim(), pinned: el.pinned };
  });
  if (pin.pinned) {   // start from auto-hide whatever the blob remembered
    await sidebar((el, rr) => [...rr.querySelectorAll('.mode-btn')].find((x) => x.textContent.includes('📌')).click());
    await sleep(300);
    pin = await sidebar((el, rr) => {
      const b = [...rr.querySelectorAll('.mode-btn')].find((x) => x.textContent.includes('📌'));
      return { text: b.textContent.trim(), pinned: el.pinned };
    });
  }
  check('unpinned reads "auto hide"', pin.text === '📌 auto hide', pin.text);

  // Auto-hide: Enter still dismisses (the old behavior must not regress).
  await page.keyboard.press('ArrowDown');
  await sleep(600);
  await page.keyboard.press('Enter');
  await sleep(600);
  let collapsed = await sidebar((el) => el.collapsed);
  check('auto-hide: Enter still closes the panel', collapsed === true, `collapsed=${collapsed}`);

  // Now pin it.
  await page.keyboard.press('Control+Alt+w');
  await sleep(600);
  await sidebar((el, rr) => [...rr.querySelectorAll('.mode-btn')].find((x) => x.textContent.includes('📌')).click());
  await sleep(400);
  const pinnedText = await sidebar((el, rr) =>
    [...rr.querySelectorAll('.mode-btn')].find((x) => x.textContent.includes('📌')).textContent.trim());
  check('pinned reads "pinned"', pinnedText === '📌 pinned', pinnedText);

  await page.keyboard.press('ArrowDown');
  await sleep(700);
  const previewed = await sidebar((el) => el.unit?.manager?.hover?.windowId || '');
  await page.keyboard.press('Enter');
  await sleep(900);
  const afterEnter = await sidebar((el) => ({ collapsed: el.collapsed, active: el.activeWindow }));
  check('pinned: Enter keeps the panel open', afterEnter.collapsed === false,
    `collapsed=${afterEnter.collapsed}`);
  check('pinned: Enter still COMMITS the previewed window',
    !!previewed && afterEnter.active === previewed, `previewed ${previewed}, active ${afterEnter.active}`);

  // ---- 3. arrows survive a row click -----------------------------------------
  // Click a window row, then press ↓ — the browse must move, which it cannot do if
  // keyboard focus went to the terminal (the bug).
  const rows = await sidebar((el, rr) => rr.querySelectorAll('.window-tab').length);
  await sidebar((el, rr) => {
    const list = [...rr.querySelectorAll('.window-tab')].filter((r) => !r.classList.contains('disabled'));
    (list[1] || list[0]).click();
  });
  await sleep(1200);
  const afterClick = await sidebar((el) => ({
    collapsed: el.collapsed,
    active: el.activeWindow,
    focusedInPanel: el.shadowRoot.activeElement?.classList?.contains('sidebar-content'),
  }));
  check('clicking a row returns keyboard focus to the panel',
    afterClick.focusedInPanel === true, JSON.stringify(afterClick));

  await page.keyboard.press('ArrowDown');
  await sleep(900);
  const afterArrow = await sidebar((el) => el.unit?.manager?.hover?.windowId || '');
  check('↑/↓ still navigate after a row click',
    !!afterArrow && afterArrow !== afterClick.active,
    `rows=${rows} clicked=${afterClick.active} arrowed to=${afterArrow}`);

  // And a second arrow in a row keeps moving (the old failure was "one press then dead").
  await page.keyboard.press('ArrowDown');
  await sleep(900);
  const afterArrow2 = await sidebar((el) => el.unit?.manager?.hover?.windowId || '');
  check('and keep working on the press after that',
    !!afterArrow2 && afterArrow2 !== afterArrow, `${afterArrow} -> ${afterArrow2}`);

  await page.keyboard.press('Escape');
  await sleep(500);

  // ---- 4. spinner turns red when tmux goes away ------------------------------
  const spinBefore = await toolbar((el, rr) => ({
    lost: rr.querySelector('.spin').classList.contains('lost'),
    disconnected: el.disconnected,
  }));
  check('spinner is normal while connected', spinBefore.lost === false, JSON.stringify(spinBefore));

  // One activity notch must actually CHANGE THE SHAPE. The spinner is an eight-spoke
  // star, which is symmetric under 45° — the step it shipped with mapped the icon
  // exactly onto itself, so "activity" was a transform that rendered identically
  // forever. Compare consecutive notches as images, not as a transform string.
  const spinBox0 = await page.evaluate(() => {
    const r = document.querySelector('webtmux-toolbar').shadowRoot
      .querySelector('.spin').getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  });
  await page.screenshot({ path: OUT + '/verify-ux5-notch-a.png', clip: spinBox0 });
  const rotBefore = await toolbar((el, rr) => rr.querySelector('.spin').style.transform);
  await toolbar((el) => el.tickActivity());
  await sleep(600);   // past the 0.18s transform transition
  const rotAfter = await toolbar((el, rr) => rr.querySelector('.spin').style.transform);
  await page.screenshot({ path: OUT + '/verify-ux5-notch-b.png', clip: spinBox0 });
  check('one activity notch is a visible rotation', rotBefore !== rotAfter,
    `${rotBefore} -> ${rotAfter}`);
  const okBox = await page.evaluate(() => {
    const r = document.querySelector('webtmux-toolbar').shadowRoot
      .querySelector('.spin').getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  });
  await page.screenshot({ path: OUT + '/verify-ux5-ink-ok.png', clip: okBox });

  // ---- 4a. the OPEN-BUT-MUTE stall ------------------------------------------
  // The failure that actually strands you, and the one a readyState check cannot see:
  // the server (or tmux) wedges, the socket stays OPEN, and everything keeps looking
  // healthy while keystrokes vanish. Simulated by swallowing what the page sends and
  // withholding what comes back — the socket object is untouched and still reports
  // OPEN throughout, exactly as it did in the real incident.
  await page.evaluate(() => {
    for (const u of window.webtmux.manager.units) {
      u.ws.send = () => {};                       // our pings go nowhere
      u.ws.onmessage = () => {};                  // and nothing comes back
    }
  });
  await sleep(14000);   // STALL_MS is 8s, judged on a 3s heartbeat
  const stall = await toolbar((el, rr) => ({
    lost: rr.querySelector('.spin').classList.contains('lost'),
    disconnected: el.disconnected,
    stalled: el.stalledRegions,
    closed: el.lostRegions,
    open: window.webtmux.manager.units.every((u) => u.ws.readyState === WebSocket.OPEN),
  }));
  check('a mute-but-open connection turns the spinner red',
    stall.lost === true && stall.stalled >= 1, JSON.stringify(stall));
  check('…and it really was still an OPEN socket (what readyState alone misses)',
    stall.open === true, `open=${stall.open}`);
  const stallTip = await toolbar((el) => el._lostTip());
  check('the stall tooltip says to reload rather than to wait',
    /stopped answering/.test(stallTip) && /Reload/.test(stallTip) && !/keeps retrying/.test(stallTip),
    stallTip.slice(0, 60) + '…');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(4000);
  const recovered = await toolbar((el, rr) => rr.querySelector('.spin').classList.contains('lost'));
  check('a reload clears the stall', recovered === false, `lost=${recovered}`);

  // ---- 4b. the closed socket -------------------------------------------------
  // Drop every region's socket from underneath the page, exactly as a dead tmux
  // (or a restarted server) would.
  await page.evaluate(() => {
    const mgr = window.webtmux?.manager;
    for (const u of mgr.units) u.ws.close();
  });
  await sleep(1200);
  const spinAfter = await toolbar((el, rr) => {
    const s = rr.querySelector('.spin');
    return {
      lost: s.classList.contains('lost'),
      color: getComputedStyle(s).color,
      disconnected: el.disconnected,
      regions: el.lostRegions,
    };
  });
  check('spinner goes red when the connection to tmux drops',
    spinAfter.lost === true && spinAfter.disconnected === true && spinAfter.regions >= 1,
    JSON.stringify(spinAfter));
  // Test the CHANNELS, not the exact hex: the shade is a design choice that gets
  // tuned, and pinning it here turns every legibility tweak into a false failure.
  const rgb = (spinAfter.color.match(/\d+/g) || []).map(Number);
  check('and it is actually rendered red',
    rgb.length >= 3 && rgb[0] > 200 && rgb[0] > rgb[1] * 2 && rgb[0] > rgb[2] * 2, spinAfter.color);
  await page.screenshot({ path: OUT + '/verify-ux5-lost.png', clip: { x: 0, y: 0, width: 700, height: 44 } });

  // …and PIXELS, not just computed style. The glyph this replaced (✳) had emoji
  // presentation, so Chromium drew it from the color-emoji font and every `color`
  // rule on it — including this one — was silently ignored while getComputedStyle
  // reported the colour perfectly. Crop the spinner itself out of a real screenshot;
  // the run script compares the ink against the connected shot afterwards.
  const spinBox = await page.evaluate(() => {
    const r = document.querySelector('webtmux-toolbar').shadowRoot
      .querySelector('.spin').getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  });
  await page.screenshot({ path: OUT + '/verify-ux5-ink-lost.png', clip: spinBox });

  // It must clear itself when the retry loop gets back in. The server's --reconnect
  // interval is 10s by default, so this waits well past one attempt.
  await sleep(26000);
  const spinBack = await toolbar((el, rr) => ({
    lost: rr.querySelector('.spin').classList.contains('lost'),
    disconnected: el.disconnected,
  }));
  check('and clears once the reconnect lands', spinBack.lost === false, JSON.stringify(spinBack));

  await page.screenshot({ path: OUT + '/verify-ux5-spinner.png', clip: { x: 0, y: 0, width: 700, height: 60 } });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(4000);
  await openRecentMenu();
  await page.screenshot({ path: OUT + '/verify-ux5-menu.png', clip: { x: 0, y: 0, width: 700, height: 320 } });
  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error('DRIVER CRASH', e); process.exit(2); });
