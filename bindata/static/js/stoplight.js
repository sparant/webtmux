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
// hook, a script) with:  tmux set -w -t "$TMUX_PANE" @wt_working 1|0|2  (-u to clear).
// The pane target is part of the contract, not a flourish: a bare `set -w` writes to
// whatever window is CURRENT, i.e. the one being watched, so an unaddressed write is
// right only while nobody needs it and lands on the wrong window the moment they do.
//
// This module has no imports on purpose: the components, the SplitManager and the
// node test runner can all load it.

// Raw @wt_working value -> the CSS class the dot carries. '' (no class) is the
// unfilled "not reporting" dot.
export function workClass(working) {
  return working === '1' ? 'on' : working === '0' ? 'off' : working === '2' ? 'wait' : '';
}

// The one-line "what is this window doing right now" answer.
export function workLabel(working) {
  return working === '1' ? 'Working'
    : working === '0' ? 'Waiting for work to do'
    : working === '2' ? 'Prompting — it needs an answer from you'
    : 'Not reporting a status';
}

// The full colour key, appended to every stoplight's hover text. A dot is only
// worth having if you can find out what it means from the dot itself, and hover
// is the only place there's room to say it. Colour NAMES lead each line: the tooltip
// has to be readable by someone who can't tell the three fills apart.
export const WORK_LEGEND = [
  'Work status — set by the window itself (tmux set -w @wt_working):',
  '  ● Green — working',
  '  ● Amber — prompting: something is blocked until you answer',
  '  ● Red — waiting for work to do',
  '  ○ Unfilled — not reporting a status',
].join('\n');

// The complete hover text for a stoplight: where THIS window is, then the key.
export function workTip(working) {
  return `${workLabel(working)}\n\n${WORK_LEGEND}`;
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
// blocked on you, out of work, or silent; there is nothing else the stoplight knows,
// and a filter that combined statuses ("anything but green") would need a name that
// says which combination it means.
export const STATUS_FILTERS = [
  { id: 'all',       label: 'All',       hint: 'every window, whatever it is doing' },
  { id: 'working',   label: 'Working',   hint: 'green — busy right now' },
  { id: 'attention', label: 'Needs you', hint: 'amber — prompting: blocked until you answer' },
  { id: 'idle',      label: 'Idle',      hint: 'red — reported that it has run out of work to do' },
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
    case 'working':   return working === '1';
    case 'attention': return working === '2';
    case 'idle':      return working === '0';
    default:          return true;
  }
}
