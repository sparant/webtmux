// Top toolbar: a most-recently-accessed window strip on the LEFT and the sidebar
// toggle on the RIGHT. The SplitManager owns the data — it sets `recent`
// (up to 5 {id,index,name,active}) and `collapsed`, and handles clicks via
// `manager.pickRecentWindow(id)` / `manager.sidebar.toggleCollapsed()`.
import { LitElement, html, css } from 'lit';

class WebtmuxToolbar extends LitElement {
  static properties = {
    recent: { type: Array },
    collapsed: { type: Boolean },
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
      gap: 4px;
      overflow: hidden;
      flex: 1 1 auto;
    }
    .label { color: #666; font-size: 12px; margin-right: 2px; white-space: nowrap; }
    .tab {
      background: #1a1a2e;
      color: #aaa;
      border: 1px solid #0f3460;
      border-radius: 4px;
      padding: 4px 10px;
      font-size: 13px;
      cursor: pointer;
      white-space: nowrap;
      max-width: 200px;
      overflow: hidden;
      text-overflow: ellipsis;
      font-family: Menlo, Monaco, "Courier New", monospace;
      transition: all 0.15s;
    }
    .tab:hover { border-color: #4a9eff; color: #fff; }
    .tab.active { background: #e94560; border-color: #e94560; color: #fff; }
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
  `;

  constructor() {
    super();
    this.recent = [];
    this.collapsed = false;
    this.manager = null;   // SplitManager, set directly
  }

  render() {
    return html`
      <div class="tabs">
        ${this.recent.length ? html`<span class="label">Recent</span>` : ''}
        ${this.recent.map(w => html`
          <button
            class="tab ${w.active ? 'active' : ''}"
            title="Go to window ${w.index}: ${w.name}"
            @click=${() => this.manager?.pickRecentWindow(w.id)}
          >${w.index}: ${w.name}</button>
        `)}
      </div>
      <button
        class="sidebar-toggle"
        title="Toggle sidebar (Ctrl+Alt+B)"
        @click=${() => this.manager?.sidebar?.toggleCollapsed()}
      >${this.collapsed ? '☰' : '✕'}</button>
    `;
  }
}

customElements.define('webtmux-toolbar', WebtmuxToolbar);
