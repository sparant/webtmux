// Top toolbar: a most-recently-accessed window strip on the LEFT and the sidebar
// toggle on the RIGHT. The SplitManager owns the data — it sets `recent`
// (up to 5 {id,index,name,active}) and `collapsed`, and handles clicks via
// `manager.pickRecentWindow(id)` / `manager.sidebar.toggleCollapsed()`.
import { LitElement, html, css } from 'lit';

class WebtmuxToolbar extends LitElement {
  static properties = {
    recent: { type: Array },
    collapsed: { type: Boolean },
    panes: { type: Array },
  };

  static styles = css`
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
    .label { color: #666; font-size: 12px; margin-right: 2px; white-space: nowrap; flex: 0 0 auto; }
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
    .tab .sess { color: #4a9eff; font-size: 11px; opacity: 0.85; flex: 0 0 auto; }
    .tab.active .sess { color: #ffd7de; }
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
    /* Build id on the far left — read it aloud to identify the running build. */
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
      cursor: default;
    }
  `;

  constructor() {
    super();
    this.recent = [];
    this.collapsed = false;
    this.panes = [];       // [bool] per pane in order; true = focused. [] hides the dots.
    this.manager = null;   // SplitManager, set directly
    // Build id (git short-hash) served fresh by config.js from the RUNNING binary —
    // read it out loud to identify exactly which build is deployed.
    this.build = (typeof window !== 'undefined' && window.webtmux_build) || '?';
    this.built = (typeof window !== 'undefined' && window.webtmux_built) || '';
  }

  render() {
    return html`
      <span class="build" title="webtmux build ${this.build}${this.built ? ' — built ' + this.built : ''}">⬢ ${this.build}</span>
      <div class="tabs">
        ${this.recent.length ? html`<span class="label">Recent</span>` : ''}
        ${this.recent.map(w => html`
          <button
            class="tab ${w.active ? 'active' : ''}"
            title="${w.session} — window ${w.index}: ${w.name}"
            @click=${() => this.manager?.pickRecentWindow(w)}
          ><span class="sess">${w.session}:${w.index}</span><span class="wname">${w.name}</span><span
              class="close"
              title="Remove from recents (does not close the window)"
              @click=${(e) => { e.stopPropagation(); this.manager?.removeRecent(w.id); }}
            >×</span></button>
        `)}
      </div>
      ${this.panes.length > 1 ? html`
        <div class="dots" title="Panes — green is the focused pane">
          ${this.panes.map((focused, i) => html`<span
            class="dot ${focused ? 'focused' : ''}"
            title="Pane ${i + 1}${focused ? ' (focused)' : ''}"></span>`)}
        </div>
      ` : ''}
      <button
        class="sidebar-toggle"
        title="Toggle sidebar (Ctrl+Alt+B)"
        @click=${() => this.manager?.sidebar?.toggleCollapsed()}
      >${this.collapsed ? '☰' : '✕'}</button>
    `;
  }
}

customElements.define('webtmux-toolbar', WebtmuxToolbar);
