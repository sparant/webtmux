// The scrollback buffer as a thing with a SIZE — the arithmetic and the wording
// behind the toolbar's ⛁ dropdown.
//
// tmux gives every pane a fixed-capacity history: `history-limit` lines, decided
// when the pane is created and never afterwards. Three facts follow, and all
// three used to be invisible from the browser:
//
//   1. how many lines this pane can hold,
//   2. how many it is holding (i.e. how close you are to losing the oldest),
//   3. that changing the limit does NOTHING to a pane that already exists.
//
// (3) is the one that costs people output. It is why this module reports the
// PANE's limit and the DEFAULT for new windows as two separate numbers, and why
// the resize control is worded as a rebuild rather than as a setting.
//
// Import-free on purpose, like save-scope.js: the rules here are a contract with
// the Go server (pkg/tmux/history.go) and deserve a test that runs under node
// without a browser.

// The bounds the server enforces (pkg/tmux/history.go). Restated rather than
// discovered from a rejection, so a typo is caught next to the input box.
export const HISTORY_MIN = 0;
export const HISTORY_MAX = 1000000;

// The sizes worth one click. 2,000 is tmux's own default and belongs here so
// "put it back" is as easy as raising it; the rest are the round numbers people
// actually reach for when a build log has just scrolled away.
export const HISTORY_PRESETS = [2000, 10000, 50000, 100000];

// The four things the dropdown can ask the server for. Same strings the Go side
// switches on (webtty/history.go).
//
// 'default' and 'persist' are two different scopes of the same idea, and the
// difference is the one people trip over: `set -g history-limit` lasts exactly as
// long as the tmux SERVER does, so a default set today is gone after a reboot.
// 'persist' also writes it into the tmux config file, where a server started
// tomorrow will read it.
export const ACTION_DEFAULT = 'default';
export const ACTION_PERSIST = 'persist';
export const ACTION_RESIZE = 'resize';
export const ACTION_CLEAR = 'clear';

// Read a typed limit. Returns {ok, value} or {ok:false, error} — an error a
// person can act on, not "invalid input": the two ways to get this wrong are a
// non-number and an out-of-range number, and they need different sentences.
export function parseLimit(text) {
  const raw = String(text == null ? '' : text).trim().replace(/[,_\s]/g, '');
  if (!raw) return { ok: false, error: 'Enter a number of lines.' };
  if (!/^\d+$/.test(raw)) return { ok: false, error: 'Lines must be a whole number.' };
  const value = Number(raw);
  if (value > HISTORY_MAX) {
    return { ok: false, error: `That is more than ${formatLines(HISTORY_MAX)} lines — pick a smaller buffer.` };
  }
  return { ok: true, value };
}

export function formatLines(n) {
  return Number(n || 0).toLocaleString();
}

// Byte counts a person can read at a glance. Shared with the save dropdown's
// download confirmation, so the two never describe the same buffer differently.
export function formatBytes(n) {
  const v = Number(n || 0);
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / (1024 * 1024)).toFixed(1)} MB`;
}

// One window's panes summed into the numbers the panel leads with.
//
// `mixed` is the case a single number would lie about: a window whose panes were
// created at different times can genuinely have different capacities, and the
// commonest way to get there is to resize a window while something is running in
// one of its panes. Reporting the largest (or the first) would hide exactly the
// pane that is about to lose lines.
export function windowUsage(panes) {
  const list = Array.isArray(panes) ? panes : [];
  if (!list.length) return { panes: 0, limit: 0, size: 0, bytes: 0, pct: 0, mixed: false, full: false };
  const limits = new Set(list.map((p) => Number(p.limit) || 0));
  const limit = Math.min(...limits);
  const size = list.reduce((a, p) => a + (Number(p.size) || 0), 0);
  const bytes = list.reduce((a, p) => a + (Number(p.bytes) || 0), 0);
  // Percentage is per PANE, not of the summed total: four panes each half full
  // are half full, not 200%. The fullest pane is the one that matters, since it
  // is the one already dropping lines.
  const pct = Math.max(0, ...list.map((p) => {
    const lim = Number(p.limit) || 0;
    return lim > 0 ? Math.min(100, ((Number(p.size) || 0) / lim) * 100) : 0;
  }));
  return {
    panes: list.length,
    limit,
    size,
    bytes,
    pct,
    mixed: limits.size > 1,
    // "Full" means the oldest lines are already being dropped as new ones
    // arrive — the state the panel exists to let you notice BEFORE the output
    // you wanted is gone. 99% rather than 100 because history_size stops one
    // short of the limit for a moment as tmux trims.
    full: pct >= 99,
  };
}

// Shells whose loss on a rebuild costs nothing but their own in-memory history.
// The SAME list the server enforces with (pkg/tmux/history.go): a confirmation
// naming a different set than the server refuses on is worse than none.
const IDLE_SHELLS = new Set([
  'bash', 'zsh', 'sh', 'dash', 'fish', 'ksh', 'mksh', 'ash', 'csh', 'tcsh',
]);

export function paneIsIdle(command) {
  return IDLE_SHELLS.has(String(command || '').trim().replace(/^-/, ''));
}

// Would rebuilding this pane destroy something? The question the confirmation
// actually asks, and it is NOT answerable from the foreground process alone: a
// pane launched as `sh -c "deploy.sh"` reports `sh`, which reads as an idle
// prompt. A pane tmux was given a command for is not a bare shell whatever its
// foreground process is called, and its startCommand says so.
export function paneIsWork(p) {
  return !paneIsIdle(p?.command) || !!p?.startCommand;
}

// What to CALL this pane's work. The launch command beats the process name when
// there is one — "sh -c \"deploy.sh\"" rather than a bare "sh" — and it is also
// exactly what a re-run would put back.
export function workName(p) {
  return p?.startCommand || p?.command || '';
}

// The panes a rebuild could put back as they were: the ones tmux knows a launch
// command for. A program you started by typing at a prompt is not one of them —
// tmux never saw it — which is why this is a subset of what a resize kills, not
// all of it.
export function relaunchable(panes, limit) {
  return panesToRebuild(panes, limit).filter((p) => !!p.startCommand);
}

// Which panes a resize would actually touch — the ones not already the right
// size. A pane that already holds the requested number of lines is left running.
export function panesToRebuild(panes, limit) {
  return (Array.isArray(panes) ? panes : []).filter((p) => Number(p.limit) !== Number(limit));
}

// The commands a resize would kill. Empty means every affected pane is sitting at
// a prompt and the rebuild is cheap.
export function busyCommands(panes, limit) {
  return panesToRebuild(panes, limit).filter(paneIsWork).map(workName);
}

// What the resize button is about to do, said plainly enough to decide on.
//
// Returns {none:true} when there is nothing to do, and otherwise
// {needsConfirm, text}. The scrollback is carried into the replacement, so the
// only irreversible part left is the running program — and the wording never
// softens THAT, because tmux offers no way to avoid it: a running process cannot
// be moved into a new pane.
export function resizePlan(panes, limit, rerun = true) {
  const todo = panesToRebuild(panes, limit);
  if (!todo.length) {
    return { none: true, needsConfirm: false, text: `Every pane already holds ${formatLines(limit)} lines.` };
  }
  const back = relaunchable(panes, limit);
  // What is offered is separate from what is left over: a pane tmux can relaunch
  // is not a loss the user has to accept, so with the box ticked it drops out of
  // the warning entirely and appears as a promise instead.
  const busy = rerun
    ? busyCommands(panes, limit).filter((c) => !back.some((p) => workName(p) === c))
    : busyCommands(panes, limit);
  const one = todo.length === 1;
  const count = `${todo.length} pane${one ? '' : 's'}`;
  const head = `tmux cannot resize a pane's buffer, so this rebuilds ${count} at `
    + `${formatLines(limit)} lines. The current scrollback is carried across.`;
  const relaunch = rerun && back.length
    ? ` ${back.map(workName).join(', ')} ${back.length === 1 ? 'is' : 'are'} started again `
      + '\u2014 restarted from scratch, not resumed.'
    : '';
  if (!busy.length) {
    return {
      none: false,
      needsConfirm: true,
      relaunchable: back,
      text: `${head}${relaunch}`
        + (relaunch ? '' : ` The shell${one ? '' : 's'} restart${one ? 's' : ''} in the same place.`),
    };
  }
  // The one cost nothing can soften, so it is stated in full and the escape hatch
  // is named. reptyr is the only way to move a running program to another pty, and
  // it is deliberately not automated (it needs a permissive kernel ptrace_scope and
  // fails by orphaning the program) — but someone who wants it should not have to
  // discover that it exists.
  return {
    none: false,
    needsConfirm: true,
    busy,
    relaunchable: back,
    text: `${head}${relaunch} But it KILLS ${busy.join(', ')}: tmux never saw `
      + `${busy.length === 1 ? 'that command' : 'those commands'}, so there is nothing `
      + 'to start again, and a running program cannot be moved into a new pane. To '
      + 'keep one, hand it over yourself first with reptyr (Linux, needs ptrace '
      + 'permission), then resize.',
  };
}

// One line of feedback for a completed action. The server replies to all three
// actions with the same frame, so this is where an outcome becomes a sentence.
export function actionBanner(res) {
  if (!res) return { state: 'err', text: 'No answer from webtmux.' };
  if (res.error) return { state: 'err', text: res.error };
  switch (res.action) {
    case ACTION_DEFAULT:
      return { state: 'ok', text: `New windows will hold ${formatLines(res.default)} lines. Windows that already exist keep their current size.` };
    case ACTION_CLEAR:
      return { state: 'ok', text: 'Scrollback cleared for this window.' };
    case ACTION_PERSIST:
      return {
        state: 'ok',
        text: `Saved to ${res.savedTo || 'your tmux config'} — new tmux servers will start at `
          + `${formatLines(res.default)} lines, and this one already does.`,
      };
    case ACTION_RESIZE: {
      const r = res.resize || {};
      if (!r.rebuilt) return { state: 'ok', text: `Nothing to rebuild — every pane already held ${formatLines(res.panes?.[0]?.limit || 0)} lines.` };
      const bits = [`Rebuilt ${r.rebuilt} pane${r.rebuilt === 1 ? '' : 's'} at ${formatLines(res.panes?.[0]?.limit || 0)} lines`];
      if (r.skipped) bits.push(`${r.skipped} already the right size`);
      // The scrollback is the thing the user was most afraid of losing, so whether
      // it came across is reported either way rather than only when it didn't.
      if (r.replayed >= r.rebuilt) bits.push('scrollback carried across');
      else if (r.replayed) bits.push(`scrollback carried across for ${r.replayed} of them`);
      else bits.push('the old scrollback could not be read, so they start empty');
      if (r.rerun?.length) bits.push(`started ${r.rerun.join(', ')} again`);
      if (r.restarted?.length) bits.push(`lost ${r.restarted.join(', ')}`);
      // Said out loud rather than left to be noticed: the panes are the size you
      // asked for, but they are not the shape you left them in.
      if (r.layoutRestored === false) bits.push('pane sizes could not be restored');
      return { state: 'ok', text: bits.join(' · ') + '.' };
    }
    default:
      return { state: 'ok', text: '' };
  }
}

// Which tmux config file a "save for next time" would land in, said as a phrase
// the panel can drop into a sentence. `#{config_files}` lists what this server
// actually loaded and is empty when it loaded none — in which case one is created,
// and saying so beforehand is the difference between a button and a surprise.
export function configFileHint(configFiles) {
  const files = String(configFiles || '').split(',').map((f) => f.trim()).filter(Boolean);
  if (!files.length) return 'you have no tmux config yet — one will be created';
  const mine = files[files.length - 1];
  return mine;
}
