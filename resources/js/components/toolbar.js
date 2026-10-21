// Top toolbar: a most-recently-accessed window strip on the LEFT and the sidebar
// toggle on the RIGHT. The SplitManager owns the data — it sets `recent`
// (up to `recentMax` {id,index,name,active,working,alert}) and `collapsed`, and
// handles clicks via `manager.pickRecentWindow(id)` /
// `manager.sidebar.toggleCollapsed()`.
//
// `recent` is only the TABS: the first `recentMax` remembered windows that the preview
// isn't already showing. Two kinds of entry are missing from it and neither is gone —
// a window sitting in the PiP or the preview bar is on screen and one click away, so it
// does not also spend a tab (`recentHeld` counts those), and a window pushed past the
// last slot keeps its place in line (`recentQueued` counts those). Both come back, in
// place, when a slot frees. See recents-strip.js.
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
import { workClass, workLabel, workTip, workBadgeTip, workBadge, workBadgeModes, nextBadgeMode } from '../stoplight.js';
import { ALERT_CSS, alertClass, alertTip } from '../alert-flash.js';
import { STOPLIGHT_CSS } from '../stoplight-dot.js';
import { Tip, TIP_CSS } from '../tooltip.js';
import { saveHint } from '../save-target.js';
import {
  DEFAULT_SAVE_SCOPE, SCOPE_OPTIONS, normalizeScope,
  downloadLabel, saveButtonLabel,
} from '../save-scope.js';
import {
  HISTORY_PRESETS, parseLimit, formatLines, formatBytes, windowUsage, resizePlan,
  configFileHint, workName,
} from '../scrollback.js';
import {
  THERE, TRANSFER_BLURB, UPLOAD_TITLE, DOWNLOAD_TITLE,
  uploadPlan, transferSummary, uploadLabel, transferHint,
  defaultTransferDir, transferPlaceholder,
} from '../file-transfer.js';
import { READ_ONLY_NOTICE } from '../write-guard.js';
import { copyText } from '../clipboard.js';
import { copyBuffers } from '../copy-buffer-store.js';
import { SCROLL_MODES as SCROLL_ORDER, normalizeScrollMode as normalizeScroll } from '../terminal-unit.js';
import { MOUSE_MODES as MOUSE_ORDER, normalizeMouseMode as normalizeMouse } from '../mouse-mode.js';
import {
  clampRecentsMax, fitTabCount, RECENTS_MIN, RECENTS_MAX,
  RECENT_DRAG_TYPE, recentDragPayload, parseRecentDrag,
} from '../recents-strip.js';
import { labelPrefs, windowLabel, windowTitle } from '../window-label.js';
import { ConfirmPopup, CONFIRM_CSS } from '../confirm-popup.js';

// Recent-tab label shape (LABEL_DEFAULTS, trimWindowName, windowLabel) lives in
// window-label.js — the preview's tiles are labelled by the same prefs.

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
  'adaptive-probe': { name: 'auto+', hint: 'clicks still reach the program, but click-and-DRAG selects text — tmux copy mode is entered automatically if needed' },
};

// The closed button has to answer "what am I in?" without a click, so it shows both
// current modes by their short names. A metaMap lookup that can't fail: an unknown
// stored mode falls back to the default rather than rendering `undefined`.
const modeName = (metaMap, cur) => (metaMap[cur] || metaMap['adaptive-probe']).name;

// Hovering the closed button says what is in force NOW, on both axes — one line
// each — and that a click offers the alternatives. Every mode's description lives
// in the dropdown, where it sits beside the choice it describes; repeating all
// eight here made a wall of text to read past the two lines that mattered.
const mouseCaptureTooltip = (mouseCur, scrollCur) => {
  const m = MOUSE_META[mouseCur] || MOUSE_META['adaptive-probe'];
  const w = SCROLL_META[scrollCur] || SCROLL_META['adaptive-probe'];
  return [
    'Mouse capture — who gets your gestures, the program or webtmux.',
    '',
    `click+drag: ${m.name} — ${m.hint}`,
    '',
    `scroll wheel: ${w.name} — ${w.hint}`,
    '',
    'Click to change either (▾).',
  ].join('\n');
};

// The split button's hover hint.
const SPLIT_TIP = [
  'Split view — split the focused view in two, left | right or top / bottom.',
  '',
  'Unlike tmux panes, which subdivide one window and travel with it, each view is independent: it shows any window from any session.',
  '',
  'Once split, the menu also adds a view across the whole screen: full height on the right, or full width along the bottom.',
  '',
  'The focused view has the bright frame; every switcher (recents, sidebar, Exposé) changes the window in it.',
  '',
  'Point near the top of a view for its controls: move it left / right / up / down, or close it. Drag a divider to resize.',
  '',
  `Click for the directions (▾). Shortcuts: ${chord('%')} left | right, ${chord('"')} top / bottom, ${chord('X')} closes the focused view.`,
].join('\n');

// The Exposé button's icon. It used to be ▦ — a grid glyph that, next to the
// split button's ⊞, read as "another box" and said nothing about windows. Four
// UNEVEN tiles, each with a title bar, are the picture of "every window, spread
// out": uneven because a grid of identical cells is a table, and title bars
// because that is what makes a rectangle a window. Drawn rather than typed so it
// doesn't depend on a font having a usable glyph — the same lesson as the
// renderer's system-font fallback.
// The scrollback button's hover hint. It leads with the fact the control exists
// to expose — a pane's buffer size is fixed when the pane is made — because that
// is the thing a person has no way to discover from the terminal in front of them.
const SCROLLBACK_TIP = [
  'Scrollback buffer — how many lines this window keeps, and how many it is holding.',
  '',
  'tmux fixes a pane\'s buffer size when the pane is created, so raising the limit',
  'only affects NEW windows. Resizing one that already exists means rebuilding its',
  'panes, which restarts them (the scrollback comes along). Both are in here, kept',
  'apart \u2014 plus saving the default into your tmux config, so it survives a restart.',
  '',
  'Click for this window\'s sizes, resizing, and the default for new windows.',
].join('\n');

// The scrollback button's icon: a buffer with a fill level.
//
// Drawn rather than typed, for the reason the Exposé icon is — a glyph that
// depends on the system font having it is a glyph that renders as a box on
// somebody's machine. A container filled from the bottom says "how much of it is
// used", which is the question this control exists to answer; the lines inside
// the fill say the contents are text.
function bufferIcon() {
  return html`
    <svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true" focusable="false">
      <rect x="3.2" y="2.2" width="13.6" height="15.6" rx="1.8"
            fill="none" stroke="currentColor" stroke-width="1.3"></rect>
      <path d="M3.2 9.4 h13.6 V16 a1.8 1.8 0 0 1 -1.8 1.8 H5 a1.8 1.8 0 0 1 -1.8 -1.8 Z"
            fill="currentColor" opacity="0.28"></path>
      <g stroke="currentColor" stroke-width="1.1" stroke-linecap="round" opacity="0.85">
        <line x1="6" y1="11.6" x2="14" y2="11.6"></line>
        <line x1="6" y1="14" x2="11.6" y2="14"></line>
      </g>
    </svg>`;
}

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
const EXPOSE_TIP = 'Exposé — a thumbnail of every window across all sessions.'
  + (IS_MAC ? '\n\nTrackpad: spread two fingers to open it, spread again for 9 smaller tiles;'
            + '\npinch back to 4, and pinch once more to close.' : '')
  + `\n\nShortcut: ${chord('F')}`;

// The spinner's hover hint ends with what clicking it does. It is a separate
// constant because the sentences ABOVE it are the link's own report, shared
// verbatim with the menu (see _linkDetail) — only this tail belongs to the hint.
const LINK_MENU_HINT = '\n\nClick for the connection in full, and for tmux\'s own settings.';

// The per-tab × hint. A constant rather than an inline string because _syncTabHover
// has to be able to say it too: after a × click the pointer is left sitting on the
// NEXT tab's ×, and re-hinting it with the tab's own text would describe a control
// the pointer isn't on.
const CLOSE_TAB_TIP =
  'Remove this tab from Recent.\n\nThe window keeps running — this does not close or kill it.';

class WebtmuxToolbar extends LitElement {
  static properties = {
    recent: { type: Array },
    collapsed: { type: Boolean },
    // Current scroll-wheel mode (mirror of the focused unit's setting). Cycled by
    // the toolbar's scroll button; one of SCROLL_ORDER.
    scrollMode: { type: String },
    // Current mouse click/drag mode (mirror of the focused unit's setting).
    // Cycled by the toolbar's selection button; one of MOUSE_ORDER.
    mouseMode: { type: String },
    // True when the focused split region's active pane is in tmux copy/view mode.
    // Reflected to the `copymode` attribute so :host() can recolor the whole bar.
    copyMode: { type: Boolean, reflect: true, attribute: 'copymode' },
    // How many copy buffers actually hold something. Shown on the mode pill (which
    // now opens the copy-buffer panel) so a list you have been filling up says so
    // from the toolbar, without the panel having to be open.
    bufferCount: { type: Number },
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
    // WHICH buffer a save means — the whole scrollback or just the visible screen
    // (see save-scope.js). Qualifies BOTH destinations in the dropdown, and is
    // re-set to the default every time the menu opens: "entire buffer" is the
    // answer that should never depend on what someone picked an hour ago.
    saveScope: { type: String },
    // What the user has picked to upload — an uploadPlan (see file-transfer.js),
    // or null when nothing is chosen. Held here rather than read out of the file
    // input at send time because a <input type=file> cannot be re-filled
    // programmatically, so the pick has to survive the re-renders that the
    // progress banner causes.
    uploadPick: { type: Object },
    // Whether an upload may replace files that are already there. Defaults to
    // false and resets with every pick: "replace" is a decision about ONE
    // transfer, and a sticky tick is how a folder upload silently overwrites work
    // somebody else did on that machine in between.
    uploadOverwrite: { type: Boolean },
    // The window the shared HoverPreview is currently showing ('' = none). Marks
    // which tab the preview on screen belongs to. Set by the SplitManager.
    previewWindow: { type: String },
    // Scrollback-buffer dropdown: whether it's open, the server's last report
    // (a tmux.HistoryReport plus an action outcome — see webtty/history.go), the
    // transient banner under it, and the pending "this rebuilds panes" question.
    // The report is what makes a pane's ACTUAL capacity visible, as opposed to
    // the option that only governs the next pane to be created.
    historyOpen: { type: Boolean },
    historyInfo: { type: Object },
    historyStatus: { type: Object },
    historyConfirm: { type: Object },
    // Whether the mouse-capture dropdown is open (the two gesture modes live in it).
    mouseMenuOpen: { type: Boolean },
    // Recent-tab label shape (see LABEL_DEFAULTS) + whether its little menu is open.
    showSession: { type: Boolean },
    trimName: { type: Boolean },
    labelMenuOpen: { type: Boolean },
    // How many tabs the strip holds. Mirrors the shared toolbar.recentMax pref; the
    // SplitManager is what actually enforces it (see setRecentsMax).
    recentMax: { type: Number },
    // How many recent windows are currently standing down because the preview is
    // showing them (see recents-strip.js). Not tabs — these draw nothing. It is here
    // so the "Recent ▾" menu survives previewing every recent window at once, and so
    // the strip can explain the tab that disappeared when a window was previewed.
    recentHeld: { type: Number },
    // How many remembered windows are queued behind the last tab because the cap ran
    // out (see recents-strip.js). They are not lost — the head of that queue takes the
    // next slot that frees — so the "Recent ▾" menu says how many are waiting, right
    // beside the number that decides it.
    recentQueued: { type: Number },
    // The head of that queue, handed over so its tab can be MEASURED without being
    // shown (see .rtab.spare and _fitStrip). Null when the queue is empty, or when the
    // user's cap rather than the width is what is holding it back — then there is
    // nothing a wider window would let in, so there is nothing to measure.
    recentNext: { type: Object },
    // Everything the strip remembers: tabs + queue + the ones the preview is holding.
    // The clear affordance is about this number, not about the tabs — clearing only
    // what is drawn is precisely the treadmill it exists to end (see clearRecents).
    recentTotal: { type: Number },
    // The split button's ▾ menu (left | right, or top / bottom).
    splitMenuOpen: { type: Boolean },
    // Recents drag-reorder: the tab being dragged, and the insertion GAP the drop
    // would land in (0..n, -1 = not over the strip).
    dragKey: { type: String },
    dropIndex: { type: Number },
    // tmux-activity spinner position, in increments (rendered as rotation).
    activity: { type: Number },
    // The spinner's OTHER job: the health of the link to tmux — 'live', 'slow' (asked,
    // not answered yet) or 'lost' — with how many regions are in each failing state:
    // closed socket vs open-but-mute vs merely late (see SplitManager._refreshConnection
    // and link-health.js). `disconnected` is the old boolean, kept because the red
    // state's aria-label and pulse are the same thing they always were.
    linkState: { type: String },
    disconnected: { type: Boolean },
    lostRegions: { type: Number },
    stalledRegions: { type: Number },
    slowRegions: { type: Number },
    // The spinner's THIRD job: it is the button that opens the link menu — the
    // connection in longhand, and the tmux settings that have nowhere else to live.
    // tmuxSettings is the server's last TmuxSettings report (see pkg/tmux/settings.go),
    // null until one arrives; tmuxSettingsBusy covers the round trip after a toggle,
    // so the checkbox stays on what tmux says rather than jumping to what was clicked.
    linkMenuOpen: { type: Boolean },
    tmuxSettings: { type: Object },
    tmuxSettingsBusy: { type: Boolean },
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
    /* The strip is FITTED, not scrolled: the manager draws only as many tabs as there
       is room for and queues the rest (see recents-strip.js "the width cap"). So this
       box never has anything to scroll — overflow:hidden is the backstop for the one
       frame between a resize and the re-measure, not the mechanism.
       position:relative makes it the containing block for the width probe below. */
    .tabs {
      display: flex;
      align-items: center;
      gap: 6px;
      overflow: hidden;
      position: relative;
      flex: 1 1 auto;
      min-width: 0;
    }
    /* The width probe: the next window in line, rendered for its WIDTH alone. Taken out
       of the flow (absolute) so it costs no space, hidden so it is never seen, and inert
       so it can't be hovered, dragged or clicked — but still laid out, which is the
       whole point: _fitStrip measures a real tab instead of guessing at one. */
    .rtab.spare {
      position: absolute;
      left: 0;
      top: 0;
      visibility: hidden;
      pointer-events: none;
    }
    .label {
      color: #666; font-size: 12px; margin-right: 2px; white-space: nowrap; flex: 0 0 auto;
      background: none; border: none; padding: 2px 4px; border-radius: 4px;
      font-family: inherit; cursor: pointer;
    }
    .label:hover { color: #9fc4ff; background: #1a1a2e; }

    /* Clear the whole strip. Hung off the "Recent" label, revealed on hover, because
       it is a rare gesture that must not sit permanently next to the ordinary ones —
       and because the label is exactly the thing it is about.

       Its space is RESERVED even while it is invisible, rather than the button being
       taken out of the flow. The tabs are width-fitted to what is left of the toolbar
       (see _fitStrip), so a control that only claimed room once the pointer arrived
       would re-measure the strip on hover and could drop a tab out from under the very
       pointer that revealed it. Only the ink comes and goes. */
    .label-clear {
      flex: 0 0 auto;
      margin-right: 2px;
      padding: 2px 3px;
      border: none;
      background: none;
      color: #6b7ba8;
      font-size: 12px;
      line-height: 1;
      font-family: inherit;
      border-radius: 4px;
      cursor: pointer;
      opacity: 0;
      /* Invisible means unclickable: an opacity-0 button still takes clicks, and this
         one is destructive. Keyboard focus re-enables it via :focus-within below, so
         it stays reachable without a pointer. */
      pointer-events: none;
      transition: opacity 0.12s ease;
    }
    .label-wrap:hover .label-clear,
    .label-wrap:focus-within .label-clear { opacity: 1; pointer-events: auto; }
    .label-clear:hover { color: #e94560; background: #1a1a2e; }
    /* Nothing to clear: no ink, no target, even on hover. */
    .label-clear[disabled] { opacity: 0 !important; pointer-events: none !important; }

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

    /* Working-status dot: green = working, green ring = working in the background,
       amber = prompting (blocked on your answer), red = waiting for work to do,
       unfilled = not reporting. Clients drive it with: tmux set -w @wt_working
       1|3|2|0 (set -u to clear). The words live in stoplight.js — every surface that
       shows this dot says them the same way, and hovering it prints the whole key. */
    /* Look and colours: .stoplight in STOPLIGHT_CSS (stoplight-dot.js). */

    /* The always-visible "how long has it been like this" reading (workBadge() in
       stoplight.js) — the answer someone scanning the whole strip needs without
       hovering anything. Muted (not competing with the window name for attention)
       but readable at a glance — 9px measured too small in practice. Hovering it
       explains the mechanism (workBadgeTip()), same as hovering the dot explains
       the colour. The .cyclable variant (both readings exist) invites a click to
       switch between them — see _cycleBadgeMode(). */
    /* .work-age's look is in STOPLIGHT_CSS (stoplight-dot.js). */

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
    /* On screen in another split view. Clicking brings it into the focused view (the
       two views trade windows), so it is NOT dimmed like a dead control — just a
       dotted edge, so you can see it is already showing somewhere. */
    .tab.elsewhere { border-style: dotted; }
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
      /* Right-aligned, not left. Both buttons that open this menu sit near the
         right end of the toolbar, so a left-anchored panel grows toward — and
         past — the window's right edge; the scrollback menu was already spilling
         a little before the wider transfer sections made it obvious. Same rule
         popup-place.js calls align:'right', in CSS because this menu is
         positioned by the stylesheet rather than measured in JS. */
      right: 0;
      z-index: 95;
      min-width: 330px;
      /* The dropdown now holds four sections (scope, download, save, transfer),
         which on a short window is taller than the viewport. Capping it and
         scrolling INSIDE keeps the last section reachable; without this the
         transfer controls simply fall off the bottom of the screen with nothing
         to indicate they are there. */
      max-width: min(620px, 94vw);
      max-height: min(78vh, 660px);
      /* An explicit width is required, not merely nice: this menu is positioned
         against .save-wrap, which is the width of the ⤓ button, so shrink-to-fit
         has ~28px of "available space" to work with and collapses the panel to
         its min-width no matter what max-width says. Without .wide below, the
         two transfer columns silently stack back into one. */
      overflow-y: auto;
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
    /* Wide enough for the transfer pair to sit in two columns. Applied only when
       those sections are actually rendered — a read-only server shows a sentence
       in their place, and a 600px panel around one sentence is just a big hole. */
    .save-menu.wide { width: min(600px, 94vw); }
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
    /* The scope chooser sits ABOVE both destinations, because it qualifies both:
       whichever button you press next, this is which buffer it means. */
    .save-scope { display: flex; flex-direction: column; gap: 4px; }
    .save-scope-opt {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 6px 8px;
      border: 1px solid transparent;
      border-radius: 6px;
      cursor: pointer;
      color: #c9d4e8;
      font-size: 12px;
      line-height: 1.35;
    }
    .save-scope-opt:hover { background: #14233f; }
    .save-scope-opt.on { border-color: #4a9eff; background: #14233f; color: #e8eefc; }
    .save-scope-opt input { margin: 2px 0 0; accent-color: #4a9eff; cursor: pointer; }
    .save-scope-note { display: block; color: #6b7690; font-size: 10.5px; margin-top: 2px; }
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
    /* An upload that mostly worked. Looks like 'confirm' because it is the same
       kind of news — something needs your attention, nothing is lost — but it is
       deliberately a DIFFERENT state name, because the dropdown renders the
       Overwrite button from the state alone and this banner has nothing left to
       overwrite. Its text runs to several lines (one per file that didn't land),
       hence the pre-line. */
    .save-status.partial {
      background: #33260f;
      color: #f2c774;
      border: 1px solid #7a5a24;
      white-space: pre-line;
      max-height: 140px;
      overflow-y: auto;
    }
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

    /* ---- file transfer -----------------------------------------------------
       Two sections that move whole FILES between the machine this browser runs
       on and the machine tmux runs on (see file-transfer.js).

       They deliberately reuse the save chrome (.save-row/.save-path/.save-go)
       rather than growing a second look, with one addition that is not
       decoration: .xfer-dir, the line naming BOTH machines in the direction the
       bytes travel. It is styled as the loudest thing in its section because it
       is the only defence against the one mistake this feature can make — an
       upload the user reads as a download, which on a shared machine means
       overwriting the good copy with the stale one. */
    /* Upload and download sit SIDE BY SIDE. Stacked, they pushed the download
       section below the fold of a 720px-tall window — a feature you have to
       scroll a dropdown to discover is one most people never find. Two columns
       also state the thing the headings are working to say: these are one pair of
       opposite directions, not two unrelated tools.

       They wrap back to one column when there is no room (a phone, a narrow
       window), which is the case the scrolling cap above still covers. */
    .xfer-pair { display: flex; gap: 12px; align-items: flex-start; flex-wrap: wrap; }
    .xfer-pair > .xfer { flex: 1 1 250px; min-width: 0; }
    .xfer { display: flex; flex-direction: column; gap: 6px; }
    .xfer-dir {
      color: #9fc4ff;
      font-size: 11.5px;
      font-weight: 600;
      letter-spacing: 0.01em;
      overflow-wrap: anywhere;
    }
    .xfer-lbl { color: #6b7690; font-size: 10.5px; }
    .xfer-pick { display: flex; gap: 6px; flex-wrap: wrap; }
    /* The file inputs themselves are hidden and driven by their labels: a bare
       <input type=file> renders as an OS-styled button that cannot be made to
       match anything around it, and its text ("No file chosen") contradicts the
       summary line below. */
    .xfer-btn {
      flex: 1 1 auto;
      text-align: center;
      background: #1a1a2e;
      color: #e8eefc;
      border: 1px solid #0f3460;
      border-radius: 5px;
      padding: 5px 8px;
      font-size: 11px;
      cursor: pointer;
    }
    .xfer-btn:hover { border-color: #4a9eff; }
    .xfer-btn input { display: none; }
    .xfer-sum {
      display: flex;
      align-items: baseline;
      gap: 6px;
      color: #6ee7a8;
      font-size: 11px;
      overflow-wrap: anywhere;
    }
    .xfer-ow {
      display: flex;
      align-items: center;
      gap: 6px;
      color: #9fc4ff;
      font-size: 10.5px;
      cursor: pointer;
    }
    .xfer-ow input { accent-color: #4a9eff; cursor: pointer; }
    /* Full width: it is the button that acts, and it restates the destination. */
    .xfer-go { width: 100%; }

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

    /* Scrollback-buffer control. Reuses the save dropdown's chrome wholesale
       (.save-menu/.save-row/.save-path/.save-go/.save-status/.save-confirm) —
       it is the same kind of object in the same place, and a second set of the
       same rules is a second set to keep in step. Only what is genuinely new
       lives here: a fullness gauge, the per-pane breakdown, and the preset chips. */
    .save-menu.hist { min-width: 340px; max-width: min(380px, 92vw); }
    .hist-num {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      font-size: 11px;
      color: #9fc4ff;
    }
    .hist-num b { color: #e8eefc; font-weight: 600; }
    /* The gauge. Blue while there is room; amber once the buffer is full, which
       is not decoration — a full buffer is already dropping the oldest lines, and
       that is the moment worth noticing BEFORE the output you wanted is gone. */
    .hist-bar {
      position: relative;
      height: 8px;
      border-radius: 4px;
      background: #14233f;
      border: 1px solid #0f3460;
      overflow: hidden;
    }
    .hist-fill {
      position: absolute;
      top: 0; bottom: 0; left: 0;
      background: #4a9eff;
      transition: width 0.2s;
    }
    .hist-bar.full .hist-fill { background: #f0a742; }
    .hist-panes { display: flex; flex-direction: column; gap: 2px; }
    .hist-pane {
      display: flex;
      gap: 8px;
      font-size: 10.5px;
      color: #6b7690;
      white-space: nowrap;
    }
    .hist-pane.on { color: #9fc4ff; }
    .hist-pane .cmd {
      flex: 1;
      color: #9aa4bf;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .hist-pane.on .cmd { color: #e8eefc; }
    .hist-presets { display: flex; gap: 4px; flex-wrap: wrap; }
    .hist-preset {
      background: #14233f;
      color: #9fc4ff;
      border: 1px solid #0f3460;
      border-radius: 4px;
      padding: 2px 7px;
      font-size: 10.5px;
      font-family: inherit;
      cursor: pointer;
    }
    .hist-preset:hover { border-color: #4a9eff; color: #fff; }
    /* "Clear" is destructive in the quiet way — nothing looks different afterwards
       except that the history is gone — so it is styled as a warning rather than
       as another neutral row. */
    .hist-clear {
      background: #2a1a20;
      color: #ff9db0;
      border: 1px solid #7a2438;
      border-radius: 4px;
      padding: 5px 8px;
      font-size: 11px;
      font-family: inherit;
      cursor: pointer;
    }
    .hist-clear:hover { background: #3a1420; color: #fff; }
    /* "Save for next time" is a normal, safe action — it writes a config file and
       changes nothing running — so it is styled as a quiet secondary button rather
       than borrowing the destructive red of Clear. */
    .hist-persist {
      background: #14233f;
      color: #9fc4ff;
      border: 1px solid #0f3460;
      border-radius: 4px;
      padding: 5px 8px;
      font-size: 11px;
      font-family: inherit;
      cursor: pointer;
      text-align: left;
    }
    .hist-persist:hover { border-color: #4a9eff; color: #fff; }
    /* The "start it again afterwards" tickbox, shown only when tmux actually knows
       the window's launch command. Same shape as the save dropdown's scope options,
       since it is the same kind of thing: a choice about what the button you are
       looking at will do. */
    .hist-rerun {
      display: flex;
      gap: 6px;
      align-items: flex-start;
      padding: 6px;
      border: 1px solid #7a5a24;
      border-radius: 4px;
      background: #241b0d;
      color: #f2c774;
      font-size: 11px;
      line-height: 1.4;
      cursor: pointer;
    }
    .hist-rerun input { margin: 2px 0 0; accent-color: #f0a742; cursor: pointer; }
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

    /* Copy pill (second from the right). Shows the focused pane's mode — green-ish
       = NORMAL, amber = COPY — and OPENS THE COPY-BUFFER PANEL, which holds the
       button that flips the mode. Mode and buffers are one subject (you enter copy
       mode in order to fill the buffers), so the pill leads to both rather than
       being a one-trick switch; ⌃⌥[ still flips the mode with no panel at all. */
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
    /* How many buffers are being held, shown only once there is more than one —
       i.e. once the pill leads somewhere with a choice in it. */
    .mode .bufn {
      padding: 1px 5px;
      border-radius: 8px;
      background: rgba(74, 158, 255, 0.22);
      border: 1px solid rgba(74, 158, 255, 0.55);
      color: #cfe3ff;
      font-size: 10.5px;
      line-height: 1.3;
    }
    .mode.copy .bufn {
      background: rgba(42, 25, 2, 0.18);
      border-color: rgba(42, 25, 2, 0.5);
      color: #2a1902;
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
    /* The spinner is a BUTTON (see the link menu below), so it carries the
       button reset the other .tbtn-shaped controls get from .tbtn: no UA chrome,
       no inherited font metrics, and a pointer cursor — it does something now. */
    .spin {
      flex: 0 0 auto;
      width: 22px;
      height: 22px;
      margin-right: 3px;
      padding: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      background: none;
      border: 0;
      color: #6cb6ff;
      line-height: 1;
      cursor: pointer;
      transition: transform 0.18s ease-out;
    }
    .spin svg { display: block; }
    /* Open state. The spinner cannot take .tbtn's filled "on" look — it is
       rotating, and a box that rotates with it reads as broken — so being open is
       said with the icon's own colour instead. */
    .spin.open { color: #fff; }
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

    /* …and amber for the state in between, which the spinner used to have to round to
       one side or the other: we have asked tmux something and it has not answered YET.
       Amber matches the stoplight vocabulary's "something is pending on you looking at
       it" without claiming the link is gone — a slow box lands here and goes back to
       blue by itself the moment the answer arrives.

       It does NOT pulse. Amber is a "hang on", not a "go and look", and a second
       pulsing control competing with a flashing tab for the same corner of your eye
       would make both of them mean less. The glow is enough to catch a glance. */
    .spin.slow {
      color: #ffb454;
      filter: drop-shadow(0 0 4px rgba(255, 180, 84, 0.7));
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
    .label-wrap, .split-wrap { position: relative; flex: 0 0 auto; display: inline-flex; }
    /* The split button's ▾, kept small: the button says "split" first and "has a menu"
       second, and stays about the width it always was. */
    .split-wrap .caret { font-size: 8px; margin-left: 2px; opacity: 0.8; }
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
    /* The one item in here that throws something away wears the app's destructive
       colour, so it can never be mistaken for another display toggle. */
    .label-menu .mitem.danger { color: #d99aa8; }
    .label-menu .mitem.danger:hover { border-color: #e94560; color: #fff; }
    .label-menu .mitem[disabled] { opacity: 0.35; cursor: default; }
    .label-menu .mitem[disabled]:hover { border-color: #0f3460; color: #d99aa8; }
    .label-menu .mitem .mark { width: 12px; flex: 0 0 auto; color: #37d17a; }
    .split-menu .mitem .mark { color: #9fc4ff; }
    .split-menu .mkey { margin-left: auto; padding-left: 12px; color: #6b7690; font-size: 11px; }
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

    /* The link menu, hung off the spinner at the FAR LEFT of the bar — so it
       opens left-aligned, the mirror of .mouse-menu's right. Same .label-menu
       chrome as the other two for the same reason: three settings menus that
       looked like three different objects would read as three mechanisms.

       It is wider than the mouse menu because its first row is not a choice at
       all — it is the connection in longhand, the paragraphs the spinner's hover
       hint has always carried, now in something you can read at your own pace
       instead of racing a tooltip timeout. */
    .spin-wrap { position: relative; flex: 0 0 auto; display: inline-flex; }
    /* max-height, unlike the other two menus, because this one GROWS: the rename
       row lists a window per opt-in on top of three settings that each explain
       themselves in a paragraph. Without it a laptop viewport gets a menu whose
       bottom rows are off-screen and unreachable — the rows are anchored to the
       toolbar at the top, so there is nothing to scroll the page to. */
    .link-menu {
      left: 0; right: auto; min-width: 340px; max-width: min(380px, 92vw);
      max-height: calc(100vh - 56px); overflow-y: auto;
    }
    .link-menu .mitem { align-items: flex-start; }
    .link-menu .mitem .mark { margin-top: 2px; }
    .link-menu .mtext { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .link-menu .mtext b { font-weight: 600; color: #e8eefc; }
    .link-menu .mhint { color: #8b96b4; font-size: 11px; line-height: 1.35; white-space: normal; }
    /* The connection row. A DIV, not a button: it reports, it does not act, and a
       row that looked clickable would be promising a reconnect nothing here can
       deliver. Its dot repeats the spinner's colour so the menu and the control
       that opened it can never disagree about what state we are in. */
    .link-menu .mstat {
      display: flex; align-items: flex-start; gap: 8px;
      background: #1a1a2e; border: 1px solid #0f3460; border-radius: 6px;
      padding: 7px 9px; font-size: 12.5px; color: #e8eefc;
    }
    .link-menu .mstat .sdot {
      flex: 0 0 auto; width: 9px; height: 9px; margin-top: 5px;
      border-radius: 50%; background: #6cb6ff;
    }
    .link-menu .mstat.slow .sdot { background: #ffb454; }
    .link-menu .mstat.lost .sdot { background: #ff5470; }
    /* pre-line, because the body is the SAME string the hover hint shows and its
       paragraph breaks are real newlines. One text, two presentations. */
    .link-menu .mstat .mhint { white-space: pre-line; }
    .link-menu .mitem[disabled] { opacity: 0.45; cursor: default; }
    .link-menu .mitem[disabled]:hover { border-color: #0f3460; }
    /* The hook's command, verbatim. Shown rather than summarised: it names a
       script on the tmux machine, and "something runs when you rename a window"
       is not a thing to ask anyone to take on trust. It wraps rather than
       ellipsing for the same reason — a path cut off in the middle is the half
       that does not identify it. */
    .link-menu .mcode {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 10.5px; line-height: 1.4; color: #9fb2d6;
      background: #0b1a30; border: 1px solid #14315a; border-radius: 4px;
      padding: 4px 6px; margin-top: 4px;
      white-space: pre-wrap; overflow-wrap: anywhere; max-height: 88px; overflow-y: auto;
    }
    /* The opted-in windows. Indented under the row they belong to, and scrollable
       rather than unbounded: a busy server can have a dozen, and the menu must not
       grow past the viewport it is anchored in. */
    .link-menu .rwins {
      display: flex; flex-direction: column; gap: 2px;
      margin: -2px 0 2px 22px; max-height: 168px; overflow-y: auto;
    }
    .link-menu .rwin {
      display: flex; align-items: center; gap: 6px; width: 100%;
      background: transparent; border: 1px solid transparent; border-radius: 4px;
      padding: 3px 6px; color: #c8d4ee; font: inherit; font-size: 11px;
      text-align: left; cursor: pointer;
    }
    .link-menu .rwin:hover:not([disabled]) { border-color: #0f3460; background: #0d1c33; }
    .link-menu .rwin[disabled] { opacity: 0.45; cursor: default; }
    .link-menu .rwin .mark { flex: 0 0 10px; margin-top: 0; color: #57d9a3; }
    /* The window's identity gets the room; the handler name is the smaller fact
       and shrinks first, because "which tab" is what you scan the list for. */
    .link-menu .rwin .rwname {
      flex: 1 1 auto; min-width: 0; overflow: hidden;
      text-overflow: ellipsis; white-space: nowrap;
    }
    .link-menu .rwin .rwh {
      flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis;
      white-space: nowrap; color: #7e8db0; font-size: 10.5px;
    }
    /* A window switched off still lists what it would run, in the same row, so
       turning it back on is not a leap of faith. */
    .link-menu .rwin.off .rwname, .link-menu .rwin.off .rwh { color: #6b7899; }
    /* The one failure this list can report: the hook ran and the name did not
       land. Amber, the same "waiting on you" colour the stoplight uses. */
    .link-menu .rwin .rwpend { flex: 0 0 auto; color: #ffb454; font-size: 15px; line-height: 1; }
    .link-menu .merr { color: #ff8fa3; font-size: 11px; line-height: 1.35; padding: 0 2px; }
  `, STOPLIGHT_CSS, ALERT_CSS, TIP_CSS, CONFIRM_CSS];

  constructor() {
    super();
    this.recent = [];
    this.recentHeld = 0;
    this.recentQueued = 0;
    this.recentTotal = 0;
    this.recentNext = null;
    // "Are you sure?" for the one destructive control up here — the same popup the
    // sidebar asks kill questions with, anchored at whatever was clicked.
    this._confirm = new ConfirmPopup(this);
    this.splitMenuOpen = false;
    this.collapsed = false;
    // Per-window override of which "how long" reading the duration badge shows
    // (see stoplight.js workBadgeModes()) — a plain Map, not a reactive property,
    // because it's read-modify-render entirely inside click handlers that already
    // call requestUpdate() themselves. Keyed by window id so it survives the
    // recents array being REPLACED wholesale on every layout poll (~500ms).
    this._badgeMode = new Map();
    // Scroll-wheel mode mirror (moved here from the sidebar). Seeded from the same
    // shared 'renderer' pref the terminal reads, so the label is right on first paint.
    this.scrollMode = normalizeScroll(stateStore.section('renderer').scrollMode || '');
    this.mouseMode = normalizeMouse(stateStore.section('renderer').mouseMode || '');
    this.copyMode = false; // focused pane in tmux copy/view mode (SplitManager sets)
    // Read straight from the ring singleton rather than being pushed by the
    // SplitManager: the clipboard is global, so the count is the same number for
    // every region and there is nothing for the manager to decide.
    this.bufferCount = copyBuffers.filled;
    this._unsubCopy = copyBuffers.subscribe(() => { this.bufferCount = copyBuffers.filled; });
    this.previewCount = 0;        // windows currently in the preview (SplitManager sets)
    this.previewHidden = false;   // preview tucked away (SplitManager sets)
    this.previewHasFocused = false; // focused window is in the preview (SplitManager sets)
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
    this.saveScope = DEFAULT_SAVE_SCOPE; // which buffer a save means (see save-scope.js)
    this._editingDir = false; // save-directory row open for editing (see _saveDirRow)
    this.uploadPick = null;      // files chosen to upload (see file-transfer.js)
    this.uploadOverwrite = false; // may an upload replace what is already there?
    this._xferDest = null;       // typed upload destination; null = use the prefill
    this._xferSrc = null;        // typed download source; null = untouched
    this.historyOpen = false;    // scrollback-buffer dropdown open?
    this.historyInfo = null;     // last report from the server
    this.historyStatus = null;   // transient result banner
    this.historyConfirm = null;  // pending "this rebuilds panes" question
    this.readOnly = false;   // set from the connect handshake (see write-guard.js)
    this.notice = '';        // transient explanation line
    this.previewWindow = ''; // window the shared hover preview is showing
    // Which recents tab the pointer is on, as this component last told the hover
    // controller — '' for none. Not derivable from `previewWindow` (that is what the
    // preview is SHOWING, which lags the pointer by the enter delay and stays empty
    // for a window already on screen), and it is what _syncTabHover compares the
    // strip against after a re-render. See "hovering a tab that changed underneath".
    this._hoverKey = '';
    this.labelMenuOpen = false;
    this.dragKey = '';
    this.dropIndex = -1;
    this.activity = 0;
    this.disconnected = false;
    this.lostRegions = 0;
    this.stalledRegions = 0;
    this.slowRegions = 0;
    this.linkState = 'live';
    this.linkMenuOpen = false;   // link menu (connection + tmux settings) open?
    this.tmuxSettings = null;    // last TmuxSettings report; null = never asked
    this.tmuxSettingsBusy = false;
    this.overflowAlerts = [];
  }

  // Pull the recents label-shape prefs out of the shared store (they ride @wt_state,
  // so the strip looks the same in every browser on this tmux server).
  _applyLabelPrefs() {
    const t = stateStore.section('toolbar');
    const prefs = labelPrefs(t);
    this.showSession = prefs.showSession;
    this.trimName = prefs.trimName;
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
    return windowLabel(w, { showSession: this.showSession, trimName: this.trimName });
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
    // Back to the whole buffer on every open. A scope is a decision about ONE
    // save, not a preference: someone who once grabbed a screenshot of a screen
    // should not silently get 24 rows the next time they reach for a build log.
    this.saveScope = DEFAULT_SAVE_SCOPE;
    // Same rule as the scope above, and for a stronger reason: a transfer acts on
    // another machine's filesystem, so a selection left over from the last time
    // this menu was open — possibly against a different window, in a different
    // session, on a different host — must not be one click from being sent.
    this.clearUploadPick();
    this._xferDest = null;
    this._xferSrc = null;
    this.manager?.requestSaveInfo?.();
    const def = this.manager?.suggestedSaveName?.() || 'pane.txt';
    this.updateComplete.then(() => {
      const el = this.renderRoot?.querySelector('.save-path');
      if (el) { if (!el.value) el.value = def; el.focus(); el.select(); }
    });
  }

  // "Download …" — hands the browser a .txt of the chosen buffer.
  //
  // The menu deliberately STAYS OPEN. It used to close on the click, which was
  // honest when the download was a synchronous read of a screen already in the
  // cache; a whole-buffer read is a round trip to tmux that can take a moment and
  // can fail, and its result — including how much text actually came out — is
  // reported in the banner this menu is the only home for.
  _saveToBrowser() {
    this._tipLeave();
    this.saveStatus = null;
    this.manager?.savePaneBuffer(this.saveScope);
  }

  // The scope chooser: which buffer BOTH destinations below mean.
  _saveScopeRow() {
    const current = normalizeScope(this.saveScope);
    return html`
      <div class="save-scope" role="radiogroup" aria-label="Which buffer to save">
        ${SCOPE_OPTIONS.map((opt) => html`
          <label class="save-scope-opt ${current === opt.value ? 'on' : ''}">
            <input
              type="radio"
              name="save-scope"
              .checked=${current === opt.value}
              @change=${() => { this.saveScope = opt.value; }}
            >
            <span>${opt.label}<span class="save-scope-note">${opt.note}</span></span>
          </label>
        `)}
      </div>
    `;
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
    this.manager?.savePaneBufferToPath(path, false, this.saveScope);
  }

  // The answer to "that file already exists". Re-sends the refused REQUEST (the
  // manager kept it) rather than re-reading the input, which the user may have
  // edited or scrolled away from since.
  _confirmOverwrite() {
    this.manager?.confirmOverwriteSave();
  }

  // ---- file transfer -------------------------------------------------------
  //
  // Two sections below the save half, moving whole FILES between the machine this
  // browser runs on and the machine tmux runs on. The wording rules — and why
  // every label names both machines rather than saying "upload" and trusting the
  // reader — are in file-transfer.js. The paths resolve through exactly the same
  // machinery as a save, so the directory question above answers both.

  // The two path boxes are backed by fields rather than read straight out of the
  // DOM on every render, the same pattern the scrollback panel's inputs use: an
  // upload posts a progress banner several times a second, and each one is a
  // re-render that would otherwise clobber whatever is half-typed beside it.
  // `null` means untouched, which is what lets the server's answer prefill them
  // the moment it lands rather than only on the next open.
  _uploadDest() {
    return this._xferDest ?? defaultTransferDir(this.saveInfo);
  }

  _downloadSrc() {
    return this._xferSrc ?? '';
  }

  // A pick happened. The plan (see uploadPlan) is kept whole rather than reduced
  // to a count, because the relative paths inside it are what make a folder
  // arrive as a folder.
  _pickUpload(e) {
    const plan = uploadPlan(e.target?.files);
    this.uploadPick = plan.files ? plan : null;
    this.uploadOverwrite = false;
    this.saveStatus = null;
  }

  // Forget the pick. Public because the SplitManager calls it after a clean
  // upload — a selection that has already been sent should not sit there looking
  // like it is about to be sent again.
  //
  // Clearing the INPUTS matters as much as clearing the field: a file input whose
  // value is unchanged fires no `change` event, so without this, picking the same
  // folder a second time (after fixing something in it) would appear to do
  // nothing at all.
  clearUploadPick() {
    this.uploadPick = null;
    this.uploadOverwrite = false;
    this.renderRoot?.querySelectorAll('.xfer-file').forEach((el) => { el.value = ''; });
  }

  _doUpload() {
    this.manager?.uploadToTmuxMachine(this.uploadPick, this._uploadDest(), this.uploadOverwrite);
  }

  _doDownload() {
    this.manager?.downloadFromTmuxMachine(this._downloadSrc());
  }

  // The two transfer sections. Read-only servers get a sentence instead — see
  // transferAllowed in server/handler_transfer.go for why a DOWNLOAD is gated on
  // the write flag too.
  _transferSections() {
    if (this.readOnly) {
      return html`
        <div class="save-sep"></div>
        <div class="save-label">Transfer files</div>
        <div class="save-ro">Not available — this server is read-only (started without -w).
          Reading a file is not a write, but ${'-w'} is what separates watching these terminals
          from acting on the machine behind them. Downloading the pane's buffer above still
          works: it only hands back what is already on your screen.</div>
      `;
    }
    // The save half is still asking which directory it may use, and that one
    // answer governs transfers too. Pointing at the question already on screen
    // beats asking it again here in different words.
    const asking = this._askingForDir();
    const plan = this.uploadPick;
    const hint = transferHint(this.saveInfo);
    return html`
      <div class="save-sep"></div>
      <div class="save-label">Transfer files</div>
      <div class="save-hint">${TRANSFER_BLURB}</div>

      <div class="xfer-pair">
      <div class="xfer">
        <div class="xfer-dir">${UPLOAD_TITLE}</div>
        <label class="xfer-lbl">Folder on ${THERE} to put them in</label>
        <input
          class="save-path xfer-dest"
          type="text"
          spellcheck="false"
          autocomplete="off"
          ?disabled=${asking}
          placeholder=${transferPlaceholder(this.saveInfo, 'upload')}
          .value=${this._uploadDest()}
          @input=${(e) => { this._xferDest = e.target.value; }}
          @keydown=${(e) => e.stopPropagation()}
        >
        <div class="xfer-pick">
          <label class="xfer-btn">Choose files…
            <input class="xfer-file" type="file" multiple ?disabled=${asking} @change=${(e) => this._pickUpload(e)}>
          </label>
          <label class="xfer-btn">Choose a folder…
            <input class="xfer-file" type="file" webkitdirectory ?disabled=${asking} @change=${(e) => this._pickUpload(e)}>
          </label>
        </div>
        ${plan ? html`
          <div class="xfer-sum">
            <span>${transferSummary(plan)}</span>
            <button class="save-dir-change" @click=${() => this.clearUploadPick()}>clear</button>
          </div>
          <label class="xfer-ow">
            <input
              type="checkbox"
              .checked=${this.uploadOverwrite}
              @change=${(e) => { this.uploadOverwrite = e.target.checked; }}
            >
            replace files that already exist
          </label>
        ` : ''}
        <button
          class="save-go xfer-go"
          ?disabled=${asking || !plan}
          @click=${() => this._doUpload()}
        >${uploadLabel(plan)}</button>
      </div>

      <div class="xfer">
        <div class="xfer-dir">${DOWNLOAD_TITLE}</div>
        <label class="xfer-lbl">File or folder on ${THERE}</label>
        <div class="save-row">
          <input
            class="save-path xfer-src"
            type="text"
            spellcheck="false"
            autocomplete="off"
            ?disabled=${asking}
            placeholder=${transferPlaceholder(this.saveInfo, 'download')}
            .value=${this._downloadSrc()}
            @input=${(e) => { this._xferSrc = e.target.value; }}
            @keydown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); this._doDownload(); } e.stopPropagation(); }}
          >
          <button class="save-go" ?disabled=${asking} @click=${() => this._doDownload()}>Download</button>
        </div>
      </div>
      </div>
      <div class="save-hint ${hint.level}">${hint.text}</div>
    `;
  }

  // ---- scrollback buffer ---------------------------------------------------
  //
  // The panel is laid out as an argument, in this order:
  //
  //   1. what this window's buffer IS — capacity, how full, per pane;
  //   2. what it would take to change it — a rebuild, stated as such;
  //   3. what NEW windows get, which is the only part that is a mere setting.
  //
  // (3) sits last on purpose even though it is the cheap, safe one. Putting the
  // setting first is what taught everybody that `history-limit` resizes a pane:
  // you change it, nothing happens to what you are looking at, and there is
  // nothing on screen to say why. Here the pane's own number is the first thing
  // you read, so the two can never be mistaken for each other.

  _toggleHistoryMenu() {
    this.historyOpen = !this.historyOpen;
    if (!this.historyOpen) return;
    this.historyStatus = null;
    this.historyConfirm = null;
    // Dropped first, like the save dropdown's env: a report about the window you
    // were looking at a minute ago must not be read as this one's while the fresh
    // answer is still in flight.
    this.historyInfo = null;
    this._histResize = null;
    this._histDefault = null;
    this.manager?.requestHistoryInfo?.();
  }

  _closeHistoryMenu() {
    this.historyOpen = false;
    this.historyStatus = null;
    this.historyConfirm = null;
  }

  // The two inputs are backed by fields rather than read out of the DOM, so a
  // re-render (a status line, the settling re-poll) can never clobber what
  // someone is halfway through typing. `null` means untouched, which is what lets
  // the current value prefill them the moment the report lands.
  _resizeValue() {
    return this._histResize ?? String(this.historyInfo?.default ?? '');
  }

  _defaultValue() {
    return this._histDefault ?? String(this.historyInfo?.default ?? '');
  }

  // Set what NEW windows are born with. Not a resize, and the banner says so.
  _setHistoryDefault() {
    const parsed = parseLimit(this._defaultValue());
    if (!parsed.ok) { this.historyStatus = { state: 'err', text: parsed.error }; return; }
    this.historyConfirm = null;
    this.manager?.setDefaultHistoryLimit(parsed.value);
  }

  // …and make it stick across tmux restarts, by writing the config file. Reads the
  // SAME input as "Set default": they are one number at two scopes, and two boxes
  // for it would invite them to disagree.
  _persistHistoryDefault() {
    const parsed = parseLimit(this._defaultValue());
    if (!parsed.ok) { this.historyStatus = { state: 'err', text: parsed.error }; return; }
    this.historyConfirm = null;
    this.manager?.persistDefaultHistoryLimit(parsed.value);
  }

  // Ask to rebuild. Never acts on the click: a rebuild kills what is running and
  // discards the scrollback, and neither is recoverable, so the plan is put on
  // screen in words first (see scrollback.js's resizePlan).
  _askResize(rerun = true) {
    const parsed = parseLimit(this._resizeValue());
    if (!parsed.ok) { this.historyStatus = { state: 'err', text: parsed.error }; return; }
    const plan = resizePlan(this.historyInfo?.panes || [], parsed.value, rerun);
    if (plan.none) { this.historyStatus = { state: 'ok', text: plan.text }; return; }
    this.historyStatus = null;
    // `relaunchable` drives the tickbox below; ticking it re-computes the plan,
    // because what the rebuild costs genuinely changes with the answer.
    this.historyConfirm = {
      kind: 'resize', limit: parsed.value, label: 'Rebuild', text: plan.text,
      rerun, relaunchable: plan.relaunchable || [],
    };
  }

  _askClear() {
    const n = (this.historyInfo?.panes || []).length || 1;
    this.historyStatus = null;
    this.historyConfirm = {
      kind: 'clear',
      label: 'Clear',
      text: `Discard the scrollback of ${n} pane${n === 1 ? '' : 's'} in this window. `
        + 'What is on screen stays, and nothing running is disturbed — but the '
        + 'history above it is gone. Download it first with ⤓ if you might want it.',
    };
  }

  _doHistoryConfirm() {
    const c = this.historyConfirm;
    if (!c) return;
    this.historyConfirm = null;
    // force: the user has just read what it costs and said yes. The server refuses
    // a rebuild without it (webtty/history.go), so this flag IS the confirmation.
    if (c.kind === 'resize') this.manager?.resizeWindowHistory(c.limit, true, !!c.rerun);
    else this.manager?.clearWindowHistory();
  }

  // The window's capacity and how much of it holds anything, with a per-pane
  // breakdown whenever there is more than one — a window's panes can genuinely
  // have different capacities (they were created at different times), and one
  // summary number would hide the pane that is about to start dropping lines.
  _historyUsage() {
    const panes = this.historyInfo?.panes || [];
    if (!panes.length) {
      return html`<div class="save-hint">${this.historyInfo?.error ? '' : 'Reading this window…'}</div>`;
    }
    const use = windowUsage(panes);
    return html`
      <div class="hist-num">
        <span>${use.mixed ? 'Smallest pane holds' : 'Buffer'} <b>${formatLines(use.limit)}</b> lines</span>
        <span><b>${formatLines(use.size)}</b> used · ${formatBytes(use.bytes)}</span>
      </div>
      <div class="hist-bar ${use.full ? 'full' : ''}">
        <div class="hist-fill" style="width:${Math.round(use.pct)}%"></div>
      </div>
      ${use.full ? html`
        <div class="save-hint warn">This buffer is full — tmux is already dropping its
          oldest lines to make room. Rebuild it bigger below, or download it with ⤓.</div>
      ` : ''}
      ${panes.length > 1 ? html`
        <div class="hist-panes">
          ${panes.map((p) => html`
            <div class="hist-pane ${p.active ? 'on' : ''}">
              <span>${p.active ? '▸' : ' '}${p.index}</span>
              <span class="cmd">${p.command || 'shell'}</span>
              <span>${formatLines(p.size)} / ${formatLines(p.limit)}</span>
              <span>${formatBytes(p.bytes)}</span>
            </div>
          `)}
        </div>
      ` : ''}
    `;
  }

  _historyPresets(apply) {
    return html`
      <div class="hist-presets">
        ${HISTORY_PRESETS.map((n) => html`
          <button class="hist-preset" @click=${() => { apply(String(n)); this.requestUpdate(); }}>
            ${formatLines(n)}
          </button>
        `)}
      </div>
    `;
  }

  _historyMenu() {
    const info = this.historyInfo;
    const confirm = this.historyConfirm;
    return html`
      <div class="save-backdrop" @click=${() => this._closeHistoryMenu()}></div>
      <div class="save-menu hist" @click=${(e) => e.stopPropagation()}>
        <div class="save-label">This window's scrollback</div>
        ${this._historyUsage()}

        ${this.readOnly ? html`
          <div class="save-sep"></div>
          <div class="save-ro">${READ_ONLY_NOTICE} Buffer sizes are shown because reading
            them changes nothing; resizing or clearing one would.</div>
        ` : html`
          <div class="save-sep"></div>
          <div class="save-label">Resize this window</div>
          <div class="save-row">
            <input
              class="save-path"
              type="text"
              inputmode="numeric"
              spellcheck="false"
              autocomplete="off"
              placeholder="lines"
              .value=${this._resizeValue()}
              @input=${(e) => { this._histResize = e.target.value; }}
              @keydown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); this._askResize(); } e.stopPropagation(); }}
            >
            <button class="save-go" @click=${() => this._askResize()}>Resize</button>
          </div>
          ${this._historyPresets((v) => { this._histResize = v; })}
          <div class="save-hint">tmux fixes a pane's buffer when the pane is created,
            so this rebuilds the panes: the shells restart in place and the current
            scrollback is lost. Anything still running is killed.</div>

          <div class="save-sep"></div>
          <div class="save-label">New windows</div>
          <div class="save-row">
            <input
              class="save-path"
              type="text"
              inputmode="numeric"
              spellcheck="false"
              autocomplete="off"
              placeholder="lines"
              .value=${this._defaultValue()}
              @input=${(e) => { this._histDefault = e.target.value; }}
              @keydown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); this._setHistoryDefault(); } e.stopPropagation(); }}
            >
            <button class="save-go" @click=${() => this._setHistoryDefault()}>Set default</button>
          </div>
          ${this._historyPresets((v) => { this._histDefault = v; })}
          <div class="save-hint">Every window and pane created from now on
            (<code>set-option -g history-limit</code>). Windows that already exist keep
            the size they were born with${info && info.global !== info.default
              ? ` — and this session overrides the server default of ${formatLines(info.global)}`
              : ''}.</div>
          <button class="hist-persist" @click=${() => this._persistHistoryDefault()}>
            Also save it for future tmux servers
          </button>
          <div class="save-hint">A default set above lasts only as long as this tmux
            SERVER — a reboot or <code>tmux kill-server</code> puts it back. This writes
            <code>set -g history-limit</code> into ${configFileHint(info?.configFiles)},
            which every tmux started afterwards reads.</div>

          <div class="save-sep"></div>
          <button class="hist-clear" @click=${() => this._askClear()}>
            Clear this window's scrollback
          </button>
        `}

        ${confirm ? html`
          <div class="save-status confirm">${confirm.text}</div>
          ${confirm.relaunchable?.length ? html`
            <label class="hist-rerun">
              <input
                type="checkbox"
                .checked=${!!confirm.rerun}
                @change=${(e) => this._askResize(e.target.checked)}
              >
              <span>Start ${confirm.relaunchable.map(workName).join(', ')} again afterwards
                <span class="save-scope-note">tmux launched this window with it, so the
                  rebuilt pane can run it too — from the beginning, not where it left
                  off.</span></span>
            </label>
          ` : ''}
          <div class="save-confirm">
            <button @click=${() => this._doHistoryConfirm()}>${confirm.label}</button>
            <button class="cancel" @click=${() => { this.historyConfirm = null; }}>Cancel</button>
          </div>
        ` : ''}
        ${this.historyStatus ? html`
          <div class="save-status ${this.historyStatus.state}">${this.historyStatus.text}</div>
        ` : ''}
      </div>
    `;
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    clearTimeout(this._buildTipTimer);
    this._tip.dispose();
    this._confirm.dispose();
    this._unsubCopy?.();
    this._stripObserver?.disconnect();
    this._stripObserver = null;
    this.manager?.hover?.cancel();
  }

  // Thin wrappers over the shared hint controller (tooltip.js). Kept as methods
  // because the ~30 call sites in render() read better as _tipEnter/_tipLeave than
  // as reaching through a field, and because the sidebar shows the same hint for
  // the same stoplight — the delay and the look have to come from one place.
  _tipEnter(ev, text) {
    this._tip.enter(ev, text);
  }
  _tipLeave() { this._tip.leave(); }

  // ---- hovering a tab that changed underneath -----------------------------------
  //
  // A recents tab is a SLOT, not a window. The strip re-renders on every layout push
  // and lit reuses the tab elements positionally, so the window a tab stands for can
  // change while the same DOM node sits under a motionless pointer — × on a tab is
  // the everyday case, because the entry at the head of the off-strip queue slides
  // straight into the slot the pointer is already on.
  //
  // No mouse event reports that. mouseenter/mouseleave fire when the POINTER crosses
  // an element boundary, and here nothing crossed anything: the node kept its
  // identity and only its data changed. So the hover state the strip had told
  // HoverPreview about was the old window's — and the user had to move the pointer
  // off the tab and back to see the preview of the tab they were already pointing at.
  //
  // The fix is to re-derive the hover from the DOM after every render instead of
  // trusting the events alone. `:hover` is the browser's own answer to "what is the
  // pointer on", it needs no pointer-position bookkeeping of our own, and — unlike
  // the events — it is a state, so it is still true for a node whose contents were
  // swapped. Everything below funnels through _tabEnter/_tabLeave so the event path
  // and the re-render path can't develop different ideas of what is hovered.

  // Point at a tab: hint it, and start the shared preview. Idempotent — the entry
  // path and the post-render sync can both call it for the same tab.
  _tabEnter(el, w) {
    if (!el || !w) return;
    this._hoverKey = this._key(w);
    this._tipEnter({ currentTarget: el }, this._tabTip(w));
    this.manager?.hover?.enter(w.id, w.session);
  }

  // Stop pointing at a tab. The preview controller applies its own leave grace, so
  // sweeping from one tab to the next doesn't tear anything down.
  _tabLeave() {
    this._hoverKey = '';
    this._tipLeave();
    this.manager?.hover?.leave();
  }

  // What a tab says when you point at it. Recomputed (rather than captured in the
  // render closure) so the sync below can re-hint a slot whose window changed.
  //
  // A window shown in ANOTHER split view still comes to the focused view when you
  // pick it — the two views trade windows — so the hint says that rather than
  // pretending it is out of reach.
  _tabTip(w) {
    const full = windowTitle(w.session, w.index, w.name);
    // One-line name, blank line, what it does — the toolbar's tooltip layout. The
    // alert line (it starts with its own newline) gets a blank line of its own too.
    return (w.elsewhere
      ? `${full}\n\nOn screen in another view — click to bring it into the focused view (the two views trade windows) · drag to reorder`
      : `${full}\n\nHover to preview it in the focused view · click to switch there · drag to reorder`)
      + (w.alert ? '\n' + alertTip(w.alert) : '');
  }

  // Re-read what the pointer is on after a render, and re-point the preview when the
  // answer changed without a mouse event to announce it. Runs from updated(), so it
  // catches the slot swap in the same frame that draws it — and, because the strip
  // re-renders with every layout push, it also self-corrects within one poll for any
  // rearrangement the browser reports late (a tab APPEARING under a still pointer
  // updates `:hover` only after the next layout).
  //
  // The "nothing is hovered any more" branch matters just as much: when the last tab
  // is removed and no queued entry replaces it, the node under the pointer is deleted
  // outright and there is no element left to fire a mouseleave — without this the
  // preview would sit there held open by a hover that has ceased to exist.
  _syncTabHover() {
    // Not mid-drag. A drag is a rearrangement, not a browse (_onTabDragStart cancels
    // the preview on purpose), and the hover state under a dragged tab is the
    // browser's to interpret — re-opening a preview from it would undo that cancel
    // on every drop-indicator re-render.
    if (this.dragKey) return;
    const tabs = this.renderRoot?.querySelector('.tabs');
    if (!tabs) return;
    // The invisible width probe is excluded: it is `pointer-events: none`, so it can
    // never be what the pointer is on, and it is not in `this.recent` either.
    const els = [...tabs.querySelectorAll('.rtab:not(.spare)')];
    const i = els.findIndex((el) => el.matches(':hover'));
    const w = i >= 0 ? this.recent[i] : null;
    const key = w ? this._key(w) : '';
    if (key === this._hoverKey) return;
    if (!w) { this._tabLeave(); return; }
    this._tabEnter(els[i], w);
    // …and hint whichever control inside the tab the pointer actually ended up on.
    // After a × click that is the new tab's ×, sitting in the same place the old
    // one was.
    const inner = els[i].querySelector('.close');
    if (inner?.matches(':hover')) this._tipEnter({ currentTarget: inner }, CLOSE_TAB_TIP);
    const dot = els[i].querySelector('.work');
    if (dot?.matches(':hover')) this._tipEnter({ currentTarget: dot }, workTip(w.working, w.workingSince, w.activity));
    const age = els[i].querySelector('.work-age');
    if (age?.matches(':hover')) this._tipEnter({ currentTarget: age }, workBadgeTip(w.workingSince, w.activity, undefined, this._badgeMode.get(w.id)));
  }

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
    // We just told the controller "nothing is hovered", so say so here too — else the
    // post-drop sync would compare against a tab it thinks is still previewing and
    // leave the dropped tab, now under the pointer, without one.
    this._hoverKey = '';
    // A tab can be dropped on a view to put it there, so every region is told to
    // show itself as a target for the length of the drag.
    this.manager?.noteRecentDrag?.(true);
    try {
      e.dataTransfer.effectAllowed = 'move';
      // A PRIVATE type, not text/plain: the regions have to decide in `dragover`
      // whether they accept this, and `types` is all that is readable that early —
      // see RECENT_DRAG_TYPE. It doubles as the strip's own drop payload, so both
      // drops read the same thing.
      e.dataTransfer.setData(RECENT_DRAG_TYPE, recentDragPayload(w));
    } catch (_) {}
  }

  _onTabDragEnd() {
    this.dragKey = '';
    this.dropIndex = -1;
    this.manager?.noteRecentDrag?.(false);
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

  // The dragged tab's identity recovered from the drop payload — the fallback for a
  // stray re-render that cleared dragKey. Matched back against the strip rather than
  // trusted as a key, so a payload from anywhere else can't name a tab.
  _dtKey(e) {
    let raw = '';
    try { raw = e.dataTransfer.getData(RECENT_DRAG_TYPE) || ''; } catch (_) { return ''; }
    const drag = parseRecentDrag(raw);
    if (!drag) return '';
    const entry = this.recent.find((w) => w.id === drag.id && (w.session || '') === drag.session);
    return entry ? this._key(entry) : '';
  }

  // ---- recents label-shape menu ------------------------------------------------
  // Hung off the "Recent" label itself rather than adding another toolbar button:
  // it's a rarely-touched display preference, and the label is exactly the thing it
  // is about.
  // The split button's menu. With one view there is one question — which way to split
  // it. Once the screen is split there are two: divide the FOCUSED view, or add a view
  // across the WHOLE screen (full height on the right, full width along the bottom) —
  // without the second, a left | right split could only ever be subdivided further,
  // never given a strip that runs the full width under both halves.
  _splitMenu() {
    const pick = (dir, span = false) => { this.splitMenuOpen = false; this.manager?.splitAdd(dir, { span }); };
    const split = (this.manager?.units?.length || 0) > 1;
    return html`
      <div class="label-backdrop" @click=${() => { this.splitMenuOpen = false; }}></div>
      <div class="label-menu split-menu" @click=${(e) => e.stopPropagation()}>
        <div class="mtitle">${split ? 'Split the focused view' : 'Split the view'}</div>
        <button class="mitem" @click=${() => pick('row')}>
          <span class="mark">◫</span> Left | right <span class="mkey">${chord('%')} · ${chord('⏎')}</span>
        </button>
        <button class="mitem" @click=${() => pick('col')}>
          <span class="mark">⊟</span> Top / bottom <span class="mkey">${chord('"')}</span>
        </button>
        ${split ? html`
          <div class="mtitle">Add a view across the whole screen</div>
          <button class="mitem span" @click=${() => pick('row', true)}>
            <span class="mark">▐</span> Full height, on the right
          </button>
          <button class="mitem span" @click=${() => pick('col', true)}>
            <span class="mark">▄</span> Full width, along the bottom
          </button>
        ` : ''}
      </div>
    `;
  }

  _labelMenu() {
    const sample = this.recent[0] || { session: 'services', name: 'ssh web-01', index: 3 };
    const shape = (showSession, trimName) => windowLabel(sample, { showSession, trimName });
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
            ? 'one tab; every other window waits in line behind it'
            : `${this.recentMax} tabs, then the least recently used one waits in line`}${
              this.recentQueued
                ? ` — ${this.recentQueued} waiting; +1 brings the next one back`
                : ''}
        </div>
        ${this._widthBound() ? html`
          <div class="mprev">
            only ${this.recent.length} fit in this window right now, so raising the number
            here changes nothing until it is wider — the rest are waiting, not closed
          </div>
        ` : ''}
        <button
          class="mitem danger"
          ?disabled=${!this.recentTotal}
          @click=${(e) => { this.labelMenuOpen = false; this._askClearRecents(e.currentTarget); }}
        ><span class="mark"></span>Clear the strip${this.recentTotal ? ` (${this.recentTotal})` : ''}…</button>
        <div class="mtitle">Labels — tabs and preview tiles</div>
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

  // ---- clearing the strip --------------------------------------------------------
  //
  // Two ways in, on purpose, and they run the same code.
  //
  // The ✕ beside the label is the one the gesture deserves — clearing follows a run of
  // × clicks that didn't do what the user wanted, and it should not be three clicks
  // deeper than the thing it rescues. It is revealed on hover so it isn't a permanent
  // destructive control sitting among the ordinary ones.
  //
  // But hover is not a gesture a touch device has, and hidden-until-hovered is not a
  // thing you can find by looking. So the menu — where every other strip-wide decision
  // already lives, and which is reachable by tap and by keyboard — carries it too, in
  // words, with the count spelled out.

  // Both hang off the "Recent ▾" label, which is now rendered UNCONDITIONALLY — it used
  // to appear only once the strip held something. That gate was harmless while the only
  // way to an empty strip was a fresh boot, where the first focus admits a window inside
  // the first poll. It stops being harmless the moment the strip can be emptied on
  // purpose: the label is the only door to the tab-count control AND to the clear
  // itself, so a clear that takes its own way back off screen is a trapdoor. The cost
  // is one quiet word on a toolbar that is never empty in practice.

  // The reveal-on-hover ✕. Rendered even with nothing to clear (disabled, and the CSS
  // keeps it invisible either way) so the space it reserves never changes: it sits
  // inside the width the strip fits its tabs into, and a control that came and went
  // with the count would re-fit the strip underneath it.
  _clearButton() {
    const n = this.recentTotal;
    const hidden = Math.max(0, n - this.recent.length);
    return html`
      <button
        class="label-clear"
        ?disabled=${!n}
        aria-label="Clear the recents strip"
        @mouseenter=${(e) => this._tipEnter(e, `Clear the recents strip — all ${n} remembered ${n === 1 ? 'window' : 'windows'}`
          + (hidden ? `, including the ${hidden} with no tab right now (waiting behind the last tab, or held by the preview)` : '')
          + `.\n\nThis is the one that empties it: × on a tab frees a slot, and the next window in line immediately takes it.`
          + `\n\nNothing is closed or killed — the windows keep running and the split regions keep their views.`)}
        @mouseleave=${() => this._tipLeave()}
        @click=${(e) => { this._tipLeave(); this._askClearRecents(e.currentTarget); }}
      >✕</button>
    `;
  }

  // Ask before emptying it. Destructive and not undoable (the strip's hand-arranged
  // order is real work), so it goes through the shared confirm popup — anchored at
  // whichever control asked, like every other question in the app.
  //
  // The message leads with the number the user cannot see, because that number IS the
  // confusion this affordance answers: a strip that "won't empty" is a strip with a
  // queue behind it, and saying so here is the only place the queue is ever named at
  // the moment it matters.
  _askClearRecents(anchor) {
    const n = this.recentTotal;
    if (!n || !anchor) return;
    const hidden = Math.max(0, n - this.recent.length);
    this._confirm.ask(anchor, {
      message: `Clear the recents strip?\n\n${n} remembered ${n === 1 ? 'window' : 'windows'}`
        + (hidden
          ? ` — ${this.recent.length} with a tab, ${hidden} with none yet (waiting behind the last tab, or held by the preview).`
          : '.')
        + `\n\nThe windows keep running; only the strip forgets them.`,
      yes: 'Clear',
      onConfirm: () => this.manager?.clearRecents(),
    });
  }

  // The overflow arrow at the end of the strip: N windows need you and none of them
  // has a tab here. Clicking it opens the window list and points the browse at the
  // most recent one — see SplitManager.revealOverflowAlert.
  // Is the browser window, rather than the user's own cap, what is holding tabs back?
  // The strip is drawing fewer tabs than the cap allows AND there are windows queued
  // for a slot: the only thing that can mean is that they don't fit. Worth saying out
  // loud in the menu, because the number in there stops responding when it's true.
  _widthBound() {
    return this.recentQueued > 0 && this.recent.length < this.recentMax;
  }

  // Click-to-cycle the duration badge between its available readings (see
  // stoplight.js workBadgeModes()/nextBadgeMode()). The caller already checked
  // there's something to cycle TO before wiring this up.
  _cycleBadgeMode(w) {
    // No override yet means the badge is showing workBadge()'s own auto preference,
    // which is exactly workBadgeModes()[0] by construction — treat that as "current"
    // so the first click moves to the OTHER mode, not a no-op wrap back to itself.
    const modes = workBadgeModes(w.workingSince, w.activity);
    const current = this._badgeMode.get(w.id) || modes[0];
    this._badgeMode.set(w.id, nextBadgeMode(current, w.workingSince, w.activity));
    this.requestUpdate();
  }

  // One recents tab. Also renders the width probe (`spare`), and that is the reason
  // this is a function rather than inline markup: the probe has to be the SAME BOX as
  // a real tab or it measures a lie, and two copies of this template would drift apart
  // the first time a tab grew a badge. The handlers come along for the ride — a spare
  // is `visibility: hidden; pointer-events: none`, so none of them can fire.
  _recentTab(w, i, spare = false) {
    const key = this._key(w);
    const full = windowTitle(w.session, w.index, w.name);
    const tip = this._tabTip(w);
    const last = !spare && i === this.recent.length - 1;
    // An explicit override (from clicking the badge) wins; otherwise fall back to
    // the default/auto reading split-manager already computed into w.badge — kept
    // as the fallback rather than always recomputing here so the width-fitting
    // probe (which renders the NEXT tab via this same function) measures exactly
    // what a real, never-yet-clicked tab would show.
    const badgeMode = this._badgeMode.get(w.id);
    const badge = badgeMode ? workBadge(w.workingSince, w.activity, undefined, badgeMode) : w.badge;
    const cyclable = workBadgeModes(w.workingSince, w.activity).length > 1;
    return html`
          <span
            class="rtab ${spare ? 'spare' : ''} ${!spare && this.dragKey === key ? 'dragging' : ''} ${!spare && this.dragKey && this.dropIndex === i ? 'drop-before' : ''} ${!spare && this.dragKey && last && this.dropIndex === this.recent.length ? 'drop-end' : ''}"
            aria-hidden=${spare ? 'true' : 'false'}
            draggable=${spare ? 'false' : 'true'}
            @dragstart=${(e) => this._onTabDragStart(e, w)}
            @dragend=${() => this._onTabDragEnd()}
            @mouseenter=${(e) => this._tabEnter(e.currentTarget, w)}
            @mouseleave=${() => this._tabLeave()}
          ><span
            class="work stoplight ${workClass(w.working)}"
            role="img"
            aria-label=${workLabel(w.working)}
            @mouseenter=${(e) => { e.stopPropagation(); this._tipEnter(e, workTip(w.working, w.workingSince, w.activity)); }}
            @mouseleave=${(e) => { e.stopPropagation(); this._tipEnter({ currentTarget: e.currentTarget.closest('.rtab') }, tip); }}
          ></span>${badge ? html`<span
            class="work-age ${cyclable ? 'cyclable' : ''}"
            aria-label=${badge}
            @click=${(e) => { e.stopPropagation(); if (cyclable) this._cycleBadgeMode(w); }}
            @mouseenter=${(e) => { e.stopPropagation(); this._tipEnter(e, workBadgeTip(w.workingSince, w.activity, undefined, badgeMode)); }}
            @mouseleave=${(e) => { e.stopPropagation(); this._tipEnter({ currentTarget: e.currentTarget.closest('.rtab') }, tip); }}
          >${badge}</span>` : ''}<button
            class="tab ${w.active ? 'active' : ''} ${w.elsewhere ? 'elsewhere' : ''} ${!w.active && this.previewWindow === w.id ? 'previewing' : ''} ${alertClass(w.alert)}"
            aria-label=${full}
            @click=${() => { this._tipLeave(); this.manager?.pickRecentWindow(w); }}
          ><span class="sess">${w.index}</span><span class="wname">${this._tabLabel(w)}</span><span
              class="close"
              aria-label="Remove from Recent (does not close the window)"
              @mouseenter=${(e) => { e.stopPropagation(); this._tipEnter(e, CLOSE_TAB_TIP); }}
              @mouseleave=${(e) => { e.stopPropagation(); this._tipEnter({ currentTarget: e.currentTarget.closest('.tab') }, tip); }}
              @click=${(e) => { e.stopPropagation(); this._tipLeave(); this.manager?.removeRecent(w); }}
            >×</span></button></span>
    `;
  }

  // ---- fitting the strip to the toolbar ----------------------------------------
  //
  // The tabs used to overflow into a horizontal scrollbar. A switcher you have to
  // scroll to see isn't glance-able, and the scrolled-away tabs were invisible to the
  // alert machinery as well — they HAD tabs, so the overflow arrow didn't speak for
  // them, and a window flashing for attention could sit off the left edge unseen.
  //
  // So the strip is measured against the space it has and the surplus is queued (see
  // recents-strip.js "the width cap"). The manager owns the resulting cap; this is the
  // measurement it can't make, reported after every render and on every resize.
  //
  // Three widths go into the answer, most trustworthy first:
  //   • the drawn tabs — measured;
  //   • the next window in line — measured too, via the invisible spare, which is what
  //     makes GROWING exact rather than a guess that oscillates;
  //   • the slots beyond that — assumed to look like the widest tab on screen. Only
  //     this last one is an estimate, and it only decides how much room the strip
  //     claims to have SPARE, which is what a newly-visited window is placed against.
  _fitStrip() {
    const tabs = this.renderRoot?.querySelector('.tabs');
    if (!tabs || !this.manager) return;
    // Not while the pointer is on the strip. A hovered tab reveals its × and so grows
    // by ~18px, and re-fitting against that would drop the last tab the moment you
    // reached for one — then put it back when you left. The measurement resumes on the
    // way out; nothing else in here changes while a mouse sits still.
    if (tabs.matches(':hover')) return;
    const gap = this._stripGap(tabs);
    const widths = [];
    let spare = 0;
    for (const el of tabs.querySelectorAll('.rtab')) {
      const w = el.getBoundingClientRect().width;
      if (el.classList.contains('spare')) spare = w;
      else widths.push(w);
    }
    // Nothing drawn yet: no measurement to report. Say nothing rather than "1 fits" —
    // the strip is empty because there are no recents, not because it is out of room.
    if (!widths.length) return;
    const widest = Math.max(...widths, spare);
    const candidates = [...widths];
    if (spare) candidates.push(spare);
    while (candidates.length < RECENTS_MAX) candidates.push(widest);
    this.manager.setRecentsFit(fitTabCount(candidates, tabs.clientWidth, gap));
  }

  // The flex gap between tabs, read from the stylesheet rather than repeated here so
  // the arithmetic can't disagree with the layout. Cached: _fitStrip runs on every
  // toolbar update (twice a second, with the layout push) and the gap never changes.
  _stripGap(tabs) {
    if (this._gapPx == null) {
      const raw = parseFloat(getComputedStyle(tabs).columnGap);
      this._gapPx = Number.isFinite(raw) ? raw : 6;
    }
    return this._gapPx;
  }

  // A window resize changes the strip's width without changing a single property, so
  // updated() alone would leave the fit stale until the next layout push happened to
  // re-render. Observing the box itself also catches the toolbar's OWN reflows — a
  // long notice, the read-only badge, the overflow arrow appearing — which take room
  // from the tabs just as surely as dragging the window narrower does.
  //
  // Idempotent and driven from updated() rather than firstUpdated() so a detach/attach
  // (or a first render with no strip to observe yet) re-arms it instead of silently
  // leaving the strip unfitted for the rest of the session.
  _observeStrip() {
    if (this._stripObserver || typeof ResizeObserver === 'undefined') return;
    const tabs = this.renderRoot?.querySelector('.tabs');
    if (!tabs) return;
    this._stripObserver = new ResizeObserver(() => this._fitStrip());
    this._stripObserver.observe(tabs);
  }

  updated() {
    this._observeStrip();
    this._fitStrip();
    // After the strip is drawn, not before: the answer to "which window is the
    // pointer on" is read off the tabs this render just produced.
    this._syncTabHover();
  }

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

  // What the AMBER spinner says. The distinction it is drawing is the one that took a
  // dead link ten seconds to admit to: we asked, and the answer is late — which is what
  // a loaded box looks like, and also what a dead one looks like for its first second.
  // So it says how long, and says plainly that it does not know yet which of the two
  // this is. The seconds are read live from the manager at hover time, so the number is
  // the number now and not whenever the toolbar last re-rendered.
  _slowTip() {
    const waited = this.manager?.linkWaitedMs?.() || 0;
    const secs = Math.max(1, Math.round(waited / 1000));
    const n = this.slowRegions || 0;
    const which = n > 1 ? `${n} terminal regions have` : 'The terminal has';
    return `tmux is answering slowly. ${which} been waiting about ${secs}s for a reply`
      + ` to something already sent.\n\nThis is normally a busy machine or a slow link and`
      + ` clears itself — what is on screen is still current, and anything you type is`
      + ` queued, not lost. If it goes red, the link is gone rather than late.`;
  }

  // Which of the three the spinner is showing. Derived from linkState so there is one
  // answer, and defaulted from the old boolean so a caller that only sets `disconnected`
  // still gets red rather than silently nothing.
  _linkClass() {
    if (this.linkState === 'lost' || this.disconnected) return 'lost';
    return this.linkState === 'slow' ? 'slow' : '';
  }

  // The link's state as a headline and a body, ONE string each, used by both the
  // hover hint and the menu row. They used to be two texts saying the same thing
  // in two places, which is how a tooltip ends up a version behind the panel it
  // duplicates. The body keeps its paragraph breaks; the menu renders them with
  // white-space: pre-line and the tooltip renders them as-is.
  _linkDetail() {
    const kind = this._linkClass();
    if (kind === 'lost') return { kind, head: 'Connection to tmux lost', body: this._lostTip() };
    if (kind === 'slow') return { kind, head: 'tmux is answering slowly', body: this._slowTip() };
    return {
      kind: 'live',
      head: 'Connected to tmux',
      body: 'The spinner advances one notch each time webtmux sends tmux a command'
        + ' (window switches, renames, captures, saved state), so it flicks when'
        + ' something is driving tmux and sits still when nothing is.'
        + '\n\nIt turns amber when webtmux has asked tmux something and is still'
        + ' waiting, and red when the link is gone.',
    };
  }

  // ---- the link menu ------------------------------------------------------------
  // The spinner was the only control on the bar that reported without doing
  // anything, and its report was locked inside a hover hint: a paragraph you had
  // to keep the pointer still to read, that vanished if you moved to reach for
  // anything, and that could not hold a control. Giving it a menu costs nothing —
  // the icon keeps spinning and keeps its colour — and buys the one thing the bar
  // had no home for: SETTINGS THAT BELONG TO TMUX rather than to webtmux.
  //
  // That distinction is the whole reason this is not another .tbtn. Every other
  // menu on this bar changes how webtmux behaves. The rows here change the tmux
  // SERVER, which other clients are attached to — so they live behind the control
  // that is already about the link to that server, and each says who else it
  // affects.
  _toggleLinkMenu() {
    this.linkMenuOpen = !this.linkMenuOpen;
    if (!this.linkMenuOpen) return;
    // Clear any in-flight marker left by a toggle whose reply never landed (the
    // socket dropped while it was out). Without this the row would stay disabled
    // for the life of the page, which looks exactly like a setting that is not
    // allowed rather than one whose answer went missing.
    this.tmuxSettingsBusy = false;
    // Ask tmux on every open rather than trusting the last answer. `status` can be
    // changed from a terminal attached to the same server, from .tmux.conf, or by
    // another browser — a checkbox drawn from what THIS page last set would be
    // confidently wrong in all three cases.
    this.manager?.requestTmuxSettings?.();
  }

  // Flip the tmux status line. Nothing is drawn optimistically: the reply carries
  // the state tmux was actually left in (see webtty/settings.go), and a toggle that
  // ticked itself before tmux agreed would show "on" against a server that had
  // refused.
  _toggleStatusBar() {
    const on = !!this.tmuxSettings?.on;
    this.manager?.setTmuxStatusBar?.(!on);
  }

  // Flip whether a program running in a pane can put text on THIS browser's
  // clipboard. Nothing optimistic, same as above.
  _toggleClipboard() {
    const on = !!this.tmuxSettings?.clipboardOn;
    this.manager?.setTmuxClipboard?.(!on);
  }

  // Flip tmux's `after-rename-window` hook as a whole, and one window's opt-in to
  // it. Nothing optimistic, same as above.
  _toggleRenameForward() {
    const on = !!this.tmuxSettings?.renameOn;
    this.manager?.setTmuxRenameForward?.(!on, '');
  }

  _toggleRenameWindow(w) {
    this.manager?.setTmuxRenameForward?.(!w.on, w.id);
  }

  // The rename row's second line. It has a harder job than the other two: those
  // describe a tmux setting most people have at least heard of, while this one has
  // to establish that renaming a window can RUN something at all — a tmux ability
  // that lives in `show-hooks`, a command almost nobody types.
  _renameHint(set) {
    const what = 'tmux can run a command every time a window is renamed'
      + ' (`set-hook -g after-rename-window`). It is a server-wide hook, so it'
      + ' covers a rename typed here, one from `⌃b ,`, and one from a script.';
    if (!set) return what;
    if (set.renameOn) {
      const n = (set.renameWindows || []).filter((w) => w.on).length;
      const who = n === 0
        ? ' No window has opted in, so nothing happens on a rename yet.'
        : ` ${n} window${n === 1 ? '' : 's'} below ${n === 1 ? 'has' : 'have'} opted in`
          + ' — renaming one of those does something as well as changing the name.';
      return `${what} It is set on this server:${who}`;
    }
    if (set.renameSaved) {
      return `${what} Switched off from here — the command is remembered and goes`
        + ' back exactly as it was.';
    }
    // The honest third state. An off checkbox over a server that never had a hook
    // would invite a click that cannot do anything, so the row says so and is inert.
    return `${what} Nothing is hooked on this server. webtmux does not write the`
      + ' command itself — it names a script on the machine tmux runs on, which'
      + ' this browser cannot see — so it can only switch off one that is there'
      + ' and put it back.';
  }

  // The per-window list under the rename row: which windows do something when you
  // rename them, and what. This is the part that makes the row worth opening —
  // "a hook is installed" is server trivia, "this tab renames its Claude session"
  // is the thing you actually wanted to know.
  _renameWindowRows(set, locked) {
    const wins = set?.renameWindows || [];
    if (!wins.length) return '';
    return html`
      <div class="rwins">
        ${wins.map((w) => html`
          <button
            class="rwin ${w.on ? '' : 'off'}"
            ?disabled=${locked || this.tmuxSettingsBusy}
            aria-pressed=${w.on ? 'true' : 'false'}
            title=${w.on
              ? `Renaming ${w.session}:${w.name} runs "${w.handler}"`
                + (w.pane ? ` against pane ${w.pane}` : '')
                + (w.synced ? '' : ' — its last rename has not been applied')
              : `Renaming ${w.session}:${w.name} does nothing. Click to restore "${w.handler}".`}
            @click=${() => this._toggleRenameWindow(w)}
          >
            <span class="mark">${w.on ? '✓' : ''}</span>
            <span class="rwname">${w.session}:${w.name}</span>
            <span class="rwh">${w.handler}</span>
            ${w.on && !w.synced ? html`<span class="rwpend" title="The last rename has not reached it">·</span>` : ''}
          </button>
        `)}
      </div>
    `;
  }

  // The clipboard row's second line. This one has to explain a mechanism, not just
  // a preference, because the thing it fixes looks like a bug in the OTHER program:
  // you press the key it offers, it says it copied, and nothing is on your
  // clipboard — with no error anywhere, because tmux dropped the request silently.
  _clipboardHint(set) {
    const scope = 'set-clipboard is a tmux server option, so this applies to every'
      + ' client on this tmux server.';
    const what = 'A program in a pane can offer to copy something — a login URL, a'
      + ' token — by writing an OSC 52 escape. webtmux turns that into a copy on the'
      + ' clipboard of the machine running this browser, which is the one you can'
      + ' paste from.';
    if (!set) return `${what} ${scope}`;
    if (set.clipboardOn) {
      return `${what} tmux is forwarding those (\`set-clipboard on\`), so "press c to`
        + ` copy" in a pane reaches you here. Any program in any pane can then replace`
        + ` your clipboard — but not read it, and not quietly: every arriving copy`
        + ` floats the copy buffers panel in showing what it was, and the one it`
        + ` replaced is still a row above it. ${scope}`;
    }
    // The two "no" values are not the same and the difference is worth a sentence:
    // one still lets tmux's OWN copies out, the other lets nothing out at all.
    const state = set.clipboard === 'off'
      ? 'tmux is dropping them, and its own copy-mode yanks too (`set-clipboard off`).'
      : `tmux is dropping them (\`set-clipboard ${set.clipboard || 'external'}\`) — its own`
        + ' copy-mode yanks still get through, but a program\'s do not. This is tmux\'s'
        + ' default, and it is why "(c to copy)" in a remote program appears to do nothing.';
    return `${what} ${state} ${scope}`;
  }

  // The status-line row's second line: what the setting is, and — the part that is
  // genuinely surprising — who else it moves. tmux has no per-client `status`, so
  // there is no version of this that only affects the browser.
  _statusBarHint(set) {
    const scope = 'tmux has no per-client status line, so this applies to every'
      + ' client on this tmux server — a terminal attached to the same session included.';
    if (!set) return `The bar tmux draws across the bottom row (\`set -g status\`). ${scope}`;
    if (set.on) {
      return `tmux is drawing it (\`status ${set.status}\`). Turning it off gives the row`
        + ` back to the terminal — webtmux's own toolbar and sidebar already name the`
        + ` session, list the windows and show what each one is doing. ${scope}`;
    }
    return (set.chosen
      ? 'Hidden. Turn it back on to get tmux\'s own bar again.'
      : 'Hidden by webtmux when it attached, because this toolbar and the sidebar'
        + ' already show what it shows — and in a split it costs a row per region.'
        + ' Turning it on here is remembered for as long as this tmux server runs.')
      + ` ${scope}`;
  }

  _linkMenu() {
    const st = this._linkDetail();
    const set = this.tmuxSettings;
    const on = !!set?.on;
    const clip = !!set?.clipboardOn;
    const rename = !!set?.renameOn;
    // Read-only servers watch; they do not rearrange the tmux server they are
    // watching (see webtty/authority.go). The row still SHOWS the setting — the
    // read behind it is allowed — it just cannot be clicked, and says why.
    const locked = !!this.readOnly;
    return html`
      <div class="label-backdrop" @click=${() => { this.linkMenuOpen = false; }}></div>
      <div class="label-menu link-menu" @click=${(e) => e.stopPropagation()}>
        <div class="mtitle">connection:</div>
        <div class="mstat ${st.kind}">
          <span class="sdot"></span>
          <span class="mtext"><b>${st.head}</b><span class="mhint">${st.body}</span></span>
        </div>
        <div class="mtitle">tmux settings:</div>
        <button
          class="mitem"
          ?disabled=${locked || !set || this.tmuxSettingsBusy}
          aria-pressed=${on ? 'true' : 'false'}
          @click=${() => this._toggleStatusBar()}
        >
          <span class="mark">${on ? '✓' : ''}</span>
          <span class="mtext">
            <b>tmux status line</b>
            <span class="mhint">${!set ? 'Asking tmux…'
              : locked
                ? 'This server is read-only, so the setting can be seen but not changed. '
                  + this._statusBarHint(set)
                : this._statusBarHint(set)}</span>
          </span>
        </button>
        <button
          class="mitem"
          ?disabled=${locked || !set || this.tmuxSettingsBusy}
          aria-pressed=${clip ? 'true' : 'false'}
          @click=${() => this._toggleClipboard()}
        >
          <span class="mark">${clip ? '✓' : ''}</span>
          <span class="mtext">
            <b>copy from a program to this browser</b>
            <span class="mhint">${!set ? 'Asking tmux…'
              : locked
                ? 'This server is read-only, so the setting can be seen but not changed. '
                  + this._clipboardHint(set)
                : this._clipboardHint(set)}</span>
          </span>
        </button>
        <button
          class="mitem"
          ?disabled=${locked || !set || this.tmuxSettingsBusy || !(set.renameOn || set.renameSaved)}
          aria-pressed=${rename ? 'true' : 'false'}
          @click=${() => this._toggleRenameForward()}
        >
          <span class="mark">${rename ? '✓' : ''}</span>
          <span class="mtext">
            <b>run a command when a window is renamed</b>
            <span class="mhint">${!set ? 'Asking tmux…'
              : locked
                ? 'This server is read-only, so the setting can be seen but not changed. '
                  + this._renameHint(set)
                : this._renameHint(set)}</span>
            ${(set?.renameHook || []).length ? html`
              <code class="mcode">${(set.renameHook || []).join('\n')}</code>` : ''}
          </span>
        </button>
        ${set ? this._renameWindowRows(set, locked) : ''}
        ${set?.error ? html`<div class="merr">${set.error}</div>` : ''}
      </div>
    `;
  }

  render() {
    return html`
      <div class="spin-wrap">
        <button
          class="spin ${this._linkClass()} ${this.linkMenuOpen ? 'open' : ''}"
          style="transform: rotate(${this.activity * SPIN_STEP_DEG}deg)"
          aria-label=${this._linkDetail().head + ' — connection details and tmux settings'}
          aria-expanded=${this.linkMenuOpen ? 'true' : 'false'}
          @mouseenter=${(e) => { const d = this._linkDetail(); this._tipEnter(e, `${d.head}\n\n${d.body}${LINK_MENU_HINT}`); }}
          @mouseleave=${() => this._tipLeave()}
          @click=${() => { this._tipLeave(); this._toggleLinkMenu(); }}
        >${spinIcon()}</button>
        ${this.linkMenuOpen ? this._linkMenu() : ''}
      </div>
      ${this.showBuild ? html`
        <button
          class="build"
          aria-label="webtmux build ${this.build} — click to copy"
          @mouseenter=${(e) => this._tipEnter(e, `webtmux build ${this.build}${this.built ? ' — built ' + this.built : ''}\n\nClick to copy it (it is also copied whenever you reveal this chip).\n\nHide with ${chord('B')}.`)}
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
            + '\n\nWatching, capture, hover previews and the save-to-browser download all still work.')}
          @mouseleave=${() => this._tipLeave()}
        >READ-ONLY</span>
      ` : ''}
      ${this.notice ? html`<div class="notice" title=${this.notice}>${this.notice}</div>` : ''}
      <button
        class="tbtn"
        aria-label="Keyboard shortcuts"
        @mouseenter=${(e) => this._tipEnter(e, `Keyboard shortcuts — every key, listed.\n\n${chord('?')} instead: the help overlay — notes and arrows on every part of the screen.\n\nShortcut: ${chord('K')}`)}
        @mouseleave=${() => this._tipLeave()}
        @click=${() => { this._tipLeave(); this.manager?.shortcuts?.toggle(); }}
      >⌨</button>
      <span class="label-wrap">
        ${this._clearButton()}
        <button
          class="label"
          aria-label="Recent tab options"
          @mouseenter=${(e) => this._tipEnter(e, `Recent windows — the strip's options.\n\nHow many tabs to keep (now ${this.recentMax}), and their labels (show the session, trim the window name). Drag tabs to reorder them.`
            + (this.recentHeld
              ? `\n\n${this.recentHeld} recent ${this.recentHeld === 1 ? 'window is' : 'windows are'} in the preview right now, so ${this.recentHeld === 1 ? 'its tab is' : 'their tabs are'} hidden — already on screen there. Close the preview and ${this.recentHeld === 1 ? 'it comes' : 'they come'} back.`
              : '')
            + (this.recentQueued
              ? `\n\n${this.recentQueued} more ${this.recentQueued === 1 ? 'window is' : 'windows are'} waiting behind the last tab. Close a tab (×) or keep more tabs and ${this.recentQueued === 1 ? 'it slides' : 'they slide'} back in.`
              : '')
            + '\n\nClick for the options (▾).')}
          @mouseleave=${() => this._tipLeave()}
          @click=${() => { this._tipLeave(); this.labelMenuOpen = !this.labelMenuOpen; }}
        >Recent ▾</button>
        ${this.labelMenuOpen ? this._labelMenu() : ''}
      </span>
      <div
        class="tabs"
        @dragover=${(e) => this._onStripDragOver(e)}
        @dragleave=${(e) => this._onStripDragLeave(e)}
        @drop=${(e) => this._onStripDrop(e)}
      >
        ${this.recent.map((w, i) => this._recentTab(w, i))}
        ${this.recentNext ? this._recentTab(this.recentNext, -1, true) : ''}
      </div>
      ${this._overflowArrow()}
      <div class="wt-tip"></div>
      <div class="wt-confirm"></div>
      <span class="tsep"></span>
      <span class="split-wrap">
        <button
          class="tbtn ${this.splitMenuOpen ? 'on' : ''}"
          aria-label="Split view — split the focused view"
          @mouseenter=${(e) => this._tipEnter(e, SPLIT_TIP)}
          @mouseleave=${() => this._tipLeave()}
          @click=${() => { this._tipLeave(); this.splitMenuOpen = !this.splitMenuOpen; }}
        >⊞<span class="caret">▾</span></button>
        ${this.splitMenuOpen ? this._splitMenu() : ''}
      </span>
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
          aria-label="Save pane buffer and transfer files"
          @mouseenter=${(e) => this._tipEnter(e, `Save & transfer — the focused pane's buffer, and whole files.\n\n`
            + `Save the whole scrollback (default) or just the visible screen: download it to your browser, or write it to a file on the machine tmux runs on.\n\n`
            + `Transfer whole files and folders between this browser's machine and the machine tmux runs on — the thing you would otherwise open a second terminal and type scp for.\n\n`
            + `Click for both (▾).`)}
          @mouseleave=${() => this._tipLeave()}
          @click=${() => { this._tipLeave(); this._toggleSaveMenu(); }}
        >⤓</button>
        ${this.saveOpen ? html`
          <div class="save-backdrop" @click=${() => { this.saveOpen = false; this.saveStatus = null; }}></div>
          <div class="save-menu ${this.readOnly ? '' : 'wide'}" @click=${(e) => e.stopPropagation()}>
            ${this._saveScopeRow()}
            <div class="save-sep"></div>
            <button class="save-item" @click=${() => this._saveToBrowser()}>⤓&nbsp; ${downloadLabel(this.saveScope)}</button>
            <div class="save-sep"></div>
            <div class="save-label">Save on the machine tmux runs on</div>
            ${this.readOnly ? html`
              <div class="save-ro">Not available — this server is read-only (started without -w),
                so it will not write files. The download above needs nothing written anywhere
                and still works — including for the whole scrollback.</div>
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
                <button class="save-go" ?disabled=${this._askingForDir()} @click=${() => this._saveToPath()}>${saveButtonLabel(this.saveScope)}</button>
              </div>
              ${this._saveHint()}
            `}
            ${this._transferSections()}
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
      <div class="save-wrap">
        <button
          class="tbtn icon ${this.historyOpen ? 'on' : ''}"
          aria-label="Scrollback buffer"
          @mouseenter=${(e) => this._tipEnter(e, SCROLLBACK_TIP)}
          @mouseleave=${() => this._tipLeave()}
          @click=${() => { this._tipLeave(); this._toggleHistoryMenu(); }}
        >${bufferIcon()}</button>
        ${this.historyOpen ? this._historyMenu() : ''}
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
      <button
        class="mode ${this.copyMode ? 'copy' : ''}"
        aria-label="Copy buffers and copy mode"
        @mouseenter=${(e) => this._tipEnter(e, `Copy — the focused pane is in ${this.copyMode ? 'COPY (scrollback)' : 'NORMAL (input)'} mode.\n\n`
          + `${this.bufferCount > 1 ? `${this.bufferCount} buffers held — click a row in the panel to choose which one ⌘V pastes.\n\n` : ''}`
          + `To flip the mode without opening anything: ${chord('[')} (tmux ⌃b [).\n\n`
          + `Click to open the copy-buffer panel (${chord('=')}, tmux ⌃b =): the buffers you have copied, one of them on the clipboard, and the button that flips this mode.`)}
        @mouseleave=${() => this._tipLeave()}
        @click=${() => { this._tipLeave(); this.manager?.copySidebar?.toggleCollapsed(); }}
      ><span class="mdot"></span>${this.copyMode ? 'COPY' : 'NORMAL'}${
        this.bufferCount > 1 ? html`<span class="bufn">${this.bufferCount}</span>` : ''}</button>
      <button
        class="pip-toggle ${this.previewHasFocused ? 'on' : ''}"
        aria-label="Add focused window to preview"
        @mouseenter=${(e) => this._tipEnter(e, `${this.previewHasFocused ? 'Remove the focused window from' : 'Add the focused window to'} the live preview.\n\nIt joins the docked edge bar, which reserves its own space rather than covering the terminal.\n\nHover a preview tile to pin it to a screen corner as a floating box instead — one window per corner, four at once — or ${chord('Shift+I')} to pin the focused one straight away.${this.previewCount ? `\n\n${this.previewCount} window${this.previewCount === 1 ? '' : 's'} in preview.` : ''}\n\nShortcut: ${chord('I')}`)}
        @mouseleave=${() => this._tipLeave()}
        @click=${() => { this._tipLeave(); this.manager?.toggleFocusedInPreview(); }}
      >◳</button>
      ${this.previewCount ? html`
        <button
          class="pip-toggle ${this.previewHidden ? '' : 'on'}"
          aria-label="Show or hide the preview"
          @mouseenter=${(e) => this._tipEnter(e, `${this.previewHidden ? 'Show' : 'Hide'} the preview.\n\nIt keeps its ${this.previewCount} window${this.previewCount === 1 ? '' : 's'}, and where each one is drawn.\n\nShortcut: ${chord('H')}`)}
          @mouseleave=${() => this._tipLeave()}
          @click=${() => { this._tipLeave(); this.manager?.togglePreviewHidden(); }}
        >${this.previewHidden ? '🙈' : '👁'}</button>
      ` : ''}
      <button
        class="sidebar-toggle"
        aria-label="Toggle sidebar"
        @mouseenter=${(e) => this._tipEnter(e, `Toggle the windows & sessions sidebar.\n\nShortcut: ${chord('W')}`)}
        @mouseleave=${() => this._tipLeave()}
        @click=${() => { this._tipLeave(); this.manager?.sidebar?.toggleCollapsed(); }}
      >${this.collapsed ? '☰' : '✕'}</button>
    `;
  }
}

customElements.define('webtmux-toolbar', WebtmuxToolbar);
