// Verification driver for the link menu — the dropdown hung off the toolbar
// spinner — and the first tmux setting living in it: whether tmux draws its own
// status line.
//
// What this checks, on the real UI against a real tmux server:
//   1. attaching HIDES tmux's status line, and the terminal gets that row back
//      (asked of tmux itself, not of the UI's opinion of tmux)
//   2. the spinner opens a menu instead of only reporting through a tooltip
//   3. the menu's connection row agrees with the spinner's own state
//   4. the settings row is drawn from what tmux ACTUALLY reports — unticked, and
//      saying the bar was hidden by webtmux rather than merely "hidden"
//   5. clicking it turns the status line back on in tmux, ticks the row, and
//      records the choice so the next attach leaves it alone
//   6. clicking it again hides it, and the RESTORED value is the one that was
//      saved rather than a guess
//
// Run exactly like run.sh does, with DRIVER=verify-link-menu.js.
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const fs = require('fs');

const OUT = '/src/screenshots/verify';
const URL = 'http://localhost:8090/';
const SOCK = '/tmp/wt.sock';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let page;
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

// Ask tmux directly. The whole point of this feature is a tmux option, and the UI
// asserting about its own state would prove only that it is self-consistent.
function tmuxOpt(name) {
  try {
    return execFileSync('tmux', ['-S', SOCK, 'show-options', '-g', '-q', '-v', name],
      { encoding: 'utf8' }).trim();
  } catch (e) {
    return `<error: ${e.message}>`;
  }
}

const toolbar = (fn, arg) => page.evaluate(([f, a]) => {
  const el = document.querySelector('webtmux-toolbar');
  return eval(f)(el, el.shadowRoot, a);
}, [fn.toString(), arg]);

// Everything the menu is currently saying, in one read.
const menuState = () => toolbar((el, rr) => {
  const menu = rr.querySelector('.link-menu');
  const row = menu && menu.querySelector('.mitem');
  const stat = menu && menu.querySelector('.mstat');
  return {
    open: !!menu,
    spinOpenClass: rr.querySelector('.spin').className.includes('open'),
    statKind: stat ? stat.className.replace('mstat', '').trim() : null,
    statHead: stat ? stat.querySelector('b').textContent.trim() : null,
    ticked: row ? row.querySelector('.mark').textContent.trim() === '✓' : null,
    pressed: row ? row.getAttribute('aria-pressed') : null,
    hint: row ? row.querySelector('.mhint').textContent.trim() : null,
    disabled: row ? row.hasAttribute('disabled') : null,
    settings: el.tmuxSettings,
  };
});

// Crop the menu itself rather than a fixed rectangle: a clip that is a guess
// silently truncates the row it was taken to show.
async function shotMenu(name) {
  const box = await page.evaluate(() => {
    const r = document.querySelector('webtmux-toolbar').shadowRoot
      .querySelector('.link-menu').getBoundingClientRect();
    return { x: Math.round(r.x) - 4, y: Math.round(r.y) - 4,
      width: Math.round(r.width) + 8, height: Math.round(r.height) + 8 };
  });
  await page.screenshot({ path: `${OUT}/link-menu-${name}.png`, clip: box });
}

const clickSpin = () => page.evaluate(() =>
  document.querySelector('webtmux-toolbar').shadowRoot.querySelector('.spin').click());
const clickRow = () => page.evaluate(() =>
  document.querySelector('webtmux-toolbar').shadowRoot
    .querySelector('.link-menu .mitem').click());

// How tall tmux's window is. This is the change a person actually sees, and it has
// to be asked of tmux: xterm's own row count is set by the browser viewport and
// does not move — the status line takes its row out of the tmux WINDOW inside that
// same terminal, which is why an xterm.rows assertion here passed identically in
// both states and proved nothing.
function winHeight() {
  try {
    return Number(execFileSync('tmux',
      ['-S', SOCK, 'display-message', '-p', '-t', 'dev', '#{window_height}'],
      { encoding: 'utf8' }).trim());
  } catch (e) {
    return -1;
  }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1400, height: 850 },
    httpCredentials: { username: 'wt', password: 'wt' },
  });
  page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.log('  [console]', m.text()); });
  await page.goto(URL);
  await page.waitForSelector('webtmux-toolbar');
  await sleep(3500);

  // 1. The default, asked of tmux.
  const statusAfterAttach = tmuxOpt('status');
  check('attaching hides tmux\'s status line', statusAfterAttach === 'off',
    `tmux says status=${statusAfterAttach}`);
  check('and remembers what it hid, so it can be put back',
    tmuxOpt('@wt_status_saved') === 'on', `saved=${tmuxOpt('@wt_status_saved')}`);
  check('without recording it as the user\'s choice',
    tmuxOpt('@wt_status_show') === '', `chosen=${tmuxOpt('@wt_status_show')}`);
  const rowsHidden = winHeight();

  // 2/3/4. The menu.
  await clickSpin();
  await sleep(900);
  const open = await menuState();
  check('the spinner opens a menu', open.open === true, JSON.stringify(open).slice(0, 160));
  check('and marks itself open', open.spinOpenClass === true);
  check('the connection row agrees with the spinner', open.statKind === 'live'
    && /Connected to tmux/.test(open.statHead || ''), `${open.statKind} / ${open.statHead}`);
  check('the settings row is drawn from tmux, not from a default',
    open.settings && open.settings.on === false && open.settings.status === 'off'
      && open.settings.chosen === false, JSON.stringify(open.settings));
  check('so the checkbox is unticked', open.ticked === false && open.pressed === 'false');
  check('and it says WHO hid it, not merely that it is hidden',
    /Hidden by webtmux/.test(open.hint || ''), (open.hint || '').slice(0, 90));
  await shotMenu('hidden');

  // 5. Turn it on.
  await clickRow();
  await sleep(1500);
  const on = await menuState();
  check('clicking it turns tmux\'s status line back on', tmuxOpt('status') === 'on',
    `tmux says status=${tmuxOpt('status')}`);
  check('and the row ticks from what tmux reported', on.ticked === true
    && on.pressed === 'true' && on.settings && on.settings.on === true,
    JSON.stringify(on.settings));
  check('and the choice is recorded, so the next attach leaves it alone',
    tmuxOpt('@wt_status_show') === '1', `chosen=${tmuxOpt('@wt_status_show')}`);
  const rowsShown = winHeight();
  check('and tmux takes the row back from the window', rowsShown === rowsHidden - 1,
    `window was ${rowsHidden} rows with the bar hidden, ${rowsShown} with it shown`);
  await shotMenu('shown');

  // 6. And off again, through the same control.
  await clickRow();
  await sleep(1500);
  const off = await menuState();
  check('clicking again hides it', tmuxOpt('status') === 'off' && off.ticked === false,
    `tmux=${tmuxOpt('status')} ticked=${off.ticked}`);
  check('and the saved value is still the one to restore',
    tmuxOpt('@wt_status_saved') === 'on', `saved=${tmuxOpt('@wt_status_saved')}`);
  check('the row now speaks as a decision, not a default',
    !/Hidden by webtmux/.test(off.hint || ''), (off.hint || '').slice(0, 90));

  // The backdrop closes it, like every other menu on this bar.
  await page.evaluate(() => document.querySelector('webtmux-toolbar').shadowRoot
    .querySelector('.label-backdrop').click());
  await sleep(400);
  check('the backdrop closes the menu', (await menuState()).open === false);

  await browser.close();
  const bad = results.filter((r) => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} passed`);
  process.exit(bad.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
