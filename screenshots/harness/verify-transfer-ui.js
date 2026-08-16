// Drives the ⤓ dropdown's two file-transfer sections in a real browser.
//
// The Go tests prove the routes and test/verify-transfer.sh proves them against a
// booted server, but neither touches the part most likely to be quietly broken:
// the lit template. A template that throws renders NOTHING and takes the rest of
// the dropdown with it, and a syntax check cannot see that — the file parses
// fine, it just fails at render time.
//
// So this asks the questions only a browser can answer:
//   1. do the sections appear at all, with both machines named in each heading?
//   2. does a download actually reach the browser as a file?
//   3. does an upload actually put a file on the far machine?
//   4. does a refusal land in the dropdown rather than navigating away?
//
// Run via screenshots/harness/run.sh with DRIVER=verify-transfer-ui.js.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const URL = 'http://localhost:8090/';
const FAR = '/tmp/far';
const DOWNLOADS = '/tmp/downloads';

let pass = 0; let fail = 0;
const ok = (m) => { console.log(`  PASS  ${m}`); pass++; };
const bad = (m, d) => { console.log(`  FAIL  ${m}`); if (d) console.log(`        ${d}`); fail++; };
const check = (m, cond, d) => (cond ? ok(m) : bad(m, d));

// Everything lives in the toolbar's shadow root; these helpers keep the driver
// readable rather than a wall of evaluate() strings.
const inToolbar = (page, fn, arg) => page.evaluate(({ src, a }) => {
  const tb = document.querySelector('webtmux-toolbar');
  // eslint-disable-next-line no-new-func
  return new Function('root', 'arg', src)(tb.shadowRoot, a);
}, { src: fn, a: arg });

(async () => {
  fs.mkdirSync(DOWNLOADS, { recursive: true });
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({
    httpCredentials: { username: 'wt', password: 'wt' },
    acceptDownloads: true,
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('webtmux-toolbar', { timeout: 20000 });
  await page.waitForTimeout(2500);

  // ---- 1. the sections render -------------------------------------------------
  await inToolbar(page, `
    const btn = [...root.querySelectorAll('.tbtn')].find(b => b.textContent.trim() === '⤓');
    btn.click(); return true;
  `);
  await page.waitForTimeout(1200);

  const headings = await inToolbar(page, `
    return [...root.querySelectorAll('.xfer-dir')].map(e => e.textContent.trim());
  `);
  check('both transfer sections render', headings.length === 2, JSON.stringify(headings));
  // The one thing this feature can get badly wrong is an upload the user reads as
  // a download, so every heading must name BOTH machines.
  const named = headings.every((h) => h.includes('this browser') && h.includes('the machine tmux runs on'));
  check('each heading names both machines', named, JSON.stringify(headings));
  check('the upload heading reads browser -> tmux',
    /this browser[\s\S]*the machine tmux runs on/.test(headings[0] || ''), headings[0]);
  check('the download heading reads tmux -> browser',
    /the machine tmux runs on[\s\S]*this browser/.test(headings[1] || ''), headings[1]);

  // The save half must still be there — a broken template would take it out too.
  const stillThere = await inToolbar(page, `
    return !!root.querySelector('.save-scope') && !!root.querySelector('.save-item');
  `);
  check('the existing save controls survive', stillThere);

  // The destination box should be prefilled with the directory webtmux can
  // actually reach, so a transfer is one word of typing away.
  const dest = await inToolbar(page, `return root.querySelector('.xfer-dest')?.value || '';`);
  check('the upload destination is prefilled', dest === FAR, `got "${dest}"`);

  // ---- 2. a download reaches the browser --------------------------------------
  await inToolbar(page, `
    const el = root.querySelector('.xfer-src');
    el.value = 'build.log';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return el.value;
  `);
  const dl = page.waitForEvent('download', { timeout: 20000 });
  await inToolbar(page, `
    [...root.querySelectorAll('.save-go')].find(b => b.textContent.trim() === 'Download').click();
    return true;
  `);
  try {
    const d = await dl;
    const to = path.join(DOWNLOADS, d.suggestedFilename());
    await d.saveAs(to);
    const body = fs.readFileSync(to, 'utf8');
    check('a file downloads to the browser', body.includes('the build log'), body.slice(0, 80));
    check('it keeps its name', d.suggestedFilename() === 'build.log', d.suggestedFilename());
  } catch (e) {
    bad('a file downloads to the browser', String(e));
  }

  // A folder is the other half of "individual files and entire folders".
  await inToolbar(page, `
    const el = root.querySelector('.xfer-src');
    el.value = 'project';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  `);
  const dz = page.waitForEvent('download', { timeout: 20000 });
  await inToolbar(page, `
    [...root.querySelectorAll('.save-go')].find(b => b.textContent.trim() === 'Download').click();
    return true;
  `);
  try {
    const d = await dz;
    check('a folder downloads as a .zip', d.suggestedFilename() === 'project.zip', d.suggestedFilename());
  } catch (e) {
    bad('a folder downloads as a .zip', String(e));
  }

  // ---- 3. a refusal stays in the dropdown -------------------------------------
  // The whole reason the download is probed before it is started: an error has to
  // appear beside the path that caused it, not as a navigation to an error page.
  await inToolbar(page, `
    const el = root.querySelector('.xfer-src');
    el.value = '/etc/passwd';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    [...root.querySelectorAll('.save-go')].find(b => b.textContent.trim() === 'Download').click();
    return true;
  `);
  await page.waitForTimeout(1500);
  const refusal = await inToolbar(page, `
    const s = root.querySelector('.save-status');
    return s ? { cls: s.className, text: s.textContent.trim() } : null;
  `);
  check('a refused path reports in the dropdown', !!refusal && /err/.test(refusal.cls || ''),
    JSON.stringify(refusal));
  check('…and the page did not navigate away', page.url().startsWith(URL), page.url());
  check('…and the reason names the limit',
    !!refusal && /outside the folders/.test(refusal.text || ''), refusal && refusal.text);

  // ---- 4. an upload puts a file on the far machine ----------------------------
  const localFile = '/tmp/near-upload.txt';
  fs.writeFileSync(localFile, 'sent from the browser\n');
  await page.setInputFiles('webtmux-toolbar >> .xfer-file >> nth=0', localFile).catch(async () => {
    // setInputFiles cannot pierce a shadow root by CSS in every version; fall
    // back to the element handle, which always can.
    const handle = await page.evaluateHandle(() =>
      document.querySelector('webtmux-toolbar').shadowRoot.querySelectorAll('.xfer-file')[0]);
    await handle.asElement().setInputFiles(localFile);
  });
  await page.waitForTimeout(600);

  const summary = await inToolbar(page, `return root.querySelector('.xfer-sum')?.textContent.trim() || '';`);
  check('the pick is summarised before sending', /near-upload\.txt/.test(summary), summary);

  // Type a destination rather than accepting the prefill, so this covers the
  // control the user actually reaches for when they want a subfolder.
  await inToolbar(page, `
    const el = root.querySelector('.xfer-dest');
    el.value = arg;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return el.value;
  `, path.join(FAR, 'incoming'));
  await inToolbar(page, `
    root.querySelector('.xfer-go').click(); return true;
  `);
  await page.waitForTimeout(2500);
  const upStatus = await inToolbar(page, `
    const s = root.querySelector('.save-status');
    return s ? { cls: s.className, text: s.textContent.trim() } : null;
  `);
  check('the upload reports success', !!upStatus && /\bok\b/.test(upStatus.cls || ''),
    JSON.stringify(upStatus));
  const landed = path.join(FAR, 'incoming', 'near-upload.txt');
  check('the file is on the far machine', fs.existsSync(landed),
    `${landed} missing; banner was ${JSON.stringify(upStatus)}`);
  if (fs.existsSync(landed)) {
    check('…with its contents intact',
      fs.readFileSync(landed, 'utf8').includes('sent from the browser'));
  }

  await page.screenshot({ path: '/src/screenshots/transfer-dropdown.png' });

  check('no uncaught page errors', errors.length === 0, errors.join('\n'));

  console.log('\n======================================');
  console.log(`  ${pass} passed, ${fail} failed`);
  console.log('======================================');
  await browser.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
