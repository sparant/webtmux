// Sidebar component with minimap
import { LitElement, html, css } from 'lit';

class WebtmuxSidebar extends LitElement {
  static properties = {
    layout: { type: Object },
    activePane: { type: String },
    activeWindow: { type: String },
    collapsed: { type: Boolean },
    overlay: { type: Boolean },
    scrollMode: { type: String },
    pinned: { type: Boolean },
    editingWindow: { type: String },
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
       removes the host from the #app flex flow, so #terminal-container expands to
       full width and its ResizeObserver re-fits xterm automatically. */
    :host(.overlay) {
      position: fixed;
      top: 0;
      right: 0;
      height: 100%;
      z-index: 50;
      box-shadow: -8px 0 24px rgba(0, 0, 0, 0.5);
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

    .toggle-btn {
      position: absolute;
      top: 8px;
      right: 8px;
      background: #1a1a2e;
      border: 1px solid #0f3460;
      border-radius: 6px;
      color: #ccc;
      width: 34px;
      height: 34px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 10;
    }

    .toggle-btn:hover {
      border-color: #e94560;
      color: #fff;
    }

    /* Collapsed: the whole pane disappears; only a bigger toggle button floats
       over the top-right of the terminal (Ctrl+Alt+B also toggles it). */
    :host(.collapsed) {
      position: fixed;
      top: 10px;
      right: 10px;
      width: auto;
      height: auto;
      padding: 0;
      background: transparent;
      border: none;
      overflow: visible;
      box-shadow: none;
      z-index: 60;
    }

    :host(.collapsed) .toggle-btn {
      position: static;
      width: 44px;
      height: 44px;
      background: #16213e;
      border: 1px solid #0f3460;
      box-shadow: 0 2px 12px rgba(0, 0, 0, 0.6);
    }

    :host(.collapsed) .sidebar-content {
      display: none;
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

    .window-tabs {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-bottom: 16px;
    }

    .window-tab {
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

    .window-edit {
      background: #0f3460;
      color: #fff;
      border: 1px solid #e94560;
      border-radius: 4px;
      padding: 6px 10px;
      font-size: 15px;
      width: 130px;
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
    // Scroll-wheel behavior mirror of the app's setting ('buffer' | 'passthrough').
    this.scrollMode = localStorage.getItem('webtmux-scroll-mode') || 'buffer';
    // Pinned = stay open when clicking into the terminal (default: auto-hide).
    this.pinned = localStorage.getItem('webtmux-pinned') === 'true';
    // Window id currently being renamed inline ('' = none).
    this.editingWindow = '';

    // Listen for layout updates
    window.addEventListener('tmux-layout-update', (e) => {
      this.layout = e.detail;
      this.activePane = e.detail.activePaneId;
      this.activeWindow = e.detail.activeWindowId;
    });
  }

  updated(changedProperties) {
    if (changedProperties.has('collapsed')) {
      if (this.collapsed) {
        this.classList.add('collapsed');
      } else {
        this.classList.remove('collapsed');
        // Opening the panel grabs keyboard focus so ↑/↓ navigate windows.
        this.focusPanel();
      }
    }
    if (changedProperties.has('overlay')) {
      // Toggling in/out of flow changes #terminal's width; its ResizeObserver
      // re-fits xterm. A deferred fit() nudge covers the reflow timing.
      this.classList.toggle('overlay', this.overlay);
      setTimeout(() => { try { window.webtmux?.fitAddon?.fit(); } catch (e) {} }, 80);
    }
  }

  toggleCollapsed() {
    this.collapsed = !this.collapsed;
  }

  toggleOverlay() {
    this.overlay = !this.overlay;
    localStorage.setItem('webtmux-overlay', String(this.overlay));
  }

  togglePin() {
    this.pinned = !this.pinned;
    localStorage.setItem('webtmux-pinned', String(this.pinned));
  }

  toggleScrollMode() {
    this.scrollMode = this.scrollMode === 'passthrough' ? 'buffer' : 'passthrough';
    // Apply live to the terminal app (also persists); fall back to localStorage.
    if (window.webtmux?.setScrollMode) {
      window.webtmux.setScrollMode(this.scrollMode);
    } else {
      localStorage.setItem('webtmux-scroll-mode', this.scrollMode);
    }
  }

  modeRow() {
    return html`
      <div class="mode-row">
        <div class="shortcut-hint">Toggle panel: <kbd>⌃ Control</kbd>+<kbd>⌥ Option</kbd>+<kbd>B</kbd></div>
        <button
          class="mode-btn"
          @click=${this.toggleOverlay}
          title="Hover = float over the terminal; Side-by-side = shrink the terminal to sit beside the pane"
        >
          ${this.overlay ? '▣ Hover over terminal' : '⇔ Side-by-side'}
        </button>
        <button
          class="mode-btn"
          @click=${this.toggleScrollMode}
          title="Buffer = wheel scrolls tmux history (copy-mode); Pass to app = wheel goes to the program (Claude/vim/less scroll themselves)"
        >
          ${this.scrollMode === 'passthrough' ? '🖱 Scroll → app' : '🖱 Scroll → buffer'}
        </button>
        <button
          class="mode-btn"
          @click=${this.togglePin}
          title="Pinned = the panel stays open when you click into the terminal; otherwise it auto-hides on terminal click"
        >
          ${this.pinned ? '📌 Pinned (stays open)' : '📌 Auto-hide on click'}
        </button>
      </div>
    `;
  }

  render() {
    const toggleIcon = this.collapsed
      ? html`<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>`
      : html`<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>`;

    if (!this.layout) {
      return html`
        <button class="toggle-btn" @click=${this.toggleCollapsed}>${toggleIcon}</button>
        <div class="sidebar-content" tabindex="0" @keydown=${this.onKeyDown}>
          ${this.modeRow()}
          <h3>tmux</h3>
          <p style="color: #666; font-size: 16px;">Connecting...</p>
        </div>
      `;
    }

    const sessions = this.layout.sessions || [];
    const showSessions = sessions.length > 1;

    return html`
      <button class="toggle-btn" @click=${this.toggleCollapsed}>${toggleIcon}</button>
      <div class="sidebar-content" tabindex="0" @keydown=${this.onKeyDown}>
      ${this.modeRow()}
      ${showSessions ? html`
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
        </div>
      ` : ''}

      <h3>Windows</h3>
      <div class="window-tabs">
        ${this.layout.windows?.map(win => win.id === this.editingWindow
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
              class="window-tab ${win.id === this.activeWindow ? 'active' : ''}"
              @click=${() => this.selectWindow(win.id)}
              @dblclick=${() => this.startRename(win.id)}
              title="Double-click to rename"
            >
              ${win.index}: ${win.name || 'bash'}
            </button>`
        )}
        <button class="window-tab" @click=${() => this.newWindow()}>+</button>
      </div>

      <div class="session-info">
        Session: ${this.layout.sessionName}<br>
        ${this.layout.windows?.length || 0} windows
      </div>
      </div>
    `;
  }

  // When the panel (or a control inside it) has keyboard focus, ↑/↓ move to the
  // previous/next window so you can flip through windows with the arrow keys
  // while the pane is open. Any other key falls through to normal handling.
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

  // Collapse the panel and hand keyboard focus back to the terminal, so typing
  // resumes at the prompt right after dismissing.
  dismiss() {
    this.collapsed = true;
    try { window.webtmux?.terminal?.focus(); } catch (e) {}
  }

  // Step delta windows from the active one (wrapping), by the sidebar's own
  // window order, and select it. Refocus the panel afterwards: selecting a
  // window re-renders the tabs, which would otherwise drop keyboard focus (and
  // break a second arrow press) if focus had been on a now-replaced tab button.
  navigateWindow(delta) {
    const windows = this.layout?.windows || [];
    if (windows.length === 0) return;
    let idx = windows.findIndex(w => w.id === this.activeWindow);
    if (idx === -1) idx = 0;
    const next = (idx + delta + windows.length) % windows.length;
    const target = windows[next];
    if (target) {
      this.selectWindow(target.id);
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
    window.webtmux?.selectWindow(windowId);
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
    if (name) window.webtmux?.renameWindow(windowId, name);
  }

  switchSession(sessionName) {
    window.webtmux?.switchSession(sessionName);
  }

  newWindow() {
    window.webtmux?.newWindow();
  }
}

customElements.define('webtmux-sidebar', WebtmuxSidebar);
