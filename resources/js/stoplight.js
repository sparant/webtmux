// The work-status stoplight — one source of truth for what @wt_working means.
//
// The dot shows up in three places (recents tabs, the sidebar's window list, the
// preview tiles) and each used to carry its own copy of the class mapping and its
// own words for the states — "Idle" here, "stopped" there. Three surfaces
// describing one signal three ways is how a colour quietly loses its meaning, so
// the mapping, the one-line label and the legend all live here and every surface
// imports them.
//
// The values are set by whatever runs IN the window (agent hooks, a shell prompt
// hook, a script) with:  tmux set -w -t "$TMUX_PANE" @wt_working 1|0|2|3 (-u to clear).
// The pane target is part of the contract, not a flourish: a bare `set -w` writes to
// whatever window is CURRENT, i.e. the one being watched, so an unaddressed write is
// right only while nobody needs it and lands on the wrong window the moment they do.
//
// This module has no imports on purpose: the components, the SplitManager and the
// node test runner can all load it.

// Raw @wt_working value -> the CSS class the dot carries. '' (no class) is the
// unfilled "not reporting" dot.
export function workClass(working) {
  return working === '1' ? 'on'
    : working === '0' ? 'off'
    : working === '2' ? 'wait'
    : working === '3' ? 'bg'
    : '';
}

// The one-line "what is this window doing right now" answer.
export function workLabel(working) {
  return working === '1' ? 'Working'
    : working === '0' ? 'Waiting for work to do'
    : working === '2' ? 'Prompting — it needs an answer from you'
    : working === '3' ? 'Working in the background — it can take input meanwhile'
    : 'Not reporting a status';
}

// Is this window BUSY — i.e. does it have work of its own that it expects to carry
// on with, whether or not it happens to be executing something this instant?
//
// The two busy values are one state to everything that asks "does this window need
// me": a live turn (1) and a window parked on work it launched (3) both mean "it is
// not out of work, and it is not blocked on you". They differ only in whether you
// can usefully TALK to it right now, which is a property of the dot, not of the
// alerting — so WorkAlerts asks this rather than comparing against '1', and the
// drop out of busy (either kind) is what raises a flash.
export function isBusy(working) {
  return working === '1' || working === '3';
}

// The full colour key, appended to every stoplight's hover text. A dot is only
// worth having if you can find out what it means from the dot itself, and hover
// is the only place there's room to say it. Colour NAMES lead each line: the tooltip
// has to be readable by someone who can't tell the fills apart.
export const WORK_LEGEND = [
  'Work status — set by the window itself (tmux set -w @wt_working):',
  '  ● Green — working',
  '  ◉ Green ring — working in the background: it is waiting on something it started,',
  '                 and can take input while it waits',
  '  ● Amber — prompting: something is blocked until you answer',
  '  ● Red — waiting for work to do',
  '  ○ Unfilled — not reporting a status',
].join('\n');

// Turn a count of seconds into a short "how long" reading: '<1m', '5m', '2h14m',
// '3d7h'. Never fractional and never negative-looking — a clock a hair ahead of
// tmux's would otherwise print "-1m" the instant a value is stamped.
export function formatDuration(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '';
  const s = Math.floor(totalSeconds);
  if (s < 60) return '<1m';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) { const rm = m % 60; return rm ? `${h}h${rm}m` : `${h}h`; }
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d}d${rh}h` : `${d}d`;
}

// Which readings a window actually HAS, in the same preference order workBadge()
// defaults to (since first). This is the single source of truth for "what can this
// badge show" — both the badge's default pick and its click-to-cycle behaviour walk
// this same list, so they can never disagree about what's available.
export function workBadgeModes(sinceSeconds, activitySeconds) {
  const modes = [];
  const since = Number(sinceSeconds);
  if (Number.isFinite(since) && since > 0) modes.push('since');
  const activity = Number(activitySeconds);
  if (Number.isFinite(activity) && activity > 0) modes.push('activity');
  return modes;
}

// Given the currently-displayed mode (or '' / an unrecognised one), return the next
// mode to show on a click — the next entry in workBadgeModes(), wrapping around.
// A single-entry (or empty) list has nothing to cycle to, so it just returns what it
// was given: the caller should not offer a click affordance in that case at all.
export function nextBadgeMode(currentMode, sinceSeconds, activitySeconds) {
  const modes = workBadgeModes(sinceSeconds, activitySeconds);
  if (modes.length < 2) return currentMode;
  const i = modes.indexOf(currentMode);
  return modes[(i + 1) % modes.length];
}

// The short always-visible label next to a dot — the at-a-glance answer, for
// someone scanning a whole strip of tabs without hovering anything, to "how long
// has it been like this".
//
// mode picks WHICH reading to show: 'since' or 'activity' show exactly that one (an
// unavailable one degrades to '', not a silent substitution of the other — a forced
// choice has to fail visibly, or clicking to "since" on a window with none would
// look like nothing happened) rather than the other reading appearing under a label
// the caller specifically asked to move away from. Omitted/falsy/unrecognised falls
// back to the original auto behaviour: prefer sinceSeconds (the agent's own reported
// state, the more meaningful reading when it exists), fall back to activitySeconds
// (tmux's own clock, so even a window with no stoplight hook at all still gets a
// reading). '' when the requested reading (or, in auto mode, both) is unavailable.
export function workBadge(sinceSeconds, activitySeconds, nowSeconds = Date.now() / 1000, mode) {
  const since = Number(sinceSeconds);
  const hasSince = Number.isFinite(since) && since > 0;
  const activity = Number(activitySeconds);
  const hasActivity = Number.isFinite(activity) && activity > 0;
  if (mode === 'since') return hasSince ? formatDuration(nowSeconds - since) : '';
  if (mode === 'activity') return hasActivity ? formatDuration(nowSeconds - activity) : '';
  if (hasSince) return formatDuration(nowSeconds - since);
  if (hasActivity) return formatDuration(nowSeconds - activity);
  return '';
}

// What the badge means and how it was worked out — separate from workTip() because
// the badge is a NUMBER standing alone with no colour/label next to it to give it
// context, so its own hover has to explain the mechanism, not just restate the dot's
// state. Names whichever reading workBadge() was ALSO given the same arguments and
// mode would show, so the explanation can never claim a mechanism the number on
// screen didn't come from — and, when a click-to-cycle is available, says so.
export function workBadgeTip(sinceSeconds, activitySeconds, nowSeconds = Date.now() / 1000, mode) {
  const since = Number(sinceSeconds);
  const hasSince = Number.isFinite(since) && since > 0;
  const activity = Number(activitySeconds);
  const hasActivity = Number.isFinite(activity) && activity > 0;
  const showSince = mode === 'since' ? hasSince : mode === 'activity' ? false : hasSince;
  const cycleHint = workBadgeModes(sinceSeconds, activitySeconds).length > 1
    ? '\n\nClick to switch to the other reading.' : '';
  if (showSince) {
    return [
      `In this state for ${formatDuration(nowSeconds - since)}`,
      '',
      'Time since @wt_working (the stoplight colour) last actually CHANGED — not',
      'since it was last re-asserted. The window’s own hooks stamp this only on a',
      'real transition, so re-reporting the same colour every ~60s does not reset it.',
    ].join('\n') + cycleHint;
  }
  const showActivity = mode === 'activity' ? hasActivity : mode === 'since' ? false : hasActivity;
  if (showActivity) {
    return [
      `Pane silent for ${formatDuration(nowSeconds - activity)}`,
      '',
      'Time since anything was last written to this pane, from tmux’s own',
      '#{window_activity} clock.' + (mode === 'activity' ? '' :
        ' Shown because this window has no stoplight state (@wt_working) reported at all —' +
        ' this is the only timing tmux itself can give it.'),
    ].join('\n') + cycleHint;
  }
  return 'No timing data available for this window.';
}

// The complete hover text for a stoplight: where THIS window is, then how long it's
// been that way, then the key.
//
// Two independent "how long" readings, because they answer different questions:
//   sinceSeconds    from @wt_working_since — how long the AGENT has reported this
//                   exact colour (stamped only on a real transition, never on a
//                   re-assert of the same value).
//   activitySeconds from tmux's own #{window_activity} — how long since ANYTHING
//                   was written to the pane at all, whether or not anything installed
//                   a stoplight hook. A background build can keep this moving while
//                   sinceSeconds sits still, which is exactly the distinction that
//                   makes both worth showing rather than picking one.
// Both optional and independently omitted when absent/invalid, so every existing
// single-argument call site keeps behaving exactly as before.
export function workTip(working, sinceSeconds, activitySeconds, nowSeconds = Date.now() / 1000) {
  const lines = [workLabel(working)];
  const since = Number(sinceSeconds);
  if (Number.isFinite(since) && since > 0) {
    lines.push(`In this state for ${formatDuration(nowSeconds - since)}`);
  }
  const activity = Number(activitySeconds);
  if (Number.isFinite(activity) && activity > 0) {
    lines.push(`Pane silent for ${formatDuration(nowSeconds - activity)}`);
  }
  return `${lines.join(' — ')}\n\n${WORK_LEGEND}`;
}

// --- filtering BY stoplight ---------------------------------------------------
// Exposé can narrow its grid to one work status, which turns "every window on the
// server" into a triage board: show me only the ones that need me. The vocabulary
// lives here with the rest of the stoplight's meaning rather than in the overlay,
// because a filter called "idle" that disagreed with the dot labelled "waiting for
// work to do" would be two names for one state — the exact failure this module was
// extracted to prevent.
//
// `working` is deliberately the ONLY narrowing axis. A window is either doing work,
// waiting on work it started, blocked on you, out of work, or silent; there is
// nothing else the stoplight knows, and a filter that combined statuses ("anything
// but green") would need a name that says which combination it means.
//
// 'background' gets its own button rather than folding into 'working' for the reason
// the state exists at all: those are the windows you can interrupt cheaply. "Show me
// everything that is busy" and "show me the busy ones I can talk to" are different
// questions, and only the second one has an answer worth acting on.
export const STATUS_FILTERS = [
  { id: 'all',        label: 'All',        hint: 'every window, whatever it is doing' },
  { id: 'working',    label: 'Working',    hint: 'green — running a turn right now' },
  { id: 'background', label: 'Background', hint: 'green ring — waiting on work it started; free to take input' },
  { id: 'attention',  label: 'Needs you',  hint: 'amber — prompting: blocked until you answer' },
  { id: 'idle',       label: 'Idle',       hint: 'red — reported that it has run out of work to do' },
];

// Coerce a stored/typed filter id into a real one. Total, like the other readers of
// @wt_state: the blob is user-writable tmux state, and an unknown id must degrade to
// showing everything rather than to an empty grid with no way back — 'all' is the only
// safe default because it is the only value that can't hide the control's own effect.
export function normalizeStatusFilter(raw) {
  return STATUS_FILTERS.some((f) => f.id === raw) ? raw : 'all';
}

// Does a window with this @wt_working value pass the filter?
//
// '' (never set, or `set -u`) passes ONLY under 'all'. It is tempting to fold it into
// idle — a silent window is usually doing nothing — but "not reporting" is the absence
// of a claim, not a claim of idleness: most windows on a server never install the hook
// at all, and lumping them in would make "Idle" mean "everything except my agents" and
// bury the handful of windows that genuinely said they had run out of work.
export function matchesStatus(working, filter) {
  switch (normalizeStatusFilter(filter)) {
    case 'working':    return working === '1';
    case 'background': return working === '3';
    case 'attention':  return working === '2';
    case 'idle':       return working === '0';
    default:           return true;
  }
}
