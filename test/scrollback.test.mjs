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
  paneIsIdle, paneIsWork, workName, relaunchable,
  panesToRebuild, busyCommands, resizePlan, actionBanner, configFileHint,
  ACTION_DEFAULT, ACTION_PERSIST, ACTION_RESIZE, ACTION_CLEAR,
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

test('a pane launched with a shell command is work, not an idle prompt', () => {
  // `sh -c "deploy.sh"` reports its foreground process as `sh`. Reading that as a
  // prompt would rebuild the pane — killing the script — without asking.
  const script = pane({ command: 'sh', startCommand: 'sh -c "deploy.sh"' });
  const prompt = pane({ command: 'sh' });
  assert.equal(paneIsWork(script), true);
  assert.equal(paneIsWork(prompt), false);
  // …and it is named by what it IS, not by the process that happens to host it.
  assert.equal(workName(script), 'sh -c "deploy.sh"');
  assert.deepEqual(busyCommands([script, prompt], 50000), ['sh -c "deploy.sh"']);
});

test('only panes tmux launched can be started again', () => {
  const panes = [
    pane({ paneId: '%0', command: 'vim' }),                        // typed at a prompt
    pane({ paneId: '%1', command: 'htop', startCommand: 'htop' }),  // tmux launched it
    pane({ paneId: '%2', command: 'bash' }),                        // plain shell
    pane({ paneId: '%3', command: 'htop', startCommand: 'htop', limit: 50000 }), // untouched
  ];
  assert.deepEqual(relaunchable(panes, 50000).map((p) => p.paneId), ['%1']);
});

test('a plan that can start the command again promises it instead of warning', () => {
  const panes = [pane({ command: 'htop', startCommand: 'htop -d 5' })];
  const withRerun = resizePlan(panes, 50000, true);
  assert.match(withRerun.text, /htop -d 5 is started again/);
  assert.match(withRerun.text, /not resumed/, 'a restart is not a rescue, and says so');
  assert.doesNotMatch(withRerun.text, /KILLS/);
  assert.deepEqual(withRerun.relaunchable.map((p) => p.paneId), ['%0']);

  // Untick it and the same pane is back to being a loss.
  const without = resizePlan(panes, 50000, false);
  assert.match(without.text, /KILLS htop -d 5/);
});

test('the resize plan names what dies, and the one way to keep it', () => {
  const plan = resizePlan([
    pane({ paneId: '%0', command: 'bash' }),
    pane({ paneId: '%1', command: 'claude' }),
  ], 50000);
  assert.equal(plan.needsConfirm, true);
  assert.match(plan.text, /2 panes/);
  assert.match(plan.text, /50,000/);
  assert.match(plan.text, /claude/);
  // The scrollback survives a rebuild now, so promising otherwise would be a
  // stale warning that talks people out of a resize they can safely make.
  assert.match(plan.text, /scrollback is carried across/);
  assert.doesNotMatch(plan.text, /scrollback is lost/);
  // reptyr is not automated (see the module comment), but it IS the answer to
  // "can I keep this running", so the confirmation names it rather than leaving
  // the user to conclude there is no way.
  assert.match(plan.text, /reptyr/);
});

test('an all-shell window confirms without the reptyr sentence', () => {
  const plan = resizePlan([pane({ command: 'bash' })], 50000);
  assert.equal(plan.needsConfirm, true);
  assert.equal(plan.busy, undefined);
  assert.match(plan.text, /1 pane\b/);
  assert.match(plan.text, /scrollback is carried across/);
  assert.doesNotMatch(plan.text, /reptyr/, 'nothing is running, so nothing needs rescuing');
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
    resize: {
      rebuilt: 3, skipped: 1, replayed: 3, rerun: ['htop -d 5'],
      restarted: ['claude'], layoutRestored: true,
    },
  });
  assert.match(b.text, /Rebuilt 3 panes at 50,000 lines/);
  assert.match(b.text, /1 already the right size/);
  assert.match(b.text, /scrollback carried across/);
  // The two outcomes are worded apart on purpose: one came back, one did not.
  assert.match(b.text, /started htop -d 5 again/);
  assert.match(b.text, /lost claude/);
});

test('a rebuild that could not carry the scrollback says which panes lost it', () => {
  const none = actionBanner({
    action: ACTION_RESIZE, ok: true, panes: [{ limit: 50000 }],
    resize: { rebuilt: 2, replayed: 0, restarted: [], layoutRestored: true },
  });
  assert.match(none.text, /could not be read, so they start empty/);
  const some = actionBanner({
    action: ACTION_RESIZE, ok: true, panes: [{ limit: 50000 }],
    resize: { rebuilt: 3, replayed: 2, restarted: [], layoutRestored: true },
  });
  assert.match(some.text, /carried across for 2 of them/);
});

test('the persist banner names the file, and both scopes it just changed', () => {
  const b = actionBanner({
    action: ACTION_PERSIST, ok: true, default: 50000, savedTo: '/home/me/.tmux.conf',
  });
  assert.equal(b.state, 'ok');
  assert.match(b.text, /\/home\/me\/\.tmux\.conf/);
  assert.match(b.text, /new tmux servers/);
  assert.match(b.text, /this one already does/);
});

test('the config-file hint says what will be written, or that one will be created', () => {
  assert.equal(configFileHint('/home/me/.tmux.conf'), '/home/me/.tmux.conf');
  // tmux lists them in load order, so the LAST is the user's own.
  assert.equal(configFileHint('/etc/tmux.conf,/home/me/.tmux.conf'), '/home/me/.tmux.conf');
  assert.match(configFileHint(''), /no tmux config yet/);
  assert.match(configFileHint(null), /no tmux config yet/);
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
