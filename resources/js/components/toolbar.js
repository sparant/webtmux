// Top toolbar: a most-recently-accessed window strip on the LEFT and the sidebar
// toggle on the RIGHT. The SplitManager owns the data — it sets `recent`
// (up to 5 {id,index,name,active}) and `collapsed`, and handles clicks via
// `manager.pickRecentWindow(id)` / `manager.sidebar.toggleCollapsed()`.
import { LitElement, html, css } from 'lit';
import { chord } from '../os.js';

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
    // True when Picture-in-Picture is active — highlights the toolbar's PiP button.
    pipActive: { type: Boolean },
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
    /* Shown in another pane -> not selectable from here. */
    .tab.disabled { opacity: 0.4; cursor: not-allowed; }
    .tab.disabled:hover { border-color: #0f3460; color: #ddd; }
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

    /* Custom quick tooltip for the recent tabs. The native title attribute has a
       ~1s browser delay; this appears after ~180ms (see _TIP_DELAY). position:fixed
       escapes the .tabs overflow clip (the strip hides overflow-y). Driven
       imperatively (show/hide/move) so hovering a tab never re-renders the bar. */
    .wt-tip {
      position: fixed;
      z-index: 100;
      /* Show the WHOLE hint — no ellipsis clipping. Wrap long single-line hints and
         honor \n in multi-line ones (pre-line), capping the width so it stays a
         readable column rather than one very long line. */
      max-width: min(440px, calc(100vw - 16px));
      padding: 6px 10px;
      border-radius: 5px;
      background: #0b1020;
      border: 1px solid #4a9eff;
      color: #e8eefc;
      font-size: 12px;
      line-height: 1.45;
      font-family: Menlo, Monaco, "Courier New", monospace;
      white-space: pre-line;
      overflow-wrap: anywhere;
      pointer-events: none;
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.5);
      opacity: 0;
      visibility: hidden;
    }
    .wt-tip.show {
      opacity: 1;
      visibility: visible;
    }
  `;

  constructor() {
    super();
    this.recent = [];
    this.collapsed = false;
    // Scroll-wheel mode mirror (moved here from the sidebar). Seeded from the same
    // persisted key the terminal reads, so the label is right on first paint.
    this.scrollMode = normalizeScroll(
      (typeof localStorage !== 'undefined' && localStorage.getItem('webtmux-scroll-mode')) || '');
    this.copyMode = false; // focused pane in tmux copy/view mode (SplitManager sets)
    this.pipActive = false; // Picture-in-Picture on (SplitManager sets)
    this.panes = [];       // [bool] per pane in order; true = focused. [] hides the dots.
    this.manager = null;   // SplitManager, set directly
    // Build id (git short-hash) served fresh by config.js from the RUNNING binary —
    // read it out loud to identify exactly which build is deployed.
    this.build = (typeof window !== 'undefined' && window.webtmux_build) || '?';
    this.built = (typeof window !== 'undefined' && window.webtmux_built) || '';
    this._tipTimer = null; // pending show timer for the quick tab tooltip
  }

  // Quick-tooltip delay (ms). Still snappier than the browser's native ~1s title
  // delay, but a deliberate hover pause so tooltips don't flash the instant the
  // pointer touches a tab/button or sweeps across the strip.
  static _TIP_DELAY = 600;

  // Cycle the scroll-wheel mode (app -> buffer -> auto -> auto+) and apply it live
  // to the focused unit's terminal (which also persists it). This control used to
  // live in the sidebar; the manager wires `this.manager`.
  cycleScroll() {
    const i = SCROLL_ORDER.indexOf(normalizeScroll(this.scrollMode));
    const next = SCROLL_ORDER[(i + 1) % SCROLL_ORDER.length];
    this.scrollMode = next;
    const u = this.manager?.focusedUnit;
    if (u?.setScrollMode) u.setScrollMode(next);
    else if (typeof localStorage !== 'undefined') localStorage.setItem('webtmux-scroll-mode', next);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this._tipTimer) { clearTimeout(this._tipTimer); this._tipTimer = null; }
  }

  _tipEl() {
    return this.renderRoot?.querySelector('.wt-tip');
  }

  // Schedule the tooltip to appear under the hovered target after a short delay —
  // OR, if a tip is already visible (e.g. moving from a tab onto its child × or
  // onto the pane dots), swap its text/position INSTANTLY so it tracks the pointer
  // without a second delay.
  _tipEnter(ev, text) {
    if (!text) return;
    const target = ev.currentTarget;
    if (this._tipTimer) clearTimeout(this._tipTimer);
    const tip = this._tipEl();
    if (tip && tip.classList.contains('show')) {
      this._tipShow(target, text);
      return;
    }
    this._tipTimer = setTimeout(() => {
      if (!target.isConnected) return;
      this._tipShow(target, text);
    }, WebtmuxToolbar._TIP_DELAY);
  }

  // Position + reveal the tip under `target` with `text`. Clamped to the viewport.
  _tipShow(target, text) {
    const tip = this._tipEl();
    if (!tip || !target?.isConnected) return;
    tip.textContent = text;
    // Show first (still transparent) so it has real dimensions to clamp against.
    tip.classList.add('show');
    const r = target.getBoundingClientRect();
    const tw = tip.offsetWidth;
    const margin = 6;
    let left = r.left;
    if (left + tw > window.innerWidth - margin) left = window.innerWidth - tw - margin;
    if (left < margin) left = margin;
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(r.bottom + margin)}px`;
  }

  _tipLeave() {
    if (this._tipTimer) { clearTimeout(this._tipTimer); this._tipTimer = null; }
    const tip = this._tipEl();
    if (tip) tip.classList.remove('show');
  }

  render() {
    return html`
      <span class="build" title="webtmux build ${this.build}${this.built ? ' — built ' + this.built : ''}">⬢ ${this.build}</span>
      <div class="tabs">
        ${this.recent.length ? html`<span class="label">Recent</span>` : ''}
        ${this.recent.map(w => {
          const tip = w.disabled ? 'Shown in another pane' : `${w.session} — window ${w.index}: ${w.name}`;
          return html`
          <button
            class="tab ${w.active ? 'active' : ''} ${w.disabled ? 'disabled' : ''}"
            aria-label=${tip}
            @mouseenter=${(e) => this._tipEnter(e, tip)}
            @mouseleave=${() => this._tipLeave()}
            @click=${() => { this._tipLeave(); if (!w.disabled) this.manager?.pickRecentWindow(w); }}
          ><span class="sess">${w.session}:${w.index}</span><span class="wname">${w.name}</span><span
              class="close"
              aria-label="Remove from Recent (does not close the window)"
              @mouseenter=${(e) => { e.stopPropagation(); this._tipEnter(e, 'Remove this tab from Recent — the window keeps running (this does not close or kill it)'); }}
              @mouseleave=${(e) => { e.stopPropagation(); this._tipEnter({ currentTarget: e.currentTarget.closest('.tab') }, tip); }}
              @click=${(e) => { e.stopPropagation(); this._tipLeave(); this.manager?.removeRecent(w.id); }}
            >×</span></button>
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
        class="tbtn"
        aria-label="Exposé — all windows"
        @mouseenter=${(e) => this._tipEnter(e, `Exposé — a thumbnail of every window across all sessions. Shortcut: ${chord('E')}`)}
        @mouseleave=${() => this._tipLeave()}
        @click=${() => { this._tipLeave(); this.manager?.expose?.toggle(); }}
      >▦</button>
      <button
        class="tbtn text"
        aria-label="Scroll-wheel mode"
        @mouseenter=${(e) => this._tipEnter(e, scrollTooltip(normalizeScroll(this.scrollMode)))}
        @mouseleave=${() => this._tipLeave()}
        @click=${() => { this._tipLeave(); this.cycleScroll(); }}
      >${(SCROLL_META[normalizeScroll(this.scrollMode)] || SCROLL_META['adaptive-probe']).label}</button>
      <button
        class="tbtn"
        aria-label="Keyboard shortcuts"
        @mouseenter=${(e) => this._tipEnter(e, `Keyboard shortcuts. Shortcut: ${chord('/')}`)}
        @mouseleave=${() => this._tipLeave()}
        @click=${() => { this._tipLeave(); this.manager?.shortcuts?.toggle(); }}
      >⌨</button>
      ${this.panes.length > 1 ? html`
        <div
          class="dots"
          @mouseenter=${(e) => this._tipEnter(e, `Split panes — one dot per open terminal region (${this.panes.length} open); green is the focused pane. Drag a divider to resize; ${chord('X')} closes the focused region.`)}
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
        class="pip-toggle ${this.pipActive ? 'on' : ''}"
        title="Picture-in-Picture the focused window (${chord('I')})"
        @click=${() => this.manager?.togglePip()}
      >◳</button>
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
