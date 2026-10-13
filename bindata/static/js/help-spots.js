// What the help overlay explains — every piece of webtmux's UI, in sections.
//
// THE COVERAGE RULE: every control in the app is either a top-level callout here or
// a DETAIL of a section, and a section opens into its details as the pointer comes
// near it. Nothing is left for the user to stumble on; moving the mouse toward any
// part of the screen is enough to find out what it does and what its keys are.
//
// A spot is { id, title, text, keys, find, … }:
//   find(m)   → the element(s) it is about (null/[] when not on screen); m is the
//               SplitManager. Several elements are unioned into one outline.
//   alt(m)    → where to point when find() has no box — controls that only appear
//               on hover (a tab's ×) are explained at the thing you hover.
//   keys      → [{ chips: [...], d }] rows: keycaps then what they do.
//   details   → child spots, shown while the pointer is near the section.
//   each      → one spot PER matching element (floating preview boxes, regions).
//   brief     → the one-liner shown when the note has to shrink (no room, or
//               another section is open); default "point here".
//   inside    → the note sits INSIDE the target (the terminal is too big to
//               point at from outside); such a target is neither undimmed nor
//               treated as an obstacle.
//
// Texts are short on purpose — the tooltips and the ⌃⌥/ list carry the long form.
import { MOD_CHIPS, IS_MAC, chord } from './os.js';

const C = (key, d) => ({ chips: [...MOD_CHIPS, ...[].concat(key)], d });
const R = (chips, d) => ({ chips: [].concat(chips), d });
const CMD = IS_MAC ? '⌘' : '⌃';

const root = (el) => el?.renderRoot || el?.shadowRoot || null;
const q = (el, sel) => root(el)?.querySelector(sel) || null;
const qa = (el, sel) => [...(root(el)?.querySelectorAll(sel) || [])];
const tb = (sel) => (m) => q(m.toolbar, sel);
const sb = (sel) => (m) => q(m.sidebar, sel);
const cs = (sel) => (m) => q(m.copySidebar, sel);
const ex = (sel) => (m) => q(m.expose, sel);
const shown = (el) => el && !el.classList.contains('collapsed');

const STOPLIGHT = 'green = working · green ring = working in the background · amber = it needs your answer · red = out of work · hollow = no status. Set by the window (tmux @wt_working).';

// ---- toolbar ----------------------------------------------------------------

const TOOLBAR = [
  {
    id: 'status',
    title: 'Connection',
    text: 'The gear turns while output arrives; its colour is the link’s health (live / slow / lost).',
    find: (m) => [tb('.spin-wrap')(m), tb('.build')(m), tb('.ro-badge')(m), tb('.notice')(m)],
    details: [
      { id: 'status.spin', title: 'Link gear', text: 'Click: connection details and tmux settings (mouse, clipboard, rename hook).', keys: [R('click', 'menu')], find: tb('.spin') },
      { id: 'status.build', title: 'Build chip', text: 'Which webtmux build this is. Click copies it.', keys: [C('B', 'show / hide')], find: tb('.build'), alt: tb('.spin') },
      { id: 'status.ro', title: 'Read-only', text: 'This server was started without -w: watching works, changing tmux does not.', find: tb('.ro-badge') },
      { id: 'status.notice', title: 'Notice', text: 'Why the last action did nothing. Fades by itself.', find: tb('.notice') },
    ],
  },
  {
    id: 'shortcuts',
    title: 'Every shortcut',
    text: 'The full keyboard list.',
    keys: [C('/', 'open / close'), R('Esc', 'close'), C('?', 'this help, no holding')],
    find: tb('.tbtn[aria-label="Keyboard shortcuts"]'),
  },
  {
    id: 'recents',
    title: 'Recent windows',
    text: 'One tab per window you visited lately, across sessions. Point here for each part of a tab.',
    keys: [C('P', 'tab left'), C('N', 'tab right'), C('L', 'walk history: keep holding, tap L again'), C('D', 'drop the current tab')],
    find: (m) => [tb('.label-wrap')(m), tb('.tabs')(m), tb('.oflow')(m)],
    details: [
      { id: 'recents.menu', title: 'Recent ▾', text: 'How many tabs to keep, label style (session, trimmed names), clear the strip.', keys: [R('click', 'options')], find: tb('.label') },
      { id: 'recents.clear', title: 'Clear strip', text: 'Forgets every remembered window (the windows stay open).', find: tb('.label-clear') },
      { id: 'recents.tab', title: 'A tab', text: 'Index and name. Hover previews it in the pane; click switches. In split view hover offers which pane to show it in.', keys: [R('click', 'switch'), R('hover', 'preview'), R('⏎', 'take the preview'), R('Esc', 'put it back'), R('drag', 'reorder · drop on a pane')], find: tb('.rtab .tab') },
      { id: 'recents.light', title: 'Stoplight', text: STOPLIGHT + ' A tab flashes when its window drops out of green while you are elsewhere.', find: tb('.rtab .work') },
      { id: 'recents.age', title: 'Time in state', text: 'How long the window has been working / waiting.', keys: [R('click', 'other reading')], find: tb('.rtab .work-age') },
      { id: 'recents.close', title: '× (on hover)', text: 'Removes the tab from the strip. The window keeps running.', keys: [C('D', 'same, current tab')], find: tb('.rtab .tab .close'), alt: (m) => qa(m.toolbar, '.rtab .tab').at(-1) || null },
      { id: 'recents.oflow', title: 'Needs attention', text: 'Windows that flashed but have no tab here. Click previews the newest in the sidebar.', keys: [R('click', 'reveal')], find: tb('.oflow') },
    ],
  },
  {
    id: 'tools',
    title: 'Tools',
    text: 'Split, Exposé, save & transfer, scrollback, mouse modes, copy, preview, sidebar. Point here for each button.',
    find: tb('.sidebar-toggle'),
    details: [
      { id: 'tools.split', title: 'Split view', text: 'Add another terminal region beside this one.', keys: [C('⏎', 'add'), C('X', 'close focused'), C('O', 'next region'), C(';', 'last region')], find: tb('.tbtn[aria-label^="Split view"]') },
      { id: 'tools.expose', title: 'Exposé', text: 'Every window of every session as live tiles; type to filter.', keys: [C('F', 'open / close')].concat(IS_MAC ? [R('spread', 'trackpad: open')] : []), find: tb('.tbtn[aria-label^="Exposé"]') },
      { id: 'tools.save', title: 'Save & transfer', text: 'Download the pane’s scrollback or screen, write it to a file there, or copy files/folders between the two machines.', find: tb('.tbtn[aria-label^="Save pane"]') },
      { id: 'tools.history', title: 'Scrollback', text: 'How full this window’s history is; resize it, set the default, clear it.', find: tb('.tbtn[aria-label="Scrollback buffer"]') },
      { id: 'tools.mouse', title: 'Mouse capture', text: 'Who gets a click+drag (the program, or a selection) and the scroll wheel.', find: tb('.mouse-wrap .tbtn') },
      { id: 'tools.dots', title: 'Regions', text: 'One dot per terminal region; green is focused. Drag a divider to resize.', find: tb('.dots') },
      { id: 'tools.copy', title: 'Copy', text: 'NORMAL / COPY mode of the focused pane. Click opens the copy buffers.', keys: [C('[', 'flip mode'), C('=', 'buffers panel'), C(']', 'paste buffer')], find: tb('.mode') },
      { id: 'tools.pip', title: 'Preview', text: 'Keep an eye on the focused window in the preview bar, or a floating corner.', keys: [C('I', 'add / remove'), C(['⇧', 'I'], 'pin to a corner')], find: tb('.pip-toggle[aria-label^="Add focused"]') },
      { id: 'tools.piphide', title: 'Show / hide preview', text: 'Hides the preview but keeps its windows.', keys: [C('H', 'hide / show')], find: tb('.pip-toggle[aria-label="Show or hide the preview"]') },
      { id: 'tools.sidebar', title: 'Sidebar', text: 'Windows & sessions list.', keys: [C('W', 'toggle')], find: tb('.sidebar-toggle') },
    ],
  },
];

// ---- sidebar ----------------------------------------------------------------

const SIDEBAR = {
  id: 'sidebar',
  title: 'Windows & sessions',
  text: 'Every session and its windows. Point here for each part.',
  keys: [C('W', 'toggle'), C(['0–9'], 'window N'), C(['⇧', 'N'], 'next window'), C(['⇧', 'P'], 'prev window'), C('C', 'new window'), C(',', 'rename window'), C('&', 'kill window')],
  find: (m) => (shown(m.sidebar) ? m.sidebar : null),
  details: [
    { id: 'sb.view', title: 'View', text: 'This session only, or a tree of all windows (like tmux ⌃b w).', find: sb('.mode-row > .mode-btn') },
    { id: 'sb.float', title: 'Float / mount', text: 'Over the terminal, or beside it (the terminal shrinks).', find: sb('.mode-pair .mode-btn:nth-child(1)') },
    { id: 'sb.pin', title: 'Pinned / auto hide', text: `Auto hide closes on a terminal click or ⏎; pinned stays until ${chord('W')}.`, find: sb('.mode-pair .mode-btn:nth-child(2)') },
    { id: 'sb.sessions', title: 'Sessions', text: 'Click switches, double-click renames, drag reorders; drop a window on one to link it there.', keys: [R(['←', '→'], 'prev / next session')], find: sb('.session-tab.has-kill'), alt: sb('.twisty') },
    { id: 'sb.newsess', title: 'New session', find: (m) => q(m.sidebar, '.session-tabs > .session-tab:last-child') || q(m.sidebar, '.tree-new'), text: 'Creates a session.' },
    { id: 'sb.skill', title: '× on a session (hover)', text: 'Kills the session and its windows — asks first.', find: sb('.session-tab.has-kill .kill'), alt: sb('.session-tab.has-kill') },
    { id: 'sb.row', title: 'A window', text: 'Hover previews, click switches, double-click renames, drag reorders or links onto a session.', keys: [R(['↑', '↓'], 'preview'), R('⏎', 'switch'), R('Esc', 'back'), R('a–z', 'filter')], find: sb('.window-tab.has-kill') },
    { id: 'sb.light', title: 'Stoplight', text: STOPLIGHT, find: sb('.wrow .stoplight') },
    { id: 'sb.age', title: 'Time in state', keys: [R('click', 'other reading')], text: 'How long it has been working / waiting.', find: sb('.wrow .work-age') },
    { id: 'sb.wkill', title: '× on a window (hover)', text: 'Kills the window (only unlinks it when it is linked elsewhere) — asks first.', keys: [C('&', 'same, current window')], find: sb('.window-tab.has-kill .kill'), alt: (m) => qa(m.sidebar, '.window-tab.has-kill').at(-1) || null },
    { id: 'sb.plus', title: '+ command', text: 'New window running this command; double-click edits it.', keys: [C('C', 'new window')], find: sb('.plus-row .window-tab:not(.plus-add)') },
    { id: 'sb.plusadd', title: '+…', text: 'Another “+” with its own command.', find: sb('.plus-add') },
    { id: 'sb.filter', title: 'Filter', text: 'Typed text filters the list; ✕ or Esc clears.', find: sb('.filter-chip') },
    { id: 'sb.info', title: 'Footer', text: 'Session name and window count.', find: sb('.session-info') },
  ],
};

// ---- copy buffers -----------------------------------------------------------

const COPY = {
  id: 'copy',
  title: 'Copy buffers',
  text: 'Everything you copied; one of them is on the clipboard. Point here for each part.',
  keys: [C('=', 'toggle'), R(['↑', '↓'], 'pick a buffer'), R('⌫', 'remove'), C(']', 'paste'), R([CMD, 'V'], 'paste')],
  find: (m) => (shown(m.copySidebar) ? m.copySidebar : null),
  details: [
    { id: 'cp.mode', title: 'NORMAL / COPY', text: 'Copy mode: wheel and arrows walk history, dragging selects.', keys: [C('[', 'flip')], find: cs('.mode-toggle') },
    { id: 'cp.float', title: 'Float / mount', text: 'Over the terminal, or beside it.', find: cs('.mode-pair .mode-btn:nth-child(1)') },
    { id: 'cp.pin', title: 'Pinned / auto hide', text: 'Whether it closes by itself.', find: cs('.mode-pair .mode-btn:nth-child(2)') },
    { id: 'cp.buf', title: 'A buffer', text: 'Click puts it on the clipboard; hover shows its text.', find: cs('.buf') },
    { id: 'cp.clip', title: 'Clipboard dot', text: 'Filled = this one is on the clipboard (or the browser refused — click to retry).', find: cs('.brow .clip') },
    { id: 'cp.kill', title: '× (hover)', text: 'Removes the buffer.', keys: [R('⌫', 'same')], find: cs('.buf .kill'), alt: cs('.buf') },
    { id: 'cp.add', title: '+ buffer', text: 'An empty buffer; the next copy lands there.', find: cs('.actions .mode-btn:not(.clear-btn)') },
    { id: 'cp.clear', title: 'Clear', text: 'Keeps only the focused buffer.', find: cs('.clear-btn') },
  ],
};

// ---- preview (pip) ----------------------------------------------------------

const TILE_DETAILS = (scope, key = scope) => [
  { id: `${key}.tile`, title: 'A tile', text: 'Hover previews it in a region, click switches there, drag reorders (or onto the bar / a corner).', keys: [R('click', 'switch'), R('drag', 'move')], find: (m) => scopeQ(m, scope, '.ptile') },
  { id: `${key}.corner`, title: '⌜⌝⌞⌟ (hover)', text: 'Pin it to that corner as a floating box; ▬ puts it back on the bar.', keys: [C(['⇧', 'I'], 'pin / unpin focused')], find: (m) => scopeQ(m, scope, '.ptile .tbtn.corner') || scopeQ(m, scope, '.ptile .tbtn.tobar'), alt: (m) => scopeQ(m, scope, '.ptile') },
  { id: `${key}.close`, title: '✕ (hover)', text: 'Removes it from the preview.', keys: [C('I', 'add / remove focused')], find: (m) => scopeQ(m, scope, '.ptile .tbtn.close'), alt: (m) => scopeQ(m, scope, '.ptile') },
  { id: `${key}.label`, title: 'Label', text: 'Stoplight, time in state (click: other reading), index and name.', find: (m) => scopeQ(m, scope, '.ptile .plabel') },
];
function scopeQ(m, scope, sel) {
  const box = scope === 'bar' ? q(m.pip, '.bar.on') : scope;
  if (!box || typeof box === 'string') return null;
  const hit = box.querySelector(sel);
  // A hover-only control has no box until hovered; treat that as absent.
  return hit && hit.getClientRects().length && getComputedStyle(hit).opacity !== '0' ? hit : (sel.includes('.tbtn') ? null : hit);
}

const PREVIEW_BAR = {
  id: 'bar',
  title: 'Preview bar',
  text: 'Live views of windows you are keeping an eye on. Its space is reserved, so it never covers the terminal. Point here for its parts.',
  keys: [C('I', 'add / remove focused'), C('H', 'hide / show')],
  find: (m) => q(m.pip, '.bar.on'),
  details: [
    { id: 'bar.edge', title: '↑↓←→', text: 'Dock the bar to that edge.', find: (m) => q(m.pip, '.bar.on .barctl .bbtn:not(.hide)') },
    { id: 'bar.hide', title: '⊘', text: 'Hide the preview (keeps its windows).', keys: [C('H', 'same')], find: (m) => q(m.pip, '.bar.on .bbtn.hide') },
    { id: 'bar.grip', title: 'Grip', text: 'Drag to resize the bar; double-click resets.', find: (m) => q(m.pip, '.bar.on .grip') },
    ...TILE_DETAILS('bar'),
  ],
};

// One section per floating corner box.
function cornerSpots(m) {
  return qa(m.pip, '.pipbox.on').map((box) => {
    const c = box.getAttribute('corner') || 'box';
    return {
      id: `pipbox.${c}`,
      title: 'Floating preview',
      text: 'One window pinned to this corner (four at most). Drag it onto the bar to dock it.',
      keys: [C(['⇧', 'I'], 'pin / unpin focused')],
      find: () => box,
      details: TILE_DETAILS(box, `pipbox.${c}`),
    };
  });
}

// ---- Exposé -----------------------------------------------------------------

const EXPOSE = [
  {
    id: 'ex.head',
    title: 'Exposé controls',
    text: 'Filter, status, search scope, grid size and sort.',
    keys: [C('F', 'close'), R('a–z', 'filter'), R('Esc', 'clear, then close')],
    find: ex('.head'),
    details: [
      { id: 'ex.filter', title: 'Filter', text: 'Type anywhere to filter tiles by name; ⌫ deletes.', find: (m) => q(m.expose, '.head .filter') || q(m.expose, '.head .typehint') },
      { id: 'ex.show', title: 'Show', text: 'Only windows in one state (working, background, needs you, idle).', find: ex('.head .sort:nth-child(6)') },
      { id: 'ex.search', title: 'Search', text: 'Names only, or names + each window’s captured output.', find: ex('.head .sort:nth-child(7)') },
      { id: 'ex.gridsize', title: 'Grid', text: '2×2 or 3×3 windows per screen.', keys: [C('F', IS_MAC ? 'or pinch: close' : 'close')], find: ex('.head .sort:nth-child(8)') },
      { id: 'ex.sort', title: 'Sort', text: 'By session / window, or last accessed.', find: ex('.head .sort:nth-child(9)') },
    ],
  },
  {
    id: 'ex.grid',
    title: 'Every window',
    text: 'Live tiles of every window in every session. Point at the first tile for its parts.',
    keys: [R(['←', '→', '↑', '↓'], 'move'), R('⏎', 'switch'), R('click', 'switch')],
    find: ex('.grid'),
    // The grid IS the screen while Exposé is up: its note sits on the (dimmed)
    // tiles rather than hunting for room that does not exist outside it.
    inside: true,
    details: [
      { id: 'ex.tile', title: 'A tile', text: 'Click (or ⏎ on the highlighted one) shows it in the focused region.', find: ex('.tile') },
      { id: 'ex.light', title: 'Stoplight', text: STOPLIGHT, find: ex('.tile-work') },
      { id: 'ex.label', title: 'Label', text: 'Index:name and its session.', find: ex('.tile-label') },
    ],
  },
];

// ---- terminal regions ---------------------------------------------------------

function regionSpots(m) {
  const regions = [...document.querySelectorAll('#app .region')];
  const multi = regions.length > 1;
  const focused = regions.find((r) => r.classList.contains('focused')) || regions[0];
  const spots = regions.map((r) => (r === focused ? {
    id: 'term',
    title: 'Terminal',
    text: multi ? 'The focused region (blue outline) — every switcher changes what it shows. Click another region to focus it.'
      : 'Your tmux window. Drag selects even over a program that holds the mouse; dragging to an edge scrolls.',
    keys: [R('drag', 'select'), R(['⇧', 'click'], 'extend selection'), R([IS_MAC ? '⌥' : '⇧', 'drag'], 'force select'), R([CMD, 'C'], 'copy (again = new buffer)'), R([CMD, 'V'], 'paste'), C('[', 'copy mode')]
      .concat(multi ? [C('O', 'next region'), C(';', 'last region'), C('X', 'close region')] : []),
    find: () => r,
    inside: true,
    brief: `drag selects · ${CMD}C / ${CMD}V copy & paste`,
  } : {
    id: `term.${regions.indexOf(r)}`,
    title: 'Region',
    text: 'Click to focus it.',
    keys: [C('O', 'next')],
    find: () => r,
    inside: true,
  }));
  document.querySelectorAll('#app .divider').forEach((d, i) => spots.push({
    id: `divider.${i}`, title: 'Divider', text: 'Drag to resize the regions.', find: () => d,
  }));
  return spots;
}

// ---- shortcuts list -----------------------------------------------------------

const SHORTCUTS_LIST = {
  id: 'kbd.list',
  title: 'Shortcut list',
  text: 'Every key, grouped by where it works.',
  keys: [R('Esc', 'close'), C('/', 'close')],
  find: (m) => (m.shortcuts?.open ? q(m.shortcuts, '.card') : null),
};

// Every section that could be on screen now, most important first (earlier ones
// get the best spots). The overlay drops those whose element is not visible.
export function helpSections(m) {
  if (m.shortcuts?.open) return [SHORTCUTS_LIST];
  if (m.expose?.open) return EXPOSE;
  return [
    ...TOOLBAR,
    SIDEBAR,
    COPY,
    PREVIEW_BAR,
    ...cornerSpots(m),
    ...regionSpots(m),
  ];
}
