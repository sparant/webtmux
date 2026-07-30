// Top toolbar: a most-recently-accessed window strip on the LEFT and the sidebar
// toggle on the RIGHT. The SplitManager owns the data — it sets `recent`
// (up to `recentMax` {id,index,name,active,working,alert}) and `collapsed`, and
// handles clicks via `manager.pickRecentWindow(id)` /
// `manager.sidebar.toggleCollapsed()`.
//
// The strip ends in an OVERFLOW ARROW (`overflowAlerts`, also from the SplitManager):
// the windows that need attention and have no tab here, because a bounded strip
// cannot promise to hold every window that stops. Without it, "nothing in the strip is
// flashing" quietly meant "nothing in the few windows I happen to be keeping tabs on
// is flashing" — which is not a thing anyone can act on. Raising the tab count (the
// "Recent ▾" menu) shrinks that gap but never closes it; the arrow is what makes the
// remainder honest.
//
// Hovering a recent tab does NOT pop a thumbnail here any more: it asks the shared
// HoverPreview to show that window in a real terminal region (see hover-preview.js),
// which is bigger, in place, and the same behavior every other switcher now has.
import { LitElement, html, css, svg } from 'lit';
import { chord, IS_MAC } from '../os.js';
import { stateStore } from '../state-store.js';
import { workClass, workLabel, workTip } from '../stoplight.js';
import { ALERT_CSS, alertClass, alertTip } from '../alert-flash.js';
import { Tip, TIP_CSS } from '../tooltip.js';
import { saveHint } from '../save-target.js';
import { READ_ONLY_NOTICE } from '../write-guard.js';
import { copyText } from '../clipboard.js';
import { SCROLL_MODES as SCROLL_ORDER, normalizeScrollMode as normalizeScroll } from '../terminal-unit.js';
import { MOUSE_MODES as MOUSE_ORDER, normalizeMouseMode as normalizeMouse } from '../mouse-mode.js';
import { clampRecentsMax, RECENTS_MIN, RECENTS_MAX } from '../recents-strip.js';

// Recent-tab label shape. Two INDEPENDENT toggles rather than one four-way cycle,
// because they answer unrelated questions: "which session is this in" and "how much
// of the name do I need". Defaults are the quiet ones — most windows live in the
// session you're already in, and long names are usually "<tool> <what>", where the
// leading word is the part you already know.
const LABEL_DEFAULTS = { showSession: false, trimName: true };

// Drop everything up to and including the first space: "ssh web-01" reads
// as "web-01". A name with no space is left alone (there's nothing redundant
// to remove), and a name that is ALL prefix ("ssh ") keeps the original rather
// than collapsing to nothing.
function trimWindowName(name) {
  const s = String(name || '');
  const i = s.indexOf(' ');
  if (i < 0) return s;
  const tail = s.slice(i + 1).trim();
  return tail || s;
}

// Scroll-wheel modes, in the order the toolbar cycles them — the one list
// terminal-unit.js owns. `name` is the short form the closed mouse button and the
// dropdown rows show; `hint` is the sentence beside it. (This control moved here from
// the sidebar, and then from a button of its own into the mouse-capture dropdown.)
const SCROLL_META = {
  'app':            { name: 'app',   hint: 'wheel always goes to the program (Claude/vim/less scroll themselves)' },
  'buffer':         { name: 'buf',   hint: 'wheel always scrolls tmux history (copy-mode)' },
  'adaptive-mode':  { name: 'auto',  hint: 'mouse-tracking / full-screen apps get the wheel; a plain shell scrolls history' },
  'adaptive-probe': { name: 'auto+', hint: 'like auto, but probes the ambiguous case — tries the app, then scrolls history if it did not react' },
};

// Mouse click/drag modes — the same four-way question asked about the OTHER
// gesture: who gets a button press, the program or a text selection. See
// mouse-mode.js for what each one does.
//
// This used to need a distinguishing label ('sel app' next to '🖱 app') because the
// two axes were two adjacent buttons and nothing on either said which gesture it
// governed. Now they are two titled groups in one dropdown, so the group heading does
// that job and the mode keeps only its bare name.
const MOUSE_META = {
  'app':            { name: 'app',   hint: 'every click and drag goes to the program; dragging never selects' },
  'buffer':         { name: 'buf',   hint: 'every click and drag selects text; the program sees no mouse at all' },
  'adaptive-mode':  { name: 'auto',  hint: 'a program that asked for the mouse (Claude/vim/htop) gets it; anywhere else, dragging selects' },
  'adaptive-probe': { name: 'auto+', hint: 'clicks still reach the program, but click-and-DRAG selects text — no entering copy mode first' },
};

// The closed button has to answer "what am I in?" without a click, so it shows both
// current modes by their short names. A metaMap lookup that can't fail: an unknown
// stored mode falls back to the default rather than rendering `undefined`.
const modeName = (metaMap, cur) => (metaMap[cur] || metaMap['adaptive-probe']).name;

// Hovering the closed button explains BOTH axes — which is the one thing the two
// separate buttons could do that a single closed button cannot, so it is kept.
const mouseCaptureTooltip = (mouseCur, scrollCur) => [
  'Mouse capture — who gets your gestures, the program or webtmux.',
  'Click for both lists.',
  '',
  'click+drag:',
  ...MOUSE_ORDER.map((m) => `${m === mouseCur ? '▸' : ' '} ${MOUSE_META[m].name} — ${MOUSE_META[m].hint}`),
  '',
  'copymode on scroll:',
  ...SCROLL_ORDER.map((m) => `${m === scrollCur ? '▸' : ' '} ${SCROLL_META[m].name} — ${SCROLL_META[m].hint}`),
].join('\n');

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

// The overflow arrow's glyph: "there is more, that way". Drawn rather than typed for
// the same reason the Exposé icon is — a font without a usable ➜ would silently ship
// a tofu box on the one control whose entire job is to be noticed. A solid shaft into
// a filled head, so it still reads as an arrow at 14px and while flashing.
function overflowIcon() {
  return html`
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path d="M1.5 8h9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"></path>
      <path d="M9.5 3.4 14.6 8l-5.1 4.6z" fill="currentColor"></path>
    </svg>
  `;
}

// The tmux-activity spinner, drawn rather than typed — for the third time in this
// file, and this one had already shipped broken. It was the character ✳ (U+2733),
// which has emoji presentation: Chromium renders it from the color-emoji font, and a
// color-emoji glyph ignores `color` completely. The spinner had been painting itself
// green-on-navy for as long as it has existed, and NOTHING that recolors it — least
// of all the red "we lost tmux" state below — could ever have been visible.
//
// The same glyph also hid the rotation, and the reason is geometry, not fonts: an
// eight-spoke star is SYMMETRIC UNDER 45°, so a 45° notch maps it exactly onto
// itself. Every step this control has ever taken has been a no-op on screen.
//
// Hence SPIN_STEP_DEG = 22.5 — exactly half the symmetry period, which is the most
// distinguishable step a shape with 45° symmetry admits. The star simply alternates
// between spokes-on-the-axes and spokes-on-the-diagonals, which is unmistakable at
// 22px. The first fix instead tried a graded-opacity "bright spoke" to mark the
// heading; that works in principle but not at this size, and it only reads at all if
// the tail is dimmed to the point where the icon looks half-missing against the navy
// bar. Uniform spokes are both maximally visible AND legibly stepped, so there is
// nothing left to trade off.
//
// Geometry, in viewBox units on a 20x20 box centred at (10,10). The outer radius is
// capped so the round cap still fits: an <svg> clips at its viewport, so
// SPIN_OUTER + SPIN_WIDTH/2 must stay under 10 or the spoke tips get shaved off.
const SPIN_INNER = 3.4;
const SPIN_OUTER = 8.3;
const SPIN_WIDTH = 3.1;
export const SPIN_STEP_DEG = 22.5;

const SPIN_SPOKES = Array.from({ length: 8 }, (_, i) => {
  const a = (i * Math.PI) / 4;
  const sin = Math.sin(a), cos = Math.cos(a);
  return {
    x1: (10 + SPIN_INNER * sin).toFixed(2), y1: (10 - SPIN_INNER * cos).toFixed(2),
    x2: (10 + SPIN_OUTER * sin).toFixed(2), y2: (10 - SPIN_OUTER * cos).toFixed(2),
  };
});

// The spokes are interpolated with lit's `svg` tag, NOT `html`. A nested html``
// template is parsed as an HTML fragment even when it lands inside an <svg>, so its
// <line>s are created in the XHTML namespace and the browser draws exactly nothing —
// no error, no warning, an empty 20x20 box that looks like the icon was never wired
// up. (The other two icons in this file get away with plain html`` because their
// shapes are literal children of one <svg> the HTML parser handles as foreign
// content; only INTERPOLATED children need this.)
function spinIcon() {
  return html`
    <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" focusable="false">
      <g stroke="currentColor" stroke-width=${SPIN_WIDTH} stroke-linecap="round">
        ${SPIN_SPOKES.map((s) => svg`
          <line x1=${s.x1} y1=${s.y1} x2=${s.x2} y2=${s.y2}></line>
        `)}
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
    // Current mouse click/drag mode (mirror of the focused unit's setting).
    // Cycled by the toolbar's selection button; one of MOUSE_ORDER.
    mouseMode: { type: String },
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
    // This webtmux was started without `-w` (see write-guard.js). Reflected to a
    // `readonly` attribute so :host([readonly]) can grey out the controls that
    // would change tmux, and rendered as a badge — a viewer who is told is not a
    // viewer hunting for the click that works.
    readOnly: { type: Boolean, reflect: true, attribute: 'readonly' },
    // One transient line of explanation (read-only refusals, and the controller's
    // "refuse, don't guess" errors). '' = nothing to say. Set by the SplitManager.
    notice: { type: String },
    // Where a save would land, as the server describes it (a SaveEnv; see
    // webtty/savepath.go). Requested when the dropdown opens and rendered as its
    // hint line, so an invisible pane directory is disclosed before a failed save
    // rather than after one. Null until the answer arrives.
    saveInfo: { type: Object },
    // The window the shared HoverPreview is currently showing ('' = none). Marks
    // which tab the preview on screen belongs to. Set by the SplitManager.
    previewWindow: { type: String },
    // Whether the mouse-capture dropdown is open (the two gesture modes live in it).
    mouseMenuOpen: { type: Boolean },
    // Recent-tab label shape (see LABEL_DEFAULTS) + whether its little menu is open.
    showSession: { type: Boolean },
    trimName: { type: Boolean },
    labelMenuOpen: { type: Boolean },
    // How many tabs the strip holds. Mirrors the shared toolbar.recentMax pref; the
    // SplitManager is what actually enforces it (see setRecentsMax).
    recentMax: { type: Number },
    // Recents drag-reorder: the tab being dragged, and the insertion GAP the drop
    // would land in (0..n, -1 = not over the strip).
    dragKey: { type: String },
    dropIndex: { type: Number },
    // tmux-activity spinner position, in increments (rendered as rotation).
    activity: { type: Number },
    // The spinner's OTHER job: red when a region has lost tmux, with how many regions
    // are down each way — closed socket vs open-but-mute (see
    // SplitManager._refreshConnection and TerminalUnit's heartbeat).
    disconnected: { type: Boolean },
    lostRegions: { type: Number },
    stalledRegions: { type: Number },
    // Flashing windows with no tab of their own — see the overflow arrow below.
    // [{id, session, index, name, alert}], most recently raised first.
    overflowAlerts: { type: Array },
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

    /* The attention flash itself (.wt-alert and friends) is spliced in from
       alert-flash.js — the sidebar rows and the preview tiles flash for the same
       windows, and a signal that pulses differently in each place stops reading as
       one signal. Colour says WHICH transition, matching the dot you'd have seen. */

    /* OVERFLOW ARROW: the strip holds a bounded number of tabs, and the windows that
       need you do not care about that. When a window drops out of green with no tab, no preview tile
       and no region of its own, this arrow appears at the end of the strip and flashes
       in its place — so "nothing is flashing" can be trusted to mean "nothing needs
       you", which is the only thing that makes the flashes worth watching at all.
       Reuses .tbtn's shape (it is an action, not a tab) with the count beside it.

       It sits just PAST .tabs rather than inside it. The strip scrolls horizontally
       once the tabs outgrow the bar, and a warning that can scroll out of sight is
       not a warning — this is the one control in here that has to be on screen
       whenever it exists. */
    .oflow {
      flex: 0 0 auto;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      height: 28px;
      box-sizing: border-box;
      padding: 0 8px;
      margin-left: 2px;
      background: #1a1a2e;
      color: #ddd;
      border: 1px solid #0f3460;
      border-radius: 4px;
      cursor: pointer;
      font-family: Menlo, Monaco, "Courier New", monospace;
      font-size: 12px;
      white-space: nowrap;
    }
    .oflow:hover { border-color: #4a9eff; color: #fff; }
    .oflow svg { display: block; }
    .oflow .n { font-weight: 600; letter-spacing: 0.02em; }

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
    /* The settled answer to "which directory?", kept in view (and correctable)
       rather than hidden once given — it is a claim about this deployment, and a
       wrong one is exactly what makes files land where nobody looks. */
    .save-dir-note {
      display: flex; align-items: center; gap: 8px;
      color: #9fc4ff; font-size: 11.5px;
    }
    .save-dir-note b { color: #e8eefc; font-weight: 600; overflow-wrap: anywhere; }
    .save-dir-change {
      margin-left: auto; flex: 0 0 auto;
      background: none; border: none; padding: 2px 4px;
      color: #6b7690; font-size: 11px; font-family: inherit;
      text-decoration: underline; cursor: pointer;
    }
    .save-dir-change:hover { color: #9fc4ff; }
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
    /* "The file is already there" is the one save error the user can answer in
       place, so it gets a button rather than just a sentence. */
    .save-status.confirm { background: #33260f; color: #f2c774; border: 1px solid #7a5a24; }
    .save-confirm { display: flex; gap: 6px; margin-top: 6px; }
    .save-confirm button {
      background: #7a2438;
      color: #fff;
      border: 1px solid #a33;
      border-radius: 5px;
      padding: 4px 10px;
      font-size: 11px;
      cursor: pointer;
    }
    .save-confirm button.cancel { background: #2a2f3f; color: #ccc; border-color: #0f3460; }

    /* ---- read-only mode (server started without -w) ------------------------
       Two visible effects. The badge SAYS so, once, next to the build chip; the
       rules below grey out every control that would change tmux — the recent-tab
       switcher (a select-window moves the shared console), copy mode, and the
       whole "save on the machine tmux runs on" half of the save dropdown. The
       controls that only rearrange this browser (split, Exposé, preview, mouse
       mode, sidebar toggle) stay live: read-only is about tmux, not about the UI. */
    .ro-badge {
      flex: 0 0 auto;
      background: #33260f;
      color: #f2c774;
      border: 1px solid #7a5a24;
      border-radius: 5px;
      padding: 3px 7px;
      font-size: 10.5px;
      letter-spacing: 0.04em;
      cursor: default;
    }
    :host([readonly]) .tabs,
    :host([readonly]) .mode { opacity: 0.45; pointer-events: none; }
    :host([readonly]) .save-ro { color: #f2c774; font-size: 11px; line-height: 1.4; }
    /* The transient explanation line (read-only refusals, controller refusals).
       Sits in the bar itself so it is visible wherever the click happened. */
    .notice {
      flex: 1 1 auto;
      min-width: 0;
      background: #33260f;
      color: #f2c774;
      border: 1px solid #7a5a24;
      border-radius: 5px;
      padding: 3px 8px;
      font-size: 11px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

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
    /* tmux-activity spinner, far left. Advances one notch (SPIN_STEP_DEG) every time
       webtmux sends tmux a command, debounced — so it flicks when you switch/rename/capture
       and sits still when nothing is talking to tmux. A liveness tell you can read
       out of the corner of your eye; there is no other signal that the tmux side of
       the connection is actually doing anything. */
    /* It has to be READABLE at a glance, which the first drawn version was not: 15px
       of thin, 75%-faded stroke in a mid blue disappeared into the navy bar. It is
       full-size, full-opacity and a brighter blue now — the whole point of this
       control is to be caught out of the corner of your eye, and one that has to be
       hunted for is telling you nothing. */
    .spin {
      flex: 0 0 auto;
      width: 22px;
      height: 22px;
      margin-right: 3px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #6cb6ff;
      line-height: 1;
      cursor: default;
      transition: transform 0.18s ease-out;
    }
    .spin svg { display: block; }
    /* …and the same spinner in red when the socket to tmux is gone. It PULSES rather
       than sitting still: a stopped spinner is exactly what an idle one looks like,
       and this state is a request (go and look), not a report. Red matches the
       stoplight vocabulary's "not working", which is precisely what tmux is doing. */
    .spin.lost {
      color: #ff5470;
      /* drop-shadow, not text-shadow: the spinner is drawn (see spinIcon) and a text
         shadow would have nothing to attach to. */
      filter: drop-shadow(0 0 5px rgba(255, 84, 112, 0.85));
      animation: wt-lost 1.2s ease-in-out infinite;
    }
    /* The pulse dips, it does not blink out: at 0.25 the icon spent half its cycle
       invisible, which is a worse tell than not pulsing at all. */
    @keyframes wt-lost { 50% { opacity: 0.5; } }

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
    /* Strip-size stepper. A −/number/+ row rather than a set of preset buttons:
       the useful value is "as many as fit on MY toolbar", which is a number nobody
       else can guess, and stepping to it while watching the strip resize live is the
       only way to find it. */
    .label-menu .msize {
      display: flex; align-items: center; gap: 8px;
      background: #1a1a2e; border: 1px solid #0f3460; border-radius: 6px;
      padding: 5px 9px; font-size: 12.5px; color: #e8eefc;
    }
    .label-menu .msize .mlabel { flex: 1 1 auto; }
    .label-menu .msize .mstep {
      flex: 0 0 auto; width: 22px; height: 22px; line-height: 1;
      background: #0b1020; color: #e8eefc;
      border: 1px solid #0f3460; border-radius: 4px;
      font-family: inherit; font-size: 14px; cursor: pointer;
    }
    .label-menu .msize .mstep:hover:not([disabled]) { border-color: #4a9eff; color: #fff; }
    .label-menu .msize .mstep[disabled] { opacity: 0.3; cursor: default; }
    .label-menu .msize .mnum {
      flex: 0 0 auto; min-width: 18px; text-align: center;
      font-variant-numeric: tabular-nums; font-weight: 600; color: #9fc4ff;
    }

    /* Mouse-capture dropdown. Reuses .label-menu wholesale — it is the same kind of
       object (a small settings menu hung off a toolbar control) and two menus that
       looked subtly different would read as two mechanisms. Only three things differ:
       it opens from the RIGHT edge (the button sits near the end of the toolbar, so
       left-aligning would push it off screen), it is wider because every row carries a
       sentence, and its rows stack name-over-hint instead of being one line. */
    .mouse-wrap { position: relative; flex: 0 0 auto; display: inline-flex; }
    .mouse-menu { left: auto; right: 0; min-width: 330px; }
    .mouse-menu .mitem { align-items: flex-start; }
    .mouse-menu .mitem .mark { margin-top: 2px; }
    .mouse-menu .mtext { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .mouse-menu .mtext b { font-weight: 600; color: #e8eefc; }
    .mouse-menu .mhint {
      color: #8b96b4; font-size: 11px; line-height: 1.35;
      white-space: normal;                /* the hints are sentences, so let them wrap */
    }
  `, ALERT_CSS, TIP_CSS];

  constructor() {
    super();
    this.recent = [];
    this.collapsed = false;
    // Scroll-wheel mode mirror (moved here from the sidebar). Seeded from the same
    // shared 'renderer' pref the terminal reads, so the label is right on first paint.
    this.scrollMode = normalizeScroll(stateStore.section('renderer').scrollMode || '');
    this.mouseMode = normalizeMouse(stateStore.section('renderer').mouseMode || '');
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
    // Re-apply shared prefs (scroll + mouse mode, build-chip visibility, recents
    // label shape) on any remote change — e.g. cycling a mode from another split
    // region, or another client toggling.
    stateStore.subscribe(() => {
      this.scrollMode = normalizeScroll(stateStore.section('renderer').scrollMode || '');
      this.mouseMode = normalizeMouse(stateStore.section('renderer').mouseMode || '');
      this.showBuild = stateStore.section('toolbar').showBuild === true;
      this._applyLabelPrefs();
      this.requestUpdate();
    });
    this._tip = new Tip(this);  // shared hover hint — see tooltip.js
    this.mouseMenuOpen = false;  // mouse-capture dropdown open?
    this.saveOpen = false;   // save dropdown open?
    this.saveStatus = null;  // transient save result banner (see properties)
    this.saveInfo = null;    // server's "where would this land?" answer
    this._editingDir = false; // save-directory row open for editing (see _saveDirRow)
    this.readOnly = false;   // set from the connect handshake (see write-guard.js)
    this.notice = '';        // transient explanation line
    this.previewWindow = ''; // window the shared hover preview is showing
    this.labelMenuOpen = false;
    this.dragKey = '';
    this.dropIndex = -1;
    this.activity = 0;
    this.disconnected = false;
    this.lostRegions = 0;
    this.stalledRegions = 0;
    this.overflowAlerts = [];
  }

  // Pull the recents label-shape prefs out of the shared store (they ride @wt_state,
  // so the strip looks the same in every browser on this tmux server).
  _applyLabelPrefs() {
    const t = stateStore.section('toolbar');
    this.showSession = t.recentShowSession === undefined
      ? LABEL_DEFAULTS.showSession : t.recentShowSession === true;
    this.trimName = t.recentTrimName === undefined
      ? LABEL_DEFAULTS.trimName : t.recentTrimName === true;
    this.recentMax = clampRecentsMax(t.recentMax);
  }

  // Resize the strip. Only the shared pref is written here — the SplitManager holds
  // the strip itself and subscribes to the blob, so the eviction rule for a shrink
  // lives in ONE place (setRecentsMax) whether the change came from this menu or
  // from another browser.
  _setRecentsMax(n) {
    const next = clampRecentsMax(n);
    if (next === this.recentMax) return;
    this.recentMax = next;
    stateStore.patchSection('toolbar', { recentMax: next });
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
  //
  // Deliberately unbounded rather than modulo-8. The counter is multiplied into a CSS
  // rotation, so wrapping it means one step in eight animates BACKWARDS through seven
  // notches — a visible counter-spin that reads as something undoing itself. Nothing
  // else consumes this value, and a session would have to send tmux a command every
  // second for a month to reach a number a double notices.
  tickActivity() {
    this.activity += 1;
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

  // Cycle the mouse click/drag mode (app -> buf -> auto -> auto+). Same shape as
  // cycleScroll: applied to the focused unit (which persists it into the shared
  // 'renderer' pref, so every region and every other browser follows).
  cycleMouse() {
    const i = MOUSE_ORDER.indexOf(normalizeMouse(this.mouseMode));
    const next = MOUSE_ORDER[(i + 1) % MOUSE_ORDER.length];
    this.mouseMode = next;
    const u = this.manager?.focusedUnit;
    if (u?.setMouseMode) u.setMouseMode(next);
    else stateStore.patchSection('renderer', { mouseMode: next });
  }

  // Set a mode outright (the dropdown rows), rather than stepping to it. Same apply
  // path as the cyclers above — the focused unit owns the setting and persists it into
  // the shared 'renderer' pref — so a click in the menu and a cycle land identically.
  // Kept separate from the cyclers because the menu shows all four states at once:
  // "step until the label says what I want" is exactly the interaction it removes.
  setScrollMode(mode) {
    if (!SCROLL_ORDER.includes(mode)) return;
    this.scrollMode = mode;
    const u = this.manager?.focusedUnit;
    if (u?.setScrollMode) u.setScrollMode(mode);
    else stateStore.patchSection('renderer', { scrollMode: mode });
  }

  setMouseMode(mode) {
    if (!MOUSE_ORDER.includes(mode)) return;
    this.mouseMode = mode;
    const u = this.manager?.focusedUnit;
    if (u?.setMouseMode) u.setMouseMode(mode);
    else stateStore.patchSection('renderer', { mouseMode: mode });
  }

  // ---- mouse-capture dropdown ---------------------------------------------------
  // ONE button for both gesture modes. They used to be two toolbar buttons labelled
  // "🖱 auto+" and "sel auto+", which is the shape of the problem: two adjacent
  // controls answering the same question about different gestures, each with room for
  // seven characters and no room to say WHICH gesture it governs. The tooltip carried
  // all of that, so the only way to find out what either button did was to hover it.
  //
  // In a dropdown each group can be titled with the gesture it is about — "click+drag:"
  // and "copymode on scroll:" — and every mode can show its own one-line hint next to
  // its name, so the whole four-by-two space is legible at once instead of one cell at
  // a time. The cost is a click to change a mode; the cyclers stay for the keyboard and
  // for anything that still wants to step.
  _mouseMenu() {
    const cur = { mouse: normalizeMouse(this.mouseMode), scroll: normalizeScroll(this.scrollMode) };
    const group = (kind, title, order, metaMap, apply) => html`
      <div class="mtitle">${title}</div>
      ${order.map((m) => html`
        <button
          class="mitem"
          data-kind=${kind}
          data-mode=${m}
          @click=${() => apply(m)}
        >
          <span class="mark">${cur[kind] === m ? '✓' : ''}</span>
          <span class="mtext"><b>${metaMap[m].name}</b><span class="mhint">${metaMap[m].hint}</span></span>
        </button>
      `)}
    `;
    return html`
      <div class="label-backdrop" @click=${() => { this.mouseMenuOpen = false; }}></div>
      <div class="label-menu mouse-menu" @click=${(e) => e.stopPropagation()}>
        ${group('mouse', 'click+drag:', MOUSE_ORDER, MOUSE_META, (m) => this.setMouseMode(m))}
        ${group('scroll', 'copymode on scroll:', SCROLL_ORDER, SCROLL_META, (m) => this.setScrollMode(m))}
      </div>
    `;
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
    this._editingDir = false;
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

  // True while webtmux has no directory it can honestly save into and is waiting
  // for the user to name one (or has rejected the one they named). The filename
  // row is dead until that's settled — there is no destination for it yet.
  _askingForDir() {
    return this.saveInfo?.blocked === true || !!this.saveInfo?.chosenError;
  }

  // The "which directory?" row. Shown while asking, and — collapsed to a single
  // line with a "change" link — once an answer is in force, because the answer is
  // a claim about the deployment that should stay visible and correctable.
  _saveDirRow() {
    const info = this.saveInfo;
    if (!info) return '';
    const chosen = info.chosen && info.baseDir === info.chosen ? info.chosen : '';
    if (!this._askingForDir() && !chosen) return '';
    if (chosen && !this._editingDir) {
      return html`
        <div class="save-dir-note">
          saving into <b>${chosen}</b>
          <button class="save-dir-change" @click=${() => { this._editingDir = true; this.requestUpdate(); }}>change</button>
        </div>
      `;
    }
    return html`
      <div class="save-row">
        <input
          class="save-path save-dir"
          type="text"
          spellcheck="false"
          autocomplete="off"
          placeholder="/data"
          .value=${chosen || ''}
          @keydown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); this._useSaveDir(); } e.stopPropagation(); }}
        >
        <button class="save-go" @click=${() => this._useSaveDir()}>Use</button>
      </div>
    `;
  }

  // Hand the typed directory to the manager, which remembers it in the shared UI
  // state and re-probes. The server decides whether it's usable — a directory
  // that doesn't exist inside the container comes back as chosenError, and the
  // row stays open with the reason.
  _useSaveDir() {
    const el = this.renderRoot?.querySelector('.save-dir');
    const dir = (el?.value || '').trim();
    if (!dir) return;
    this._editingDir = false;
    this.manager?.setSaveDir(dir);
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

  // The answer to "that file already exists". Re-sends the refused REQUEST (the
  // manager kept it) rather than re-reading the input, which the user may have
  // edited or scrolled away from since.
  _confirmOverwrite() {
    this.manager?.confirmOverwriteSave();
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
    const sample = this.recent[0] || { session: 'services', name: 'ssh web-01', index: 3 };
    const shape = (showSession, trimName) => {
      const name = trimName ? trimWindowName(sample.name) : (sample.name || 'bash');
      return showSession ? `${sample.session}: ${name}` : name;
    };
    return html`
      <div class="label-backdrop" @click=${() => { this.labelMenuOpen = false; }}></div>
      <div class="label-menu" @click=${(e) => e.stopPropagation()}>
        <div class="mtitle">Recent tabs</div>
        <div class="msize">
          <span class="mlabel">Tabs kept</span>
          <button
            class="mstep"
            aria-label="Keep fewer recent tabs"
            ?disabled=${this.recentMax <= RECENTS_MIN}
            @click=${() => this._setRecentsMax(this.recentMax - 1)}
          >−</button>
          <span class="mnum">${this.recentMax}</span>
          <button
            class="mstep"
            aria-label="Keep more recent tabs"
            ?disabled=${this.recentMax >= RECENTS_MAX}
            @click=${() => this._setRecentsMax(this.recentMax + 1)}
          >+</button>
        </div>
        <div class="mprev">
          ${this.recentMax === 1
            ? 'one tab; every other window lives in the overflow arrow and Exposé'
            : `${this.recentMax} tabs, then the least recently used one is replaced`}
        </div>
        <div class="mtitle">Labels</div>
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

  // The overflow arrow at the end of the strip: N windows need you and none of them
  // has a tab here. Clicking it opens the window list and points the browse at the
  // most recent one — see SplitManager.revealOverflowAlert.
  _overflowArrow() {
    const list = this.overflowAlerts || [];
    if (!list.length) return '';
    const top = list[0];
    // Loudest of the pending alerts wins the colour: amber (something is BLOCKED on
    // you) outranks red (something merely ran out of work), because one of them is a
    // request and the other is a report.
    const worst = list.some((w) => w.alert === '2') ? '2' : '0';
    const names = list.slice(0, 5)
      .map((w) => `  ● ${w.session}${w.index == null ? '' : ' — window ' + w.index}: ${w.name}`)
      .join('\n');
    const more = list.length > 5 ? `\n  …and ${list.length - 5} more` : '';
    const tip = `${list.length} window${list.length === 1 ? '' : 's'} need${list.length === 1 ? 's' : ''}`
      + ` attention and ${list.length === 1 ? 'has' : 'have'} no tab here:\n${names}${more}`
      + `\n\nClick to open the window list (${chord('W')}) and preview the most recent`
      + ` — ${top.session}: ${top.name}. Nothing switches until you press Enter or click it;`
      + ` Escape puts everything back.`;
    return html`
      <button
        class="oflow ${alertClass(worst)}"
        aria-label="${list.length} more windows need attention"
        @mouseenter=${(e) => this._tipEnter(e, tip)}
        @mouseleave=${() => this._tipLeave()}
        @click=${() => { this._tipLeave(); this.manager?.revealOverflowAlert(); }}
      ><span class="n">${list.length}</span>${overflowIcon()}</button>
    `;
  }

  // What the red spinner says when you point at it. The important sentence is the
  // last one: everything on screen still LOOKS live — the terminals keep their last
  // painted screen and the window list keeps listing windows — so the one thing worth
  // saying is that none of it is current.
  //
  // The two failures get different advice on purpose. A dropped socket is already
  // being retried, so "wait" is true. A STALLED one is not being retried by anybody —
  // the browser thinks the connection is fine — so the only thing that helps is
  // reloading, and saying "hang on, it's reconnecting" would be a lie that keeps
  // someone typing into a dead socket.
  _lostTip() {
    const stalled = this.stalledRegions || 0;
    const closed = this.lostRegions || 0;
    const plural = (n, one, many) => (n === 1 ? one : many);
    const tail = `\n\nWhat is on screen is the last thing that arrived, not what tmux looks`
      + ` like now; anything you type goes nowhere until the link is back.`;
    if (stalled) {
      const which = closed
        ? `${stalled + closed} terminal regions have`
        : plural(stalled, 'The terminal has', `${stalled} terminal regions have`);
      return `tmux has stopped answering. ${which} an open connection that has gone`
        + ` silent — the server is still there, but it is not responding to input, so`
        + ` nothing is automatically retrying. Reload the page to reconnect.${tail}`;
    }
    const which = plural(closed || 1, 'The terminal has', `${closed} terminal regions have`);
    return `Lost the connection to tmux. ${which} no live link to the server —`
      + ` webtmux keeps retrying in the background and this clears the moment one gets through.${tail}`;
  }

  render() {
    return html`
      <span
        class="spin ${this.disconnected ? 'lost' : ''}"
        style="transform: rotate(${this.activity * SPIN_STEP_DEG}deg)"
        role=${this.disconnected ? 'img' : 'presentation'}
        aria-hidden=${this.disconnected ? 'false' : 'true'}
        aria-label=${this.disconnected ? 'Connection to tmux lost' : ''}
        @mouseenter=${(e) => this._tipEnter(e, this.disconnected ? this._lostTip()
          : 'tmux activity — advances one notch each time webtmux sends tmux a command (window switches, renames, captures, saved state).')}
        @mouseleave=${() => this._tipLeave()}
      >${spinIcon()}</span>
      ${this.showBuild ? html`
        <button
          class="build"
          aria-label="webtmux build ${this.build} — click to copy"
          @mouseenter=${(e) => this._tipEnter(e, `webtmux build ${this.build}${this.built ? ' — built ' + this.built : ''}\nClick to copy it (it is also copied whenever you reveal this chip). Hide with ${chord('B')}.`)}
          @mouseleave=${() => this._tipLeave()}
          @click=${() => this._copyBuild()}
        >⬢ ${this.build}</button>
      ` : ''}
      ${this.readOnly ? html`
        <span
          class="ro-badge"
          role="img"
          aria-label="Read-only server"
          @mouseenter=${(e) => this._tipEnter(e, READ_ONLY_NOTICE
            + '\nWatching, capture, hover previews and the save-to-browser download all still work.')}
          @mouseleave=${() => this._tipLeave()}
        >READ-ONLY</span>
      ` : ''}
      ${this.notice ? html`<div class="notice" title=${this.notice}>${this.notice}</div>` : ''}
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
            aria-label="Recent tab options"
            @mouseenter=${(e) => this._tipEnter(e, `Recent windows — click for options: how many tabs to keep (now ${this.recentMax}), and their labels (show the session, trim the window name). Drag tabs to reorder them.`)}
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
            + alertTip(w.alert);
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
            class="tab ${w.active ? 'active' : ''} ${w.disabled ? 'disabled' : ''} ${!w.active && this.previewWindow === w.id ? 'previewing' : ''} ${alertClass(w.alert)}"
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
      ${this._overflowArrow()}
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
            ${this.readOnly ? html`
              <div class="save-ro">Not available — this server is read-only (started without -w),
                so it will not write files. "Download to browser" needs nothing from the server
                and still works.</div>
            ` : html`
              ${this._saveDirRow()}
              <div class="save-row">
                <input
                  class="save-path"
                  type="text"
                  spellcheck="false"
                  autocomplete="off"
                  ?disabled=${this._askingForDir()}
                  placeholder=${this._askingForDir() ? 'name a directory first' : '~/out.txt or ./out.txt'}
                  @keydown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); this._saveToPath(); } e.stopPropagation(); }}
                >
                <button class="save-go" ?disabled=${this._askingForDir()} @click=${() => this._saveToPath()}>Save</button>
              </div>
              ${this._saveHint()}
            `}
            ${this.saveStatus ? html`
              <div class="save-status ${this.saveStatus.state}">${this.saveStatus.text}</div>
              ${this.saveStatus.state === 'confirm' ? html`
                <div class="save-confirm">
                  <button @click=${() => this._confirmOverwrite()}>Overwrite</button>
                  <button class="cancel" @click=${() => { this.saveStatus = null; }}>Cancel</button>
                </div>
              ` : ''}
            ` : ''}
          </div>
        ` : ''}
      </div>
      <div class="mouse-wrap">
        <button
          class="tbtn text ${this.mouseMenuOpen ? 'on' : ''}"
          aria-label="Mouse capture — click+drag and scroll-wheel modes"
          @mouseenter=${(e) => this._tipEnter(e, mouseCaptureTooltip(
            normalizeMouse(this.mouseMode), normalizeScroll(this.scrollMode)))}
          @mouseleave=${() => this._tipLeave()}
          @click=${() => { this._tipLeave(); this.mouseMenuOpen = !this.mouseMenuOpen; }}
        >🖱 ${modeName(MOUSE_META, normalizeMouse(this.mouseMode))}/${modeName(SCROLL_META, normalizeScroll(this.scrollMode))} ▾</button>
        ${this.mouseMenuOpen ? this._mouseMenu() : ''}
      </div>
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
