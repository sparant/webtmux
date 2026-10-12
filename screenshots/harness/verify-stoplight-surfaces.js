// Verification driver: every stoplight surface draws the same dot.
//
// The preview tiles and Exposé used to paint their dots by hand and never applied
// the background-work class, so a window reporting 3 showed the recents tab's
// green ring but a grey "not reporting" circle in the preview. All dots now share
// STOPLIGHT_CSS (stoplight-dot.js) and paintWorkClass (stoplight.js). This checks,
// from computed style, that each state renders identically in the recents strip,
// the preview tiles and Exposé, and that the preview tiles carry the same
// time-in-state badge as the recents tab.
//
// Run exactly like run.sh does, with DRIVER=verify-stoplight-surfaces.js.
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const fs = require('fs');

const URL = 'http://localhost:8090/';
const SOCK = '/tmp/wt.sock';
const OUT = '/src/screenshots/verify';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let page;
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

const tmux = (...args) => execFileSync('tmux', ['-S', SOCK, ...args], { encoding: 'utf8' });
const setWork = (win, val) => {
  tmux('set-option', '-t', win, '-w', '@wt_working', val);
  tmux('set-option', '-t', win, '-w', '@wt_working_since', String(Math.floor(Date.now() / 1000) - 7 * 60));
};
const mgr = (fn, arg) => page.evaluate(([f, a]) => eval(f)(window.splitManager, a), [fn.toString(), arg]);

// Colour/size readout of a dot, so "the same" means what the browser drew.
const LOOK = `(d) => { if (!d) return null; const cs = getComputedStyle(d);
  return { fill: cs.backgroundColor, border: cs.borderTopColor, bw: cs.borderTopWidth };}`;

const STATES = { build: ['1', 'on'], server: ['3', 'bg'], tests: ['0', 'off'], editor: ['2', 'wait'] };
// A window in the preview holds no recents tab (by design), so each state is mirrored
// onto a second window that stays in the strip, and the two dots are compared.
const MIRROR = { build: 'htop', server: 'logs', tests: 'shell', editor: 'state' };
const MIRROR_TARGET = { htop: 'ops:htop', logs: 'ops:logs', shell: 'scratch:shell', state: 'scratch:state' };

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

  // Earn recents tabs for the four windows by visiting each, then a fifth so none of
  // them is the one on screen (as verify-recents-target.js does).
  await mgr(async (m, names) => {
    for (const e of [...m.recentWindows]) m.removeRecent(e);
    m.setRecentsMax(8);
    const ps = (m._placements || []).filter((p) => names.includes(p.name));
    for (const p of ps) {
      m.goToWindow(p.id, p.session);
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 200));
        if (m.focusedUnit?.layout?.activeWindowId === p.id) break;
      }
    }
  }, Object.values(MIRROR));
  for (const [w, [v]] of Object.entries(STATES)) {
    setWork(`dev:${w}`, v);
    setWork(MIRROR_TARGET[MIRROR[w]], v);
  }

  const ids = await mgr((m, names) => {
    for (const id of [...m.pip.windowIds()]) m.pip.removeWindow(id);
    m.pip.setHidden(false);
    const ps = (m._placements || []).filter((p) => p.session === 'dev' && names.includes(p.name));
    for (const p of ps) m.pip.addWindow(p.id, { session: p.session, index: p.index, name: p.name });
    return Object.fromEntries(ps.map((p) => [p.name, p.id]));
  }, Object.keys(STATES));
  check('setup: four windows in the preview', Object.keys(ids).length === 4, JSON.stringify(ids));
  await sleep(2500);

  const read = () => page.evaluate(([look, ids, mirror]) => {
    const L = eval(look);
    const tb = document.querySelector('webtmux-toolbar').shadowRoot;
    const pip = document.querySelector('webtmux-pip').shadowRoot;
    const out = {};
    for (const [name, id] of Object.entries(ids)) {
      const tab = [...tb.querySelectorAll('.rtab')].find((t) => t.querySelector('.wname')?.textContent.includes(mirror[name]));
      const tile = [...pip.querySelectorAll('.ptile')].find((t) => t.querySelector('.plabel .name')?.textContent.includes(name));
      const pdot = tile?.querySelector('.pwork');
      const page = tile?.querySelector('.plabel .work-age');
      const tage = tab?.querySelector('.work-age');
      out[name] = {
        tab: L(tab?.querySelector('.work')), tile: L(pdot),
        tileCls: pdot ? [...pdot.classList].join(' ') : null,
        tabAge: tage?.textContent || '', tileAge: page && !page.hidden ? page.textContent : '',
        tabAgeLook: tage ? getComputedStyle(tage).fontSize + ' ' + getComputedStyle(tage).color : null,
        tileAgeLook: page ? getComputedStyle(page).fontSize + ' ' + getComputedStyle(page).color : null,
      };
    }
    return out;
  }, [LOOK, ids, MIRROR]);

  await sleep(1500);
  const r = await read();
  for (const [name, [, cls]] of Object.entries(STATES)) {
    const x = r[name] || {};
    check(`${name} (${cls}): preview tile carries the class`, (x.tileCls || '').split(' ').includes(cls), x.tileCls);
    check(`${name} (${cls}): preview dot looks like the recents dot`,
      !!x.tab && !!x.tile && x.tab.fill === x.tile.fill && x.tab.border === x.tile.border && x.tab.bw === x.tile.bw,
      `tab=${JSON.stringify(x.tab)} tile=${JSON.stringify(x.tile)}`);
    check(`${name}: preview shows the same time-in-state badge`,
      !!x.tileAge && x.tileAge === x.tabAge && x.tileAgeLook === x.tabAgeLook,
      `tab="${x.tabAge}" (${x.tabAgeLook}) tile="${x.tileAge}" (${x.tileAgeLook})`);
  }

  fs.mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: `${OUT}/stoplight-surfaces-full.png` });
  await page.screenshot({ path: `${OUT}/stoplight-surfaces-strip.png`, clip: { x: 0, y: 0, width: 1600, height: 40 } });

  // Exposé: same dot for each state.
  await page.keyboard.press('Control+Alt+e');
  await sleep(2500);
  const ex = await page.evaluate(([look, ids]) => {
    const L = eval(look);
    const el = document.querySelector('webtmux-expose');
    const out = {};
    for (const [name, id] of Object.entries(ids)) {
      const rec = [...(el._tiles?.values?.() || [])].find((t) => t.windowId === id);
      out[name] = L(rec?.work);
    }
    return out;
  }, [LOOK, ids]);
  for (const [name, [, cls]] of Object.entries(STATES)) {
    const a = r[name]?.tab; const b = ex[name];
    check(`${name} (${cls}): Exposé dot looks like the recents dot`,
      !!a && !!b && a.fill === b.fill && a.border === b.border && a.bw === b.bw,
      `tab=${JSON.stringify(a)} expose=${JSON.stringify(b)}`);
  }
  await page.screenshot({ path: `${OUT}/stoplight-surfaces-expose.png` });
  await page.keyboard.press('Escape');

  await browser.close();
  const bad = results.filter((x) => !x.ok);
  console.log(`\n${results.length - bad.length}/${results.length} passed`);
  process.exit(bad.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
