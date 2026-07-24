// Sidebar component with minimap
import { LitElement, html, css } from 'lit';
import { MOD_KEYS, chord } from '../os.js';

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
    // Window id currently being dragged for reorder ('' = none).
    draggingWindow: { type: String },
    // Insertion GAP index the reorder drop would land at while a window is dragged
    // over the window list: 0 = before the first row, N = after the last (move to
    // end). -1 = not currently over the list. Drives the single insertion line.
    dropIndex: { type: Number },
    // Session name currently under a dragged WINDOW (link drop-target highlight).
    dragOverSession: { type: String },
    // Window ids currently displayed by OTHER split regions — not selectable here
    // (two panes on one window share it / stay in sync). Set by the SplitManager.
    disabledWindows: { type: Array },
  };

  static styles = css`
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
       never shifts layout. */
    .window-tab.drop-before::before {
      content: '';
      position: absolute;
      left: 0;
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
  `;

  constructor() {
    super();
    this.layout = null;
    this.activePane = '';
    this.activeWindow = '';
    this.collapsed = false;
    // Hover-overlay vs side-by-side. Default hover (float over the terminal);
    // persisted across reloads.
    this.overlay = localStorage.getItem('webtmux-overlay') !== 'false';
    // Pinned = stay open when clicking into the terminal (default: auto-hide).
    this.pinned = localStorage.getItem('webtmux-pinned') === 'true';
    // Window id currently being renamed inline ('' = none).
    this.editingWindow = '';
    // Session name currently being renamed inline ('' = none).
    this.editingSession = '';
    // Drag-and-drop reorder state.
    this.draggingWindow = '';
    this.dropIndex = -1;
    this.dragOverSession = '';
    // Type-ahead search state (typing in the focused panel selects a window).
    this._searchWords = [];
    this._searchTimer = null;
    // Windows shown by other split regions (disabled here). SplitManager updates it.
    this.disabledWindows = [];

    // The TerminalUnit that owns this sidebar sets `this.unit = <unit>` when it
    // binds, and pushes layout/activePane/activeWindow onto us directly (scoped —
    // no global event), so a split's N sidebars each reflect only their own unit.
    this.unit = null;
  }

  updated(changedProperties) {
    if (changedProperties.has('collapsed')) {
      if (this.collapsed) {
        this.classList.add('collapsed');
        this._stopCapturePoll();
      } else {
        this.classList.remove('collapsed');
        // Opening the panel grabs keyboard focus so ↑/↓ navigate windows.
        this.focusPanel();
        // …and starts warming capture buffers so window switches paint instantly.
        this._startCapturePoll();
      }
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
    localStorage.setItem('webtmux-overlay', String(this.overlay));
  }

  togglePin() {
    this.pinned = !this.pinned;
    localStorage.setItem('webtmux-pinned', String(this.pinned));
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
        <div class="shortcut-hint">Toggle panel: <kbd>${MOD_KEYS[0]}</kbd>+<kbd>${MOD_KEYS[1]}</kbd>+<kbd>W</kbd></div>
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

    // The server already hides the ephemeral per-region web-* grouped sessions
    // and marks Active by GROUP (so a split viewing "services" through web-abc
    // marks the services tab active); the client filter is belt-and-braces.
    const sessions = this._sessionList();

    return html`
      <div class="sidebar-content" tabindex="0" @keydown=${this.onKeyDown}>
      ${this.modeRow()}
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
            class="session-tab ${sess.active ? 'active' : ''} ${sess.name === this.dragOverSession ? 'link-target' : ''}"
            @click=${() => this.switchSession(sess.name)}
            @dblclick=${() => this.startSessionRename(sess.name)}
            @dragover=${(e) => this.onSessionDragOver(e, sess.name)}
            @dragleave=${() => this.onSessionDragLeave(sess.name)}
            @drop=${(e) => this.onSessionDrop(e, sess.name)}
            title="Double-click to rename · drop a window here to link it into this session"
          >
            ${sess.name}<span class="win-count">(${sess.windows})</span><span
              class="kill"
              aria-label="Kill session ${sess.name}"
              title="Kill session ${sess.name} and all its windows — ends their processes"
              @click=${(e) => { e.stopPropagation(); this.killSession(sess.name); }}
            >×</span>
          </button>
        `)}
        <button class="session-tab" title="New session" @click=${() => this.newSession()}>+</button>
      </div>

      <h3>Windows</h3>
      <div
        class="window-tabs"
        @dragover=${(e) => this.onWinListDragOver(e)}
        @dragleave=${(e) => this.onWinListDragLeave(e)}
        @drop=${(e) => this.onWinListDrop(e)}
      >
        ${this.layout.windows?.map((win, i) => win.id === this.editingWindow
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
              class="window-tab ${win.id === this.activeWindow ? 'active' : ''} ${this._windowDisabled(win.id) ? 'disabled' : ''} ${win.id === this.draggingWindow ? 'dragging' : ''} ${this.draggingWindow && this.dropIndex === i ? 'drop-before' : ''}"
              draggable="true"
              @click=${() => this.selectWindow(win.id)}
              @dblclick=${() => this.startRename(win.id)}
              @dragstart=${(e) => this.onDragStart(e, win.id)}
              @dragend=${() => this.onDragEnd()}
              title=${this._windowDisabled(win.id) ? 'Shown in another split pane' : 'Double-click to rename · drag between rows to reorder, or onto a session to link'}
            >
              ${win.index}: ${win.name || 'bash'}<span
                class="kill"
                aria-label=${this._windowKillLabel(win)}
                title=${this._windowKillLabel(win)}
                @click=${(e) => { e.stopPropagation(); this.killWindow(win.id); }}
              >×</span>
            </button>`
        )}
        <button
          class="window-tab ${this.draggingWindow && this.dropIndex === (this.layout.windows?.length || 0) ? 'drop-before' : ''}"
          title="New window"
          @click=${() => this.newWindow()}
        >+</button>
      </div>

      <div class="session-info">
        Session: ${this.layout.sessionBase || this.layout.sessionName}<br>
        ${this.layout.windows?.length || 0} windows
      </div>
      </div>
    `;
  }

  // --- Drag-and-drop window reordering -------------------------------------
  // Window tabs are draggable. Reordering uses INSERTION-GAP semantics: as you drag
  // over the window list a single bright line shows the gap the window will land in
  // (between any two rows, before the first, or after the last = "move to end"),
  // and dropping moves it there. Dropping on a SESSION tab instead LINKS it (handled
  // separately, below) — so the list is only ever a reorder target and the sessions
  // are only ever link targets, cleanly separated.
  onDragStart(e, winId) {
    // Disabled windows (shown in another pane) can't be dragged meaningfully.
    if (this._windowDisabled(winId)) { e.preventDefault(); return; }
    this.draggingWindow = winId;
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

  // Over the window list: compute the insertion gap from the pointer's Y against
  // each row's midpoint and show the line there. preventDefault marks the list a
  // valid drop target so the drop actually fires.
  onWinListDragOver(e) {
    if (!this.draggingWindow) return;                 // only during a window drag
    e.preventDefault();
    try { e.dataTransfer.dropEffect = 'move'; } catch (_) {}
    const idx = this._dropIndexAt(e.clientY);
    if (idx !== this.dropIndex) this.dropIndex = idx;
  }

  // Clear the line only when the pointer truly leaves the list (not when crossing
  // between child rows, where dragleave also fires and relatedTarget stays inside).
  onWinListDragLeave(e) {
    if (!e.currentTarget.contains(e.relatedTarget)) this.dropIndex = -1;
  }

  onWinListDrop(e) {
    e.preventDefault();
    // Prefer the live drag state; fall back to the dataTransfer payload so a stray
    // reactive re-render that cleared draggingWindow can never eat the drop.
    const srcId = this.draggingWindow || this._dtWindowId(e);
    const insert = this.dropIndex >= 0 ? this.dropIndex : this._dropIndexAt(e.clientY);
    this.onDragEnd();
    if (!srcId) return;
    const wins = this.layout?.windows || [];
    const from = wins.findIndex(w => w.id === srcId);
    if (from === -1) return;
    // Translate the insertion GAP (0..N) into MoveWindow's FINAL ordinal (0..N-1):
    // removing the row first shifts everything after it down by one, so a gap past
    // the source maps one lower. A no-op gap (same slot) is skipped.
    const finalPos = insert > from ? insert - 1 : insert;
    if (finalPos === from) return;
    this.unit?.moveWindow(srcId, finalPos);
  }

  // The insertion gap for pointer-Y: the first row whose vertical midpoint is below
  // the pointer marks the gap ABOVE it; past every row => after the last (end).
  _dropIndexAt(y) {
    const rows = [...this.renderRoot.querySelectorAll('.window-tab[data-widx]')];
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
    this.dropIndex = -1;
    this.dragOverSession = '';
  }

  // --- Drag-a-window-onto-a-session to LINK it ------------------------------
  // A window tab dropped on a session tab links that window into the session (it
  // keeps running and appears in both). Only meaningful for a window NOT already
  // in that session — the current pane's own logical session is skipped.
  onSessionDragOver(e, sessionName) {
    if (!this.draggingWindow) return;                 // only during a window drag
    if (this._isCurrentSession(sessionName)) return;  // already here — not a link target
    e.preventDefault();                               // allow the drop
    try { e.dataTransfer.dropEffect = 'link'; } catch (_) {}
    if (this.dragOverSession !== sessionName) this.dragOverSession = sessionName;
  }

  onSessionDragLeave(sessionName) {
    if (this.dragOverSession === sessionName) this.dragOverSession = '';
  }

  onSessionDrop(e, sessionName) {
    e.preventDefault();
    e.stopPropagation();                              // don't also bubble to the window-list drop
    // Prefer live drag state; fall back to the dataTransfer payload so the link
    // fires even if a re-render cleared draggingWindow before the drop landed.
    const srcId = this.draggingWindow || this._dtWindowId(e);
    this.onDragEnd();
    if (!srcId || this._isCurrentSession(sessionName)) return;
    this.unit?.linkWindow(srcId, sessionName);
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
      e.preventDefault();
      this._resetSearch();
      this.navigateSession(-1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      this._resetSearch();
      this.navigateSession(1);
    } else if (e.key === 'Escape') {
      // Escape always dismisses the panel, wherever focus sits inside it.
      e.preventDefault();
      this._resetSearch();
      this.dismiss();
    } else if (e.key === 'Enter' && tag !== 'BUTTON') {
      // Enter dismisses too, but only from the panel itself — on a button
      // (window tab, +, mode toggle) Enter still activates that control.
      e.preventDefault();
      this._resetSearch();
      this.dismiss();
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // Type-ahead: printable characters build a search phrase that selects a
      // window (like the ↑/↓ preview). preventDefault so Space/Enter can't also
      // activate a focused window-tab button.
      e.preventDefault();
      this._typeahead(e.key);
    }
  }

  // Type-ahead window selection. The phrase is split into space-separated WORDS;
  // a window matches when EVERY word is a substring of its "index: name" label, and
  // we select the FIRST such window — so "cla" lands on claude-1 while "cla 2" lands
  // on claude-2. A printable char grows the current word; if the grown phrase would
  // match nothing we DISCARD the char (pretend it wasn't typed), so the selection
  // never jumps to nowhere. Space starts a new word. A ~2s pause resets the phrase.
  _typeahead(ch) {
    // Any keystroke restarts the idle-reset timer.
    if (this._searchTimer) clearTimeout(this._searchTimer);
    this._searchTimer = setTimeout(() => this._resetSearch(), 2000);

    const words = this._searchWords.slice();
    if (ch === ' ') {
      // Separator: begin a new (empty) word, but don't stack empties.
      if (words.length === 0 || words[words.length - 1] !== '') words.push('');
      this._searchWords = words;
      return;   // an empty trailing word doesn't narrow the match — selection holds
    }
    if (words.length === 0) words.push('');
    words[words.length - 1] += ch.toLowerCase();

    const match = this._findWindowByWords(words);
    if (!match) return;                         // no match → reject this character
    this._searchWords = words;
    // Preview it in the pane exactly like arrow-key nav (suppress the MRU access).
    this.unit?._suppressAccessIds?.add(match.id);
    this.selectWindow(match.id);
    this.focusPanel();
  }

  // First selectable window whose "index: name" label contains every non-empty
  // search word as a substring, or null if none match.
  _findWindowByWords(words) {
    const terms = words.filter(w => w !== '');
    if (terms.length === 0) return null;
    return (this.layout?.windows || []).find(w => {
      if (this._windowDisabled(w.id)) return false;
      const hay = `${w.index}: ${w.name || 'bash'}`.toLowerCase();
      return terms.every(t => hay.includes(t));
    }) || null;
  }

  _resetSearch() {
    if (this._searchTimer) { clearTimeout(this._searchTimer); this._searchTimer = null; }
    this._searchWords = [];
  }

  // Collapse the panel and hand keyboard focus back to THIS unit's terminal, so
  // typing resumes at the prompt right after dismissing.
  dismiss() {
    this.collapsed = true;
    try { this.unit?.terminal?.focus(); } catch (e) {}
  }

  // True if a window is displayed by ANOTHER split region (so not selectable from
  // this pane). The pane's own current window is never "disabled".
  _windowDisabled(id) {
    return id !== this.activeWindow && (this.disabledWindows || []).includes(id);
  }

  // Step delta windows from the active one (wrapping), by the sidebar's own window
  // order, SKIPPING windows shown in another split pane, and select it. Refocus
  // the panel afterwards: selecting a window re-renders the tabs, which would
  // otherwise drop keyboard focus (and break a second arrow press) if focus had
  // been on a now-replaced tab button.
  navigateWindow(delta) {
    const windows = this.layout?.windows || [];
    if (windows.length === 0) return;
    let idx = windows.findIndex(w => w.id === this.activeWindow);
    if (idx === -1) idx = 0;
    for (let n = 0; n < windows.length; n++) {
      idx = (idx + delta + windows.length) % windows.length;
      const cand = windows[idx];
      if (cand && !this._windowDisabled(cand.id)) {
        // Arrow-key browsing must NOT count as a toolbar "access" — mark the
        // target so the SplitManager skips it when the layout comes back.
        this.unit?._suppressAccessIds?.add(cand.id);
        this.selectWindow(cand.id);
        this.focusPanel();
        return;
      }
    }
    // Every other window is occupied by another pane — nothing to move to.
  }

  // The user-selectable session list: exactly what render() shows (web-* shadow
  // sessions excluded), so arrow-key session nav can never land on another
  // pane's ephemeral grouped session.
  _sessionList() {
    return (this.layout?.sessions || []).filter(s => !/^web-/.test(s.name));
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

  selectWindow(windowId) {
    if (this._windowDisabled(windowId)) return;   // shown in another split pane
    this.unit?.selectWindow(windowId);
  }

  startRename(windowId) {
    this.editingWindow = windowId;
    this.updateComplete.then(() => {
      const input = this.renderRoot.querySelector('.window-edit');
      if (input) { input.focus(); input.select(); }
    });
  }

  onRenameKey(e, windowId) {
    if (e.key === 'Enter') {
      e.preventDefault();
      this.commitRename(e, windowId);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.editingWindow = '';   // cancel
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
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.editingSession = '';   // cancel
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
  killWindow(windowId) {
    const win = (this.layout?.windows || []).find(w => w.id === windowId);
    if (this._windowLinkedElsewhere(win)) {
      this.unit?.unlinkWindow(windowId);   // just remove it from this session
      return;
    }
    const label = win ? `window ${win.index}: ${win.name || 'bash'}` : 'this window';
    if (!confirm(`Kill ${label}? This ends its processes.`)) return;
    this.unit?.killWindow(windowId);
  }

  // A window is "linked elsewhere" when it belongs to more than one logical
  // session (sessionCount from the backend; defaults to 1 when unknown).
  _windowLinkedElsewhere(win) {
    return (win?.sessionCount || 1) > 1;
  }

  // Tooltip/aria-label for a window's × — distinguishes the unlink case ("Remove
  // from session") from the kill case ("Kill window"), matching what the click does.
  _windowKillLabel(win) {
    if (this._windowLinkedElsewhere(win)) {
      const others = (win.sessionCount || 2) - 1;
      return `Remove window ${win.index} from this session — stays open in ${others} other session${others === 1 ? '' : 's'}`;
    }
    return `Kill window ${win.index}: ${win?.name || 'bash'} — ends its processes`;
  }

  // Killing a session confirms first UNLESS it's empty (a single idle-shell window
  // with nothing running — the backend flags it), where there's no live work to
  // protect and the confirm is just friction.
  killSession(sessionName) {
    const sess = (this.layout?.sessions || []).find(s => s.name === sessionName);
    if (!sess?.empty &&
        !confirm(`Kill session "${sessionName}" and all its windows? This ends their processes.`)) return;
    this.unit?.killSession(sessionName);
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

customElements.define('webtmux-sidebar', WebtmuxSidebar);
