// Verification driver for "hovering a session tab near the sidebar's flex-wrap
// boundary flickers between two lines forever".
//
// Root cause: .session-tab grew padding-right by 16px ONLY on :hover (to reveal the
// kill ×), inside a `.session-tabs { flex-wrap: wrap }` row. A tab sitting right at
// the row's width limit would tip onto the next line the instant it grew — which
// moves it out from under the pointer, drops :hover, shrinks it back, refits it on
// the original line, re-triggers :hover, grows again: forever.
//
// Fix: reserve the kill button's space PERMANENTLY (`.has-kill`) instead of only on
// :hover, so hovering never changes a tab's box size and it can never cross the
// wrap boundary.
//
// This driver stages many sessions with a spread of name lengths (near-guaranteeing
// some tab lands at a wrap boundary at the sidebar's fixed 330px width), puts the
// sidebar in side-by-side mode so its box participates in real layout, then hovers
// EVERY session tab three times each and asserts:
//   1. no tab ever changes row (top y) between not-hovered / hovered / not-hovered
//   2. .has-kill tabs' padding-right is identical hovered vs not (the actual fix)
const { chromium } = require('playwright');
const { execSync } = require('child_process');

const URL = 'http://localhost:8090/';
const SOCK = '/tmp/wt.sock';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let page;
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

const T = (args) => execSync(`tmux -u -S ${SOCK} ${args}`, { stdio: 'pipe' });

// Reach into the sidebar's shadow root, same pattern the toolbar driver uses.
const sidebar = (fn, arg) => page.evaluate(([f, a]) => {
  const el = document.querySelector('webtmux-sidebar');
  return eval(f)(el, el.shadowRoot, a);
}, [fn.toString(), arg]);

async function main() {
  // Stage a spread of session-name widths so some tab lands near the sidebar's
  // fixed content width (330px host - 24px padding). Widths 1..16 chars almost
  // certainly straddle at least one wrap point at 15px/char-ish monospace-ish text.
  const letters = 'abcdefghijklmnop'.split('');
  for (let i = 1; i <= letters.length; i++) {
    const name = 'w' + letters[i - 1].repeat(i);
    try { T(`new-session -d -s ${name} -x 80 -y 24`); } catch (e) { /* already exists across reruns */ }
  }

  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    httpCredentials: { username: 'wt', password: 'wt' },
  });
  page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await sleep(4000);

  // Side-by-side (not overlay), expanded, so the sidebar's box is real layout and
  // .session-tabs wraps at its actual fixed width.
  await sidebar((el) => { el.collapsed = false; el.overlay = false; el.pinned = true; });
  await sleep(600);

  const tabCount = await sidebar((el, rr) => rr.querySelectorAll('.session-tabs .session-tab:has(.kill)').length);
  check('sidebar shows many session tabs to pack against the wrap boundary',
    tabCount >= 15, `${tabCount} tabs`);

  // For every session tab: record its row (top), hover it, record again, unhover,
  // record a third time. A wrap-flicker shows up as top changing while hovered
  // (or, if the flicker is fast enough to have already settled onto the other line
  // by the time we read, as a THIRD reading that disagrees with the first).
  const n = await sidebar((el, rr) => rr.querySelectorAll('.session-tabs .session-tab:has(.kill)').length);
  let flickered = 0;
  let paddingChanged = 0;
  const flickerDetail = [];
  for (let i = 0; i < n; i++) {
    const before = await sidebar((el, rr, idx) => {
      const t = rr.querySelectorAll('.session-tabs .session-tab:has(.kill)')[idx];
      const r = t.getBoundingClientRect();
      return { top: Math.round(r.top), left: Math.round(r.left), width: Math.round(r.width),
               padRight: getComputedStyle(t).paddingRight, name: t.textContent.trim() };
    }, i);

    // Real mouse hover (not just a class toggle) so CSS :hover genuinely applies,
    // and so a real wrap would really move the element out from under the pointer.
    const box = await sidebar((el, rr, idx) => {
      const t = rr.querySelectorAll('.session-tabs .session-tab:has(.kill)')[idx];
      const r = t.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, i);
    await page.mouse.move(box.x, box.y);
    await sleep(250);

    const hovered = await sidebar((el, rr, idx) => {
      const t = rr.querySelectorAll('.session-tabs .session-tab:has(.kill)')[idx];
      const r = t.getBoundingClientRect();
      return { top: Math.round(r.top), left: Math.round(r.left), width: Math.round(r.width),
               padRight: getComputedStyle(t).paddingRight };
    }, i);

    await page.mouse.move(5, 5); // well off the sidebar
    await sleep(250);

    const after = await sidebar((el, rr, idx) => {
      const t = rr.querySelectorAll('.session-tabs .session-tab:has(.kill)')[idx];
      if (!t) return null;
      const r = t.getBoundingClientRect();
      return { top: Math.round(r.top), left: Math.round(r.left) };
    }, i);

    const rowStable = before.top === hovered.top && after && before.top === after.top;
    if (!rowStable) {
      flickered++;
      flickerDetail.push(`"${before.name}" top ${before.top}->${hovered.top}->${after && after.top}`);
    }
    if (before.padRight !== hovered.padRight) {
      paddingChanged++;
      flickerDetail.push(`"${before.name}" padRight ${before.padRight}->${hovered.padRight}`);
    }
  }
  check('no session tab changes row when hovered (the wrap-flicker bug)',
    flickered === 0, flickered ? flickerDetail.join('; ') : `${n} tabs checked, all stable`);
  check('has-kill tabs keep a fixed padding-right across hover (the actual fix)',
    paddingChanged === 0, paddingChanged ? flickerDetail.join('; ') : `${n} tabs checked, all fixed at reserved width`);

  try {
    execSync('mkdir -p /src/screenshots/tmp-verify-wrap');
    await page.screenshot({ path: '/src/screenshots/tmp-verify-wrap/sidebar.png' });
  } catch (e) { /* best-effort */ }

  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
