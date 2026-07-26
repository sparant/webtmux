// Top toolbar: a most-recently-accessed window strip on the LEFT and the sidebar
// toggle on the RIGHT. The SplitManager owns the data — it sets `recent`
// (up to 5 {id,index,name,active,working,alert}) and `collapsed`, and handles
// clicks via `manager.pickRecentWindow(id)` / `manager.sidebar.toggleCollapsed()`.
//
// Hovering a recent tab does NOT pop a thumbnail here any more: it asks the shared
// HoverPreview to show that window in a real terminal region (see hover-preview.js),
// which is bigger, in place, and the same behavior every other switcher now has.
import { LitElement, html, css } from 'lit';
import { chord, IS_MAC } from '../os.js';
import { stateStore } from '../state-store.js';
import { workClass, workLabel, workTip } from '../stoplight.js';
import { Tip, TIP_CSS } from '../tooltip.js';
import { saveHint } from '../save-target.js';
import { copyText } from '../clipboard.js';

// Recent-tab label shape. Two INDEPENDENT toggles rather than one four-way cycle,
// because they answer unrelated questions: "which session is this in" and "how much
// of the name do I need". Defaults are the quiet ones — most windows live in the
// session you're already in, and long names are usually "<tool> <what>", where the
// leading word is the part you already know.
const LABEL_DEFAULTS = { showSession: false, trimName: true };

// Drop everything up to and including the first space: "claude Dominion-wq" reads
// as "Dominion-wq". A name with no space is left alone (there's nothing redundant
// to remove), and a name that is ALL prefix ("claude ") keeps the original rather
// than collapsing to nothing.
function trimWindowName(name) {
  const s = String(name || '');
  const i = s.indexOf(' ');
  if (i < 0) return s;
  const tail = s.slice(i + 1).trim();
  return tail || s;
}

// Scroll-wheel modes, in the order the toolbar button cycles them. Kept in sync
// with SCROLL_MODES in terminal-unit.js. `label` is the compact toolbar text;
// `hint` is the tooltip. (This control moved here from the sidebar.)
const SCROLL_ORDER = ['app', 'buffer', 'adaptive-mode', 'adaptive-probe'];
const SCROLL_META = {
  'app':            { label: '🖱 app',   name: 'app',   hint: 'wheel always goes to the program (Claude/vim/less scroll themselves)' },
  'buffer':         { label: '🖱 buf',   name: 'buf',   hint: 'wheel always scrolls tmux history (copy-mode)' },
  'adaptive-mode':  { label: '🖱 auto',  name: 'auto',  hint: 'mouse-tracking / full-screen apps get the wheel; a plain shell scrolls history' },
  'adaptive-probe': { label: '🖱 auto+', name: 'auto+', hint: 'like auto, but probes the ambiguous case — tries the app, then scrolls history if it did not react' },
};
function normalizeScroll(m) {
  if (m === 'passthrough') return 'app';
  return SCROLL_ORDER.includes(m) ? m : 'adaptive-probe';
}

// The scroll button cycles four modes and its label only shows the current one, so
// the tooltip lists ALL four (current marked ▸) — the mode names alone don't say
// what they do. Rendered with `white-space: pre-line`, so \n break the lines.
function scrollTooltip(current) {
  const lines = SCROLL_ORDER.map((m) => {
    const meta = SCROLL_META[m];
    const mark = m === current ? '▸' : ' '; // ▸ current, em-space otherwise (aligns)
    return `${mark} ${meta.name} — ${meta.hint}`;
  });
  return `Scroll-wheel mode — click to cycle:\n${lines.join('\n')}`;
}

// The Exposé button's icon. It used to be ▦ — a grid glyph that, next to the
// split button's ⊞, read as "another box" and said nothing about windows. Four
// UNEVEN tiles, each with a title bar, are the picture of "every window, spread
// out": uneven because a grid of identical cells is a table, and title bars
// because that is what makes a rectangle a window. Drawn rather than typed so it
// doesn't depend on a font having a usable glyph — the same lesson as the
// renderer's system-font fallback.
function exposeIcon() {
  return html`
    <svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round">
        <rect x="1.4" y="2.6" width="7.6" height="6.2" rx="1.2"></rect>
        <rect x="11" y="1.4" width="7.6" height="7.4" rx="1.2"></rect>
        <rect x="1.4" y="10.6" width="7.6" height="7.4" rx="1.2"></rect>
        <rect x="11" y="11.2" width="7.6" height="6.2" rx="1.2"></rect>
      </g>
      <g stroke="currentColor" stroke-width="1.1" stroke-linecap="round" opacity="0.75">
        <line x1="1.4" y1="4.6" x2="9" y2="4.6"></line>
        <line x1="11" y1="3.4" x2="18.6" y2="3.4"></line>
        <line x1="1.4" y1="12.6" x2="9" y2="12.6"></line>
        <line x1="11" y1="13.2" x2="18.6" y2="13.2"></line>
      </g>
    </svg>
  `;
}

// Exposé's hover text. The trackpad gesture is listed HERE, on the button that
// does the same thing, because that is where someone looking for "how do I get
// all my windows" is already pointing — the shortcuts overlay only helps people
// who already knew to open it. Mac-only, matching the gesture's own gating in
// SplitManager (a ctrl+wheel on other platforms is still page zoom).
const EXPOSE_TIP = `Exposé — a thumbnail of every window across all sessions. Shortcut: ${chord('E')}`
  + (IS_MAC ? '\nTrackpad: spread two fingers to open it, pinch them together to close it.' : '');

class WebtmuxToolbar extends LitElement {
  static properties = {
    recent: { type: Array },
    collapsed: { type: Boolean },
    panes: { type: Array },
    // Current scroll-wheel mode (mirror of the focused unit's setting). Cycled by
    // the toolbar's scroll button; one of SCROLL_ORDER.
    scrollMode: { type: String },
    // True when the focused split region's active pane is in tmux copy/view mode.
    // Reflected to the `copymode` attribute so :host() can recolor the whole bar.
    copyMode: { type: Boolean, reflect: true, attribute: 'copymode' },
    // Preview state (SplitManager sets): how many windows are in the preview,
    // whether it's hidden, and whether the focused pane's window is one of them.
    previewCount: { type: Number },
    previewHidden: { type: Boolean },
    previewHasFocused: { type: Boolean },
    // Whether the build-id chip on the far left is shown. Hidden by default;
    // toggled by Ctrl+Alt+B (see the shortcuts overlay). Persisted per browser.
    showBuild: { type: Boolean },
    // Save dropdown: whether it's open, and the transient result banner it shows
    // (null | {state:'saving'|'ok'|'err', text}). Both set by this component and,
    // for saveStatus, by the SplitManager when a server-side save resolves.
    saveOpen: { type: Boolean },
    saveStatus: { type: Object },
    // Where a save would land, as the server describes it (a SaveEnv; see
    // webtty/savepath.go). Requested when the dropdown opens and rendered as its
    // hint line, so an invisible pane directory is disclosed before a failed save
    // rather than after one. Null until the answer arrives.
    saveInfo: { type: Object },
    // The window the shared HoverPreview is currently showing ('' = none). Marks
    // which tab the preview on screen belongs to. Set by the SplitManager.
    previewWindow: { type: String },
    // Recent-tab label shape (see LABEL_DEFAULTS) + whether its little menu is open.
    showSession: { type: Boolean },
    trimName: { type: Boolean },
    labelMenuOpen: { type: Boolean },
    // Recents drag-reorder: the tab being dragged, and the insertion GAP the drop
    // would land in (0..n, -1 = not over the strip).
    dragKey: { type: String },
    dropIndex: { type: Number },
    // tmux-activity spinner position, in increments (rendered as rotation).
    activity: { type: Number },
  };

  // TIP_CSS is appended so the hover hint is byte-identical to the sidebar's.
  static styles = [css`
    :host {
      display: flex;
      align-items: center;
      height: var(--wt-toolbar-h, 44px);
      box-sizing: border-box;
      background: #16213e;
      border-bottom: 1px solid #0f3460;
      padding: 0 8px;
      gap: 8px;
      flex: 0 0 auto;
      z-index: 70;
      transition: background 0.15s, border-color 0.15s;
    }
    /* COPY MODE: recolor the entire toolbar so it's unmistakable which mode the
       focused pane is in. Amber = copy/view mode; default navy = normal input. */
    :host([copymode]) {
      background: #7a4a12;
      border-bottom-color: #f0a742;
    }
    .tabs {
      display: flex;
      align-items: center;
      gap: 6px;
      overflow-x: auto;
      overflow-y: hidden;
      flex: 1 1 auto;
      scrollbar-width: thin;
    }
    .tabs::-webkit-scrollbar { height: 6px; }
    .tabs::-webkit-scrollbar-thumb { background: #0f3460; border-radius: 3px; }
    .label {
      color: #666; font-size: 12px; margin-right: 2px; white-space: nowrap; flex: 0 0 auto;
      background: none; border: none; padding: 2px 4px; border-radius: 4px;
      font-family: inherit; cursor: pointer;
    }
    .label:hover { color: #9fc4ff; background: #1a1a2e; }

    /* A recents entry = the status dot + the tab, as one drag unit. The dot lives
       OUTSIDE the tab button on purpose: inside, it sat on the tab's own background,
       and a red dot on the selected tab's red fill was nearly invisible — exactly
       when you most want to see it. Out here it always has the toolbar behind it. */
    .rtab {
      position: relative;
      flex: 0 0 auto;
      display: inline-flex;
      align-items: center;
      gap: 5px;
    }
    .rtab[draggable] { cursor: grab; user-select: none; }
    .rtab.dragging { opacity: 0.4; cursor: grabbing; }
    /* Insertion line for the reorder drop, drawn in the gap before this entry (or
       after the last one). Same vocabulary as the sidebar's window-list reorder. */
    .rtab.drop-before::before,
    .rtab.drop-end::after {
      content: '';
      position: absolute;
      top: 2px;
      bottom: 2px;
      width: 2px;
      border-radius: 2px;
      background: #4a9eff;
      box-shadow: 0 0 6px rgba(74, 158, 255, 0.9);
    }
    .rtab.drop-before::before { left: -4px; }
    .rtab.drop-end::after { right: -4px; }

    /* Working-status dot: green = working, amber = prompting (blocked on your
       answer), red = waiting for work to do, unfilled = not reporting. Clients drive
       it with: tmux set -w @wt_working 1|0|2 (set -u to clear). The words live in
       stoplight.js — every surface that shows this dot says them the same way, and
       hovering it prints the whole key. */
    .work {
      flex: 0 0 auto; width: 8px; height: 8px; border-radius: 50%;
      border: 1px solid #5a6a8a; background: transparent; box-sizing: border-box;
    }
    .work.on   { background: #2ecc71; border-color: #2ecc71; box-shadow: 0 0 4px #2ecc71; }
    .work.off  { background: #e74c3c; border-color: #e74c3c; }
    /* Waiting for user input — pulses, because unlike the other two states it is a
       request: something is blocked until you go and answer it. */
    .work.wait { background: #f5c542; border-color: #f5c542; box-shadow: 0 0 5px #f5c542; animation: wt-wait 1.4s ease-in-out infinite; }
    @keyframes wt-wait { 50% { opacity: 0.35; } }

    /* ATTENTION FLASH: this window's stoplight dropped out of green while you were
       looking at some other window — it either ran out of work (red) or is prompting
       you (amber). The dot alone is a 8px change in the corner of your eye and is easy
       to miss for minutes; the whole tab flashing is not. It keeps flashing until
       you focus that window (SplitManager._markWorkAlerts owns that rule) — it is a
       "you missed something" signal, so it must not expire on its own.
       Colour says WHICH transition, matching the dot you'd have seen. */
    .tab.alert { animation: wt-flash 1.05s ease-in-out infinite; }
    .tab.alert-off  { --flash: #e74c3c; }
    .tab.alert-wait { --flash: #f5c542; }
    @keyframes wt-flash {
      50% {
        background: var(--flash);
        border-color: var(--flash);
        color: #10131f;
        box-shadow: 0 0 10px var(--flash);
      }
      0%, 100% { border-color: var(--flash); }
    }
    /* Reduced motion: keep the signal, drop the blinking — a solid ring in the same
       colour, which is still the loudest thing in the strip. */
    @media (prefers-reduced-motion: reduce) {
      .tab.alert {
        animation: none;
        border-color: var(--flash);
        box-shadow: 0 0 0 2px var(--flash);
      }
    }

    .tab {
      display: inline-flex;
      align-items: baseline;
      gap: 6px;
      flex: 0 0 auto;
      background: #1a1a2e;
      color: #ddd;
      border: 1px solid #0f3460;
      border-radius: 4px;
      padding: 6px 14px;
      font-size: 14px;
      cursor: pointer;
      white-space: nowrap;
      max-width: 340px;
      font-family: Menlo, Monaco, "Courier New", monospace;
      transition: all 0.15s;
    }
    .tab:hover { border-color: #4a9eff; color: #fff; }
    .tab.active { background: #e94560; border-color: #e94560; color: #fff; }
    /* Open in another region: it can't be moved HERE (two regions on one window would
       just mirror each other), so it reads as dimmed — but clicking jumps to the
       region that has it, which is the only useful thing left to do with it. */
    .tab.disabled { opacity: 0.5; }
    .tab.disabled:hover { border-color: #4a9eff; color: #fff; }
    .tab .sess { color: #4a9eff; font-size: 11px; opacity: 0.85; flex: 0 0 auto; }
    .tab.active .sess { color: #ffd7de; }
    /* The tab whose window the shared hover preview is currently showing. Dashed,
       not filled: the preview is transient and nothing has been committed yet, so it
       must not look like the selected tab. */
    .tab.previewing { border-style: dashed; border-color: #37d17a; color: #fff; }
    .tab .wname { overflow: hidden; text-overflow: ellipsis; }
    /* Per-tab remove-from-recents affordance: hidden until the tab is hovered. */
    .tab .close {
      display: none;
      flex: 0 0 auto;
      align-self: center;
      margin-left: 2px;
      width: 16px;
      height: 16px;
      line-height: 16px;
      text-align: center;
      border-radius: 3px;
      color: #aaa;
      font-size: 15px;
    }
    .tab:hover .close { display: inline-block; }
    .tab .close:hover { background: #e94560; color: #fff; }
    .sidebar-toggle {
      flex: 0 0 auto;
      background: #1a1a2e;
      color: #ccc;
      border: 1px solid #0f3460;
      border-radius: 6px;
      width: 32px;
      height: 32px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 16px;
    }
    .sidebar-toggle:hover { border-color: #e94560; color: #fff; }

    /* Toolbar action buttons (moved out of the sidebar): split-add, Exposé, scroll
       mode, keyboard shortcuts. Icon-only by default; the stateful scroll button
       adds .text for a small current-mode label. Grouped to the right, just left
       of the copy-mode pill. */
    .tbtn {
      flex: 0 0 auto;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
      height: 32px;
      box-sizing: border-box;
      padding: 0 9px;
      background: #1a1a2e;
      color: #ccc;
      border: 1px solid #0f3460;
      border-radius: 6px;
      cursor: pointer;
      font-size: 16px;
      white-space: nowrap;
    }
    .tbtn:hover { border-color: #4a9eff; color: #fff; }
    /* Drawn (SVG) icon rather than a glyph: strokes inherit the button's colour,
       so hover/pressed states keep working without per-icon rules. */
    .tbtn.icon { padding: 0 8px; }
    .tbtn.icon svg { display: block; }
    /* Stateful button (scroll mode): show a small text label beside the glyph. */
    .tbtn.text {
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.02em;
      color: #9fc4ff;
      font-family: Menlo, Monaco, "Courier New", monospace;
    }
    /* A thin divider separating the action group from the recent-tabs strip. */
    .tsep {
      flex: 0 0 auto;
      width: 1px;
      height: 22px;
      background: #0f3460;
      margin: 0 2px;
    }

    /* Action button in its pressed/open state (e.g. the save button while its
       dropdown is showing). */
    .tbtn.on { border-color: #4a9eff; color: #fff; background: #0f3460; }

    /* Save-buffer control: a normal .tbtn that toggles a dropdown anchored beneath
       it. The wrapper is the positioning context; a transparent full-screen
       backdrop closes the menu on an outside click. */
    .save-wrap { position: relative; flex: 0 0 auto; display: inline-flex; }
    .save-backdrop { position: fixed; inset: 0; z-index: 90; background: transparent; }
    .save-menu {
      position: absolute;
      top: calc(100% + 6px);
      left: 0;
      z-index: 95;
      min-width: 290px;
      box-sizing: border-box;
      padding: 8px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      background: #0b1020;
      border: 1px solid #4a9eff;
      border-radius: 8px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.55);
      font-family: Menlo, Monaco, "Courier New", monospace;
    }
    .save-item {
      display: flex;
      align-items: center;
      gap: 8px;
      background: #1a1a2e;
      color: #e8eefc;
      border: 1px solid #0f3460;
      border-radius: 6px;
      padding: 8px 10px;
      font-size: 13px;
      cursor: pointer;
      text-align: left;
    }
    .save-item:hover { border-color: #4a9eff; color: #fff; }
    .save-sep { height: 1px; background: #0f3460; }
    .save-label { color: #9fc4ff; font-size: 11px; letter-spacing: 0.02em; }
    .save-row { display: flex; gap: 6px; }
    .save-path {
      flex: 1 1 auto;
      min-width: 0;
      box-sizing: border-box;
      background: #05070f;
      color: #e8eefc;
      border: 1px solid #0f3460;
      border-radius: 6px;
      padding: 7px 9px;
      font-size: 12px;
      font-family: Menlo, Monaco, "Courier New", monospace;
    }
    .save-path:focus { outline: none; border-color: #4a9eff; }
    .save-go {
      flex: 0 0 auto;
      background: #e94560;
      color: #fff;
      border: 1px solid #e94560;
      border-radius: 6px;
      padding: 7px 14px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
    }
    .save-go:hover { background: #ff5c78; }
    /* Server-side saving has nowhere to write (see save-target.js's blocked
       case). The controls stay VISIBLE but dead: hiding them would leave the
       "Save on the machine tmux runs on" heading describing nothing, and the
       warning below explains why they're greyed. */
    .save-go[disabled], .save-path[disabled] {
      opacity: 0.4;
      cursor: not-allowed;
      background: #2a2f3f;
      border-color: #2a2f3f;
      color: #9aa3b8;
    }
    .save-go[disabled]:hover { background: #2a2f3f; }
    .save-hint { color: #6b7690; font-size: 10.5px; line-height: 1.4; white-space: pre-line; overflow-wrap: anywhere; }
    /* The destination is NOT what the label above the input implies (the pane's
       directory isn't visible here, or isn't writable). It has to look different,
       not merely read differently — this is the line that stops a save from
       failing in a way that looks like the user's mistake. */
    .save-hint.warn {
      color: #ffc9a3;
      background: #3a2a14;
      border: 1px solid #7a5a24;
      border-radius: 5px;
      padding: 6px 8px;
    }
    .save-status {
      font-size: 11.5px;
      padding: 6px 8px;
      border-radius: 5px;
      overflow-wrap: anywhere;
    }
    .save-status.saving { background: #14233f; color: #9fc4ff; }
    .save-status.ok { background: #103524; color: #6ee7a8; border: 1px solid #1f6b45; }
    .save-status.err { background: #3a1420; color: #ff9db0; border: 1px solid #7a2438; }

    /* Picture-in-Picture toggle (left of the sidebar toggle). Highlights when on.
       The ◳ glyph reads as an inset in the upper-right — the PiP's default corner. */
    .pip-toggle {
      flex: 0 0 auto;
      background: #1a1a2e;
      color: #ccc;
      border: 1px solid #0f3460;
      border-radius: 6px;
      width: 32px;
      height: 32px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 16px;
    }
    .pip-toggle:hover { border-color: #4a9eff; color: #fff; }
    .pip-toggle.on {
      background: #0f3460;
      border-color: #4a9eff;
      color: #fff;
    }

    /* Copy-mode status pill (second from the right). Shows the focused pane's mode
       and toggles it on click. Green-ish = NORMAL, amber = COPY. */
    .mode {
      flex: 0 0 auto;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      height: 32px;
      box-sizing: border-box;
      padding: 0 12px;
      border-radius: 6px;
      border: 1px solid #0f3460;
      background: #1a1a2e;
      color: #9fe3bd;
      cursor: pointer;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.04em;
      font-family: Menlo, Monaco, "Courier New", monospace;
      white-space: nowrap;
      transition: all 0.15s;
    }
    .mode:hover { border-color: #4a9eff; color: #fff; }
    .mode .mdot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #37d17a;
      box-shadow: 0 0 5px rgba(55, 209, 122, 0.7);
    }
    .mode.copy {
      background: #f0a742;
      border-color: #f0a742;
      color: #2a1902;
    }
    .mode.copy .mdot {
      background: #2a1902;
      box-shadow: none;
    }

    /* One dot per visible pane (only when >1). Green = the focused pane, red = the
       rest. Sits just left of the sidebar toggle. */
    .dots {
      flex: 0 0 auto;
      display: flex;
      align-items: center;
      gap: 5px;
      margin-right: 4px;
    }
    .dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: #e94560;              /* red — not the focused pane */
      box-shadow: 0 0 0 1px rgba(0,0,0,0.3) inset;
    }
    .dot.focused {
      background: #37d17a;              /* green — the focused pane */
      box-shadow: 0 0 6px rgba(55, 209, 122, 0.8);
    }
    /* tmux-activity spinner, far left. Advances one notch (45°) every time webtmux
       sends tmux a command, debounced — so it flicks when you switch/rename/capture
       and sits still when nothing is talking to tmux. A liveness tell you can read
       out of the corner of your eye; there is no other signal that the tmux side of
       the connection is actually doing anything. */
    .spin {
      flex: 0 0 auto;
      width: 20px;
      height: 20px;
      margin-right: 2px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #4a9eff;
      font-size: 15px;
      line-height: 1;
      opacity: 0.75;
      cursor: default;
      transition: transform 0.18s ease-out;
    }

    /* Build id on the far left — read it aloud, or click it to copy (revealing it
       copies it too; see toggleBuild). A button, not a label, because it does
       something. */
    .build {
      flex: 0 0 auto;
      color: #5a7;
      font-family: Menlo, Monaco, "Courier New", monospace;
      font-size: 12px;
      background: #1a1a2e;
      border: 1px solid #0f3460;
      border-radius: 4px;
      padding: 3px 7px;
      margin-right: 4px;
      white-space: nowrap;
      cursor: pointer;
    }
    .build:hover { border-color: #4a9eff; color: #8fe3b5; }

    /* The hover hint itself lives in tooltip.js (TIP_CSS, spliced in below the
       component's own rules) — the sidebar shows the same hint for the same
       stoplights, and a hint that appears after a different delay in each place
       reads as one of them being slow. position:fixed also escapes the .tabs
       overflow clip (the strip hides overflow-y), and the whole thing is driven
       imperatively so hovering a tab never re-renders the bar. */

    /* Recent-tab label-shape menu, anchored under the "Recent" label. */
    .label-wrap { position: relative; flex: 0 0 auto; display: inline-flex; }
    .label-backdrop { position: fixed; inset: 0; z-index: 90; background: transparent; }
    .label-menu {
      position: absolute;
      top: calc(100% + 6px);
      left: 0;
      z-index: 95;
      min-width: 230px;
      box-sizing: border-box;
      padding: 8px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      background: #0b1020;
      border: 1px solid #4a9eff;
      border-radius: 8px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.55);
      font-family: Menlo, Monaco, "Courier New", monospace;
    }
    .label-menu .mtitle { color: #9fc4ff; font-size: 11px; letter-spacing: 0.02em; }
    .label-menu .mitem {
      display: flex; align-items: center; gap: 8px;
      background: #1a1a2e; color: #e8eefc;
      border: 1px solid #0f3460; border-radius: 6px;
      padding: 7px 9px; font-size: 12.5px; cursor: pointer; text-align: left;
    }
    .label-menu .mitem:hover { border-color: #4a9eff; }
    .label-menu .mitem .mark { width: 12px; flex: 0 0 auto; color: #37d17a; }
    .label-menu .mprev {
      color: #6b7690; font-size: 11px; padding: 2px 2px 0;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
  `, TIP_CSS];

  constructor() {
    super();
    this.recent = [];
    this.collapsed = false;
    // Scroll-wheel mode mirror (moved here from the sidebar). Seeded from the same
    // shared 'renderer' pref the terminal reads, so the label is right on first paint.
    this.scrollMode = normalizeScroll(stateStore.section('renderer').scrollMode || '');
    this.copyMode = false; // focused pane in tmux copy/view mode (SplitManager sets)
    this.previewCount = 0;        // windows currently in the preview (SplitManager sets)
    this.previewHidden = false;   // preview tucked away (SplitManager sets)
    this.previewHasFocused = false; // focused window is in the preview (SplitManager sets)
    this.panes = [];       // [bool] per pane in order; true = focused. [] hides the dots.
    this.manager = null;   // SplitManager, set directly
    // Build id (git short-hash) served fresh by config.js from the RUNNING binary —
    // read it out loud to identify exactly which build is deployed.
    this.build = (typeof window !== 'undefined' && window.webtmux_build) || '?';
    this.built = (typeof window !== 'undefined' && window.webtmux_built) || '';
    // Build-id chip hidden by default (it's clutter for daily use); Ctrl+Alt+B
    // reveals it when you need to read the running build aloud. Persisted.
    this.showBuild = stateStore.section('toolbar').showBuild === true;
    this._applyLabelPrefs();
    // Re-apply shared prefs (scroll mode, build-chip visibility, recents label shape)
    // on any remote change — e.g. cycling scroll mode from a region sidebar, or
    // another client toggling.
    stateStore.subscribe(() => {
      this.scrollMode = normalizeScroll(stateStore.section('renderer').scrollMode || '');
      this.showBuild = stateStore.section('toolbar').showBuild === true;
      this._applyLabelPrefs();
      this.requestUpdate();
    });
    this._tip = new Tip(this);  // shared hover hint — see tooltip.js
    this.saveOpen = false;   // save dropdown open?
    this.saveStatus = null;  // transient save result banner (see properties)
    this.saveInfo = null;    // server's "where would this land?" answer
    this.previewWindow = ''; // window the shared hover preview is showing
    this.labelMenuOpen = false;
    this.dragKey = '';
    this.dropIndex = -1;
    this.activity = 0;
  }

  // Pull the recents label-shape prefs out of the shared store (they ride @wt_state,
  // so the strip looks the same in every browser on this tmux server).
  _applyLabelPrefs() {
    const t = stateStore.section('toolbar');
    this.showSession = t.recentShowSession === undefined
      ? LABEL_DEFAULTS.showSession : t.recentShowSession === true;
    this.trimName = t.recentTrimName === undefined
      ? LABEL_DEFAULTS.trimName : t.recentTrimName === true;
  }

  _setLabelPref(key, value) {
    if (key === 'showSession') this.showSession = value;
    else this.trimName = value;
    stateStore.patchSection('toolbar', {
      recentShowSession: this.showSession, recentTrimName: this.trimName,
    });
  }

  // The visible text of a recent tab under the current label prefs.
  _tabLabel(w) {
    const name = this.trimName ? trimWindowName(w.name) : (w.name || 'bash');
    return this.showSession ? `${w.session}: ${name}` : name;
  }

  // Advance the tmux-activity spinner one notch. Called (debounced) by the
  // SplitManager whenever a region sends tmux a command.
  tickActivity() {
    this.activity = (this.activity + 1) % 8;
  }

  // Show/hide the build-id chip (Ctrl+Alt+B, wired by the SplitManager). Persisted
  // so the choice survives a reload.
  //
  // Revealing it also COPIES the build id: the only reason to show this chip is to
  // report which build is running — into a bug report, a chat message, a commit
  // note — and every one of those ends in a paste. Reading seven characters off a
  // screen and retyping them is the one step a computer should be doing.
  toggleBuild() {
    this.showBuild = !this.showBuild;
    stateStore.patchSection('toolbar', { showBuild: this.showBuild });
    if (this.showBuild) this._copyBuild();
  }

  // Copy the build id and say so ON the chip. The confirmation matters more than
  // usual here: a clipboard write is invisible, and "did that work?" is exactly
  // the doubt that sends you back to reading the characters by hand. Uses the
  // shared hint (shown immediately, not after the hover delay) so the message
  // appears where the pointer already is, then clears itself.
  _copyBuild() {
    this.updateComplete.then(async () => {
      const el = this.renderRoot?.querySelector('.build');
      if (!el) return;
      const ok = await copyText(this.build);
      this._tip.show(el, ok
        ? `Copied build id "${this.build}" to the clipboard`
        : `Could not reach the clipboard — the build id is ${this.build}`);
      clearTimeout(this._buildTipTimer);
      this._buildTipTimer = setTimeout(() => this._tipLeave(), 1600);
    });
  }

  // Cycle the scroll-wheel mode (app -> buffer -> auto -> auto+) and apply it live
  // to the focused unit's terminal (which also persists it). This control used to
  // live in the sidebar; the manager wires `this.manager`.
  cycleScroll() {
    const i = SCROLL_ORDER.indexOf(normalizeScroll(this.scrollMode));
    const next = SCROLL_ORDER[(i + 1) % SCROLL_ORDER.length];
    this.scrollMode = next;
    const u = this.manager?.focusedUnit;
    if (u?.setScrollMode) u.setScrollMode(next);
    else stateStore.patchSection('renderer', { scrollMode: next });
  }

  // Toggle the save-buffer dropdown. On open, clear any stale result banner and
  // prefill the path input with a sensible default filename (focused + selected so
  // the user can type over it or edit it). Setting .value imperatively (not via the
  // template) means later re-renders — e.g. a status update — never clobber typing.
  _toggleSaveMenu() {
    this.saveOpen = !this.saveOpen;
    if (!this.saveOpen) return;
    this.saveStatus = null;
    // Ask where a relative path would actually land for THIS window. Dropped
    // first so a stale answer from another window can't be read as this one's;
    // the hint falls back to the general rule until the reply arrives.
    this.saveInfo = null;
    this.manager?.requestSaveInfo?.();
    const def = this.manager?.suggestedSaveName?.() || 'pane.txt';
    this.updateComplete.then(() => {
      const el = this.renderRoot?.querySelector('.save-path');
      if (el) { if (!el.value) el.value = def; el.focus(); el.select(); }
    });
  }

  // "Download to browser" — the original behavior; hands the browser a .txt.
  _saveToBrowser() {
    this._tipLeave();
    this.manager?.savePaneBuffer();
    this.saveOpen = false;
    this.saveStatus = null;
  }

  // The line under the path input: where a relative path will ACTUALLY land, per
  // the server's answer (save-target.js turns a SaveEnv into English). It is a
  // warning, styled as one, whenever that isn't the pane's own directory — the
  // whole point is that the mismatch is visible before the save, not after it.
  _saveHint() {
    const hint = saveHint(this.saveInfo);
    return html`<div class="save-hint ${hint.level}">${hint.text}</div>`;
  }

  // "Save on the machine tmux runs on" — send the typed path to the server. Keep
  // the menu open so the SplitManager's onSaveResult can show success/error here.
  _saveToPath() {
    const el = this.renderRoot?.querySelector('.save-path');
    const path = (el?.value || '').trim();
    if (!path) { this.saveStatus = { state: 'err', text: 'Enter a path' }; return; }
    this.manager?.savePaneBufferToPath(path);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    clearTimeout(this._buildTipTimer);
    this._tip.dispose();
    this.manager?.hover?.cancel();
  }

  // Thin wrappers over the shared hint controller (tooltip.js). Kept as methods
  // because the ~30 call sites in render() read better as _tipEnter/_tipLeave than
  // as reaching through a field, and because the sidebar shows the same hint for
  // the same stoplight — the delay and the look have to come from one place.
  _tipEnter(ev, text) { this._tip.enter(ev, text); }
  _tipLeave() { this._tip.leave(); }

  // ---- recents drag-reorder ----------------------------------------------------
  // The strip's order is deliberately stable (re-accessing a window never moves its
  // tab), which is what makes it a place you can build muscle memory — so it should
  // be arrangeable by hand. Horizontal INSERTION-GAP semantics, mirroring the
  // sidebar's vertical window reorder: a line shows the gap the tab will land in,
  // and the drop moves it there.

  // A stable identity for a tab. Not the window id alone: a window linked into two
  // sessions earns a tab per session, and they must be independently draggable.
  _key(w) { return `${w.session} ${w.id}`; }

  _onTabDragStart(e, w) {
    this.dragKey = this._key(w);
    this._tipLeave();
    this.manager?.hover?.cancel();     // a drag is a rearrangement, not a browse
    try {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', this.dragKey);
    } catch (_) {}
  }

  _onTabDragEnd() {
    this.dragKey = '';
    this.dropIndex = -1;
  }

  // Over the strip: the insertion gap is the first tab whose horizontal midpoint is
  // right of the pointer; past them all means "move to the end".
  _onStripDragOver(e) {
    if (!this.dragKey) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = 'move'; } catch (_) {}
    const idx = this._dropIndexAt(e.clientX);
    if (idx !== this.dropIndex) this.dropIndex = idx;
  }

  // Only clear the line when the pointer truly leaves the strip — dragleave also
  // fires when crossing between child tabs, where relatedTarget is still inside.
  _onStripDragLeave(e) {
    if (!e.currentTarget.contains(e.relatedTarget)) this.dropIndex = -1;
  }

  _onStripDrop(e) {
    e.preventDefault();
    // Prefer live drag state; fall back to the dataTransfer payload so a stray
    // re-render that cleared dragKey can never eat the drop.
    const key = this.dragKey || this._dtKey(e);
    const gap = this.dropIndex >= 0 ? this.dropIndex : this._dropIndexAt(e.clientX);
    this._onTabDragEnd();
    if (!key) return;
    const entry = this.recent.find((w) => this._key(w) === key);
    if (entry) this.manager?.reorderRecent(entry, gap);
  }

  _dropIndexAt(x) {
    const tabs = [...(this.renderRoot?.querySelectorAll('.rtab') || [])];
    for (let i = 0; i < tabs.length; i++) {
      const r = tabs[i].getBoundingClientRect();
      if (x < r.left + r.width / 2) return i;
    }
    return tabs.length;
  }

  _dtKey(e) {
    try { return e.dataTransfer.getData('text/plain') || ''; } catch (_) { return ''; }
  }

  // ---- recents label-shape menu ------------------------------------------------
  // Hung off the "Recent" label itself rather than adding another toolbar button:
  // it's a rarely-touched display preference, and the label is exactly the thing it
  // is about.
  _labelMenu() {
    const sample = this.recent[0] || { session: 'services', name: 'claude Dominion', index: 3 };
    const shape = (showSession, trimName) => {
      const name = trimName ? trimWindowName(sample.name) : (sample.name || 'bash');
      return showSession ? `${sample.session}: ${name}` : name;
    };
    return html`
      <div class="label-backdrop" @click=${() => { this.labelMenuOpen = false; }}></div>
      <div class="label-menu" @click=${(e) => e.stopPropagation()}>
        <div class="mtitle">Recent tab labels</div>
        <button class="mitem" @click=${() => this._setLabelPref('showSession', !this.showSession)}>
          <span class="mark">${this.showSession ? '✓' : ''}</span>Show session
        </button>
        <button class="mitem" @click=${() => this._setLabelPref('trimName', !this.trimName)}>
          <span class="mark">${this.trimName ? '✓' : ''}</span>Trim name to after first space
        </button>
        <div class="mprev">now: ${shape(this.showSession, this.trimName)}</div>
      </div>
    `;
  }

  // Flash classes for an unacknowledged drop out of green (entry.alert holds the
  // value it dropped to; see SplitManager._markWorkAlerts). Reuses workClass so
  // the flash colour can never drift from the dot's.
  _alertClass(alert) {
    return alert ? `alert alert-${workClass(alert)}` : '';
  }

  // The line the tooltip adds while a tab is flashing — it has to answer both
  // "why is this blinking" and "how do I make it stop".
  _alertTip(alert) {
    if (!alert) return '';
    const what = alert === '2' ? 'is prompting you' : 'ran out of work';
    return `\n● It ${what} since you last looked — flashes until you switch to it`;
  }

  render() {
    return html`
      <span
        class="spin"
        style="transform: rotate(${this.activity * 45}deg)"
        aria-hidden="true"
        @mouseenter=${(e) => this._tipEnter(e, 'tmux activity — advances one notch each time webtmux sends tmux a command (window switches, renames, captures, saved state).')}
        @mouseleave=${() => this._tipLeave()}
      >✳</span>
      ${this.showBuild ? html`
        <button
          class="build"
          aria-label="webtmux build ${this.build} — click to copy"
          @mouseenter=${(e) => this._tipEnter(e, `webtmux build ${this.build}${this.built ? ' — built ' + this.built : ''}\nClick to copy it (it is also copied whenever you reveal this chip). Hide with ${chord('B')}.`)}
          @mouseleave=${() => this._tipLeave()}
          @click=${() => this._copyBuild()}
        >⬢ ${this.build}</button>
      ` : ''}
      <button
        class="tbtn"
        aria-label="Keyboard shortcuts"
        @mouseenter=${(e) => this._tipEnter(e, `Keyboard shortcuts. Shortcut: ${chord('/')}`)}
        @mouseleave=${() => this._tipLeave()}
        @click=${() => { this._tipLeave(); this.manager?.shortcuts?.toggle(); }}
      >⌨</button>
      ${this.recent.length ? html`
        <span class="label-wrap">
          <button
            class="label"
            aria-label="Recent tab label options"
            @mouseenter=${(e) => this._tipEnter(e, 'Recent windows — click for label options (show the session, trim the window name). Drag tabs to reorder them.')}
            @mouseleave=${() => this._tipLeave()}
            @click=${() => { this._tipLeave(); this.labelMenuOpen = !this.labelMenuOpen; }}
          >Recent ▾</button>
          ${this.labelMenuOpen ? this._labelMenu() : ''}
        </span>
      ` : ''}
      <div
        class="tabs"
        @dragover=${(e) => this._onStripDragOver(e)}
        @dragleave=${(e) => this._onStripDragLeave(e)}
        @drop=${(e) => this._onStripDrop(e)}
      >
        ${this.recent.map((w, i) => {
          const key = this._key(w);
          const full = `${w.session} — window ${w.index}: ${w.name}`;
          // A window shown in ANOTHER region can't be moved here (two regions on one
          // window would just mirror each other) — but it can be JUMPED to, which is
          // what clicking now does. Hovering it shows nothing new for the same reason:
          // it's already on screen.
          const tip = (w.disabled
            ? `${full}\nAlready open in another region — click to jump there · drag to reorder`
            : `${full}\nHover to preview it in a terminal region · click to switch there · drag to reorder`)
            + this._alertTip(w.alert);
          const last = i === this.recent.length - 1;
          return html`
          <span
            class="rtab ${this.dragKey === key ? 'dragging' : ''} ${this.dragKey && this.dropIndex === i ? 'drop-before' : ''} ${this.dragKey && last && this.dropIndex === this.recent.length ? 'drop-end' : ''}"
            draggable="true"
            @dragstart=${(e) => this._onTabDragStart(e, w)}
            @dragend=${() => this._onTabDragEnd()}
            @mouseenter=${(e) => { this._tipEnter(e, tip); this.manager?.hover?.enter(w.id, w.session); }}
            @mouseleave=${() => { this._tipLeave(); this.manager?.hover?.leave(); }}
          ><span
            class="work ${workClass(w.working)}"
            role="img"
            aria-label=${workLabel(w.working)}
            @mouseenter=${(e) => { e.stopPropagation(); this._tipEnter(e, workTip(w.working)); }}
            @mouseleave=${(e) => { e.stopPropagation(); this._tipEnter({ currentTarget: e.currentTarget.closest('.rtab') }, tip); }}
          ></span><button
            class="tab ${w.active ? 'active' : ''} ${w.disabled ? 'disabled' : ''} ${!w.active && this.previewWindow === w.id ? 'previewing' : ''} ${this._alertClass(w.alert)}"
            aria-label=${full}
            @click=${() => { this._tipLeave(); this.manager?.pickRecentWindow(w); }}
          ><span class="sess">${w.index}</span><span class="wname">${this._tabLabel(w)}</span><span
              class="close"
              aria-label="Remove from Recent (does not close the window)"
              @mouseenter=${(e) => { e.stopPropagation(); this._tipEnter(e, 'Remove this tab from Recent — the window keeps running (this does not close or kill it)'); }}
              @mouseleave=${(e) => { e.stopPropagation(); this._tipEnter({ currentTarget: e.currentTarget.closest('.tab') }, tip); }}
              @click=${(e) => { e.stopPropagation(); this._tipLeave(); this.manager?.removeRecent(w); }}
            >×</span></button></span>
        `;})}
      </div>
      <div class="wt-tip"></div>
      <span class="tsep"></span>
      <button
        class="tbtn"
        aria-label="Split view — add a terminal region"
        @mouseenter=${(e) => this._tipEnter(e, `Split view — add another terminal region. Shortcut: ${chord('⏎ Enter')}`)}
        @mouseleave=${() => this._tipLeave()}
        @click=${() => { this._tipLeave(); this.manager?.splitAdd(); }}
      >⊞</button>
      <button
        class="tbtn icon"
        aria-label="Exposé — all windows"
        @mouseenter=${(e) => this._tipEnter(e, EXPOSE_TIP)}
        @mouseleave=${() => this._tipLeave()}
        @click=${() => { this._tipLeave(); this.manager?.expose?.toggle(); }}
      >${exposeIcon()}</button>
      <div class="save-wrap">
        <button
          class="tbtn ${this.saveOpen ? 'on' : ''}"
          aria-label="Save pane buffer"
          @mouseenter=${(e) => this._tipEnter(e, `Save the focused pane's buffer — download to your browser, or write it to a file on the machine tmux runs on.`)}
          @mouseleave=${() => this._tipLeave()}
          @click=${() => { this._tipLeave(); this._toggleSaveMenu(); }}
        >⤓</button>
        ${this.saveOpen ? html`
          <div class="save-backdrop" @click=${() => { this.saveOpen = false; this.saveStatus = null; }}></div>
          <div class="save-menu" @click=${(e) => e.stopPropagation()}>
            <button class="save-item" @click=${() => this._saveToBrowser()}>⤓&nbsp; Download to browser</button>
            <div class="save-sep"></div>
            <div class="save-label">Save on the machine tmux runs on</div>
            <div class="save-row">
              <input
                class="save-path"
                type="text"
                spellcheck="false"
                autocomplete="off"
                ?disabled=${this.saveInfo?.blocked === true}
                placeholder=${this.saveInfo?.blocked ? 'unavailable here' : '~/out.txt or ./out.txt'}
                @keydown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); this._saveToPath(); } e.stopPropagation(); }}
              >
              <button class="save-go" ?disabled=${this.saveInfo?.blocked === true} @click=${() => this._saveToPath()}>Save</button>
            </div>
            ${this._saveHint()}
            ${this.saveStatus ? html`<div class="save-status ${this.saveStatus.state}">${this.saveStatus.text}</div>` : ''}
          </div>
        ` : ''}
      </div>
      <button
        class="tbtn text"
        aria-label="Scroll-wheel mode"
        @mouseenter=${(e) => this._tipEnter(e, scrollTooltip(normalizeScroll(this.scrollMode)))}
        @mouseleave=${() => this._tipLeave()}
        @click=${() => { this._tipLeave(); this.cycleScroll(); }}
      >${(SCROLL_META[normalizeScroll(this.scrollMode)] || SCROLL_META['adaptive-probe']).label}</button>
      ${this.panes.length > 1 ? html`
        <div
          class="dots"
          @mouseenter=${(e) => this._tipEnter(e, `Split panes — one dot per open terminal region (${this.panes.length} open); green is the focused pane. Drag a divider to resize. ${chord('X')} closes the focused region — but the first (leftmost) pane is the original and can't be closed; only added panes can.`)}
          @mouseleave=${() => this._tipLeave()}
        >
          ${this.panes.map((focused) => html`<span class="dot ${focused ? 'focused' : ''}"></span>`)}
        </div>
      ` : ''}
      <button
        class="mode ${this.copyMode ? 'copy' : ''}"
        aria-label="Copy mode"
        @mouseenter=${(e) => this._tipEnter(e, `Focused pane is in ${this.copyMode ? 'COPY (scrollback)' : 'NORMAL (input)'} mode — click to ${this.copyMode ? 'exit' : 'enter'} copy mode. Shortcut: ${chord('[')} (tmux ⌃b [)`)}
        @mouseleave=${() => this._tipLeave()}
        @click=${() => { this._tipLeave(); this.manager?.toggleCopyMode(); }}
      ><span class="mdot"></span>${this.copyMode ? 'COPY' : 'NORMAL'}</button>
      <button
        class="pip-toggle ${this.previewHasFocused ? 'on' : ''}"
        aria-label="Add focused window to preview"
        @mouseenter=${(e) => this._tipEnter(e, `${this.previewHasFocused ? 'Remove the focused window from' : 'Add the focused window to'} the live preview (${chord('I')}). One window shows as a corner box; a second turns it into a docked edge bar.${this.previewCount ? ` ${this.previewCount} window${this.previewCount === 1 ? '' : 's'} in preview.` : ''}`)}
        @mouseleave=${() => this._tipLeave()}
        @click=${() => { this._tipLeave(); this.manager?.toggleFocusedInPreview(); }}
      >◳</button>
      ${this.previewCount ? html`
        <button
          class="pip-toggle ${this.previewHidden ? '' : 'on'}"
          aria-label="Show or hide the preview"
          @mouseenter=${(e) => this._tipEnter(e, `${this.previewHidden ? 'Show' : 'Hide'} the preview (keeps its ${this.previewCount} window${this.previewCount === 1 ? '' : 's'}).`)}
          @mouseleave=${() => this._tipLeave()}
          @click=${() => { this._tipLeave(); this.manager?.togglePreviewHidden(); }}
        >${this.previewHidden ? '🙈' : '👁'}</button>
      ` : ''}
      <button
        class="sidebar-toggle"
        aria-label="Toggle sidebar"
        @mouseenter=${(e) => this._tipEnter(e, `Toggle the windows & sessions sidebar. Shortcut: ${chord('W')}`)}
        @mouseleave=${() => this._tipLeave()}
        @click=${() => { this._tipLeave(); this.manager?.sidebar?.toggleCollapsed(); }}
      >${this.collapsed ? '☰' : '✕'}</button>
    `;
  }
}

customElements.define('webtmux-toolbar', WebtmuxToolbar);
