// Verification driver for "a preview tile's label is shaped like a recents tab's".
//
// The recents strip labels a window by the two toggles under its Recent ▾ menu —
// "Show session" and "Trim name to after first space" (window-label.js). The preview's
// label strip used to ignore them and always print "N: full name" plus the session, so
// the same window could read "web-01" on its tab and "ssh web-01  dev" under its
// thumbnail. This checks, in a real browser against a real tmux:
//
//   1. With the defaults (session hidden, name trimmed), a tile reads index + trimmed
//      name — exactly what the recents tab for that window reads.
//   2. Each toggle, flipped through the real menu, re-labels the tiles at once, in
//      all four combinations, and matches the tab's label for the same window.
//   3. A tmux rename reaches the tile's label, still formatted.
//
// Run exactly like run.sh does, with DRIVER=verify-pip-label-format.js.
const { chromium } = require('playwright');
const { execSync } = require('child_process');

const URL = 'http://localhost:8090/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let page;
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

const mgr = (fn, arg) => page.evaluate(([f, a]) => eval(f)(window.splitManager, a), [fn.toString(), arg]);
const toolbar = (fn, arg) => page.evaluate(([f, a]) => {
  const el = document.querySelector('webtmux-toolbar');
  return eval(f)(el, el.shadowRoot, a);
}, [fn.toString(), arg]);

// Every tile's label as drawn: {id, idx, name}.
const tileLabels = () => page.evaluate(() => {
  const rr = document.querySelector('webtmux-pip').shadowRoot;
  return [...rr.querySelectorAll('.ptile')].map((t) => ({
    id: t.dataset.window,
    idx: t.querySelector('.plabel .idx')?.textContent,
    name: t.querySelector('.plabel .name')?.textContent,
    sess: !!t.querySelector('.plabel .sess'),
  }));
});

// What the recents tab says for the same window under the toolbar's CURRENT prefs —
// the toolbar's own formatter, so the comparison is against the strip, not a copy.
const tabLabelFor = (w) => toolbar((el, rr, x) => el._tabLabel(x), w);

// Flip a Labels toggle through the real menu (opened from the Recent ▾ label).
async function toggle(which) {
  await toolbar((el) => { el.labelMenuOpen = true; });
  await sleep(200);
  const ok = await toolbar((el, rr, text) => {
    const b = [...rr.querySelectorAll('.label-menu .mitem')].find((x) => x.textContent.includes(text));
    if (!b) return false;
    b.click();
    return true;
  }, which === 'session' ? 'Show session' : 'Trim name');
  await toolbar((el) => { el.labelMenuOpen = false; });
  await sleep(400);
  return ok;
}

async function main() {
  // A name with a space in it, so "trim" has something to do.
  execSync('tmux -S /tmp/wt.sock rename-window -t dev:build "make build-all"');
  execSync('tmux -S /tmp/wt.sock rename-window -t dev:server "ssh web-01"');

  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    httpCredentials: { username: 'wt', password: 'wt' },
  });
  page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await sleep(4000);

  // Known state: defaults for the label prefs, an empty preview, then three tiles.
  await toolbar((el) => { el._setLabelPref('showSession', false); el._setLabelPref('trimName', true); });
  const wins = await mgr((m) => {
    for (const id of [...m.pip.windowIds()]) m.pip.removeWindow(id);
    m.pip.setHidden(false);
    const ps = (m._placements || []).filter((p) => p.session === 'dev').slice(0, 3);
    for (const p of ps) m.pip.addWindow(p.id, { session: p.session, index: p.index, name: p.name });
    return ps.map((p) => p.id);
  });
  check('setup: three dev windows in the preview', wins.length === 3, wins.join(' '));
  await sleep(2500);

  const expectAll = async (label) => {
    const tiles = await tileLabels();
    const live = await mgr((m) => m.pip._wins.map((w) => ({ id: w.windowId, session: w.session, index: w.index, name: w.name })));
    let ok = tiles.length === live.length;
    const detail = [];
    for (const w of live) {
      const t = tiles.find((x) => x.id === w.id);
      const want = await tabLabelFor(w);
      const good = t && t.name === want && t.idx === String(w.index) && !t.sess;
      ok = ok && good;
      detail.push(`${t?.idx} ${JSON.stringify(t?.name)}${good ? '' : ` (want ${w.index} ${JSON.stringify(want)})`}`);
    }
    check(label, ok, detail.join(' | '));
    return tiles;
  };

  // ---- 1. defaults ---------------------------------------------------------------
  const d = await expectAll('defaults: every tile reads index + trimmed name, as its tab would');
  check('…"ssh web-01" reads "web-01" and there is no separate session column',
    d.some((t) => t.name === 'web-01') && d.every((t) => !t.sess), JSON.stringify(d));

  // ---- 2. the four combinations, through the real menu ----------------------------
  check('menu: "Show session" toggled', await toggle('session'));
  const s = await expectAll('session shown + trimmed: "dev: web-01"');
  check('…literally', s.some((t) => t.name === 'dev: web-01'), JSON.stringify(s.map((t) => t.name)));

  check('menu: "Trim name" toggled', await toggle('trim'));
  const st = await expectAll('session shown + untrimmed: "dev: ssh web-01"');
  check('…literally', st.some((t) => t.name === 'dev: ssh web-01'), JSON.stringify(st.map((t) => t.name)));

  check('menu: "Show session" toggled back', await toggle('session'));
  const u = await expectAll('session hidden + untrimmed: "ssh web-01"');
  check('…literally', u.some((t) => t.name === 'ssh web-01'), JSON.stringify(u.map((t) => t.name)));

  check('menu: "Trim name" toggled back', await toggle('trim'));
  await expectAll('back to the defaults');

  // ---- 3. a rename reaches the label, formatted -------------------------------------
  execSync('tmux -S /tmp/wt.sock rename-window -t dev:2 "tail access.log"');
  await sleep(3500);
  const r = await tileLabels();
  check('a tmux rename re-labels the tile, still trimmed', r.some((t) => t.name === 'access.log'), JSON.stringify(r.map((t) => t.name)));

  await browser.close();
  const bad = results.filter((x) => !x.ok);
  console.log(`\n${results.length - bad.length}/${results.length} passed`);
  process.exit(bad.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
