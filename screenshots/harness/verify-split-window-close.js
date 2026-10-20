// Verification driver: closing a tmux WINDOW never closes the split VIEW showing it.
// The view takes the next window instead, picked the way closing a recents tab picks —
// the next tab to the right, skipping windows another view is showing — and only the
// view's own ✕ removes a view.
//
//   1. A window killed under a view (its session survives): the view stays and shows the
//      next tab along — not whatever tmux fell back to, and never a window the other view
//      already has.
//   2. The same for the first (primary) view.
//   3. The LAST window of a session killed under a view: the session dies and takes the
//      view's tmux client with it. The view re-attaches straight away and lands on the
//      next tab.
//   4. × on the recents tab of a window a view is showing: the view stays and moves on.
//   5. Ctrl+Alt+D (drop the focused window's tab): the same.
//
// Run exactly like run.sh does, with DRIVER=verify-split-window-close.js.
const { chromium } = require('playwright');
const { execSync } = require('child_process');

const URL = 'http://localhost:8090/';
const SOCK = '/tmp/wt.sock';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmux = (args) => execSync(`tmux -S ${SOCK} ${args}`, { encoding: 'utf8' });

let page;
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

const mgr = (fn, arg) => page.evaluate(([f, a]) => eval(f)(window.splitManager, a), [fn.toString(), arg]);
const panes = () => mgr((m) => m.units.map((u) => u._targetWindowId || u.layout?.activeWindowId));
const count = () => mgr((m) => m.units.length);
const strip = () => mgr((m) => m.recentWindows.map((e) => e.id));

// What the app should pick when `gone` closes under view `i`: the next strip entry to
// the right, wrapping, that is not `gone` and not shown in another view.
function expectedNext(order, gone, others) {
  const at = order.indexOf(gone);
  for (let k = 1; k < order.length; k++) {
    const id = order[(at + k) % order.length];
    if (id !== gone && !others.includes(id)) return id;
  }
  return null;
}

async function settle(i, ms = 6000) {
  for (let t = 0; t < ms; t += 300) {
    await sleep(300);
    const ok = await mgr((m, n) => {
      const u = m.units[n];
      return !!u && u.isConnected() && !u._targetWindowId && !u._restoreWindowId;
    }, i);
    if (ok) return;
  }
}

async function visitFresh(session) {
  return mgr(async (m, s) => {
    const held = new Set(m.recentWindows.map((e) => e.id));
    for (const u of m.units) held.add(u.layout?.activeWindowId);
    const fresh = (m._placements || []).find((p) => !held.has(p.id) && (!s || p.session === s));
    if (!fresh) return null;
    m.goToWindow(fresh.id, fresh.session);
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 200));
      if (m.focusedUnit?.layout?.activeWindowId === fresh.id) break;
    }
    return fresh.id;
  }, session);
}

async function main() {
  // Extra windows in dev, so there is plenty to kill and plenty to step to.
  for (const n of ['k1', 'k2', 'k3', 'k4']) tmux(`new-window -d -t dev: -n ${n} 'sleep 99999'`);

  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    httpCredentials: { username: 'wt', password: 'wt' },
  });
  page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await sleep(4000);

  await mgr((m) => {
    m.sidebar.collapsed = true;
    for (const id of [...m.pip.windowIds()]) m.pip.removeWindow(id);
    for (const u of m.units.slice(1)) m.removeUnit(u);
    for (const e of [...m.recentWindows]) m.removeRecent(e);
    m.setRecentsMax(8);
  });
  await sleep(1200);
  for (let i = 0; i < 7; i++) await visitFresh('dev');
  await sleep(800);
  await mgr((m) => m.splitAdd('row'));
  await sleep(3500);
  check('setup: two views', (await count()) === 2, (await panes()).join(' '));

  // ---- 1. kill the second view's window ---------------------------------------------
  let order = await strip();
  let p = await panes();
  let want = expectedNext(order, p[1], [p[0]]);
  tmux(`kill-window -t ${p[1]}`);
  await sleep(2500);
  await settle(1);
  let q = await panes();
  check('a window killed under a view leaves the view in place', (await count()) === 2);
  check('…which shows the next tab along', q[1] === want, `strip ${order.join(' ')}, killed ${p[1]}, want ${want}, got ${q[1]}`);
  check('…and not the other view\'s window', q[1] !== q[0], q.join(' '));

  // ---- 2. the same for the primary ----------------------------------------------------
  order = await strip();
  p = await panes();
  want = expectedNext(order, p[0], [p[1]]);
  tmux(`kill-window -t ${p[0]}`);
  await sleep(2500);
  await settle(0);
  q = await panes();
  check('the first view keeps its place too', (await count()) === 2);
  check('…showing the next tab along', q[0] === want, `strip ${order.join(' ')}, killed ${p[0]}, want ${want}, got ${q[0]}`);

  // ---- 3. the last window of its session --------------------------------------------
  tmux(`new-session -d -s solo -n lonely 'sleep 99999'`);
  await sleep(1500);
  const solo = await mgr((m) => (m.units[0].layout.allWindows || []).find((w) => w.session === 'solo'));
  await mgr((m, w) => { m.focus(m.units[1]); m.goToWindow(w.id, 'solo'); }, solo);
  await sleep(2500);
  check('setup: the second view is on a one-window session', (await panes())[1] === solo.id, (await panes()).join(' '));
  order = await strip();
  p = await panes();
  want = expectedNext(order, p[1], [p[0]]);
  tmux(`kill-window -t ${solo.id}`);
  await sleep(1500);
  await settle(1, 8000);
  q = await panes();
  const conn = await mgr((m) => m.units[1]?.isConnected());
  check('killing a session\'s last window keeps the view', (await count()) === 2);
  check('…which re-attaches by itself', conn === true);
  check('…and shows the next tab along', q[1] === want, `strip ${order.join(' ')}, killed ${p[1]}, want ${want}, got ${q[1]}`);
  check('…not the other view\'s window', q[1] !== q[0], q.join(' '));

  // ---- 4. × on the tab of a window a view is showing ------------------------------------
  await mgr((m) => m.focus(m.units[0]));
  await sleep(400);
  order = await strip();
  p = await panes();
  want = expectedNext(order, p[1], [p[0]]);
  await mgr((m, id) => m.removeRecent(m.recentWindows.find((e) => e.id === id)), p[1]);
  await sleep(2500);
  q = await panes();
  check('× on the tab of the other view\'s window keeps that view', (await count()) === 2);
  check('…which moves on to the next tab', q[1] === want, `strip ${order.join(' ')}, dropped ${p[1]}, want ${want}, got ${q[1]}`);
  check('…and the focused view is untouched', q[0] === p[0], `${p[0]} -> ${q[0]}`);

  // ---- 5. Ctrl+Alt+D on the focused view -----------------------------------------------
  await mgr((m) => m.focus(m.units[1]));
  await sleep(400);
  await page.keyboard.press('Control+Alt+d');
  await sleep(2500);
  check('Ctrl+Alt+D never closes the view', (await count()) === 2);
  q = await panes();
  check('…and leaves the views on different windows', q[0] !== q[1], q.join(' '));

  await browser.close();
  const bad = results.filter((r) => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} passed`);
  process.exit(bad.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
