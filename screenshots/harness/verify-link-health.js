// Verification driver for the three-state connection spinner (link-health.js).
//
// The bug: come back to the app after the laptop has been shut and the socket is open,
// mute and useless — clicks do nothing — while the spinner stays green for another ten
// seconds or so before admitting it. The old heartbeat woke up, saw an hour of silence,
// correctly decided the silence was OURS, and then resolved the ambiguity by declaring
// the link healthy and skipping that beat's probe.
//
// What this checks, on the real UI, against a real server:
//   1. the spinner is normal on a healthy link, and stays normal through a resume
//   2. an INTERACTION with a mute link colours the spinner in about two seconds
//      (amber = asked, unanswered) and red at the stall deadline — this is the "I
//      clicked around and nothing happened" case
//   3. amber is a state you climb OUT of: a late answer takes it back to normal
//   4. coming back to a mute tab (visibilitychange/focus) probes immediately rather
//      than waiting for the next scheduled beat
//   5. amber and red are distinguishable ON THE PIXELS, not merely in the class list —
//      see check-spinner-ink.sh for why nothing here trusts getComputedStyle alone
//
// Run exactly like run.sh does, with DRIVER=verify-link-health.js.
const { chromium } = require('playwright');
const fs = require('fs');

const OUT = '/src/screenshots/verify';
const URL = 'http://localhost:8090/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Kept in step with link-health.js. Hard-coded rather than imported: this file runs in
// node against a served page, and the module it would import is the browser's copy.
const IDLE_PROBE_MS = 6000;

let page;
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

const toolbar = (fn, arg) => page.evaluate(([f, a]) => {
  const el = document.querySelector('webtmux-toolbar');
  const rr = el.shadowRoot;
  return eval(f)(el, rr, a);
}, [fn.toString(), arg]);

// What colour is the spinner claiming to be right now?
const spinState = () => toolbar((el, rr) => {
  const s = rr.querySelector('.spin');
  return {
    cls: s.className.replace('spin', '').trim(),
    linkState: el.linkState,
    slow: el.slowRegions,
    mute: el.stalledRegions,
    closed: el.lostRegions,
    open: window.webtmux.manager.units.every((u) => u.ws.readyState === WebSocket.OPEN),
    waited: window.webtmux.manager.linkWaitedMs(),
    // The primary region's raw judgement, so a failure here says WHY rather than just
    // "still green": how long since the ask, when the last probe went out, and the
    // measured round trip the amber budget is derived from.
    link: (() => {
      const l = window.webtmux.manager.units[0].link;
      const t = Date.now();
      return { rtt: Math.round(l._rtt), budget: Math.round(l.slowAfter()),
        sinceProbe: l._lastProbeAt ? t - l._lastProbeAt : null, due: l.dueProbe(t) };
    })(),
  };
});

// Crop the spinner itself out of a real screenshot. A class name is not a colour.
async function inkShot(name) {
  const box = await page.evaluate(() => {
    const r = document.querySelector('webtmux-toolbar').shadowRoot
      .querySelector('.spin').getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  });
  await page.screenshot({ path: `${OUT}/link-${name}.png`, clip: box });
}

// Wedge the link WITHOUT closing it: swallow what the page sends and withhold what
// comes back. The socket object is untouched and reports OPEN throughout — this is
// exactly what a suspended laptop or a wedged server looks like from in here, and
// exactly what a readyState check cannot see.
const goMute = () => page.evaluate(() => {
  for (const u of window.webtmux.manager.units) {
    u._realSend = u.ws.send.bind(u.ws);
    u._realOnMessage = u.ws.onmessage;
    u.ws.send = () => {};
    u.ws.onmessage = () => {};
  }
});

const goLive = () => page.evaluate(() => {
  for (const u of window.webtmux.manager.units) {
    if (u._realSend) u.ws.send = u._realSend;
    if (u._realOnMessage) u.ws.onmessage = u._realOnMessage;
  }
});

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

  // ---- 1. a healthy link ------------------------------------------------------
  const healthy = await spinState();
  check('a healthy link leaves the spinner alone',
    healthy.cls === '' && healthy.linkState === 'live', JSON.stringify(healthy));
  await inkShot('live');

  // Typing at a healthy link must not colour it: the ask is answered (by echo, then by
  // the probe's Pong) long before any threshold. A false amber on every keystroke would
  // be worse than the bug being fixed.
  await page.keyboard.type('echo hello');
  await sleep(2500);
  const afterTyping = await spinState();
  check('typing at a live link never colours the spinner',
    afterTyping.cls === '', JSON.stringify(afterTyping));
  await page.keyboard.press('Backspace');

  // A resume with the link genuinely up must also stay quiet — the fix must not trade
  // a late alarm for a false one every time you come back to the tab.
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await sleep(2500);
  const afterWake = await spinState();
  check('coming back to a healthy tab does not flash a warning',
    afterWake.cls === '', JSON.stringify(afterWake));

  // ---- 2. interact with a mute link ------------------------------------------
  await goMute();
  const t0 = Date.now();
  await page.keyboard.type('ls');          // the interaction IS the probe
  await sleep(2600);
  const amber = await spinState();
  check('an interaction with a mute link goes amber within ~2.5s',
    amber.cls === 'slow' && amber.linkState === 'slow' && amber.slow >= 1,
    `${Date.now() - t0}ms ${JSON.stringify(amber)}`);
  check('…and the socket really was still OPEN (what readyState alone misses)',
    amber.open === true, `open=${amber.open}`);
  await inkShot('slow');

  const slowTip = await toolbar((el) => el._slowTip());
  check('the amber tooltip says late, not gone, and counts the wait',
    /answering slowly/.test(slowTip) && /\d+s/.test(slowTip) && /clears itself/.test(slowTip),
    slowTip.slice(0, 70) + '…');

  // ---- 3. …and it climbs back out --------------------------------------------
  // Amber is not a one-way door: the answer arriving is the end of it.
  await goLive();
  await page.keyboard.type(' ');
  await sleep(2000);
  const recovered = await spinState();
  check('a link that answers again goes straight back to normal',
    recovered.cls === '' && recovered.linkState === 'live', JSON.stringify(recovered));

  // ---- 4. amber escalates to red at the stall deadline ------------------------
  await goMute();
  await page.keyboard.type('x');
  await sleep(10_000);                     // STALL_MS is 8s, measured from the ask
  const red = await spinState();
  check('an ask that is never answered ends up red',
    red.cls === 'lost' && red.linkState === 'lost' && red.mute >= 1, JSON.stringify(red));
  check('…and it is reported as MUTE rather than closed, so the tooltip says reload',
    red.closed === 0, JSON.stringify(red));
  await inkShot('lost');
  const lostTip = await toolbar((el) => el._lostTip());
  check('the red tooltip still tells a mute link to reload rather than wait',
    /stopped answering/.test(lostTip) && /Reload/.test(lostTip), lostTip.slice(0, 60) + '…');

  // ---- 5. coming back to a tab that died while you were away ------------------
  // The original complaint, reproduced: the link is mute and the page has been away.
  // Wake it and time how long the spinner takes to stop claiming health. Under the old
  // heartbeat this was ~11-14s and the first beat after the wake was thrown away.
  // Let it recover first. A RED link backs its probing off to the idle cadence (a mute
  // socket nobody is going to unwedge must not be pinged once a second forever), so
  // coming back from red takes up to one idle period rather than one keystroke — poll
  // for it rather than assuming a fixed delay.
  await goLive();
  await page.keyboard.type(' ');
  let healed = null;
  for (let i = 0; i < 40; i++) {
    const s = await spinState();
    if (!s.cls) { healed = i * 250; break; }
    await sleep(250);
  }
  check('a red link heals itself once the server answers again — no reload needed',
    healed !== null, healed === null ? 'never healed' : `${healed}ms`);

  await page.evaluate(() => {
    // Look away…
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await goMute();                          // …and the link dies while nobody is looking
  const hiddenAt = await spinState();
  await sleep(IDLE_PROBE_MS + 2500);       // long enough that a visible tab would have probed
  const away = await spinState();
  check('a hidden tab is not probed on spec (nothing to see, nobody looking)',
    away.link.sinceProbe > IDLE_PROBE_MS && away.link.due === false,
    JSON.stringify({ before: hiddenAt.link, after: away.link }));

  const wokeAt = Date.now();
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  // Poll rather than sleep: the number we care about is HOW LONG it took.
  let coloured = null;
  for (let i = 0; i < 60; i++) {
    const s = await spinState();
    if (s.cls) { coloured = { ...s, ms: Date.now() - wokeAt }; break; }
    await sleep(250);
  }
  check('coming back to a dead link colours the spinner in under 4s',
    !!coloured && coloured.ms < 4000, coloured ? `${coloured.ms}ms -> ${coloured.cls}` : 'never coloured');

  fs.writeFileSync(`${OUT}/link-health-results.json`, JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  await browser.close();
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
