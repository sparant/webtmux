// Verification driver for the background green — @wt_working 3.
//
// The node tests (test/stoplight.test.mjs, test/work-alerts.test.mjs) pin the pure
// meaning: which class, which label, which filter, and which transitions raise a
// flash. They cannot see the half that decides whether the state is any use — that
// the value survives the trip from a real tmux server through the layout push to a
// dot that is drawn GREEN and drawn DIFFERENTLY from a live turn. A fourth value the
// server silently dropped, or a class with no CSS rule behind it, would pass every
// unit test and paint an unfilled dot on a busy window.
//
// So this drives the real thing:
//
//   1. `tmux set -w @wt_working 3` reaches the toolbar as the 'bg' dot, and the dot
//      is actually rendered green-and-hollow — read out of getComputedStyle, not out
//      of the class name that was supposed to produce it.
//   2. It reads green at a glance: the same hue as a working window, so a wall of
//      windows still answers "does this one need me" without decoding anything.
//   3. An agent ending its turn on background work (1 -> 3) raises NO attention
//      flash, and the flash still fires when it drops out to red.
//   4. Exposé's new "Background" button selects exactly those windows, and "Working"
//      does not quietly include them.
//   5. A screenshot of the strip, because "is it distinguishable at 8px" is not a
//      question an assertion can answer.
//
// Run exactly like run.sh does, with DRIVER=verify-stoplight-bg.js.
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const fs = require('fs');

const URL = 'http://localhost:8090/';
const SOCK = '/tmp/wt.sock';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let page;
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

// Driver stills go where every other driver's do — /screenshots/verify is gitignored,
// so a verification run never leaves anything to commit.
const OUT = '/src/screenshots/verify';

const el = (tag) => (fn, arg) => page.evaluate(([t, f, a]) => {
  const node = document.querySelector(t);
  return eval(f)(node, node.shadowRoot, a);
}, [tag, fn.toString(), arg]);

const toolbar = el('webtmux-toolbar');
const expose = el('webtmux-expose');

const tmux = (...args) => execFileSync('tmux', ['-S', SOCK, ...args], { encoding: 'utf8' });
const setWork = (win, val) => tmux('set-option', '-t', win, '-w', '@wt_working', val);

// One layout poll is 500ms; two of them is comfortably past a status change.
const settle = () => sleep(1500);

// Every recents tab, with the dot's class and the colours the browser actually
// resolved for it. Reading computed style is the point: a class nobody wrote a rule
// for is exactly the failure a class-name assertion cannot see.
const strip = () => toolbar((n, rr) => [...rr.querySelectorAll('.rtab')].map((t) => {
  const d = t.querySelector('.work');
  const cs = d ? getComputedStyle(d) : null;
  return {
    name: t.textContent.trim(),
    cls: d ? [...d.classList].filter((c) => c !== 'work').join(' ') : null,
    active: !!t.querySelector('.tab.active'),
    fill: cs ? cs.backgroundColor : null,
    border: cs ? cs.borderTopColor : null,
    width: cs ? cs.borderTopWidth : null,
    label: d ? d.getAttribute('aria-label') : null,
    // The flash modifier lands on the tab BUTTON, not on the .rtab wrapper that
    // carries the dot — one tab, two elements.
    flashing: [...(t.querySelector('.tab')?.classList || [])].some((c) => c.startsWith('wt-alert')),
  };
}));

const tabFor = async (name) => (await strip()).find((t) => t.name.includes(name));

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

  // Visit a few windows so they own tabs in the strip — the surface the dot has to
  // reach. (The sidebar walk is how every other driver here earns its tabs.)
  for (const w of ['build', 'server', 'tests', 'logs']) {
    await page.evaluate((name) => window.splitManager.focusedUnit.selectWindowByName?.(name), w);
    await sleep(250);
  }
  const named = await toolbar((n, rr) => [...rr.querySelectorAll('.rtab')].length);
  if (named < 2) {
    // selectWindowByName is a convenience that may not exist; fall back to the
    // sidebar walk, which every build has.
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('Control+Alt+w'); await sleep(400);
      await page.keyboard.press('ArrowDown'); await sleep(400);
      await page.keyboard.press('Enter'); await sleep(500);
    }
  }
  await settle();

  // ---- 1. the value survives the round trip ---------------------------------
  // All four on windows that earned a tab above — a window with no tab has no dot to
  // read, which would look exactly like a value the server dropped.
  setWork('dev:build', '1');
  setWork('dev:server', '3');
  setWork('dev:tests', '0');
  setWork('dev:editor', '2');
  await settle();

  const bg = await tabFor('server');
  const on = await tabFor('build');
  const off = await tabFor('tests');
  const wait = await tabFor('editor');

  check('a window reporting 3 reaches the strip as its own dot',
    !!bg && bg.cls === 'bg', JSON.stringify(bg));
  check('and it is not the unfilled "not reporting" dot',
    !!bg && bg.cls !== '' && bg.label && !/Not reporting/.test(bg.label), bg?.label);
  check('the other three states are unchanged',
    on?.cls === 'on' && off?.cls === 'off' && wait?.cls === 'wait',
    `${on?.cls} / ${off?.cls} / ${wait?.cls}`);

  // ---- 2. it reads green, and it reads differently --------------------------
  check('the ring is the SAME green as a working window',
    !!bg && !!on && bg.border === on.border, `${bg?.border} vs ${on?.border}`);
  check('but hollow, where a working window is filled',
    !!bg && /rgba\(0, 0, 0, 0\)|transparent/.test(bg.fill) && bg.fill !== on.fill,
    `bg fill=${bg?.fill}, on fill=${on?.fill}`);
  check('and the ring is thick enough to see at 8px',
    parseFloat(bg?.width || '0') >= 2, `border-width=${bg?.width}`);
  check('the hover label says both halves: background, and still takes input',
    /background/i.test(bg?.label || '') && /input/i.test(bg?.label || ''), bg?.label);

  // The one question no assertion answers: at 8px, in a row of them, can you tell the
  // ring from the disc? Look at the file, don't take the PASS above for it.
  fs.mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: `${OUT}/stoplight-bg-strip.png`, clip: { x: 0, y: 0, width: 1600, height: 40 } });

  // ---- 3. going to wait on your own work is not "stopping" ------------------
  // The flash is cleared by having the window ON SCREEN, so all of this has to run on
  // a window the focused region is not showing — otherwise "no flash" would hold for
  // a reason that has nothing to do with the rule under test.
  const tabs = await strip();
  const spare = ['tests', 'server', 'build'].find((n) => {
    const t = tabs.find((x) => x.name.includes(n));
    return t && !t.active;
  });
  const W = `dev:${spare}`;
  check('setup: found an off-screen tab to watch', !!spare, `using ${W}`);

  // CONTROL first: the flash whose ABSENCE is asserted below has to be observable
  // here at all. Without this, a driver that could never see a flash would report the
  // new rule working perfectly.
  setWork(W, '1'); await settle();
  setWork(W, '0'); await settle();
  const control = await tabFor(spare);
  check('control: 1 -> 0 flashes, so this driver can see a flash',
    control && control.flashing, `flashing=${control?.flashing}`);

  // The exact sequence an agent produces: green while the turn runs, then 3 when it
  // ends with a build still going. Flashing here would fire on every agent turn.
  setWork(W, '1'); await settle();        // back to busy — clears the control's flash
  setWork(W, '3'); await settle();
  const parked = await tabFor(spare);
  check('1 -> 3 raises no attention flash', parked && parked.cls === 'bg' && !parked.flashing,
    `cls=${parked?.cls} flashing=${parked?.flashing}`);

  // ...and the flash still fires when it really does run out of work, even though it
  // was never plain green in between.
  setWork(W, '0'); await settle();
  const dropped = await tabFor(spare);
  check('3 -> 0 still flashes (the background work finished and it is now idle)',
    dropped && dropped.cls === 'off' && dropped.flashing,
    `cls=${dropped?.cls} flashing=${dropped?.flashing}`);

  // ---- 4. Exposé tells the two greens apart ---------------------------------
  setWork('dev:build', '1');
  setWork('dev:server', '3');
  setWork('dev:tests', '0');
  await settle();

  await page.keyboard.press('Control+Alt+f');
  await sleep(2500);
  const pick = async (want) => {
    await expose((n, rr, w) => {
      const b = [...rr.querySelectorAll('.sort .seg button')]
        .find((x) => x.textContent.trim().toLowerCase() === w);
      if (b) b.click();
    }, want);
    await sleep(900);
    return expose((n, rr) => ({ tiles: rr.querySelectorAll('.tile').length, filter: n._statusFilter }));
  };

  const buttons = await expose((n, rr) =>
    [...rr.querySelectorAll('.sort .seg button')].map((b) => b.textContent.trim()));
  check('Exposé offers Background as its own view', buttons.includes('Background'), buttons.join(' | '));

  const back = await pick('background');
  check('"Background" shows exactly the window waiting on its own work',
    back.filter === 'background' && back.tiles === 1, `${back.tiles} tiles`);
  const working = await pick('working');
  check('"Working" does NOT quietly include it', working.tiles === 1, `${working.tiles} tiles`);
  const idle = await pick('idle');
  check('"Idle" is still only the window that ran out of work', idle.tiles === 1, `${idle.tiles} tiles`);

  await pick('all');
  await page.keyboard.press('Escape');
  await sleep(400);

  await browser.close();
  const bad = results.filter((r) => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} passed`);
  process.exit(bad.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
