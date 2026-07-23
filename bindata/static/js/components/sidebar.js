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
    // Window id currently being dragged for reorder ('' = none).
    draggingWindow: { type: String },
    // Window id currently under the drag pointer (drop target highlight).
    dragOverWindow: { type: String },
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

    /* Drag-and-drop reordering: the row being dragged dims, and the row under the
       pointer shows a bright top accent marking where it will land. */
    .window-tab[draggable] { cursor: grab; }
    .window-tab.dragging {
      opacity: 0.4;
      cursor: grabbing;
    }
    .window-tab.drag-over {
      border-top: 2px solid #4a9eff;
      box-shadow: 0 -2px 6px rgba(74, 158, 255, 0.4);
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
      background: #1a1a2e;
      color: #888;
      border: 1px solid #0f3460;
      border-radius: 4px;
      padding: 6px 10px;
      font-size: 15px;
      cursor: pointer;
      transition: all 0.2s;
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
    // Drag-and-drop reorder state.
    this.draggingWindow = '';
    this.dragOverWindow = '';
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
  // split-add, Exposé, scroll mode, keyboard shortcuts — now live on the toolbar.
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
        ${sessions.map(sess => html`
          <button
            class="session-tab ${sess.active ? 'active' : ''}"
            @click=${() => this.switchSession(sess.name)}
          >
            ${sess.name}<span class="win-count">(${sess.windows})</span>
          </button>
        `)}
        <button class="session-tab" title="New session" @click=${() => this.newSession()}>+</button>
      </div>

      <h3>Windows</h3>
      <div class="window-tabs">
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
              class="window-tab ${win.id === this.activeWindow ? 'active' : ''} ${this._windowDisabled(win.id) ? 'disabled' : ''} ${win.id === this.draggingWindow ? 'dragging' : ''} ${win.id === this.dragOverWindow ? 'drag-over' : ''}"
              draggable="true"
              @click=${() => this.selectWindow(win.id)}
              @dblclick=${() => this.startRename(win.id)}
              @dragstart=${(e) => this.onDragStart(e, win.id)}
              @dragover=${(e) => this.onDragOver(e, win.id)}
              @dragleave=${() => this.onDragLeave(win.id)}
              @drop=${(e) => this.onDrop(e, i)}
              @dragend=${() => this.onDragEnd()}
              title=${this._windowDisabled(win.id) ? 'Shown in another split pane' : 'Double-click to rename · drag to reorder'}
            >
              ${win.index}: ${win.name || 'bash'}
            </button>`
        )}
        <button class="window-tab" title="New window" @click=${() => this.newWindow()}>+</button>
      </div>

      <div class="session-info">
        Session: ${this.layout.sessionBase || this.layout.sessionName}<br>
        ${this.layout.windows?.length || 0} windows
      </div>
      </div>
    `;
  }

  // --- Drag-and-drop window reordering -------------------------------------
  // The window tabs are draggable; dropping one on another reorders the shared
  // window list. The drop target's ordinal position becomes the dragged window's
  // new position, which the server realizes via adjacent swap-window calls.
  onDragStart(e, winId) {
    // Disabled windows (shown in another pane) can't be dragged meaningfully.
    if (this._windowDisabled(winId)) { e.preventDefault(); return; }
    this.draggingWindow = winId;
    try {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', winId);   // Firefox needs a payload to drag
    } catch (_) {}
  }

  onDragOver(e, winId) {
    if (!this.draggingWindow) return;
    e.preventDefault();                               // allow the drop
    try { e.dataTransfer.dropEffect = 'move'; } catch (_) {}
    if (winId !== this.draggingWindow) this.dragOverWindow = winId;
  }

  onDragLeave(winId) {
    if (this.dragOverWindow === winId) this.dragOverWindow = '';
  }

  onDrop(e, targetIdx) {
    e.preventDefault();
    const srcId = this.draggingWindow;
    this.draggingWindow = '';
    this.dragOverWindow = '';
    if (!srcId) return;
    const wins = this.layout?.windows || [];
    const from = wins.findIndex(w => w.id === srcId);
    if (from === -1 || from === targetIdx) return;
    // targetIdx is the drop target's current ordinal — the dragged window takes
    // that slot; the server bubbles it there (see Controller.MoveWindow).
    this.unit?.moveWindow(srcId, targetIdx);
  }

  onDragEnd() {
    this.draggingWindow = '';
    this.dragOverWindow = '';
  }

  // When the panel (or a control inside it) has keyboard focus, ↑/↓ move to the
  // previous/next window and ←/→ move to the previous/next session, so you can
  // flip through both with the arrow keys while the pane is open. Any other key
  // falls through to normal handling.
  onKeyDown(e) {
    // Don't hijack arrows while renaming a window inline (caret movement).
    if (this.editingWindow) return;
    const tag = e.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.navigateWindow(-1);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.navigateWindow(1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      this.navigateSession(-1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      this.navigateSession(1);
    } else if (e.key === 'Escape') {
      // Escape always dismisses the panel, wherever focus sits inside it.
      e.preventDefault();
      this.dismiss();
    } else if (e.key === 'Enter' && tag !== 'BUTTON') {
      // Enter dismisses too, but only from the panel itself — on a button
      // (window tab, +, mode toggle) Enter still activates that control.
      e.preventDefault();
      this.dismiss();
    }
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
