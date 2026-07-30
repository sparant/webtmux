// Verification driver for the harden-parse subplan. Everything here needs the
// REAL stack — a live tmux server, the Go layout controller, the websocket and the
// browser — because every fix in this subplan is invisible to a unit test that
// stubs any one of those layers out. The Go tests pin the parse and the argv; this
// pins that the parse is fed the format the code asks tmux for, and that the UI
// built on top of it still names, lights and navigates to the right thing.
//
// The fixture is one window called `a, b | c` (a comma AND a pipe — the comma
// broke the old per-session split, the pipe is the new separator) inside a session
// called `ops | staging` (the second user-typed string on the same rows).
//
// Run exactly like run.sh does, with DRIVER=verify-parse.js.
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');

const URL = 'http://localhost:8090/';
const SOCK = '/tmp/wt.sock';
const NASTY_WIN = 'a, b | c';
const NASTY_SESS = 'ops | staging';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let page;
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

const el = (tag) => (fn, arg) => page.evaluate(([t, f, a]) => {
  const node = document.querySelector(t);
  return eval(f)(node, node.shadowRoot, a);
}, [tag, fn.toString(), arg]);

const sidebar = el('webtmux-sidebar');
const toolbar = el('webtmux-toolbar');
const expose = el('webtmux-expose');
const mgr = (fn, arg) => page.evaluate(([f, a]) => eval(f)(window.splitManager, a), [fn.toString(), arg]);

// tmux runs in THIS container on the harness's private socket, so the driver can
// build the fixture and read back what the server actually did.
const tmux = (...args) => execFileSync('tmux', ['-u', '-S', SOCK, ...args], { encoding: 'utf8' });
const sessions = () => tmux('list-sessions', '-F', '#{session_name}').trim().split('\n');

async function main() {
  // ---- fixture -------------------------------------------------------------
  // Renamed rather than created, so the window keeps a real running program (the
  // build loop) and therefore a real pane row to parse.
  tmux('rename-window', '-t', '=dev:2', '--', NASTY_WIN);
  tmux('set-option', '-t', '=dev:2', '-w', '@wt_working', '1');
  tmux('rename-session', '-t', '=scratch', '--', NASTY_SESS);
  // The pair a prefix match would confuse: killing "proj" must not touch "proj-2".
  tmux('new-session', '-d', '-s', 'proj');
  tmux('new-session', '-d', '-s', 'proj-2');

  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    httpCredentials: { username: 'wt', password: 'wt' },
  });
  page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await sleep(5000);

  // ---- 1. the per-session window list --------------------------------------
  // The old format was "#{window_id},#{window_name},…" split on every ',', so this
  // window arrived as name "a", index " b | c", active "2" — the sidebar then
  // highlighted the wrong row and lit the wrong dot.
  const win = await mgr((m, want) => {
    const l = m.focusedUnit?.layout;
    return (l?.windows || []).find((w) => w.name === want) || null;
  }, NASTY_WIN);
  check('the window list carries the name whole, with its index/active/status intact',
    !!win && win.index === 2 && win.working === '1',
    win ? `${win.id} idx=${win.index} working=${JSON.stringify(win.working)}` : 'not found');

  // ---- 2. panes ------------------------------------------------------------
  // pane_title takes the last slot now; geometry must survive whatever is in it.
  const panes = win ? await mgr((m, want) => {
    const w = (m.focusedUnit?.layout?.windows || []).find((x) => x.name === want);
    return (w?.panes || []).map((p) => ({ id: p.id, w: p.width, h: p.height, cmd: p.command }));
  }, NASTY_WIN) : [];
  check('its panes parse with real geometry',
    panes.length > 0 && panes.every((p) => /^%/.test(p.id) && p.w > 0 && p.h > 0),
    JSON.stringify(panes));

  // ---- 3. the server-wide directory ----------------------------------------
  // Rows carry #{session_id} now, so BOTH names on the line can hold a '|'.
  const ref = await mgr((m, want) => {
    const l = m.focusedUnit?.layout;
    return (l?.allWindows || []).find((w) => w.name === want[0] && w.session === 'dev') || null;
  }, [NASTY_WIN]);
  check('the server-wide window directory names the window and its session',
    !!ref && ref.working === '1', ref ? JSON.stringify(ref) : 'not found');

  const nastyPlacements = await mgr((m, want) => {
    const l = m.focusedUnit?.layout;
    return (l?.allWindows || []).filter((w) => w.session === want).map((w) => w.name);
  }, NASTY_SESS);
  check('and a session whose own name holds the separator is still a navigable home',
    nastyPlacements.length > 0, JSON.stringify(nastyPlacements));

  // ---- 4. the session list + emptiness -------------------------------------
  const sess = await mgr((m, want) => {
    const l = m.focusedUnit?.layout;
    return (l?.sessions || []).find((s) => s.name === want) || null;
  }, NASTY_SESS);
  check('the sidebar session list holds it under its full name',
    !!sess, sess ? JSON.stringify(sess) : 'not found');
  // sessionEmptiness used to key on the truncated name ("ops"), so this session
  // looked like a DIFFERENT, always-empty one — which is the state that skips the
  // kill confirmation. It has a running pane, so it must read non-empty.
  check('and its emptiness is computed against the same name (kill-confirm safety)',
    !!sess && sess.empty === false, sess ? `empty=${sess.empty}` : '');

  // ---- 5. the pane's own identity ------------------------------------------
  // display-message is a target-PANE command: with a bare `=name` tmux expands the
  // whole format to "" and exits 0, so this is the check that would catch it.
  await mgr((m, want) => m.focusedUnit?.switchSession(want), NASTY_SESS);
  await sleep(2500);
  const ident = await mgr((m) => {
    const l = m.focusedUnit?.layout;
    return { id: l?.sessionId, name: l?.sessionName, base: l?.sessionBase };
  });
  check('after switching, the pane reports its own session id and full name',
    /^\$/.test(ident.id || '') && ident.base === NASTY_SESS, JSON.stringify(ident));

  await mgr((m) => m.focusedUnit?.switchSession('dev'));
  await sleep(2500);

  // ---- 6. the sidebar row: label, stoplight, navigation ---------------------
  await page.keyboard.press('Control+Alt+w');
  await sleep(1200);
  const rowInfo = await sidebar((n, rr, want) => {
    const label = (x) => x.textContent.replace(/\u00d7/g, '').trim();
    const tabs = [...rr.querySelectorAll('.window-tab')];
    const t = tabs.find((x) => label(x).includes(want));
    return {
      all: tabs.map(label),
      row: t ? { text: label(t), win: t.dataset.win, dot: t.previousElementSibling?.className || '' } : null,
    };
  }, NASTY_WIN);
  const row = rowInfo.row;
  check('the sidebar row shows the whole name', !!row,
    row ? JSON.stringify(row.text) : `rows: ${JSON.stringify(rowInfo.all)}`);
  check('with the green stoplight its @wt_working asks for',
    !!row && /\bon\b/.test(row.dot), row ? row.dot : '');

  await sidebar((n, rr, want) => {
    const label = (x) => x.textContent.replace(/\u00d7/g, '').trim();
    [...rr.querySelectorAll('.window-tab')].find((x) => label(x).includes(want))?.click();
  }, NASTY_WIN);
  await sleep(2000);
  const active = await mgr((m) => m.focusedUnit?.layout?.activeWindowId);
  check('clicking it selects that exact window', !!row && active === row.win,
    `active=${active} want=${row && row.win}`);
  const tmuxActive = tmux('display-message', '-p', '-t', '=dev:', '#{window_name}').trim();
  check('and tmux agrees the pane is on it', tmuxActive === NASTY_WIN, tmuxActive);
  await page.keyboard.press('Escape');
  await sleep(600);

  // ---- 7. the recents strip ------------------------------------------------
  // The strip's DATA must carry the whole name. Its visible LABEL does not, and
  // that is correct: the recentTrimName pref (on by default) drops everything
  // before the first space, so "ssh web-01" reads as "web-01" — and this
  // window as "b | c". Asserting the label would be asserting that pref, not the
  // parse, so both are checked for what they are.
  const strip = await toolbar((n, rr) => ({
    names: (n.recent || []).map((w) => w.name),
    labels: [...rr.querySelectorAll('.rtab')].map((t) => t.textContent.trim()),
  }));
  check('the visited window reaches the recents strip with its name intact',
    strip.names.includes(NASTY_WIN), JSON.stringify(strip.names));
  check('and the strip renders it (trimmed by the recentTrimName pref, as designed)',
    strip.labels.some((t) => t.includes('b | c')), JSON.stringify(strip.labels));

  // ---- 8. Exposé -----------------------------------------------------------
  // This is capture.go's EnumerateWindows, the listing where the session name sat
  // in field 1 of 7: a '|' there shifted the index, the PANE ID and the dimensions,
  // so the tile lost its screen as well as its label.
  await page.keyboard.press('Control+Alt+e');
  await sleep(3500);
  const tiles = await expose((n, rr) => [...rr.querySelectorAll('.tile')].map((t) => t.textContent.trim()));
  check('Exposé tiles the window under its own name',
    tiles.some((t) => t.includes(NASTY_WIN)), `${tiles.length} tiles`);
  const placements = await expose((n, rr, want) => n.cache.all().filter((c) => c.sessionName === want).length, NASTY_SESS);
  check('and knows the separator-named session as a placement home', placements > 0,
    `${placements} placements in ${NASTY_SESS}`);
  await page.keyboard.press('Escape');
  await sleep(800);

  // ---- 9. rename-session over the new NUL payload --------------------------
  // Both halves are user-typed session names with spaces in them — the exact shape
  // the old first-space split mangled.
  const renamed = NASTY_SESS + ' two';
  await mgr((m, args) => m.focusedUnit?.renameSession(args[0], args[1]), [NASTY_SESS, renamed]);
  await sleep(2000);
  check('renaming a session end to end keeps both spaced names whole',
    sessions().includes(renamed) && !sessions().includes(NASTY_SESS), JSON.stringify(sessions()));

  // ---- 10. exact targeting, live ------------------------------------------
  // `kill-session -t proj` resolves by PREFIX and takes proj-2 with it when proj
  // is gone; with `-t =proj` it is the one session or nothing.
  await mgr((m) => m.focusedUnit?.killSession('proj'));
  await sleep(2000);
  const after = sessions();
  check('killing "proj" leaves "proj-2" alone',
    !after.includes('proj') && after.includes('proj-2'), JSON.stringify(after));

  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('FAILED:');
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? ' — ' + f.detail : ''}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
