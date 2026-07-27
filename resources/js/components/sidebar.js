// Sidebar component with minimap
import { LitElement, html, css } from 'lit';
import { MOD_KEYS, chord } from '../os.js';
import { matchesWords, appendChar, backspace, phraseText } from '../search.js';
import {
  buildTree, filterTree, flattenTree, stepRow, moveTargetPos, sessionCountOf, rowKey, rowText,
} from '../window-tree.js';
import { stateStore } from '../state-store.js';
import { clientStore } from '../client-store.js';
import { workClass, workLabel, workTip } from '../stoplight.js';
import { ALERT_CSS, alertClass, alertTip } from '../alert-flash.js';
import { alertOf } from '../work-alerts.js';
import { Tip, TIP_CSS } from '../tooltip.js';
import { ConfirmPopup, CONFIRM_CSS } from '../confirm-popup.js';

// How many renders revealWindow's "scroll this row into view" waits for its row to
// appear. A cross-session reveal needs the new session's window list to arrive, which
// is a layout push or two (~500ms each) — this is generous enough to cover a slow one
// and short enough that a target which never arrives is forgotten, not remembered.
const REVEAL_TRIES = 20;

class WebtmuxSidebar extends LitElement {
  static properties = {
    layout: { type: Object },
    activePane: { type: String },
    activeWindow: { type: String },
    collapsed: { type: Boolean },
    overlay: { type: Boolean },
    pinned: { type: Boolean },
    editingWindow: { type: String },
    // Session name currently being renamed inline ('' = none). Parity with editingWindow.
    editingSession: { type: String },
    // FLAT ("all windows") view: every session on the server, each with its own
    // windows listed beneath it — the tree `prefix + w` shows. The default view
    // (sessions across the top, only the current session's windows below) answers
    // "what else is in here"; this one answers "where is that window". A shared
    // pref, so a browser you open tomorrow lists windows the way you left it.
    treeView: { type: Boolean },
    // Session names currently COLLAPSED in the tree view — a Set, replaced wholesale
    // on every change because lit re-renders on identity, not on mutation. Persisted
    // beside treeView (a folded-away session should stay folded away).
    treeCollapsed: { type: Object },
    // Window id currently being dragged for reorder ('' = none).
    draggingWindow: { type: String },
    // Which SESSION's row the dragged window came from. A window linked into two
    // sessions has a row under each, and they are separate things to drag: the same
    // window is reorderable within either list, independently.
    draggingWindowSession: { type: String },
    // In the tree view, the session whose window list the insertion line belongs to
    // ('' = none / the single-session view, which has only one list).
    dropSession: { type: String },
    // Insertion GAP index the reorder drop would land at while a window is dragged
    // over the window list: 0 = before the first row, N = after the last (move to
    // end). -1 = not currently over the list. Drives the single insertion line.
    dropIndex: { type: Number },
    // Session name currently under a dragged WINDOW (link drop-target highlight).
    dragOverSession: { type: String },
    // Session-tab REORDER drag state (distinct from the window-link drag above).
    // tmux has no native session order (it lists sessions alphabetically and has no
    // swap-session), so this order is a webtmux-local, per-browser preference.
    draggingSession: { type: String },
    // The session tab the reorder drop is hovering, and whether it lands AFTER it
    // (pointer past the tab's horizontal midpoint) — drives the insertion marker.
    sessionDropTarget: { type: String },
    sessionDropAfter: { type: Boolean },
    // Window ids currently displayed by OTHER split regions — not selectable here
    // (two panes on one window share it / stay in sync). Set by the SplitManager.
    disabledWindows: { type: Array },
    // The window the shared HoverPreview is showing ('' = none). Browsing — with the
    // pointer or the arrow keys — moves THIS, not activeWindow: nothing is committed
    // until you click or press Enter. Set by the SplitManager.
    previewWindow: { type: String },
    // …and the SESSION the previewed placement was reached through. In the tree view
    // a linked window has a row under every session it lives in; without this, both
    // rows would light up for a preview that is only ever of one of them.
    previewSession: { type: String },
    // Attention flashes, as a WorkAlerts.snapshot() (see work-alerts.js): the windows
    // whose stoplight dropped out of green while you were looking elsewhere. Rows
    // flash for exactly the windows the recents tabs and the preview tiles flash for
    // — and this list is where the strip's overflow arrow sends you, so the window it
    // was flashing about has to be findable here the moment you arrive. Replaced
    // wholesale on every refresh (lit re-renders on identity), never mutated.
    alerts: { type: Object },
  };

  // TIP_CSS is appended so the stoplight hint here is the same hint, after the
  // same delay, as the one the recents strip shows for the very same dot.
  // CONFIRM_CSS does the same for the kill confirmations: the question opens at
  // the × you clicked, in the app's own colours — see confirm-popup.js.
  static styles = [css`
    :host {
      display: block;
      width: 330px;
      background: #16213e;
      border-left: 1px solid #0f3460;
      padding: 12px;
      overflow-y: auto;
      transition: width 0.2s, padding 0.2s;
    }

    /* Overlay ("hover") mode: float over the right of the terminal instead of
       taking a flex column (which would shrink the terminal). position:fixed
       removes the host from its region's flex flow, so the region's .region-term
       expands to full width and its ResizeObserver re-fits xterm automatically. */
    :host(.overlay) {
      position: fixed;
      top: var(--wt-toolbar-h, 0);
      right: 0;
      height: calc(100% - var(--wt-toolbar-h, 0));
      z-index: 50;
      box-shadow: -8px 0 24px rgba(0, 0, 0, 0.5);
    }

    /* The popup sidebar is toggled from the toolbar button (and Ctrl+Alt+W); when
       collapsed it fully hides — the toolbar toggle brings it back. */
    :host(.collapsed) {
      display: none;
    }

    .mode-row {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-bottom: 12px;
    }

    .shortcut-hint {
      color: #888;
      font-size: 13px;
    }

    .shortcut-hint kbd {
      background: #1a1a2e;
      border: 1px solid #0f3460;
      border-radius: 4px;
      padding: 1px 6px;
      color: #4a9eff;
      font-family: monospace;
      font-size: 12px;
    }

    .mode-btn {
      width: 100%;
      background: #1a1a2e;
      border: 1px solid #0f3460;
      border-radius: 4px;
      color: #4a9eff;
      padding: 9px;
      font-size: 14px;
      cursor: pointer;
      transition: all 0.2s;
    }

    .mode-btn:hover {
      border-color: #4a9eff;
      color: #fff;
    }

    .sidebar-content {
      position: relative;
    }

    /* The panel takes keyboard focus so ↑/↓ navigate windows; hide the default
       focus ring (it would box the whole pane) and show a subtle left accent. */
    .sidebar-content:focus,
    .sidebar-content:focus-visible {
      outline: none;
    }

    h3 {
      color: #e94560;
      font-size: 16px;
      text-transform: uppercase;
      letter-spacing: 1px;
      margin: 0 0 12px 0;
    }

    /* A straight vertical list (one window per row) so it's obvious ↑/↓ walk it. */
    .window-tabs {
      display: flex;
      flex-direction: column;
      align-items: stretch;
      gap: 4px;
      margin-bottom: 16px;
    }

    /* One row of the window list = the stoplight dot + the tab, side by side. The
       dot lives OUTSIDE the tab button for the same reason it does in the recents
       strip: the active row is filled solid #e94560, and a red "stopped" dot on that
       fill was nearly invisible — precisely when you most want to see it. Out here it
       always has the sidebar's own background behind it. The "+" row carries an empty
       dot-width spacer so every tab in the list still shares one left edge. */
    .wrow {
      --dotcol: 14px;   /* dot width + gap — the tabs' inset, reused by the drop line */
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .wrow > .window-tab,
    .wrow > .window-edit { flex: 1 1 auto; min-width: 0; }

    /* Working-status dot — the same stoplight the recents tabs, the preview tiles and
       Exposé show, read from the same @wt_working value: green = working, amber =
       prompting (blocked on your answer), red = waiting for work to do, unfilled =
       not reporting. Clients drive it with: tmux set -w @wt_working 1|0|2 (set -u to
       clear). The words come from stoplight.js and hovering the dot prints the key. */
    .work, .work-gap {
      flex: 0 0 auto; width: 8px; height: 8px; box-sizing: border-box;
    }
    .work {
      border-radius: 50%;
      border: 1px solid #5a6a8a;
      background: transparent;
    }
    .work.on   { background: #2ecc71; border-color: #2ecc71; box-shadow: 0 0 4px #2ecc71; }
    .work.off  { background: #e74c3c; border-color: #e74c3c; }
    /* Waiting for user input — pulses, because unlike the other two states it is a
       request: something is blocked until you go and answer it. */
    .work.wait { background: #f5c542; border-color: #f5c542; box-shadow: 0 0 5px #f5c542; animation: wt-wait 1.4s ease-in-out infinite; }
    @keyframes wt-wait { 50% { opacity: 0.35; } }

    .window-tab {
      display: block;
      position: relative;
      width: 100%;
      box-sizing: border-box;
      text-align: left;
      background: #1a1a2e;
      color: #888;
      border: 1px solid #0f3460;
      border-radius: 4px;
      padding: 6px 10px;
      font-size: 15px;
      cursor: pointer;
      transition: all 0.2s;
    }

    /* Hover-revealed kill affordance on window & session tabs. A <span> (not a
       nested <button>, which is invalid inside the tab <button>); stopPropagation on
       click so it kills rather than selecting/switching. Reserve room on hover so
       the × never sits on top of the label. */
    .window-tab:hover, .session-tab:hover { padding-right: 26px; }
    .window-tab .kill, .session-tab .kill {
      display: none;
      position: absolute;
      top: 50%;
      right: 5px;
      transform: translateY(-50%);
      width: 18px;
      height: 18px;
      line-height: 17px;
      text-align: center;
      border-radius: 3px;
      color: #f3a7b4;
      font-size: 15px;
    }
    .window-tab:hover .kill, .session-tab:hover .kill { display: block; }
    .window-tab .kill:hover, .session-tab .kill:hover { background: #e94560; color: #fff; }

    .window-tab:hover {
      border-color: #e94560;
      color: #fff;
    }

    .window-tab.active {
      background: #e94560;
      border-color: #e94560;
      color: #fff;
    }

    /* Being PREVIEWED (pointer resting on it, or the arrow keys/type-ahead sitting
       on it). Dashed and unfilled so it never reads as the committed selection —
       the whole point of the browse is that nothing has happened yet. */
    .window-tab.previewing {
      border-style: dashed;
      border-color: #37d17a;
      color: #fff;
    }

    /* The attention flash (.wt-alert…) is spliced in from alert-flash.js, so a row
       here blinks in the same colours, at the same rate, as the tab in the recents
       strip for the very same window. */

    /* Shown in another split pane -> not selectable from here. */
    .window-tab.disabled {
      opacity: 0.35;
      cursor: not-allowed;
    }
    .window-tab.disabled:hover {
      border-color: #0f3460;
      color: #888;
    }

    /* Drag-and-drop reordering: the row being dragged dims. */
    .window-tab[draggable] { cursor: grab; }
    .window-tab.dragging {
      opacity: 0.4;
      cursor: grabbing;
    }
    /* A single bright insertion line marking exactly where the dragged window will
       land — drawn in the gap ABOVE the row at the current drop index (and above the
       "+" row when dropping at the end). Unmistakable, and it makes "move to end"
       obvious, unlike highlighting a whole target row. Sits in the 4px flex gap so it
       never shifts layout. Extends back across the stoplight column (--dotcol) so it
       still spans the whole list, not just the inset tab. */
    .window-tab.drop-before::before {
      content: '';
      position: absolute;
      left: calc(-1 * var(--dotcol, 0px));
      right: 0;
      top: -3px;
      height: 2px;
      border-radius: 2px;
      background: #4a9eff;
      box-shadow: 0 0 6px rgba(74, 158, 255, 0.9);
    }

    .window-edit {
      background: #0f3460;
      color: #fff;
      border: 1px solid #e94560;
      border-radius: 4px;
      padding: 6px 10px;
      font-size: 15px;
      width: 100%;
      box-sizing: border-box;
      font-family: inherit;
      outline: none;
    }

    .session-info {
      color: #666;
      font-size: 14px;
      margin-top: 16px;
      padding-top: 12px;
      border-top: 1px solid #0f3460;
    }

    .session-tabs {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-bottom: 16px;
    }

    .session-tab {
      position: relative;
      background: #1a1a2e;
      color: #888;
      border: 1px solid #0f3460;
      border-radius: 4px;
      padding: 6px 10px;
      font-size: 15px;
      cursor: pointer;
      transition: all 0.2s;
    }

    /* Inline session rename input (double-click a session tab). Mirrors .window-edit
       but sized like a session tab so it doesn't jump the row. */
    .session-edit {
      background: #0f3460;
      color: #fff;
      border: 1px solid #4a9eff;
      border-radius: 4px;
      padding: 6px 10px;
      font-size: 15px;
      width: 9em;
      box-sizing: border-box;
      font-family: inherit;
      outline: none;
    }

    .session-tab:hover {
      border-color: #4a9eff;
      color: #fff;
    }

    .session-tab.active {
      background: #4a9eff;
      border-color: #4a9eff;
      color: #fff;
    }

    /* A session tab highlighted as the drop target while dragging a window onto it
       (drag-to-link): bright ring so it reads as "drop here to link the window". */
    .session-tab.link-target {
      border-color: #37d17a;
      color: #fff;
      box-shadow: 0 0 0 2px rgba(55, 209, 122, 0.6);
    }

    .session-tab .win-count {
      font-size: 12px;
      opacity: 0.7;
      margin-left: 4px;
    }

    /* Session-tab reordering (webtmux-local — tmux has no native session order). */
    .session-tab[draggable] { cursor: grab; }
    .session-tab.sdragging { opacity: 0.4; cursor: grabbing; }
    /* A vertical insertion line on the side the dragged session will land — mirrors
       the window list's insertion line, adapted to the horizontal (wrapping) row. */
    .session-tab.sdrop-before::before,
    .session-tab.sdrop-after::after {
      content: '';
      position: absolute;
      top: 0;
      bottom: 0;
      width: 2px;
      border-radius: 2px;
      background: #4a9eff;
      box-shadow: 0 0 6px rgba(74, 158, 255, 0.9);
    }
    .session-tab.sdrop-before::before { left: -3px; }
    .session-tab.sdrop-after::after { right: -3px; }

    /* ---- the flat "all windows" tree ------------------------------------------
       Same rows, same tabs, same dots as the default view — only the arrangement
       differs: sessions stack as a column, each with its windows indented under it.
       Everything below is layout; nothing here restyles a control, so a row reads
       identically whichever view you are in. */
    .tnode { margin-bottom: 6px; }

    /* A session header row: the twisty, then the session tab filling the width.
       Sessions stack vertically here (they wrap along a row in the default view),
       so the reorder insertion line is HORIZONTAL — see .tdrop-*. */
    .srow {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .srow > .session-tab, .srow > .session-edit { flex: 1 1 auto; min-width: 0; text-align: left; }

    .twisty {
      flex: 0 0 auto;
      width: 18px;
      height: 22px;
      background: transparent;
      border: none;
      color: #6f7fa5;
      font-size: 12px;
      line-height: 22px;
      padding: 0;
      cursor: pointer;
    }
    .twisty:hover { color: #4a9eff; }

    /* Insertion line for a session reorder in the tree — the horizontal counterpart
       of .sdrop-before/.sdrop-after, in the same colour and weight. */
    .session-tab.tdrop-before::before,
    .session-tab.tdrop-after::after {
      content: '';
      position: absolute;
      left: 0;
      right: 0;
      height: 2px;
      border-radius: 2px;
      background: #4a9eff;
      box-shadow: 0 0 6px rgba(74, 158, 255, 0.9);
    }
    .session-tab.tdrop-before::before { top: -3px; }
    .session-tab.tdrop-after::after { bottom: -3px; }

    /* A session's windows: indented under its header, with a hairline spine so a
       long list still reads as belonging to the session above it. */
    .window-tabs.tree-wins {
      margin: 4px 0 0 8px;
      padding-left: 10px;
      border-left: 1px solid #22345c;
      margin-bottom: 6px;
    }

    /* Dropping a window from ANOTHER session onto this branch links it in — the
       whole branch lights, exactly as its session tab does, because it is the same
       action and the same target. */
    .window-tabs.link-into {
      border-left-color: #37d17a;
      box-shadow: -2px 0 0 0 rgba(55, 209, 122, 0.6);
    }

    .tree-new { width: 100%; text-align: left; margin-top: 4px; }
    .tree-empty { color: #666; font-size: 14px; padding: 6px 2px; }

    /* The live type-ahead phrase, shown only while it is narrowing the tree. */
    .filter-chip {
      display: flex;
      align-items: baseline;
      gap: 6px;
      background: #1a1a2e;
      border: 1px solid #0f3460;
      border-radius: 4px;
      padding: 4px 8px;
      margin-bottom: 8px;
      font-size: 13px;
    }
    .fc-label { color: #6f7fa5; text-transform: uppercase; letter-spacing: 1px; font-size: 11px; }
    .fc-text { color: #fff; font-family: monospace; flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .fc-hint { color: #6f7fa5; font-size: 11px; }
  `, ALERT_CSS, TIP_CSS, CONFIRM_CSS];

  constructor() {
    super();
    this.layout = null;
    this.activePane = '';
    this.activeWindow = '';
    this._tip = new Tip(this);  // shared hover hint — see tooltip.js
    this._confirm = new ConfirmPopup(this);  // kill confirmations — see confirm-popup.js
    // Collapsed is per-client viewport state (a reload restores YOUR collapse, it
    // must not leak to other browsers) → ClientStore, not the shared blob.
    this.collapsed = !!clientStore.section('sidebar').collapsed;
    // overlay (hover vs side-by-side) and pinned are shared sidebar prefs → the
    // shared StateStore. Read synchronously from its offline cache; a later remote
    // blob re-applies via the subscription below.
    const sb = stateStore.section('sidebar');
    this.overlay = sb.overlay !== false;   // default hover (float over the terminal)
    this.pinned = sb.pinned === true;      // default auto-hide
    // Which view: sessions-then-windows (default) or the flat all-windows tree.
    this.treeView = sb.tree === true;
    this.treeCollapsed = readCollapsed(sb);
    // Window id currently being renamed inline ('' = none).
    this.editingWindow = '';
    // Session name currently being renamed inline ('' = none).
    this.editingSession = '';
    // Drag-and-drop reorder state.
    this.draggingWindow = '';
    this.draggingWindowSession = '';
    this.dropIndex = -1;
    this.dropSession = '';
    this.dragOverSession = '';
    // Session-reorder drag state + the persisted webtmux-local session order (a list
    // of session names; unknown/new sessions fall through to the server's order).
    this.draggingSession = '';
    this.sessionDropTarget = '';
    this.sessionDropAfter = false;
    this._sessionOrder = readSessionOrder();
    // Re-apply shared sidebar prefs whenever another client (or the initial tmux
    // blob) changes them. Read-only apply — the StateStore `_applying` guard stops
    // these property writes from looping back into a patch.
    stateStore.subscribe(() => this._applySharedState());
    // Type-ahead search state (typing in the focused panel selects a window).
    this._searchWords = [];
    this._searchTimer = null;
    // The view (window + logical session) that was active when the panel last took
    // keyboard focus — the "baseline" to restore if the browse is DISCARDED (Escape).
    // Arrow/type-ahead browsing switches the live view as a PREVIEW; Enter (or a
    // click into the terminal) ACCEPTS it, Escape reverts to this. Null = no browse
    // in progress. Captured in updated() on the collapsed→open transition.
    this._baseline = null;
    // Windows shown by other split regions (disabled here). SplitManager updates it.
    this.disabledWindows = [];
    this.previewWindow = '';
    this.previewSession = '';
    this.alerts = null;      // WorkAlerts.snapshot(), pushed by the SplitManager
    this._revealRow = '';    // pending revealWindow() scroll target
    this._revealSess = '';   // …and the session whose row it is (tree view)
    this._revealTries = 0;   // renders left to find it in before giving up

    // The TerminalUnit that owns this sidebar sets `this.unit = <unit>` when it
    // binds, and pushes layout/activePane/activeWindow onto us directly (scoped —
    // no global event), so a split's N sidebars each reflect only their own unit.
    this.unit = null;
  }

  updated(changedProperties) {
    // A pending "scroll to this row" from revealWindow, re-tried until the row shows
    // up (a cross-session reveal waits for the new session's window list to arrive).
    if (this._revealRow) this._scrollRevealIntoView();
    if (changedProperties.has('collapsed')) {
      if (this.collapsed) {
        this.classList.add('collapsed');
        this._stopCapturePoll();
        // The panel is going away; any browse it was driving goes with it. A no-op
        // when the collapse came from dismissAccept/dismissDiscard (already settled).
        this.unit?.manager?.hover.cancel();
        // …and so does any unanswered kill question. The popup lives INSIDE this
        // panel, so a collapse would hide it mid-question while it still held the
        // keyboard and swallowed the next click somewhere off screen.
        this._confirm.close();
      } else {
        this.classList.remove('collapsed');
        // Remember the view we're on BEFORE any browsing, so Escape can restore it.
        // (Enter / click-away keep whatever is previewed instead.)
        this._baseline = {
          windowId: this.activeWindow,
          session: this.layout?.sessionBase || this.layout?.sessionName || '',
        };
        // Opening the panel grabs keyboard focus so ↑/↓ navigate windows.
        this.focusPanel();
        // …and starts warming capture buffers so window switches paint instantly.
        this._startCapturePoll();
      }
      // Persist collapse per-client (ephemeral, per-tab) so a reload restores it
      // without leaking to other browsers or thrashing the shared tmux blob.
      clientStore.patchSection('sidebar', { collapsed: this.collapsed });
      // Keep the toolbar's toggle icon in sync with our collapsed state.
      this.dispatchEvent(new CustomEvent('webtmux-sidebar-collapsed', {
        bubbles: true, composed: true, detail: { collapsed: this.collapsed },
      }));
    }
    if (changedProperties.has('overlay')) {
      // Toggling in/out of flow changes #terminal's width; its ResizeObserver
      // re-fits xterm. A deferred fit() nudge covers the reflow timing.
      this.classList.toggle('overlay', this.overlay);
      setTimeout(() => { try { this.unit?.fit(); } catch (e) {} }, 80);
    }
    if (changedProperties.has('collapsed') || changedProperties.has('overlay')) {
      // Re-publish the occupied width for the PiP boundary — now, and again after
      // the width transition settles.
      this._publishSidebarWidth();
      setTimeout(() => this._publishSidebarWidth(), 240);
    }
  }

  firstUpdated() {
    this._publishSidebarWidth();
  }

  // Expose the sidebar's occupied right-edge width as a :root CSS var so the
  // Picture-in-Picture box can treat an OPEN sidebar (side-by-side column or
  // popped-out overlay) as its right boundary — it offsets its right-corner
  // positions by this so it never overlaps the sidebar. 0 when collapsed/hidden.
  _publishSidebarWidth() {
    const w = this.collapsed ? 0 : Math.round(this.getBoundingClientRect().width);
    try { document.documentElement.style.setProperty('--wt-sidebar-w', w + 'px'); } catch (e) {}
  }

  toggleCollapsed() {
    this.collapsed = !this.collapsed;
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._stopCapturePoll();
    this._tip.dispose();
    this._confirm.dispose();
  }

  // While the panel is open, keep this focused region's capture buffers warm so
  // optimistic paint always has something fresh to blit: one refresh after 2s,
  // then every 5s. The shared client debounce + server freshness TTL keep this
  // from stampeding tmux even when the Exposé overlay is polling concurrently
  // (both drive the SAME CaptureCache).
  _startCapturePoll() {
    this._stopCapturePoll();
    this._captureWarmTimer = setTimeout(() => {
      this.unit?.captureCache?.request('all');
      this._captureInterval = setInterval(() => this.unit?.captureCache?.request('all'), 5000);
    }, 2000);
  }

  _stopCapturePoll() {
    if (this._captureWarmTimer) { clearTimeout(this._captureWarmTimer); this._captureWarmTimer = null; }
    if (this._captureInterval) { clearInterval(this._captureInterval); this._captureInterval = null; }
  }

  toggleOverlay() {
    this.overlay = !this.overlay;
    stateStore.patchSection('sidebar', { overlay: this.overlay });
  }

  togglePin() {
    this.pinned = !this.pinned;
    stateStore.patchSection('sidebar', { pinned: this.pinned });
  }

  // Pull the shared sidebar prefs (overlay/pinned) and the session order out of the
  // StateStore into our reactive props. Called on construct and on every remote
  // change (another client wrote, or the first tmux blob arrived).
  _applySharedState() {
    const sb = stateStore.section('sidebar');
    this.overlay = sb.overlay !== false;
    this.pinned = sb.pinned === true;
    this.treeView = sb.tree === true;
    this.treeCollapsed = readCollapsed(sb);
    this._sessionOrder = readSessionOrder();
    this.requestUpdate();
  }

  // Flip between the two views. Durable (StateStore → @wt_state), so it survives a
  // reload, a reconnect and a webtmux restart, and every browser on this tmux server
  // agrees on which view the sidebar is in. Any in-progress type-ahead is dropped:
  // the phrase FILTERS in the tree and merely SELECTS in the list, so carrying it
  // across would silently change what it was doing.
  toggleTree() {
    this.treeView = !this.treeView;
    stateStore.patchSection('sidebar', { tree: this.treeView });
    this._resetSearch();
    this.focusPanel();
  }

  // Fold a session's windows away in the tree view (the twisty, or ←/→). Persisted
  // with the view itself — a session you folded away should still be folded away
  // tomorrow, or it isn't really out of the way.
  toggleSessionCollapsed(name) {
    const next = new Set(this.treeCollapsed || []);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    this.treeCollapsed = next;                       // new identity => lit re-renders
    stateStore.patchSection('sidebar', { treeCollapsed: [...next] });
  }

  _isCollapsed(name) {
    return !!(this.treeCollapsed && this.treeCollapsed.has(name));
  }

  closeRegion() {
    this.dispatchEvent(new CustomEvent('webtmux-split-close', {
      bubbles: true, composed: true, detail: { unit: this.unit },
    }));
  }

  // The sidebar keeps only the controls that shape the PANEL itself (hover vs
  // side-by-side, pinned) plus the contextual close-region. Action buttons —
  // split-add, Exposé, Picture-in-Picture, scroll mode, keyboard shortcuts — now
  // live on the toolbar.
  modeRow() {
    // "Close this region" only makes sense for an added (non-primary) region.
    const canClose = this.unit && !this.unit.primary;
    return html`
      <div class="mode-row">
        <div class="shortcut-hint">Toggle panel: <kbd>${MOD_KEYS[0]}</kbd>+<kbd>${MOD_KEYS[1]}</kbd>+<kbd>W</kbd></div>
        <button
          class="mode-btn"
          @click=${this.toggleTree}
          title="Sessions + windows = the session list with the current session's windows below it; All windows = every session on the server with its own windows beneath it (tmux's prefix+w tree). Drag, rename, kill and type-ahead work the same in both."
        >
          ${this.treeView ? '🌳 All windows (tree)' : '▤ Sessions + windows'}
        </button>
        <button
          class="mode-btn"
          @click=${this.toggleOverlay}
          title="Hover = float over the terminal; Side-by-side = shrink the terminal to sit beside the pane"
        >
          ${this.overlay ? '▣ Hover over terminal' : '⇔ Side-by-side'}
        </button>
        <button
          class="mode-btn"
          @click=${this.togglePin}
          title="Pinned = the panel stays open when you click into the terminal; otherwise it auto-hides on terminal click"
        >
          ${this.pinned ? '📌 Pinned (stays open)' : '📌 Auto-hide on click'}
        </button>
        ${canClose ? html`
          <button
            class="mode-btn"
            @click=${this.closeRegion}
            title="Close this region. Shortcut: ${chord('X')}"
          >
            ✕ Close this region
          </button>
        ` : ''}
      </div>
    `;
  }

  render() {
    if (!this.layout) {
      return html`
        <div class="sidebar-content" tabindex="0" @keydown=${this.onKeyDown}>
          ${this.modeRow()}
          <h3>tmux</h3>
          <p style="color: #666; font-size: 16px;">Connecting...</p>
        </div>
      `;
    }

    return html`
      <div class="sidebar-content" tabindex="0" @keydown=${this.onKeyDown}>
      ${this.modeRow()}
      ${this.treeView ? this.renderTree() : this.renderSessionView()}
      </div>
      <!-- The shared hover hint. position:fixed, so it can sit last and still land
           anywhere on screen; it escapes the panel's own overflow-y clip. -->
      <div class="wt-tip"></div>
      <!-- The kill confirmation, positioned at whichever × asked. Same reason it
           sits last and is position:fixed; its contents are built imperatively so
           this element is stable across re-renders. -->
      <div class="wt-confirm"></div>
    `;
  }

  // ---- the default view: the session list, then THIS session's windows ----------
  renderSessionView() {
    // The server already hides the ephemeral per-region web-* grouped sessions
    // and marks Active by GROUP (so a split viewing "services" through web-abc
    // marks the services tab active); the client filter is belt-and-braces.
    const sessions = this._sessionList();
    const own = this._ownSession();
    // One node, so the window list below is rendered by exactly the same code the
    // tree uses — same rows, same drag semantics, same ×.
    const node = { name: own, windows: (this.layout.windows || []).map((w) => ({ ...w, session: own })) };

    return html`
      <h3>Sessions</h3>
      <div class="session-tabs">
        ${sessions.map(sess => sess.name === this.editingSession
          ? html`
            <input
              class="session-edit"
              .value=${sess.name}
              @keydown=${(e) => this.onSessionRenameKey(e, sess.name)}
              @blur=${(e) => this.commitSessionRename(e, sess.name)}
              @click=${(e) => e.stopPropagation()}
            >`
          : html`
          <button
            class="session-tab ${sess.active ? 'active' : ''} ${sess.name === this.dragOverSession ? 'link-target' : ''} ${sess.name === this.draggingSession ? 'sdragging' : ''} ${sess.name === this.sessionDropTarget ? (this.sessionDropAfter ? 'sdrop-after' : 'sdrop-before') : ''}"
            draggable="true"
            @click=${() => this.switchSession(sess.name)}
            @dblclick=${() => this.startSessionRename(sess.name)}
            @dragstart=${(e) => this.onSessionDragStart(e, sess.name)}
            @dragend=${() => this.onSessionDragEnd()}
            @dragover=${(e) => this.onSessionDragOver(e, sess.name)}
            @dragleave=${() => this.onSessionDragLeave(sess.name)}
            @drop=${(e) => this.onSessionDrop(e, sess.name)}
            title="Click to switch · double-click to rename · drag to reorder · drop a window here to link it"
          >
            ${sess.name}<span class="win-count">(${sess.windows})</span><span
              class="kill"
              aria-label="Kill session ${sess.name}"
              title="Kill session ${sess.name} and all its windows — ends their processes"
              @click=${(e) => { e.stopPropagation(); this.killSession(sess.name, e.currentTarget); }}
            >×</span>
          </button>
        `)}
        <button class="session-tab" title="New session" @click=${() => this.newSession()}>+</button>
      </div>

      <h3>Windows</h3>
      ${this.renderWindowList(node, { plus: true })}

      <div class="session-info">
        Session: ${this.layout.sessionBase || this.layout.sessionName}<br>
        ${this.layout.windows?.length || 0} windows
      </div>
    `;
  }

  // ---- the flat view: every session on the server, its windows beneath it -------
  //
  // The tree is built fresh each render from the server-wide directory that already
  // rides every layout push (layout.allWindows), so it costs no extra tmux traffic —
  // the data was there all along, only the current session's slice of it was shown.
  renderTree() {
    const tree = this._tree();
    const total = tree.reduce((n, s) => n + s.windows.length, 0);
    return html`
      <h3>All windows</h3>
      ${this._filterChip()}
      <div class="tree">
        ${tree.map((node) => this.renderTreeSession(node))}
        ${tree.length ? '' : html`<div class="tree-empty">No window matches that.</div>`}
        <button class="session-tab tree-new" title="New session" @click=${() => this.newSession()}>+ New session</button>
      </div>

      <div class="session-info">
        Session: ${this.layout.sessionBase || this.layout.sessionName}<br>
        ${tree.length} session${tree.length === 1 ? '' : 's'} · ${total} window${total === 1 ? '' : 's'}${
          this._searchWords.length ? ' matching' : ''}
      </div>
    `;
  }

  // One session in the tree: its header row (the same session tab as the default
  // view, so click/rename/kill/reorder/link all behave identically) plus its windows.
  renderTreeSession(node) {
    const collapsed = this._isCollapsed(node.name);
    return html`
      <div class="tnode">
        <div class="srow">
          <button
            class="twisty"
            aria-label=${collapsed ? `Expand ${node.name}` : `Collapse ${node.name}`}
            title=${collapsed ? 'Expand — or press → on one of its windows' : 'Collapse — or press ← on one of its windows'}
            @click=${() => this.toggleSessionCollapsed(node.name)}
          >${collapsed ? '▸' : '▾'}</button>
          ${node.name === this.editingSession
            ? html`
          <input
            class="session-edit tree-edit"
            .value=${node.name}
            @keydown=${(e) => this.onSessionRenameKey(e, node.name)}
            @blur=${(e) => this.commitSessionRename(e, node.name)}
            @click=${(e) => e.stopPropagation()}
          >`
            : html`
          <button
            class="session-tab srow-tab ${node.active ? 'active' : ''} ${node.name === this.dragOverSession ? 'link-target' : ''} ${node.name === this.draggingSession ? 'sdragging' : ''} ${node.name === this.sessionDropTarget ? (this.sessionDropAfter ? 'tdrop-after' : 'tdrop-before') : ''}"
            draggable="true"
            @click=${() => this.switchSession(node.name)}
            @dblclick=${() => this.startSessionRename(node.name)}
            @dragstart=${(e) => this.onSessionDragStart(e, node.name)}
            @dragend=${() => this.onSessionDragEnd()}
            @dragover=${(e) => this.onSessionDragOver(e, node.name)}
            @dragleave=${() => this.onSessionDragLeave(node.name)}
            @drop=${(e) => this.onSessionDrop(e, node.name)}
            title="Click to switch · double-click to rename · drag to reorder · drop a window here to link it"
          >
            ${node.name}<span class="win-count">(${node.windows.length})</span><span
              class="kill"
              aria-label="Kill session ${node.name}"
              title="Kill session ${node.name} and all its windows — ends their processes"
              @click=${(e) => { e.stopPropagation(); this.killSession(node.name, e.currentTarget); }}
            >×</span>
          </button>`}
        </div>
        ${collapsed ? '' : this.renderWindowList(node, { plus: node.name === this._ownSession(), indent: true })}
      </div>
    `;
  }

  // The window rows of ONE session — the whole of the default view's list, and one
  // branch of the tree. The list is the reorder drop target: dropping a row from
  // THIS session lands it in the gap the insertion line marks; dropping one from
  // another session LINKS it here instead (the same thing dropping on the session
  // tab does, which is what the whole branch reads as while you drag).
  //
  // `plus` adds the "new window" row. In the tree it appears only under the pane's
  // own session, because tmux creates a window in the session the pane is attached
  // to — the row would be a lie anywhere else.
  renderWindowList(node, { plus = false, indent = false } = {}) {
    const linking = !!this.draggingWindow && this.dragOverSession === node.name;
    return html`
      <div
        class="window-tabs ${indent ? 'tree-wins' : ''} ${linking ? 'link-into' : ''}"
        data-sess=${node.name}
        @dragover=${(e) => this.onWinListDragOver(e, node)}
        @dragleave=${(e) => this.onWinListDragLeave(e)}
        @drop=${(e) => this.onWinListDrop(e, node)}
      >
        ${node.windows.map((win, i) => this.renderWindowRow(win, i, node))}
        ${plus ? html`
        <div class="wrow">
          <span class="work-gap" aria-hidden="true"></span>
          <button
            class="window-tab ${this._dropLine(node, node.windows.length) ? 'drop-before' : ''}"
            title="New window in ${node.name}"
            @click=${() => this.newWindow()}
          >+</button>
        </div>` : ''}
      </div>
    `;
  }

  // One window row: the stoplight dot + the tab (or the inline rename input). `win`
  // always carries its own `session` — the placement it is a row for — so every
  // action below (preview, select, reorder, unlink) targets the right one of a
  // linked window's several homes.
  renderWindowRow(win, i, node) {
    const disabled = this._windowDisabled(win.id);
    return html`
      <div class="wrow">
        <span
          class="work ${workClass(this._working(win))}"
          role="img"
          aria-label=${workLabel(this._working(win))}
          @mouseenter=${(e) => this._tip.enter(e, workTip(this._working(win)))}
          @mouseleave=${() => this._tip.leave()}
        ></span>
        ${win.id === this.editingWindow
          ? html`
        <input
          class="window-edit"
          .value=${win.name || ''}
          @keydown=${(e) => this.onRenameKey(e, win.id)}
          @blur=${(e) => this.commitRename(e, win.id)}
          @click=${(e) => e.stopPropagation()}
        >`
          : html`
        <button
          data-widx=${i}
          data-win=${win.id}
          data-sess=${win.session || ''}
          class="window-tab ${this._isActiveRow(win) ? 'active' : ''} ${disabled ? 'disabled' : ''} ${this._isDraggingRow(win) ? 'dragging' : ''} ${this._dropLine(node, i) ? 'drop-before' : ''} ${!this._isActiveRow(win) && this._isPreviewRow(win) ? 'previewing' : ''} ${alertClass(this._alert(win))}"
          draggable="true"
          @mouseenter=${() => this.previewWindowRow(win.id, win.session)}
          @mouseleave=${() => this.endPreview()}
          @click=${() => this.selectWindow(win.id, win.session)}
          @dblclick=${() => this.startRename(win.id)}
          @dragstart=${(e) => this.onDragStart(e, win.id, win.session)}
          @dragend=${() => this.onDragEnd()}
          title=${(disabled ? 'Shown in another split pane' : 'Hover to preview · click to switch · double-click to rename · drag between rows to reorder, or onto another session to link') + alertTip(this._alert(win))}
        >
          ${win.index}: ${win.name || 'bash'}<span
            class="kill"
            aria-label=${this._windowKillLabel(win)}
            title=${this._windowKillLabel(win)}
            @click=${(e) => { e.stopPropagation(); this.killWindow(win, e.currentTarget); }}
          >×</span>
        </button>`}
      </div>
    `;
  }

  // What the user has typed, shown while it is narrowing the tree. The default view
  // has nothing to show here — a phrase there SELECTS a row rather than hiding any,
  // so the selection itself is the feedback.
  _filterChip() {
    if (!this._searchWords.length) return '';
    return html`
      <div class="filter-chip">
        <span class="fc-label">filter</span>
        <span class="fc-text">${phraseText(this._searchWords)}</span>
        <span class="fc-hint">⌫ · Esc clears</span>
      </div>
    `;
  }

  // The tree, narrowed by the live type-ahead phrase. Built from the server-wide
  // directory; the session ORDER is the sidebar's own persisted one, so dragging a
  // session in either view moves it in both.
  _tree() {
    const tree = buildTree({
      sessions: this._sessionList(),
      allWindows: this.layout?.allWindows || [],
      windows: this.layout?.windows || [],
      ownSession: this._ownSession(),
      working: this.layout?.allWorking || null,
    });
    return filterTree(tree, this._searchWords);
  }

  // Is this row the pane's current window? In the tree, only under the session the
  // pane is actually viewing it through — the same window's row under another
  // session is somewhere you can still go, not where you are.
  _isActiveRow(win) {
    if (win.id !== this.activeWindow) return false;
    return !this.treeView || (win.session || '') === this._ownSession();
  }

  // Is this row the one being PREVIEWED? Keyed by placement in the tree so a linked
  // window's other row doesn't light up for it.
  _isPreviewRow(win) {
    if (!this.previewWindow || win.id !== this.previewWindow) return false;
    if (this.treeView && this.previewSession) return (win.session || '') === this.previewSession;
    return true;
  }

  // Is this row the one being dragged? Same placement rule.
  _isDraggingRow(win) {
    if (!this.draggingWindow || win.id !== this.draggingWindow) return false;
    if (this.treeView && this.draggingWindowSession) return (win.session || '') === this.draggingWindowSession;
    return true;
  }

  // Should the insertion line be drawn above row `i` of `node`'s list? Only during a
  // window drag, and only in the list the pointer is actually over (the tree has one
  // list per session, and two lines would be two answers to "where will it land").
  _dropLine(node, i) {
    if (!this.draggingWindow || this.dropIndex !== i) return false;
    return !this.dropSession || this.dropSession === node.name;
  }

  // --- Drag-and-drop window reordering -------------------------------------
  // Window tabs are draggable. Reordering uses INSERTION-GAP semantics: as you drag
  // over the window list a single bright line shows the gap the window will land in
  // (between any two rows, before the first, or after the last = "move to end"),
  // and dropping moves it there. Dropping on a SESSION tab LINKS it instead.
  //
  // The tree view has one list per session, so a drop there means one of two things,
  // decided by whether the dragged row belongs to the list under the pointer:
  //   • its own session's list -> REORDER, with the insertion line, as ever;
  //   • another session's list -> LINK it into that session (exactly what dropping
  //     on that session's tab does — the branch you are over IS the session, and
  //     making the reader aim at the header instead would be a needless trap).
  onDragStart(e, winId, session = '') {
    // Disabled windows (shown in another pane) can't be dragged meaningfully.
    if (this._windowDisabled(winId)) { e.preventDefault(); return; }
    this.draggingWindow = winId;
    this.draggingWindowSession = session || this._ownSession();
    try {
      // MUST allow BOTH 'move' (reorder onto the window list) and 'link' (drop onto
      // a session): a dropEffect the effectAllowed set doesn't permit makes the
      // browser suppress the drop entirely (no-drop cursor, no `drop` event). The
      // old 'move' rejected the session's 'link' dropEffect — that's why dropping a
      // window on a session did nothing. 'all' permits every dropEffect we use.
      e.dataTransfer.effectAllowed = 'all';
      e.dataTransfer.setData('text/plain', winId);   // payload (Firefox needs it; also our drop fallback)
    } catch (_) {}
  }

  // Over a window list: either mark the insertion gap (a reorder within this
  // session) or light the whole branch as a link target (a row from elsewhere).
  // preventDefault marks the list a valid drop target so the drop actually fires.
  onWinListDragOver(e, node) {
    if (!this.draggingWindow) return;                 // only during a window drag
    e.preventDefault();
    if (this._dragIsForeign(node)) {
      // Not this session's window — dropping it here links it in. Same highlight
      // and same dropEffect as its session tab, because it is the same action.
      try { e.dataTransfer.dropEffect = 'link'; } catch (_) {}
      this.dropIndex = -1;
      if (this.dragOverSession !== node.name) this.dragOverSession = node.name;
      return;
    }
    try { e.dataTransfer.dropEffect = 'move'; } catch (_) {}
    if (this.dragOverSession) this.dragOverSession = '';
    const idx = this._dropIndexAt(e.clientY, e.currentTarget);
    if (idx !== this.dropIndex) this.dropIndex = idx;
    if (this.dropSession !== node.name) this.dropSession = node.name;
  }

  // Clear the line only when the pointer truly leaves the list (not when crossing
  // between child rows, where dragleave also fires and relatedTarget stays inside).
  onWinListDragLeave(e) {
    if (!e.currentTarget.contains(e.relatedTarget)) {
      this.dropIndex = -1;
      this.dropSession = '';
      const name = e.currentTarget.dataset?.sess;
      if (name && this.dragOverSession === name) this.dragOverSession = '';
    }
  }

  onWinListDrop(e, node) {
    e.preventDefault();
    // Prefer the live drag state; fall back to the dataTransfer payload so a stray
    // reactive re-render that cleared draggingWindow can never eat the drop.
    const srcId = this.draggingWindow || this._dtWindowId(e);
    const foreign = this._dragIsForeign(node);
    const insert = this.dropIndex >= 0 ? this.dropIndex : this._dropIndexAt(e.clientY, e.currentTarget);
    this.onDragEnd();
    if (!srcId) return;
    if (foreign) { this.unit?.linkWindow(srcId, node.name); return; }
    // Translate the insertion GAP (0..N) into MoveWindow's FINAL ordinal (0..N-1);
    // -1 means the gap is the row's own slot (nothing to do).
    const finalPos = moveTargetPos(node.windows, srcId, insert);
    if (finalPos < 0) return;
    // Name the session: in the tree the list being reordered can belong to a session
    // no region is attached to, which the server can't infer from this connection.
    this.unit?.moveWindow(srcId, finalPos, node.name);
  }

  // Is the row being dragged from a DIFFERENT session than the list it is over? Only
  // ever true in the tree view (the default view has a single list, which is always
  // the dragged row's own). A row whose window happens to be linked into the target
  // session too is not foreign — it has a row there, and that row is what moves.
  _dragIsForeign(node) {
    if (!this.draggingWindow || !node) return false;
    return !(node.windows || []).some((w) => w.id === this.draggingWindow);
  }

  // The insertion gap for pointer-Y within `container`: the first row whose vertical
  // midpoint is below the pointer marks the gap ABOVE it; past every row => after
  // the last (end). Scoped to one list — the tree has several.
  _dropIndexAt(y, container) {
    const scope = container || this.renderRoot;
    const rows = [...scope.querySelectorAll('.window-tab[data-widx]')];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].getBoundingClientRect();
      if (y < r.top + r.height / 2) return i;
    }
    return rows.length;
  }

  // The dragged window id from the drop event's dataTransfer (robust fallback).
  _dtWindowId(e) {
    try { return e.dataTransfer.getData('text/plain') || ''; } catch (_) { return ''; }
  }

  onDragEnd() {
    this.draggingWindow = '';
    this.draggingWindowSession = '';
    this.dropIndex = -1;
    this.dropSession = '';
    this.dragOverSession = '';
  }

  // --- Drag-a-window-onto-a-session to LINK it ------------------------------
  // A window tab dropped on a session tab links that window into the session (it
  // keeps running and appears in both). Only meaningful for a window NOT already
  // in that session — the current pane's own logical session is skipped.
  onSessionDragOver(e, sessionName) {
    // REORDER: a session tab dragged over another session tab. Insertion lands
    // before the tab, or after it when the pointer is past its horizontal midpoint.
    if (this.draggingSession) {
      if (this.draggingSession === sessionName) { this.sessionDropTarget = ''; return; }
      e.preventDefault();
      try { e.dataTransfer.dropEffect = 'move'; } catch (_) {}
      const r = e.currentTarget.getBoundingClientRect();
      // The session tabs wrap along a ROW in the default view and stack as a COLUMN
      // in the tree, so "past the midpoint" is a different axis in each — the same
      // gesture, measured the way the list you're looking at actually runs.
      const after = this.treeView
        ? e.clientY > r.top + r.height / 2
        : e.clientX > r.left + r.width / 2;
      if (this.sessionDropTarget !== sessionName) this.sessionDropTarget = sessionName;
      if (this.sessionDropAfter !== after) this.sessionDropAfter = after;
      return;
    }
    // LINK: a window tab dragged onto a session tab (existing behavior).
    if (!this.draggingWindow) return;                 // only during a window drag
    if (this._draggedWindowIn(sessionName)) return;   // already there — not a link target
    e.preventDefault();                               // allow the drop
    try { e.dataTransfer.dropEffect = 'link'; } catch (_) {}
    if (this.dragOverSession !== sessionName) this.dragOverSession = sessionName;
  }

  onSessionDragLeave(sessionName) {
    if (this.dragOverSession === sessionName) this.dragOverSession = '';
    if (this.sessionDropTarget === sessionName) this.sessionDropTarget = '';
  }

  onSessionDrop(e, sessionName) {
    e.preventDefault();
    e.stopPropagation();                              // don't also bubble to the window-list drop
    // REORDER drop: move the dragged session before/after this one.
    if (this.draggingSession) {
      const drag = this.draggingSession;
      const after = this.sessionDropAfter;
      this.onSessionDragEnd();
      if (drag && drag !== sessionName) this.reorderSession(drag, sessionName, after);
      return;
    }
    // LINK drop: prefer live drag state; fall back to the dataTransfer payload so the
    // link fires even if a re-render cleared draggingWindow before the drop landed.
    const srcId = this.draggingWindow || this._dtWindowId(e);
    const already = this._draggedWindowIn(sessionName);
    this.onDragEnd();
    if (!srcId || already) return;
    this.unit?.linkWindow(srcId, sessionName);
  }

  // True when the window being dragged already lives in sessionName, so linking it
  // there would be a no-op. Answered from the server-wide directory, which knows
  // every placement; without one (first paint, older server) it falls back to "is
  // this our own session" — the same answer in the default view, whose rows are all
  // from that session anyway.
  _draggedWindowIn(sessionName) {
    const dir = this.layout?.allWindows || [];
    if (this.draggingWindow && dir.length) {
      return dir.some((w) => w.id === this.draggingWindow && w.session === sessionName);
    }
    return this._isCurrentSession(sessionName);
  }

  // --- Session-tab reorder drag (tmux has no native session order; webtmux-local) ---
  onSessionDragStart(e, sessionName) {
    this.draggingSession = sessionName;
    try {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', 'session:' + sessionName);
    } catch (_) {}
  }

  onSessionDragEnd() {
    this.draggingSession = '';
    this.sessionDropTarget = '';
    this.sessionDropAfter = false;
  }

  // True if sessionName is the session this pane is logically viewing (so a window
  // "linked" there would already be present — a no-op).
  _isCurrentSession(sessionName) {
    return sessionName === (this.layout?.sessionBase || this.layout?.sessionName);
  }

  // When the panel (or a control inside it) has keyboard focus, ↑/↓ move to the
  // previous/next window and ←/→ move to the previous/next session, so you can
  // flip through both with the arrow keys while the pane is open. Any other key
  // falls through to normal handling.
  onKeyDown(e) {
    // Don't hijack arrows while renaming a window/session inline (caret movement).
    if (this.editingWindow || this.editingSession) return;
    const tag = e.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      this._resetSearch();
      this.navigateWindow(-1);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      this._resetSearch();
      this.navigateWindow(1);
    } else if (e.key === 'ArrowLeft') {
      // In the tree ←/→ FOLD the session you're standing in, the way they do in
      // tmux's own tree — there is no "previous session" to step to when every
      // session is already on screen, and folding is what that view needs instead.
      e.preventDefault();
      if (this.treeView) this.foldCurrentSession(true);
      else { this._resetSearch(); this.navigateSession(-1); }
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      if (this.treeView) this.foldCurrentSession(false);
      else { this._resetSearch(); this.navigateSession(1); }
    } else if (e.key === 'Backspace') {
      // Rub out the last typed character of the type-ahead phrase (in the tree, of
      // the filter). Only meaningful while a phrase is up; otherwise fall through.
      if (!this._searchWords.length) return;
      e.preventDefault();
      this._backspaceSearch();
    } else if (e.key === 'Escape') {
      // With a filter up, Escape clears the FILTER first — dismissing the panel on
      // the same key would throw away the browse you were in the middle of. A second
      // Escape (nothing left to clear) dismisses as always.
      e.preventDefault();
      if (this.treeView && this._searchWords.length) {
        this._resetSearch();
        this.requestUpdate();
        return;
      }
      // Escape DISCARDS the browse: restore the window/session we were on before
      // the panel took focus, then dismiss — wherever focus sits inside it.
      this._resetSearch();
      this.dismissDiscard();
    } else if (e.key === 'Enter' && tag !== 'BUTTON') {
      // Enter ACCEPTS the currently-previewed window (it becomes the new focus) and
      // dismisses — but only from the panel itself; on a button (window tab, +, mode
      // toggle) Enter still activates that control.
      e.preventDefault();
      this._resetSearch();
      this.dismissAccept();
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // Type-ahead: printable characters build a search phrase that selects a
      // window (like the ↑/↓ preview). preventDefault so Space/Enter can't also
      // activate a focused window-tab button.
      e.preventDefault();
      this._typeahead(e.key);
    }
  }

  // Type-ahead. The phrase is split into space-separated WORDS; a window matches
  // when EVERY word is a substring of its label, and we select the FIRST such window
  // — so "cla" lands on claude-1 while "cla 2" lands on claude-2. A printable char
  // grows the current word; if the grown phrase would match nothing we DISCARD the
  // char (pretend it wasn't typed), so the selection never jumps to nowhere. Space
  // starts a new word. A ~2s pause resets the phrase.
  //
  // In the TREE the same phrase also FILTERS: rows that don't match are hidden and
  // sessions left with none drop out, so what you typed is visible as a narrowing
  // list rather than only as a moved selection. Same words, same matcher — the only
  // difference is that the tree has room to show you the answer, and a haystack that
  // includes the session name (typing a session's name narrows to that session).
  _typeahead(ch) {
    // Any keystroke restarts the idle-reset timer.
    if (this._searchTimer) clearTimeout(this._searchTimer);
    this._searchTimer = setTimeout(() => { this._resetSearch(); this.requestUpdate(); }, 2000);

    const words = appendChar(this._searchWords, ch);
    if (ch === ' ') {
      // Separator: an empty trailing word doesn't narrow the match — selection holds.
      this._searchWords = words;
      this.requestUpdate();
      return;
    }

    const match = this._findWindowByWords(words);
    if (!match) return;                         // no match → reject this character
    this._searchWords = words;
    this.requestUpdate();                       // the tree narrows to what's left
    // Preview it in the pane exactly like arrow-key nav — Enter commits.
    this.previewWindowRow(match.id, match.session);
    this.focusPanel();
  }

  // Rub out the last character. Unlike typing, this never rejects: shortening a
  // phrase can only ever widen the match set, so the row you were on stays matched
  // and the tree simply shows more around it.
  _backspaceSearch() {
    if (this._searchTimer) clearTimeout(this._searchTimer);
    this._searchTimer = setTimeout(() => { this._resetSearch(); this.requestUpdate(); }, 2000);
    this._searchWords = backspace(this._searchWords);
    this.requestUpdate();
  }

  // First selectable row whose label contains every non-empty search word, or null
  // if none match. The label is "index: name" in the default view and "session
  // index: name" in the tree, where the session is on screen and worth filtering by.
  _findWindowByWords(words) {
    const terms = words.filter(w => w !== '');
    if (terms.length === 0) return null;
    const tree = this.treeView;
    return this._rows({ filtered: false }).find(w => {
      if (this._windowDisabled(w.id)) return false;
      return matchesWords(tree ? rowText(w) : `${w.index}: ${w.name || 'bash'}`, terms);
    }) || null;
  }

  _resetSearch() {
    if (this._searchTimer) { clearTimeout(this._searchTimer); this._searchTimer = null; }
    this._searchWords = [];
  }

  // The rows the keyboard walks, top to bottom, exactly as rendered: this session's
  // windows in the default view; every visible window in the tree (collapsed
  // sessions contribute none — they aren't on screen). `filtered` narrows by the
  // live type-ahead phrase, which is what ↑/↓ should walk; the type-ahead's own
  // search deliberately looks at the UNFILTERED set, or growing a phrase could never
  // move the selection off the rows that phrase already matched.
  _rows({ filtered = true } = {}) {
    if (!this.treeView) {
      const own = this._ownSession();
      return (this.layout?.windows || []).map((w) => ({ ...w, session: own }));
    }
    const tree = filtered ? this._tree() : buildTree({
      sessions: this._sessionList(),
      allWindows: this.layout?.allWindows || [],
      windows: this.layout?.windows || [],
      ownSession: this._ownSession(),
      working: this.layout?.allWorking || null,
    });
    return flattenTree(tree, this.treeCollapsed);
  }

  // ACCEPT the browse: keep whatever window is currently previewed and collapse the
  // panel. Focusing the unit (via SplitManager.focus) records the previewed window
  // as a real access (MRU) — the commit point — and hands keyboard focus back to the
  // terminal. Clicking into the terminal takes the SAME path (region mousedown →
  // focus), so a click is also an accept.
  dismissAccept() {
    this._baseline = null;
    this.collapsed = true;
    // Commit whatever the browse is sitting on. Window browsing is a preview now, so
    // this is the moment it becomes real (and enters the recents strip); a SESSION
    // browse already switched for real, and focusing the unit records it as before.
    const mgr = this.unit?.manager;
    if (mgr?.hover.windowId) mgr.hover.commit();
    try { this.unit?.focus(); } catch (e) { try { this.unit?.terminal?.focus(); } catch (_) {} }
  }

  // DISCARD the browse: restore the window/session that was active when the panel
  // took focus (the baseline), then collapse and return focus to the terminal. If
  // nothing was previewed (no baseline or already on it) this is just a plain
  // dismiss.
  dismissDiscard() {
    const b = this._baseline;
    this._baseline = null;
    this.collapsed = true;
    // Drop the window preview outright — it never touched tmux, so "undo" is just
    // restoring the region. A session browse DID switch for real, so that still has
    // to be walked back (_revertTo).
    this.unit?.manager?.hover.cancel();
    this._revertTo(b);
  }

  // Restore the pane to baseline b = {windowId, session}. The revert must NOT count
  // as a new access (we're going back, not navigating), so suppress the resulting
  // window(s): _suppressAccessIds for the target window, and _suppressAccessNext for
  // the intermediate window a session switch lands on. Falls through to a plain
  // terminal focus when there's nothing to undo.
  _revertTo(b) {
    const u = this.unit;
    if (!u) return;
    const curWin = this.activeWindow;
    const curSess = this.layout?.sessionBase || this.layout?.sessionName || '';
    const needSess = b?.session && b.session !== curSess;
    const needWin = b?.windowId && b.windowId !== curWin;
    if (!needSess && !needWin) { try { u.terminal?.focus(); } catch (e) {} return; }
    if (b.windowId) u._suppressAccessIds?.add(b.windowId);
    if (needSess) {
      u._suppressAccessNext = true;
      u.switchSession(b.session);
    }
    if (b.windowId) u.selectWindow(b.windowId);
    try { u.terminal?.focus(); } catch (e) {}
  }

  // True if a window is displayed by ANOTHER split region (so not selectable from
  // this pane). The pane's own current window is never "disabled".
  _windowDisabled(id) {
    return id !== this.activeWindow && (this.disabledWindows || []).includes(id);
  }

  // A window's raw @wt_working value for its stoplight dot. Prefer the layout's
  // GLOBAL allWorking map (one `list-windows -a` covering every session) over the
  // per-session copy carried on the window row — the same order of preference the
  // recents dots use, so one window's dot can never read differently in the sidebar
  // than it does in the strip. allWorking is omitempty, hence the fallback.
  _working(win) {
    const all = this.layout?.allWorking;
    if (all && win && Object.prototype.hasOwnProperty.call(all, win.id)) return all[win.id];
    return (win && win.working) || '';
  }

  // A window's attention flash ('' | '0' | '2'), from the shared registry. Keyed by
  // (this panel's session, window) so a linked window is acknowledged per placement,
  // exactly as its recents tabs are.
  _alert(win) {
    return alertOf(this.alerts, win?.session || this._ownSession(), win?.id);
  }

  // Step delta windows from the active one (wrapping), by the sidebar's own window
  // order, SKIPPING windows shown in another split pane, and select it. Refocus
  // the panel afterwards: selecting a window re-renders the tabs, which would
  // otherwise drop keyboard focus (and break a second arrow press) if focus had
  // been on a now-replaced tab button.
  navigateWindow(delta) {
    const rows = this._rows();
    if (!rows.length) return;
    // Step from wherever the browse currently sits — the previewed row if one is up,
    // otherwise the pane's real window in its own session. In the tree the walk
    // crosses session boundaries: the last window of one session is followed by the
    // first of the next, because that is what the list on screen does.
    const from = this.previewWindow
      ? rowKey(this.previewSession || this._ownSession(), this.previewWindow)
      : rowKey(this._ownSession(), this.activeWindow);
    const cand = stepRow(rows, from, delta, (r) => this._windowDisabled(r.id));
    // Every other window is occupied by another pane — nothing to move to.
    if (!cand) return;
    // Arrow-key browsing is a PREVIEW, exactly like hovering: the region shows the
    // window's captured screen, tmux is not touched, and nothing enters the recents
    // strip until Enter (or a click) commits it.
    this.previewWindowRow(cand.id, cand.session);
    this.focusPanel();
  }

  // ← / → in the tree: fold the session the browse is standing in away, or unfold
  // it. Folding does NOT move the preview — you asked to tidy the list, not to go
  // somewhere — but the folded rows leave the ↑/↓ walk with them, which is the point.
  foldCurrentSession(collapse) {
    const name = this._cursorSession();
    if (!name) return;
    if (collapse === this._isCollapsed(name)) return;   // already folded / unfolded
    this.toggleSessionCollapsed(name);
    this.focusPanel();
  }

  // The session the browse is currently in: the previewed row's, else the pane's own.
  _cursorSession() {
    if (this.previewWindow && this.previewSession) return this.previewSession;
    return this._ownSession();
  }

  // The user-selectable session list: exactly what render() shows (web-* shadow
  // sessions excluded), so arrow-key session nav can never land on another
  // pane's ephemeral grouped session.
  _sessionList() {
    const list = (this.layout?.sessions || []).filter(s => !/^web-/.test(s.name));
    return this._applySessionOrder(list);
  }

  // Reorder the server's session list by the persisted webtmux-local order. Names in
  // the stored order sort by their stored position; names NOT in it (new sessions)
  // keep their server order and trail the known ones (Array.prototype.sort is stable).
  _applySessionOrder(sessions) {
    const order = this._sessionOrder;
    if (!order || !order.length) return sessions;
    const pos = new Map(order.map((n, i) => [n, i]));
    const rank = (s) => (pos.has(s.name) ? pos.get(s.name) : Number.POSITIVE_INFINITY);
    return [...sessions].sort((a, b) => rank(a) - rank(b));
  }

  // Commit a new session order after a reorder drag: move `dragName` to just before
  // `targetName` (or after it when `after`), or to the end when targetName is null.
  // Persists the FULL displayed order so it's stable across new/removed sessions.
  reorderSession(dragName, targetName, after) {
    const cur = this._sessionList().map(s => s.name);
    const from = cur.indexOf(dragName);
    if (from === -1) return;
    cur.splice(from, 1);
    let to = targetName == null ? cur.length : cur.indexOf(targetName);
    if (to === -1) to = cur.length;
    else if (after) to += 1;
    cur.splice(to, 0, dragName);
    this._sessionOrder = cur;
    stateStore.patch({ sessionOrder: cur });
    this.requestUpdate();
  }

  // Step delta sessions from the active one (wrapping) and switch to it, so ←/→
  // flip between sessions the same way ↑/↓ flip between windows. No-op with a
  // single session. Refocus the panel afterwards (the re-render would otherwise
  // drop keyboard focus and break a second arrow press).
  navigateSession(delta) {
    const sessions = this._sessionList();
    if (sessions.length < 2) return;
    const base = this.layout?.sessionBase || this.layout?.sessionName;
    let idx = sessions.findIndex(s => s.active);
    if (idx === -1) idx = sessions.findIndex(s => s.name === base);
    if (idx === -1) idx = 0;
    const next = (idx + delta + sessions.length) % sessions.length;
    const target = sessions[next];
    if (target && !target.active) {
      // Arrow-key session browsing only PREVIEWS in the pane — like ↑/↓ window nav,
      // it must not populate the recents strip. The landing window id isn't known
      // until the new session's layout arrives, so flag the NEXT access to be
      // skipped; it commits to recents only when the pane itself takes focus.
      if (this.unit) this.unit._suppressAccessNext = true;
      this.switchSession(target.name);
      this.focusPanel();
    }
  }

  // Give keyboard focus to the panel so arrow-key window navigation works
  // immediately (called when the panel opens and after each navigation).
  focusPanel() {
    this.updateComplete.then(() => {
      const el = this.renderRoot.querySelector('.sidebar-content');
      if (el) el.focus({ preventScroll: true });
    });
  }

  // Click a window row = COMMIT the browse: the previewed window becomes real. Goes
  // through the shared HoverPreview so it lands in the region the preview was shown
  // in — the same path the toolbar recents and the Preview tiles take.
  // Committing a row in ANOTHER session hops the pane there on the way (goToWindowIn
  // handles it) — which is exactly what clicking a window listed under a different
  // session in the tree should mean.
  selectWindow(windowId, session = '') {
    if (this._windowDisabled(windowId)) return;   // shown in another split pane
    const mgr = this.unit?.manager;
    if (mgr) mgr.hover.commit(windowId, session || this._ownSession());
    else this.unit?.selectWindow(windowId);       // no manager (shouldn't happen) — direct
  }

  // Open the panel ON a specific window and point the browse at it — the landing for
  // the recents strip's overflow arrow (SplitManager.revealOverflowAlert).
  //
  // Everything here is the browse the panel already does when you arrow onto a row:
  // the window is PREVIEWED, not switched to. Enter (or clicking the row, or clicking
  // into the terminal) commits it; Escape restores the baseline the panel captured on
  // the way open. That is the whole reason the arrow reuses this path rather than
  // navigating — you asked to see what changed, not to leave what you were doing.
  //
  // A target in ANOTHER session needs the panel pointed there first, or the row it is
  // meant to land on simply isn't in the list. A session switch is real (unlike the
  // window preview, which never touches tmux), so it is flagged NOT to count as an
  // access — otherwise merely looking at what an arrow was flashing about would
  // rewrite the recents strip — and Escape walks it back via the baseline.
  revealWindow(windowId, session = '') {
    if (!windowId) return;
    // Open FIRST: the collapsed -> open transition is what captures the baseline, and
    // it has to capture where you actually were, not where the session hop below has
    // already taken us. (Already open = the baseline from when you opened it stands.)
    if (this.collapsed) this.collapsed = false;
    const target = session || this._ownSession();
    // The TREE already lists the target's row, whatever session it is in, so there is
    // nothing to point at it — and hopping the pane's session to reveal a window you
    // have not yet chosen would be a navigation the arrow never asked for.
    if (target && target !== this._ownSession() && this.unit && !this.treeView) {
      this.unit._suppressAccessNext = true;
      this.switchSession(target);
    }
    // …but a row folded away is not on screen either: unfold its session so the
    // scroll below has something to land on.
    if (this.treeView && this._isCollapsed(target)) this.toggleSessionCollapsed(target);
    this.unit?.manager?.hover.enter(windowId, target);
    // The row may not exist yet (a session hop lands a layout or two later), so the
    // scroll is a standing request the next render fulfils.
    this._revealRow = windowId;
    this._revealSess = target;
    this._revealTries = REVEAL_TRIES;
    this._scrollRevealIntoView();
    this.focusPanel();
  }

  // Bring the row `_revealRow` names into view, once it exists. Re-tried from
  // updated() because the window list it lives in can arrive several pushes after the
  // request — a long list would otherwise put the flashing row below the fold, which
  // is the one place the arrow must never leave you.
  //
  // The retry is BOUNDED. A target that never shows up (the window was killed between
  // the arrow being drawn and being clicked, or a session switch that never lands)
  // would otherwise leave a standing request that fires the moment some unrelated
  // future render happens to contain that id — a scroll with no cause, minutes later.
  _scrollRevealIntoView() {
    const id = this._revealRow;
    if (!id) return;
    if (this.collapsed || --this._revealTries <= 0) { this._revealRow = ''; return; }
    const sess = this._revealSess;
    this.updateComplete.then(() => {
      // In the tree the same window can have a row under several sessions, so aim at
      // the placement the arrow was flashing about; fall back to the id alone when
      // no session was given (or that row hasn't rendered yet).
      const root = this.renderRoot;
      const el = (sess && root?.querySelector(`.window-tab[data-win="${id}"][data-sess="${sess}"]`))
        || root?.querySelector(`.window-tab[data-win="${id}"]`);
      if (!el || this._revealRow !== id) return;
      this._revealRow = '';
      this._revealSess = '';
      try { el.scrollIntoView({ block: 'nearest' }); } catch (e) { /* cosmetic only */ }
    });
  }

  // Point at a window row: PREVIEW it (see hover-preview.js). Pure browsing —
  // nothing switches until a click or Enter. Rows for windows another region already
  // shows are NOT skipped: the preview controller sees they're on screen and simply
  // draws nothing, which keeps the browse "engaged" so moving on to the next row is
  // still instant instead of re-pausing.
  previewWindowRow(windowId, session = '') {
    this.unit?.manager?.hover.enter(windowId, session || this._ownSession());
  }

  // Stop pointing at a row. The preview controller applies its own grace, so
  // sweeping between adjacent rows doesn't flicker.
  endPreview() {
    this.unit?.manager?.hover.leave();
  }

  // This panel's logical session — the session a window listed here is reached
  // through (a linked window can be browsed via more than one).
  _ownSession() {
    return this.layout?.sessionBase || this.layout?.sessionName || '';
  }

  // Begin an inline rename. `append` puts the caret at the END instead of selecting
  // the whole name: that's what the rename CHORD wants, because reaching for it
  // mid-work almost always means "add something to this name" (a ticket, a branch),
  // and a select-all makes the next keystroke silently destroy the existing name.
  // Double-click keeps select-all — deliberately picking a name out of a list reads
  // as "replace this".
  startRename(windowId, { append = false } = {}) {
    this.editingWindow = windowId;
    this.updateComplete.then(() => {
      const input = this.renderRoot.querySelector('.window-edit');
      if (!input) return;
      input.focus();
      if (append) {
        const end = input.value.length;
        input.setSelectionRange(end, end);
      } else {
        input.select();
      }
    });
  }

  onRenameKey(e, windowId) {
    if (e.key === 'Enter') {
      e.preventDefault();
      this.commitRename(e, windowId);
      // Committing via the keyboard should leave the keyboard where it was: hand
      // focus back to the panel so ↑/↓ (and the rest of the panel keymap) keep
      // working. Without this, focus falls to <body> when the input is removed and
      // the sidebar goes keyboard-dead until you click it. Blur-commits (clicking
      // away) intentionally DON'T refocus — the click already moved focus elsewhere.
      this.focusPanel();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();       // don't also bubble to the panel's Escape (collapse)
      this.editingWindow = '';   // cancel the edit only
      // Hand focus back to the panel (not lost to <body>), so a SECOND Escape is
      // seen by onKeyDown and collapses the sidebar. Without this the rename input
      // vanishes and focus falls to the body, deadening further keyboard control —
      // the reason Escape-after-rename didn't collapse the panel.
      this.focusPanel();
    }
  }

  commitRename(e, windowId) {
    if (this.editingWindow !== windowId) return;   // already handled (guards blur+Enter)
    this.editingWindow = '';
    const name = e.target.value.trim();
    if (name) this.unit?.renameWindow(windowId, name);
  }

  switchSession(sessionName) {
    // Already viewing this session (possibly through a grouped shadow) — no-op.
    const cur = this.layout?.sessionBase || this.layout?.sessionName;
    if (sessionName === cur) return;
    this.unit?.switchSession(sessionName);
  }

  // --- Session rename (double-click a session tab; parity with window rename) ---
  startSessionRename(sessionName) {
    this.editingSession = sessionName;
    this.updateComplete.then(() => {
      const input = this.renderRoot.querySelector('.session-edit');
      if (input) { input.focus(); input.select(); }
    });
  }

  onSessionRenameKey(e, oldName) {
    if (e.key === 'Enter') {
      e.preventDefault();
      this.commitSessionRename(e, oldName);
      this.focusPanel();          // keep keyboard focus on the panel (parity with window rename)
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();        // don't also bubble to the panel's Escape (collapse)
      this.editingSession = '';   // cancel the edit only
      this.focusPanel();          // refocus so a second Escape collapses the panel
    }
  }

  commitSessionRename(e, oldName) {
    if (this.editingSession !== oldName) return;   // already handled (guards blur+Enter)
    this.editingSession = '';
    const name = e.target.value.trim();
    if (name && name !== oldName) this.unit?.renameSession(oldName, name);
  }

  // --- Kill affordances (hover × on a window/session tab) ---
  // The window × does one of two things depending on where the window lives:
  //   • linked into other sessions too -> UNLINK it from this session (the window
  //     keeps running elsewhere). Non-destructive, so it fires without a confirm.
  //   • last session it's in -> KILL it (ends its processes). Destructive, so it
  //     confirms first — the × is small and hover-only, but a stray click still
  //     shouldn't tear down live work.
  //
  // The confirmation opens AT the × (`anchor`), not in the middle of the screen —
  // see confirm-popup.js for why. Anything but its Yes dismisses it untouched.
  // `win` is the ROW that was clicked, so the unlink removes the window from the
  // session that row is under — which in the tree need not be the session this pane
  // is viewing.
  killWindow(win, anchor) {
    if (!win) return;
    const windowId = win.id;
    if (this._windowLinkedElsewhere(win)) {
      this.unit?.unlinkWindow(windowId, win.session || '');   // remove it from THAT session
      return;
    }
    const label = `window ${win.index}: ${win.name || 'bash'}`;
    this._confirm.ask(anchor, {
      message: `Kill ${label}?\nThis ends its processes.`,
      yes: 'Kill',
      onConfirm: () => this.unit?.killWindow(windowId),
    });
  }

  // A window is "linked elsewhere" when it belongs to more than one logical session.
  // The server-wide directory answers this for every row, including the ones in
  // sessions no pane is attached to (which carry no sessionCount of their own); the
  // current session's rows still prefer their own count, which is the same number.
  _windowLinkedElsewhere(win) {
    return this._sessionCount(win) > 1;
  }

  _sessionCount(win) {
    if (!win) return 1;
    if (win.sessionCount) return win.sessionCount;
    return sessionCountOf(this.layout?.allWindows, win.id);
  }

  // Tooltip/aria-label for a window's × — distinguishes the unlink case ("Remove
  // from session") from the kill case ("Kill window"), matching what the click does.
  _windowKillLabel(win) {
    const count = this._sessionCount(win);
    if (count > 1) {
      const others = count - 1;
      const where = win.session ? `from ${win.session}` : 'from this session';
      return `Remove window ${win.index} ${where} — stays open in ${others} other session${others === 1 ? '' : 's'}`;
    }
    return `Kill window ${win.index}: ${win?.name || 'bash'} — ends its processes`;
  }

  // Killing a session confirms first UNLESS it's empty (a single idle-shell window
  // with nothing running — the backend flags it), where there's no live work to
  // protect and the confirm is just friction.
  killSession(sessionName, anchor) {
    const sess = (this.layout?.sessions || []).find(s => s.name === sessionName);
    if (sess?.empty) {
      this.unit?.killSession(sessionName);
      return;
    }
    this._confirm.ask(anchor, {
      message: `Kill session “${sessionName}” and all its windows?\nThis ends their processes.`,
      yes: 'Kill',
      onConfirm: () => this.unit?.killSession(sessionName),
    });
  }

  newWindow() {
    this.unit?.newWindow();
  }

  // Create a fresh session and switch this pane's view to it (the "+" at the end
  // of the session list, mirroring the windows "+"). The server names it.
  newSession() {
    this.unit?.newSession();
  }
}

// The persisted webtmux-local session order (array of session names), or [] if
// absent/corrupt. tmux itself has no session order, so this is a webtmux
// preference for how the sidebar lists sessions — shared via @wt_state, so every
// browser on this server sees the same order.
function readSessionOrder() {
  const v = stateStore.get('sessionOrder', []);
  return Array.isArray(v) ? v.filter((n) => typeof n === 'string') : [];
}

// The persisted set of sessions folded away in the tree view, as a Set (stored as a
// plain array — the blob is JSON). Anything malformed reads as "nothing folded",
// which is the harmless answer: you see more than you asked for, not less.
function readCollapsed(sidebarSection) {
  const v = sidebarSection?.treeCollapsed;
  return new Set(Array.isArray(v) ? v.filter((n) => typeof n === 'string') : []);
}

customElements.define('webtmux-sidebar', WebtmuxSidebar);
