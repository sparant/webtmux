// Verification driver for "hovering a Preview/PiP tile's label shows the window's
// full name" — the fix for the gap where a tile's .plabel .name ellipsis-clips a
// long window name with no way to read the rest, unlike the recents strip (whose
// tabs answer the same question via the shared Tip — see toolbar.js's _tabTip).
//
// Run exactly like run.sh does, with DRIVER=verify-pip-tile-tip.js.
const { chromium } = require('playwright');
const { execSync } = require('child_process');

const URL = 'http://localhost:8090/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LONG_NAME = 'a-deliberately-long-tmux-window-name-meant-to-overflow-the-preview-tiles-label-strip';

let page;
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

const mgr = (fn, arg) => page.evaluate(([f, a]) => eval(f)(window.splitManager, a), [fn.toString(), arg]);
const pip = (fn, arg) => page.evaluate(([f, a]) => {
  const el = document.querySelector('webtmux-pip');
  return eval(f)(el, el.shadowRoot, a);
}, [fn.toString(), arg]);

async function main() {
  // Rename the window the harness leaves focused (dev:editor — see boot-tmux.sh's
  // final `select-window`) to something long enough to clip in a tile's narrow
  // label strip, before anything captures it.
  execSync(`tmux -S /tmp/wt.sock rename-window -t dev:editor "${LONG_NAME}"`);

  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    httpCredentials: { username: 'wt', password: 'wt' },
  });
  page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await sleep(4000);

  // Start from an empty preview set — it rides the shared @wt_state blob, so a
  // previous run's windows would otherwise still be sitting in it.
  await mgr((m) => { for (const id of [...m.pip.windowIds()]) m.pip.removeWindow(id); });
  await sleep(500);

  const target = await mgr((m) => {
    const unit = m.focusedUnit;
    const id = unit?.layout?.activeWindowId;
    if (!id) return null;
    const session = m.logicalSession ? m.logicalSession(unit) : '';
    m.pip.addWindow(id, { session });
    return { id, session };
  });
  check('setup: a window was added to the preview', !!target?.id, JSON.stringify(target));
  await sleep(2500);   // let a real capture land and _paint refresh win.label/session

  const state = await pip((el) => {
    const win = el._wins[0];
    const tile = el.shadowRoot.querySelector('.ptile');
    const name = tile?.querySelector('.plabel .name');
    return {
      mode: el.mode,
      label: win?.label,
      session: win?.session,
      nameText: name?.textContent,
      clipped: name ? name.scrollWidth > name.clientWidth : null,
    };
  });
  check('the tile picked up the renamed window\'s full name', (state.label || '').includes(LONG_NAME), JSON.stringify(state));
  check('…and the label strip is actually clipping it (scrollWidth > clientWidth)', state.clipped === true, JSON.stringify(state));

  // ---- hovering the label shows the shared Tip with the full name -------------
  await pip((el) => {
    const label = el.shadowRoot.querySelector('.ptile .plabel');
    label.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, composed: true }));
  });
  await sleep(900);   // > TIP_DELAY (600ms)
  const tipOnLabel = await pip((el) => {
    const tip = el.shadowRoot.querySelector('.wt-tip');
    return { shown: tip?.classList.contains('show'), text: tip?.textContent };
  });
  const expected = state.session ? `${state.session} — window ${state.label}` : `window ${state.label}`;
  check('hovering the tile\'s label opens the shared hint', tipOnLabel.shown === true, JSON.stringify(tipOnLabel));
  check('…with the full "session — window N: name" text', tipOnLabel.text === expected,
    `got ${JSON.stringify(tipOnLabel.text)}, expected ${JSON.stringify(expected)}`);

  // hover-preview still engages on the tile the whole time — the tooltip is an
  // addition, not a replacement of "hovering a preview shows it live".
  const hoverState = await mgr((m) => ({ windowId: m.hover?.windowId }));
  check('the live full-size preview (hover-preview) still engaged', hoverState.windowId === target.id, JSON.stringify(hoverState));

  // ---- leaving the label hides it again ----------------------------------------
  await pip((el) => {
    const label = el.shadowRoot.querySelector('.ptile .plabel');
    label.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true, composed: true }));
  });
  await sleep(200);
  const afterLeave = await pip((el) => el.shadowRoot.querySelector('.wt-tip')?.classList.contains('show'));
  check('leaving the label closes the hint', afterLeave === false, `show=${afterLeave}`);

  // ---- hovering the SCREEN (frame), not the label, does not open it -----------
  // Scoped deliberately to the label so it doesn't fight the frame's own native
  // title (click hint + stoplight key) while you're looking at the live screen.
  await pip((el) => {
    const frame = el.shadowRoot.querySelector('.ptile .pframe');
    frame.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, composed: true }));
  });
  await sleep(900);
  const tipOnFrame = await pip((el) => el.shadowRoot.querySelector('.wt-tip')?.classList.contains('show'));
  const frameTitle = await pip((el) => el.shadowRoot.querySelector('.ptile .pframe')?.title);
  check('hovering the screen itself does not open the name hint', tipOnFrame === false, `show=${tipOnFrame}`);
  check('…the frame keeps its own native click-hint title', (frameTitle || '').startsWith('Click to switch'), JSON.stringify(frameTitle));

  await browser.close();
  const bad = results.filter((r) => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} passed`);
  process.exit(bad.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
