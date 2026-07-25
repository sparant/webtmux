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
// hook, a script) with:  tmux set -w @wt_working 1|0|2  (set -u to clear).
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
