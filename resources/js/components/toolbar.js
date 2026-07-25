// Top toolbar: a most-recently-accessed window strip on the LEFT and the sidebar
// toggle on the RIGHT. The SplitManager owns the data — it sets `recent`
// (up to 5 {id,index,name,active}) and `collapsed`, and handles clicks via
// `manager.pickRecentWindow(id)` / `manager.sidebar.toggleCollapsed()`.
import { LitElement, html, css } from 'lit';
import { Terminal } from '@xterm/xterm';
import { CaptureCache, placementKey } from '../capture-cache.js';
import { chord } from '../os.js';
import { stateStore } from '../state-store.js';

// xterm's own stylesheet, pulled into this component's shadow root so the hover
// preview's terminal rows lay out correctly (same CDN the PiP overlay uses).
const XTERM_CSS = 'https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css';

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
    /* Working-status dot: green = working, red = stopped, unfilled = unset.
       Clients drive it with: tmux set -w @wt_working 1|0  (set -u to clear). */
    .tab .work {
      flex: 0 0 auto; align-self: center; width: 8px; height: 8px; border-radius: 50%;
      border: 1px solid #5a6a8a; background: transparent; box-sizing: border-box;
    }
    .tab .work.on  { background: #2ecc71; border-color: #2ecc71; box-shadow: 0 0 4px #2ecc71; }
    .tab .work.off { background: #e74c3c; border-color: #e74c3c; }
    .tab.active .work { border-color: #ffd7de; }
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
    .save-hint { color: #6b7690; font-size: 10.5px; line-height: 1.4; }
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

    /* Recent-tab HOVER PREVIEW: a small pip-sized live thumbnail that drops beneath a
       recent tab while you pause on it — but only when that window isn't already shown
       in the Preview (corner box / bar), where it'd just duplicate. Passive
       (pointer-events:none) and position:fixed so it escapes the .tabs overflow clip.
       Coexists with the tooltip: the tip sits just under the tab, this just under the
       tip (positioned imperatively in _tabPrevShow). */
    .tabprev {
      position: fixed;
      z-index: 90;
      display: none;
      flex-direction: column;
      background: #12131f;
      border: 1px solid #37d17a;
      border-radius: 8px;
      overflow: hidden;
      box-shadow: 0 14px 40px rgba(0, 0, 0, 0.66);
      pointer-events: none;
      font-family: Menlo, Monaco, "Courier New", monospace;
    }
    .tabprev.show { display: flex; }
    .tabprev .tp-frame {
      position: relative;
      /* Match the size the single-window corner PiP grows to on hover (see
         pip-overlay.js: width min(1080, 100vw-32) × frame min(648, 100vh-160)) so a
         recent-tab preview is as big and readable as the PiP's zoomed state — no
         squinting at a tiny thumbnail. Width is set imperatively in _tabPrevShow. */
      height: min(648px, calc(100vh - 160px));
      background: #1a1a2e;
      overflow: hidden;
      border-bottom: 1px solid #0f3460;
    }
    .tabprev .tp-host { position: absolute; inset: 0; }
    .tabprev .tp-host .screen { position: absolute; top: 0; left: 0; transform-origin: top left; }
    .tabprev .tp-label {
      display: flex; align-items: baseline; justify-content: space-between; gap: 8px;
      padding: 5px 9px; font-size: 12px; color: #d6ddf5; white-space: nowrap;
    }
    .tabprev .tp-label .tp-name { overflow: hidden; text-overflow: ellipsis; }
    .tabprev .tp-label .tp-sess { flex: 0 0 auto; color: #7f8bb5; letter-spacing: 0.06em; font-size: 11px; }
  `;

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
    // Re-apply shared prefs (scroll mode, build-chip visibility) on any remote change
    // — e.g. cycling scroll mode from a region sidebar, or another client toggling.
    stateStore.subscribe(() => {
      this.scrollMode = normalizeScroll(stateStore.section('renderer').scrollMode || '');
      this.showBuild = stateStore.section('toolbar').showBuild === true;
      this.requestUpdate();
    });
    this._tipTimer = null; // pending show timer for the quick tab tooltip
    // Recent-tab hover-preview state (parallels the tooltip's, using the same delay).
    this._prevTimer = null;    // pending "pause then show" timer
    this._prevHideTimer = null; // grace timer so sweeping tab→tab doesn't re-pause
    this._prevId = null;       // window id currently previewed on hover, or null
    this._prevSess = '';       // that window's logical session (for the placement-keyed capture)
    this._prevRec = null;      // { term, screen, cols, rows } for the preview's xterm
    this._prevOnUpdate = null; // capture-cache 'update' listener (keeps the preview live)
    this.saveOpen = false;   // save dropdown open?
    this.saveStatus = null;  // transient save result banner (see properties)
  }

  // Show/hide the build-id chip (Ctrl+Alt+B, wired by the SplitManager). Persisted
  // so the choice survives a reload.
  toggleBuild() {
    this.showBuild = !this.showBuild;
    stateStore.patchSection('toolbar', { showBuild: this.showBuild });
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
    if (this._tipTimer) { clearTimeout(this._tipTimer); this._tipTimer = null; }
    if (this._prevTimer) { clearTimeout(this._prevTimer); this._prevTimer = null; }
    if (this._prevHideTimer) { clearTimeout(this._prevHideTimer); this._prevHideTimer = null; }
    const cache = this.manager?.captureCache;
    if (cache && this._prevOnUpdate) cache.removeEventListener('update', this._prevOnUpdate);
    this._prevOnUpdate = null;
    if (this._prevRec) { try { this._prevRec.term.dispose(); } catch (e) {} this._prevRec = null; }
    this._prevId = null;
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

  // ---- recent-tab hover preview -----------------------------------------------
  // A small pip-sized live thumbnail beneath a recent tab, shown after the SAME pause
  // as the tooltip — but only when the window isn't already visible in the Preview
  // (corner box / bar), where a copy would be redundant. Fed by the shared
  // CaptureCache (same frames Exposé/Preview read) and kept live via its 'update'
  // event. Passive (pointer-events:none); it never covers the tooltip (positioned
  // just below it).

  // Hover-preview box width — matches the single-window corner PiP's grown-on-hover
  // width (pip-overlay.js: min(1080px, 100vw-32)), so a recent-tab preview is the
  // same big, readable size as the PiP's zoomed state. Frame height is the matching
  // clamp in CSS (.tabprev .tp-frame). A CSS expression (not a px number) so it
  // tracks the viewport; set on box.style.width in _tabPrevShow.
  static _PREV_W = 'min(1080px, calc(100vw - 32px))';

  _tabPrevEl() { return this.renderRoot?.querySelector('.tabprev'); }

  _tabPrevEnter(ev, w) {
    const cache = this.manager?.captureCache;
    if (!w?.id || !cache) return;
    // Cancel a pending grace-hide from the tab we just left, so sweeping onto this
    // tab keeps the preview up instead of letting it disappear mid-move.
    if (this._prevHideTimer) { clearTimeout(this._prevHideTimer); this._prevHideTimer = null; }
    // Already shown live in the Preview? Then a hover copy just duplicates it — skip.
    if (this.manager?.pip?.isShowing?.(w.id)) { this._tabPrevLeave(); return; }
    const target = ev.currentTarget;
    if (this._prevTimer) { clearTimeout(this._prevTimer); this._prevTimer = null; }
    const box = this._tabPrevEl();
    // Already visible (sweeping tab→tab, including across the brief gap the
    // grace-hide bridges) → switch instantly, no second pause. Once you've paused to
    // see ONE preview, moving left/right shows each next tab's preview immediately.
    if (box && box.classList.contains('show')) { this._tabPrevShow(target, w); return; }
    this._prevTimer = setTimeout(() => {
      if (!target.isConnected) return;
      this._tabPrevShow(target, w);
    }, WebtmuxToolbar._TIP_DELAY);
  }

  _tabPrevShow(target, w) {
    this._prevTimer = null;
    const cache = this.manager?.captureCache;
    const box = this._tabPrevEl();
    if (!box || !cache || !target?.isConnected) return;
    if (this.manager?.pip?.isShowing?.(w.id)) { this._tabPrevLeave(); return; }
    this._prevId = w.id;
    this._prevSess = w.session || '';
    this._buildTabPrevChrome(box);
    box.querySelector('.tp-name').textContent = `${w.index}: ${w.name}`;
    box.querySelector('.tp-sess').textContent = w.session || '';
    box.style.width = WebtmuxToolbar._PREV_W;
    // Show first (so it has real dimensions to clamp against), then position it just
    // below the tooltip (kept visible) — or below the tab if the tip isn't up yet.
    box.classList.add('show');
    const tip = this._tipEl();
    const tr = target.getBoundingClientRect();
    const margin = 6;
    const anchorBottom = (tip && tip.classList.contains('show'))
      ? tip.getBoundingClientRect().bottom : tr.bottom;
    const bw = box.offsetWidth;
    let left = tr.left;
    if (left + bw > window.innerWidth - margin) left = window.innerWidth - bw - margin;
    if (left < margin) left = margin;
    box.style.left = `${Math.round(left)}px`;
    box.style.top = `${Math.round(anchorBottom + margin)}px`;
    this._ensurePrevListener();
    cache.request([w.id], true);   // prime a fresh frame
    this._paintTabPrev();
  }

  _buildTabPrevChrome(box) {
    if (box._wired) return;
    const frame = document.createElement('div');
    frame.className = 'tp-frame';
    const host = document.createElement('div');
    host.className = 'tp-host';
    frame.appendChild(host);
    const label = document.createElement('div');
    label.className = 'tp-label';
    const name = document.createElement('span'); name.className = 'tp-name';
    const sess = document.createElement('span'); sess.className = 'tp-sess';
    label.append(name, sess);
    box.append(frame, label);
    box._wired = true;
  }

  _paintTabPrev() {
    const id = this._prevId;
    if (!id) return;
    const box = this._tabPrevEl();
    if (!box || !box.classList.contains('show')) return;
    const cache = this.manager?.captureCache;
    const sess = this._prevSess;
    const entry = (sess && cache?.byPlacement?.get(placementKey(sess, id))) || cache?.get(id);
    if (!entry) return;
    const rec = this._ensurePrevTerm(box, entry);
    if (!rec) return;
    if (entry.cols && entry.rows && (entry.cols !== rec.cols || entry.rows !== rec.rows)) {
      try { rec.term.resize(entry.cols, entry.rows); } catch (e) {}
      rec.cols = entry.cols; rec.rows = entry.rows;
    }
    rec.term.write('\x1b[H\x1b[2J');
    rec.term.write(CaptureCache.decodeAnsi(entry));
    this._rescalePrev();
  }

  _ensurePrevTerm(box, entry) {
    if (this._prevRec) return this._prevRec;
    const host = box.querySelector('.tp-host');
    if (!host) return null;
    const screen = document.createElement('div');
    screen.className = 'screen';
    host.appendChild(screen);
    const term = new Terminal({
      cols: entry?.cols || 80,
      rows: entry?.rows || 24,
      fontSize: 14,
      fontFamily: '"DejaVu Sans Mono", Menlo, Monaco, "Cascadia Mono", "Noto Sans Mono", "Liberation Mono", "Courier New", "Symbols Nerd Font", monospace',
      theme: { background: '#1a1a2e', foreground: '#eaeaea' },
      scrollback: 0,
      disableStdin: true,
      cursorStyle: 'bar',
      cursorInactiveStyle: 'none',
      allowProposedApi: true,
    });
    term.open(screen);
    this._prevRec = { term, screen, cols: entry?.cols || 0, rows: entry?.rows || 0 };
    return this._prevRec;
  }

  _rescalePrev() {
    const rec = this._prevRec;
    const box = this._tabPrevEl();
    if (!rec || !box) return;
    const frame = box.querySelector('.tp-frame');
    if (!frame) return;
    requestAnimationFrame(() => {
      const nw = rec.screen.offsetWidth || 1;
      const nh = rec.screen.offsetHeight || 1;
      const scale = Math.min(frame.clientWidth / nw, frame.clientHeight / nh);
      rec.screen.style.transform = `scale(${scale})`;
    });
  }

  _ensurePrevListener() {
    if (this._prevOnUpdate) return;
    const cache = this.manager?.captureCache;
    if (!cache) return;
    this._prevOnUpdate = (e) => {
      const caps = (e && e.detail && e.detail.captures) || [];
      if (this._prevId && caps.some((c) => c.windowId === this._prevId)) this._paintTabPrev();
    };
    cache.addEventListener('update', this._prevOnUpdate);
  }

  // Grace-hide window (ms): keep the preview up briefly after leaving a tab so
  // moving to an ADJACENT tab (a moment where no tab is hovered) doesn't force a
  // fresh pause — the next tab's _tabPrevEnter cancels the hide and switches
  // instantly. Same hover-intent trick as the PiP bar magnifier's grace.
  static _PREV_HIDE_GRACE = 260;

  // Leave a tab: schedule the hide after the grace window rather than hiding at
  // once. _prevId stays set through the grace so live captures keep the preview
  // painted while you're mid-sweep.
  _tabPrevLeave() {
    if (this._prevTimer) { clearTimeout(this._prevTimer); this._prevTimer = null; }
    if (this._prevHideTimer) clearTimeout(this._prevHideTimer);
    this._prevHideTimer = setTimeout(() => this._tabPrevHideNow(), WebtmuxToolbar._PREV_HIDE_GRACE);
  }

  // Hide the preview immediately (a click committed the switch, or teardown) —
  // no grace.
  _tabPrevHideNow() {
    if (this._prevTimer) { clearTimeout(this._prevTimer); this._prevTimer = null; }
    if (this._prevHideTimer) { clearTimeout(this._prevHideTimer); this._prevHideTimer = null; }
    this._prevId = null;
    this._prevSess = '';
    const box = this._tabPrevEl();
    if (box) box.classList.remove('show');
  }

  render() {
    return html`
      <link rel="stylesheet" href=${XTERM_CSS} />
      ${this.showBuild ? html`<span class="build" title="webtmux build ${this.build}${this.built ? ' — built ' + this.built : ''} — hide with ${chord('B')}">⬢ ${this.build}</span>` : ''}
      <div class="tabs">
        ${this.recent.length ? html`<span class="label">Recent</span>` : ''}
        ${this.recent.map(w => {
          const tip = w.disabled ? 'Shown in another pane' : `${w.session} — window ${w.index}: ${w.name}`;
          return html`
          <button
            class="tab ${w.active ? 'active' : ''} ${w.disabled ? 'disabled' : ''}"
            aria-label=${tip}
            @mouseenter=${(e) => { this._tipEnter(e, tip); this._tabPrevEnter(e, w); }}
            @mouseleave=${() => { this._tipLeave(); this._tabPrevLeave(); }}
            @click=${() => { this._tipLeave(); this._tabPrevHideNow(); if (!w.disabled) this.manager?.pickRecentWindow(w); }}
          ><span class="work ${w.working === '1' ? 'on' : w.working === '0' ? 'off' : ''}" aria-hidden="true"></span><span class="sess">${w.index}</span><span class="wname">${w.name}</span><span
              class="close"
              aria-label="Remove from Recent (does not close the window)"
              @mouseenter=${(e) => { e.stopPropagation(); this._tipEnter(e, 'Remove this tab from Recent — the window keeps running (this does not close or kill it)'); }}
              @mouseleave=${(e) => { e.stopPropagation(); this._tipEnter({ currentTarget: e.currentTarget.closest('.tab') }, tip); }}
              @click=${(e) => { e.stopPropagation(); this._tipLeave(); this.manager?.removeRecent(w); }}
            >×</span></button>
        `;})}
      </div>
      <div class="wt-tip"></div>
      <div class="tabprev"></div>
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
                placeholder="~/out.txt or ./out.txt"
                @keydown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); this._saveToPath(); } e.stopPropagation(); }}
              >
              <button class="save-go" @click=${() => this._saveToPath()}>Save</button>
            </div>
            <div class="save-hint">Relative paths save in the focused pane's current directory; ~ and absolute paths are honored as-is.</div>
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
