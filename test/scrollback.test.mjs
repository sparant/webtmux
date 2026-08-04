// The scrollback panel's arithmetic and its wording. Run with:
//
//     node --test test/
//
// Two of these are contracts rather than conveniences:
//
//   • busyCommands/paneIsIdle must agree with pkg/tmux/history.go, because the
//     browser uses them to WRITE the confirmation and the server uses them to
//     REFUSE. A confirmation that names a different set than the server refuses
//     on is worse than no confirmation at all.
//   • windowUsage must not average a split window into one comfortable-looking
//     number. The pane that is about to start dropping lines is the whole reason
//     to look at this panel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HISTORY_MAX, parseLimit, formatLines, formatBytes, windowUsage,
  paneIsIdle, panesToRebuild, busyCommands, resizePlan, actionBanner,
  ACTION_DEFAULT, ACTION_RESIZE, ACTION_CLEAR,
} from '../resources/js/scrollback.js';

const pane = (over = {}) => ({
  paneId: '%0', index: 0, active: false, limit: 2000, size: 0, bytes: 0,
  command: 'bash', ...over,
});

test('a typed limit is read, or refused with a reason you can act on', () => {
  assert.deepEqual(parseLimit('50000'), { ok: true, value: 50000 });
  // People type the number the way they read it.
  assert.deepEqual(parseLimit(' 50,000 '), { ok: true, value: 50000 });
  // Zero is meaningful to tmux: keep no history at all.
  assert.deepEqual(parseLimit('0'), { ok: true, value: 0 });

  assert.equal(parseLimit('').ok, false);
  assert.match(parseLimit('').error, /Enter a number/);
  assert.equal(parseLimit('lots').ok, false);
  assert.match(parseLimit('12.5').error, /whole number/);
  assert.match(parseLimit('-5').error, /whole number/);
  // The ceiling is stated next to the input rather than discovered from the
  // server's rejection after a round trip.
  assert.equal(parseLimit(String(HISTORY_MAX + 1)).ok, false);
  assert.equal(parseLimit(String(HISTORY_MAX)).ok, true);
});

test('usage reports the FULLEST pane, not the average', () => {
  const use = windowUsage([
    pane({ paneId: '%0', limit: 2000, size: 1990, bytes: 100 }),
    pane({ paneId: '%1', limit: 2000, size: 0, bytes: 50 }),
  ]);
  assert.equal(use.panes, 2);
  assert.equal(use.size, 1990);
  assert.equal(use.bytes, 150);
  assert.ok(use.pct > 99, `pct ${use.pct} — averaging would have said ~50%`);
  assert.equal(use.full, true);
  assert.equal(use.mixed, false);
});

test('a window whose panes have different capacities says so, and leads with the smallest', () => {
  const use = windowUsage([
    pane({ paneId: '%0', limit: 50000, size: 10 }),
    pane({ paneId: '%1', limit: 2000, size: 10 }),
  ]);
  assert.equal(use.mixed, true);
  assert.equal(use.limit, 2000, 'the smallest pane is the one that runs out first');
});

test('an empty window reports nothing rather than dividing by zero', () => {
  const use = windowUsage([]);
  assert.equal(use.pct, 0);
  assert.equal(use.full, false);
  // A pane with a limit of 0 keeps no history; it is not "full", it is disabled.
  assert.equal(windowUsage([pane({ limit: 0, size: 0 })]).pct, 0);
});

test('only shells count as idle', () => {
  for (const cmd of ['bash', 'zsh', '-bash', 'fish', ' sh ']) {
    assert.equal(paneIsIdle(cmd), true, cmd);
  }
  for (const cmd of ['vim', 'claude', 'ssh', 'go', 'less', '', null]) {
    assert.equal(paneIsIdle(cmd), false, String(cmd));
  }
});

test('panes already at the requested size are neither rebuilt nor warned about', () => {
  const panes = [
    pane({ paneId: '%0', limit: 50000, command: 'vim' }),
    pane({ paneId: '%1', limit: 2000, command: 'claude' }),
    pane({ paneId: '%2', limit: 2000, command: 'bash' }),
  ];
  assert.deepEqual(panesToRebuild(panes, 50000).map((p) => p.paneId), ['%1', '%2']);
  // %0 runs vim but is already the right size, so nothing happens to it — naming
  // it in the warning would ask the user to accept a cost they are not paying.
  assert.deepEqual(busyCommands(panes, 50000), ['claude']);
});

test('the resize plan states both irreversible costs, and names what dies', () => {
  const plan = resizePlan([
    pane({ paneId: '%0', command: 'bash' }),
    pane({ paneId: '%1', command: 'claude' }),
  ], 50000);
  assert.equal(plan.needsConfirm, true);
  assert.match(plan.text, /2 panes/);
  assert.match(plan.text, /50,000/);
  assert.match(plan.text, /claude/);
  assert.match(plan.text, /scrollback is lost/);
});

test('an all-shell window still confirms — the scrollback goes either way', () => {
  const plan = resizePlan([pane({ command: 'bash' })], 50000);
  assert.equal(plan.needsConfirm, true);
  assert.equal(plan.busy, undefined);
  assert.match(plan.text, /1 pane\b/);
  assert.match(plan.text, /scrollback is lost/);
});

test('resizing to the size it already is asks for nothing', () => {
  const plan = resizePlan([pane({ limit: 2000 }), pane({ limit: 2000 })], 2000);
  assert.equal(plan.none, true);
  assert.equal(plan.needsConfirm, false);
  assert.match(plan.text, /already/);
});

test('the default banner says what it did NOT do', () => {
  // The whole misunderstanding this panel exists to end: raising the limit does
  // nothing to the window you are looking at.
  const b = actionBanner({ action: ACTION_DEFAULT, ok: true, default: 50000 });
  assert.equal(b.state, 'ok');
  assert.match(b.text, /50,000/);
  assert.match(b.text, /already exist keep their current size/);
});

test('the resize banner is a receipt: how many, and what it cost', () => {
  const b = actionBanner({
    action: ACTION_RESIZE, ok: true,
    panes: [{ limit: 50000 }],
    resize: { rebuilt: 2, skipped: 1, restarted: ['claude'], layoutRestored: true },
  });
  assert.match(b.text, /Rebuilt 2 panes at 50,000 lines/);
  assert.match(b.text, /1 already the right size/);
  assert.match(b.text, /restarted claude/);
});

test('a rebuild that could not put the geometry back says so', () => {
  const b = actionBanner({
    action: ACTION_RESIZE, ok: true,
    panes: [{ limit: 50000 }],
    resize: { rebuilt: 2, skipped: 0, restarted: [], layoutRestored: false },
  });
  assert.match(b.text, /pane sizes could not be restored/);
});

test('an error is shown as the server worded it', () => {
  const b = actionBanner({ action: ACTION_RESIZE, error: 'would kill vim' });
  assert.equal(b.state, 'err');
  assert.equal(b.text, 'would kill vim');
  assert.equal(actionBanner(null).state, 'err');
  assert.equal(actionBanner({ action: ACTION_CLEAR, ok: true }).state, 'ok');
});

test('numbers are formatted the way the panel reads them', () => {
  assert.equal(formatLines(50000), '50,000');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
});
