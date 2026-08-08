// Verification driver for "a reconnect puts you back where you were".
//
// THE BUG. Close the laptop, open it again: the websocket had dropped, and the fresh
// attach put the primary region back on the SHARED BASE session, on whatever window it
// currently shows — in practice its most recently CREATED window, since creating one
// makes it current and nothing has moved that session since. You came back to a window
// you had never opened rather than the one you were working in, and because that parked
// window is (correctly) marked already-seen it wasn't even in the recents strip to
// explain itself. Only the extra grouped regions were restored; the primary was left
// out to protect the ssh console sharing the base session's attach — which select-window
// really would drag, but switch-client does not.
//
// What node cannot check is the only part that matters: whether a REAL socket drop
// against a REAL tmux server ends with the pane back in the session and window it left,
// without the parked window landing in the recents strip and without the base session
// being dragged around.
//
// Run exactly like run.sh does, with DRIVER=verify-reconnect-restore.js (and
// WT_RECONNECT_TIME=1, so the wait is seconds rather than tens of them).
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');

const URL = 'http://localhost:8090/';
const SOCK = '/tmp/wt.sock';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let page;
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

const tmux = (...args) => execFileSync('tmux', ['-S', SOCK, ...args], { encoding: 'utf8' }).trim();

// ---- reach-ins ---------------------------------------------------------------

const primary = (fn, arg) => page.evaluate(([f, a]) => {
  const u = window.splitManager?.units?.[0] || window.webtmux;
  return eval(f)(u, a);
}, [fn.toString(), arg]);

const view = () => primary((u) => ({
  win: u.layout?.activeWindowId || '',
  session: u.layout?.sessionBase || u.layout?.sessionName || '',
}));
const recents = () => page.evaluate(() =>
  (window.splitManager?.recentWindows || []).map((e) => `${e.session}:${e.id}`));

// Every (session, window) the server knows, from the directory the layout carries.
const directory = () => primary((u) => (u.layout?.allWindows || [])
  .map((w) => ({ id: w.id, session: w.session, name: w.name })));

async function waitFor(pred, ms = 8000, every = 250) {
  for (let i = 0; i < ms / every; i++) {
    if (await pred()) return true;
    await sleep(every);
  }
  return false;
}

// Drop the primary's websocket the way a sleeping laptop does: the socket dies, the
// unit is untouched (it still remembers the view), and its own reconnect timer fires.
const dropSocket = () => primary((u) => { u.ws.close(); return true; });

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    httpCredentials: { username: 'wt', password: 'wt' },
  });
  page = await ctx.newPage();
  page.on('dialog', (d) => { console.log('UNEXPECTED DIALOG:', d.message()); d.dismiss(); });
  await page.goto(URL);
  await page.waitForFunction(() => window.splitManager?.units?.[0]?.layout, null, { timeout: 20000 });
  await sleep(1500);

  const boot = await view();
  const dir = await directory();
  console.log('boot view:', JSON.stringify(boot));

  // The window the base session is parked on — where a fresh attach lands, and where
  // the bug left you. Deliberately NOT the one we go to.
  const parked = boot.win;

  // Somewhere else entirely: another session's window. `scratch:state` is last in the
  // staged server, standing in for the stoplight-bridge window this was reported on.
  const target = dir.find((w) => w.session === 'scratch' && w.name === 'state');
  if (!target) { console.log('FAIL  harness: scratch:state not staged'); process.exit(1); }

  // --- 1. go there, exactly as the sidebar/Exposé do -------------------------
  await page.evaluate(([id, s]) => window.splitManager.goToWindow(id, s), [target.id, target.session]);
  const arrived = await waitFor(async () => {
    const v = await view();
    return v.win === target.id && v.session === 'scratch';
  });
  check('the primary can hop to another session at all', arrived, JSON.stringify(await view()));
  if (!arrived) { await browser.close(); process.exit(1); }

  const baseBefore = tmux('display-message', '-p', '-t', 'dev', '#{window_name}');
  const recentsBefore = await recents();

  // --- 2. the laptop lid ----------------------------------------------------
  await dropSocket();
  const reconnected = await waitFor(async () =>
    await primary((u) => u.ws && u.ws.readyState === 1), 15000);
  check('the socket comes back on its own', reconnected);

  // Give the restore its hop + select, then let the layout poll settle.
  await sleep(3000);
  const after = await view();

  check('the reconnect lands back in the session it left', after.session === 'scratch',
    `session=${after.session}`);
  check('...and on the window it left', after.win === target.id,
    `window=${after.win} (parked window was ${parked})`);

  // --- 3. the things the restore must not break -----------------------------
  const recentsAfter = await recents();
  const leaked = recentsAfter.filter((e) => !recentsBefore.includes(e));
  check('the parked window does not leak into the recents strip', leaked.length === 0,
    leaked.length ? `gained ${leaked.join(', ')}` : `${recentsAfter.length} tabs, unchanged`);

  const baseAfter = tmux('display-message', '-p', '-t', 'dev', '#{window_name}');
  check('the shared base session is not dragged along', baseAfter === baseBefore,
    `dev is on ${baseAfter} (was ${baseBefore})`);

  // --- 4. and the case the old behavior got right ---------------------------
  // Back inside the base session, a reconnect must still FOLLOW tmux rather than
  // yank it: select-window there moves the session and the ssh console with it.
  const home = dir.find((w) => w.session === 'dev' && w.id !== parked);
  await page.evaluate(([id, s]) => window.splitManager.goToWindow(id, s), [home.id, 'dev']);
  await waitFor(async () => (await view()).win === home.id);
  await sleep(500);
  await dropSocket();
  await waitFor(async () => await primary((u) => u.ws && u.ws.readyState === 1), 15000);
  await sleep(3000);
  const back = await view();
  check('a same-session reconnect follows the base session, not a stale window',
    back.session === 'dev' && back.win === tmuxCurrentId(),
    `on ${back.session}:${back.win}, tmux says ${tmuxCurrentId()}`);

  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

// The window id `dev` is actually on right now, straight from tmux — the answer the
// primary is supposed to agree with inside the base session.
function tmuxCurrentId() {
  return tmux('display-message', '-p', '-t', 'dev', '#{window_id}');
}
