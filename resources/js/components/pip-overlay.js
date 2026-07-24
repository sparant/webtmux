// <webtmux-pip> — the live "Preview": a set of read-only, always-fresh previews of
// tmux windows, fed from the shared CaptureCache (the same per-window capture
// buffers Exposé uses) and polled so they stay live. Clicking a preview switches
// the FOCUSED region to that window.
//
// It has TWO shapes, chosen by how many windows are being previewed:
//   • ONE window  → a small floating Picture-in-Picture box pinned to a screen
//     CORNER, exactly like the classic PiP: hover reveals corner-move buttons + a
//     close, and the box floats OVER the terminal (z-index 50).
//   • 2+ windows  → a docked PREVIEW BAR spanning a screen EDGE (top/bottom/left/
//     right). Unlike the corner box the bar does NOT float over the terminal — it
//     RESERVES space (via the --wt-preview-* vars that pad #app), so it sits at the
//     terminal's own level and never covers content. Each tile has a hover ×
//     (remove) and click-to-activate; the bar itself carries edge-placement buttons
//     and a hide toggle.
//
// A SEPARATE hide/show toggle blanks the preview without forgetting the set, so you
// can tuck it away and bring it back with the same windows. Owned by the
// SplitManager (one instance); the toolbar drives add/remove/hide.
//
// Chrome (frame, controls, labels) is Lit-rendered; each window's xterm lives in a
// static `.screen-host` div reconciled imperatively in _syncTiles(), so a reactive
// re-render (placement move, label update) never orphans a terminal.
import { LitElement, html, css } from 'lit';
import { Terminal } from '@xterm/xterm';
import { CaptureCache, placementKey } from '../capture-cache.js';
import { chord } from '../os.js';

const XTERM_CSS = 'https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css';
const CORNERS = ['tl', 'tr', 'bl', 'br'];
const CORNER_GLYPH = { tl: '⌜', tr: '⌝', bl: '⌞', br: '⌟' };
const CORNER_NAME = { tl: 'top-left', tr: 'top-right', bl: 'bottom-left', br: 'bottom-right' };
const EDGES = ['top', 'bottom', 'left', 'right'];
const EDGE_GLYPH = { top: '↑', bottom: '↓', left: '←', right: '→' };
const EDGE_NAME = { top: 'top', bottom: 'bottom', left: 'left', right: 'right' };
const CORNER_KEY = 'webtmux-pip-corner';
const EDGE_KEY = 'webtmux-preview-edge';
const BAR_THICK = 200;     // px: bar height (top/bottom) or width (left/right)
const POLL_MS = 1500;      // keep previews live (server coalesces to 500ms)
const STALE_MS = 5000;     // no fresh capture for this long => the window is gone

class WebtmuxPip extends LitElement {
  static properties = {
    // Derived display mode, reflected so the host CSS can key off it:
    //   'off'    — nothing to show (empty set, or hidden)
    //   'single' — one window, floating corner box (classic PiP)
    //   'bar'    — 2+ windows, docked edge bar
    mode: { type: String, reflect: true },
    // Which corner the single-window box is pinned to (reflected for positioning).
    corner: { type: String, reflect: true },
    // Which edge the multi-window bar is docked to (reflected for positioning).
    edge: { type: String, reflect: true },
    _wins: { state: true },     // [{windowId, session, label}] — the preview set
    _hidden: { state: true },   // true = tucked away (set kept, nothing drawn)
    _stale: { state: true },    // Set<windowId> of windows whose captures stopped
  };

  static styles = css`
    :host { display: none; }
    :host([mode='single']), :host([mode='bar']) { display: block; }

    /* ---- SINGLE: the classic floating corner box ---------------------------- */
    :host([mode='single']) {
      position: fixed;
      z-index: 50;
      width: 360px;
      background: #12131f;
      border: 1px solid #0f3460;
      border-radius: 8px;
      box-shadow: 0 10px 34px rgba(0, 0, 0, 0.6);
      overflow: hidden;
      font-family: Menlo, Monaco, "Courier New", monospace;
    }
    /* Hover + pause DOUBLES the floating corner box (both dimensions), clamped to
       the viewport so it can't spill off-screen. Grow is delayed (deliberate pause),
       shrink-back is prompt. The frame height is doubled in lockstep just below. */
    :host([mode='single']) { transition: width 0.2s ease; }
    :host([mode='single']:hover) { width: min(720px, calc(100vw - 32px)); transition-delay: 0.35s; }
    :host([mode='single'][corner='tl']) { top: calc(var(--wt-toolbar-h, 44px) + 12px); left: 16px; }
    :host([mode='single'][corner='tr']) { top: calc(var(--wt-toolbar-h, 44px) + 12px); right: calc(var(--wt-sidebar-w, 0px) + 16px); }
    :host([mode='single'][corner='bl']) { bottom: 16px; left: 16px; }
    :host([mode='single'][corner='br']) { bottom: 16px; right: calc(var(--wt-sidebar-w, 0px) + 16px); }

    /* ---- BAR: a docked strip at terminal z-level (space is reserved by #app
       padding via the --wt-preview-* vars, so it never floats over content) --- */
    :host([mode='bar']) {
      position: fixed;
      z-index: 30;
      background: #0e1220;
      border: 1px solid #0f3460;
      box-sizing: border-box;
      font-family: Menlo, Monaco, "Courier New", monospace;
      display: flex;
    }
    :host([mode='bar'][edge='top']) {
      top: var(--wt-toolbar-h, 44px); left: 0; right: 0; height: 200px;
      border-width: 0 0 1px 0; flex-direction: row;
    }
    :host([mode='bar'][edge='bottom']) {
      bottom: 0; left: 0; right: 0; height: 200px;
      border-width: 1px 0 0 0; flex-direction: row;
    }
    :host([mode='bar'][edge='left']) {
      left: 0; top: var(--wt-toolbar-h, 44px); bottom: 0; width: 200px;
      border-width: 0 1px 0 0; flex-direction: column;
    }
    :host([mode='bar'][edge='right']) {
      right: 0; top: var(--wt-toolbar-h, 44px); bottom: 0; width: 200px;
      border-width: 0 0 0 1px; flex-direction: column;
    }

    /* The tiles container: a row for top/bottom bars, a column for left/right, and
       the whole box in single mode. Scrolls when the previews overflow. */
    .tiles {
      flex: 1 1 auto;
      min-width: 0;
      min-height: 0;
      display: flex;
      gap: 8px;
    }
    :host([mode='single']) .tiles { padding: 0; gap: 0; }
    :host([mode='bar'][edge='top']) .tiles,
    :host([mode='bar'][edge='bottom']) .tiles { flex-direction: row; overflow-x: auto; overflow-y: hidden; padding: 8px; }
    :host([mode='bar'][edge='left']) .tiles,
    :host([mode='bar'][edge='right']) .tiles { flex-direction: column; overflow-y: auto; overflow-x: hidden; padding: 8px; }

    /* A single preview tile: a scaled screen + a label strip. Bar tiles keep a FIXED
       size (the bar never grows) — hovering a bar tile instead pops a proportionally
       up-to-4x floating magnifier (.zoom) NEXT TO the bar; see _showZoom. */
    .ptile {
      position: relative;
      display: flex;
      flex-direction: column;
      background: #12131f;
      border: 1px solid #0f3460;
      border-radius: 6px;
      overflow: hidden;
      box-sizing: border-box;
    }
    /* Single mode: the one tile fills the whole box (no border/radius of its own). */
    :host([mode='single']) .ptile {
      flex: 1 1 auto;
      border: none;
      border-radius: 0;
    }
    /* Bar mode tile sizing: fixed-ish along the scroll axis, full across it. */
    :host([mode='bar'][edge='top']) .ptile,
    :host([mode='bar'][edge='bottom']) .ptile { flex: 0 0 300px; height: 100%; }
    :host([mode='bar'][edge='left']) .ptile,
    :host([mode='bar'][edge='right']) .ptile { flex: 0 0 auto; height: 150px; width: 100%; }
    .ptile.current { border-color: #37d17a; }
    :host([mode='single']) .ptile.current { border: none; }

    .pframe {
      position: relative;
      flex: 1 1 auto;
      min-height: 0;
      background: #1a1a2e;
      overflow: hidden;
      cursor: pointer;                 /* the whole preview is click-to-activate */
      border-bottom: 1px solid #0f3460;
    }
    /* Single mode keeps the classic fixed-height frame. */
    :host([mode='single']) .pframe { height: 216px; flex: none; transition: height 0.2s ease; }
    :host([mode='single']:hover) .pframe { height: 432px; transition-delay: 0.35s; }
    .screen-host { position: absolute; inset: 0; }
    .screen { position: absolute; top: 0; left: 0; transform-origin: top left; }

    /* Dim + tag a preview once its window stops producing captures (closed). */
    .pframe.stale { filter: grayscale(0.8) brightness(0.55); }
    .stale-tag {
      position: absolute; inset: 0;
      display: flex; align-items: center; justify-content: center;
      color: #ffb4b4; font-size: 13px; letter-spacing: 0.04em;
      text-shadow: 0 1px 4px #000; pointer-events: none;
    }

    /* Per-tile hover × (remove from preview). Top-right of each tile. */
    .premove {
      position: absolute;
      top: 6px; right: 6px;
      width: 22px; height: 22px;
      display: flex; align-items: center; justify-content: center;
      border-radius: 5px;
      border: 2px solid rgba(233, 69, 96, 0.7);
      background: rgba(9, 13, 28, 0.9);
      color: #f3a7b4;
      font-size: 13px; line-height: 1; padding: 0;
      cursor: pointer;
      opacity: 0; pointer-events: none;
      transition: opacity 0.12s, transform 0.1s, background 0.12s, color 0.12s;
      z-index: 4;
    }
    .ptile:hover .premove { opacity: 1; pointer-events: auto; }
    .premove:hover { transform: scale(1.12); background: #e94560; color: #fff; border-color: #e94560; }

    .plabel {
      flex: 0 0 auto;
      display: flex; align-items: baseline; justify-content: space-between; gap: 8px;
      padding: 5px 9px; font-size: 12px; color: #d6ddf5; white-space: nowrap;
    }
    .plabel .name { overflow: hidden; text-overflow: ellipsis; }
    .plabel .sess { flex: 0 0 auto; color: #7f8bb5; letter-spacing: 0.06em; font-size: 11px; }

    /* ---- bar-tile hover MAGNIFIER (.zoom) -----------------------------------
       A floating up-to-4x copy of the hovered bar tile, shown NEXT TO the bar (on
       the terminal side, away from the docked edge) so it never covers the tiles —
       you can sweep the pointer across the thumbnails and the magnifier follows the
       hovered one. It's PASSIVE (pointer-events: none): the per-preview controls
       (remove ×, click-to-activate) stay on the normal-size tiles, which the
       magnifier never covers. Sized to fit the space beside the bar (capped so it
       can't overlap the bar or leave the viewport). position:fixed + inline
       left/top/width/height set imperatively in _showZoom. */
    .zoom {
      position: fixed;
      display: none;
      z-index: 80;
      flex-direction: column;
      background: #12131f;
      border: 1px solid #37d17a;
      border-radius: 8px;
      overflow: hidden;
      box-shadow: 0 14px 40px rgba(0, 0, 0, 0.66);
      pointer-events: none;            /* passive preview — never steals hover/clicks */
    }
    .zoom.show { display: flex; }
    .zoom .zframe {
      position: relative;
      flex: 1 1 auto;
      min-height: 0;
      background: #1a1a2e;
      overflow: hidden;
      border-bottom: 1px solid #0f3460;
    }
    .zoom .screen-host { position: absolute; inset: 0; }
    .zoom .zlabel {
      flex: 0 0 auto;
      display: flex; align-items: baseline; justify-content: space-between; gap: 8px;
      padding: 6px 10px; font-size: 13px; color: #d6ddf5; white-space: nowrap;
    }
    .zoom .zlabel .name { overflow: hidden; text-overflow: ellipsis; }
    .zoom .zlabel .sess { flex: 0 0 auto; color: #7f8bb5; letter-spacing: 0.06em; font-size: 12px; }

    /* ---- classic single-box hover controls (corner move + close) ------------ */
    .controls { position: absolute; inset: 0; pointer-events: none; z-index: 3; }
    .cbtn, .close {
      position: absolute;
      display: flex; align-items: center; justify-content: center;
      border-radius: 6px;
      border: 2px solid rgba(160, 190, 245, 0.85);
      background: rgba(9, 13, 28, 0.9);
      color: #e2e9fb; cursor: pointer; line-height: 1; padding: 0;
      opacity: 0; pointer-events: none;
      transition: opacity 0.12s, transform 0.1s, border-color 0.12s, background 0.12s;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.55);
    }
    .cbtn { width: 32px; height: 32px; font-size: 18px; }
    .cbtn.tl { top: 8px; left: 8px; }
    .cbtn.tr { top: 8px; right: 8px; }
    .cbtn.bl { bottom: 8px; left: 8px; }
    .cbtn.br { bottom: 8px; right: 8px; }
    .close {
      top: 8px; left: 50%; transform: translateX(-50%);
      width: 34px; height: 26px; font-size: 14px;
      border-color: rgba(233, 69, 96, 0.7);
    }
    :host([mode='single']:hover) .cbtn,
    :host([mode='single']:hover) .close { opacity: 1; pointer-events: auto; }
    .cbtn:hover { transform: scale(1.15); border-color: #7cc0ff; background: rgba(20, 28, 54, 0.95); color: #fff; }
    .cbtn.active { border-color: #37d17a; color: #37d17a; }
    .cbtn.active:hover { border-color: #5be39a; color: #fff; }
    .close:hover { transform: translateX(-50%) scale(1.12); border-color: #e94560; background: #e94560; color: #fff; }

    /* ---- bar chrome: a compact always-visible control cluster ---------------- */
    .barctl {
      flex: 0 0 auto;
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 6px;
      background: #0b0f1c;
    }
    :host([mode='bar'][edge='left']) .barctl,
    :host([mode='bar'][edge='right']) .barctl { flex-direction: row; flex-wrap: wrap; justify-content: center; }
    .barctl .grp { display: flex; gap: 4px; }
    :host([mode='bar'][edge='top']) .barctl,
    :host([mode='bar'][edge='bottom']) .barctl { flex-direction: column; justify-content: center; }
    .bbtn {
      width: 28px; height: 28px;
      display: flex; align-items: center; justify-content: center;
      border-radius: 6px;
      border: 1px solid #0f3460;
      background: #1a1a2e; color: #ccc;
      cursor: pointer; font-size: 15px; line-height: 1; padding: 0;
    }
    .bbtn:hover { border-color: #4a9eff; color: #fff; }
    .bbtn.active { border-color: #37d17a; color: #37d17a; }
    .bbtn.hide { border-color: rgba(233, 69, 96, 0.5); color: #f3a7b4; }
    .bbtn.hide:hover { background: #e94560; color: #fff; border-color: #e94560; }
  `;

  constructor() {
    super();
    this.mode = 'off';
    this.corner = readStored(CORNER_KEY, CORNERS, 'tr');
    this.edge = readStored(EDGE_KEY, EDGES, 'bottom');
    this.cache = null;      // shared CaptureCache — set by SplitManager
    this.manager = null;    // SplitManager — set by SplitManager
    this.onChange = null;   // fired whenever the set / hidden state changes (toolbar sync)
    this._wins = [];        // [{windowId, session, label, index, name}]
    this._hidden = false;
    this._stale = new Set();
    this._terms = new Map(); // windowId -> {term, screen, cols, rows}
    this._pollTimer = null;
    // Bar-tile hover magnifier state.
    this._zoomId = null;     // window id currently magnified (bar mode), or null
    this._zoomRec = null;    // { term, screen, cols, rows } for the magnifier's xterm
    this._zoomTimer = null;  // pending "pause then show" timer
    this._zoomHideTimer = null; // grace timer so moving tile↔magnifier doesn't flicker
    // Repaint only the tiles whose captures actually arrived (and the magnifier if
    // it's showing that window, so it stays live too).
    this._onCacheUpdate = (e) => {
      const caps = (e && e.detail && e.detail.captures) || [];
      for (const c of caps) {
        if (this._has(c.windowId)) this._paint(c.windowId);
        if (c.windowId === this._zoomId) this._paintZoom();
      }
    };
    // The hover-to-enlarge CSS resizes the frame; re-letterbox the xterm inside it
    // when that transition settles. Fires on the HOST's own transition (the single
    // corner box's width); inner tile/pframe transitions are handled per-tile in
    // _buildTile (their transitionend doesn't cross the shadow boundary to here).
    this.addEventListener('transitionend', () => this._rescaleAll());
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._teardownAll();
    this._teardownZoom();
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
    this.cache?.removeEventListener('update', this._onCacheUpdate);
    this.mode = 'off';    // so _applySpace releases any reserved edge padding
    this._applySpace();
  }

  // ---- public API (driven by SplitManager) -----------------------------------

  get count() { return this._wins.length; }
  get hidden() { return this._hidden; }
  hasWindow(id) { return this._has(id); }
  _has(id) { return this._wins.some((w) => w.windowId === id); }

  // Add a window to the preview (no-op if already present). meta = {index,name,session}.
  addWindow(id, meta = {}) {
    if (!id || this._has(id)) return;
    this._wins = [...this._wins, this._entry(id, meta)];
    this._hidden = false;              // adding always reveals
    this._ensurePolling();
    this.cache?.request([id], true);   // prime a capture immediately
    this._changed();
  }

  // Remove a window from the preview.
  removeWindow(id) {
    if (!this._has(id)) return;
    this._wins = this._wins.filter((w) => w.windowId !== id);
    this._teardownTerm(id);
    this._stale.delete(id);
    this._changed();
  }

  // Add if absent, remove if present — the toolbar button / Ctrl+Alt+I behavior.
  toggleWindow(id, meta = {}) {
    if (this._has(id)) this.removeWindow(id);
    else this.addWindow(id, meta);
  }

  // Hide/show the whole preview WITHOUT forgetting the set.
  setHidden(h) {
    const v = !!h;
    if (this._hidden === v) return;
    this._hidden = v;
    // Re-showing rebuilds the tiles from scratch (the hide tore their terminals
    // down), so prime a fresh capture for every previewed window immediately —
    // otherwise they'd sit blank until the next 1.5s poll tick.
    if (!v && this._wins.length) this.cache?.request(this._wins.map((w) => w.windowId), true);
    this._changed();
  }
  toggleHidden() { this.setHidden(!this._hidden); }

  // ---- placement --------------------------------------------------------------

  setCorner(c) {
    if (!CORNERS.includes(c)) return;
    this.corner = c;
    store(CORNER_KEY, c);
    this._rescaleAll();
  }

  setEdge(e) {
    if (!EDGES.includes(e)) return;
    this.edge = e;
    store(EDGE_KEY, e);
    // The reserved-space axis changes; re-letterbox once the bar re-lays-out.
    this.updateComplete.then(() => { this._applySpace(); this._rescaleAll(); });
  }

  // ---- lit lifecycle ----------------------------------------------------------

  willUpdate() {
    // Derive the display mode from the set size + hidden flag BEFORE render, so the
    // reflected `mode` attribute (and thus the host CSS) is correct this frame.
    this.mode = (this._hidden || this._wins.length === 0)
      ? 'off'
      : (this._wins.length === 1 ? 'single' : 'bar');
  }

  updated() {
    // Keep the imperative xterm tiles, reserved space, and scaling in sync with the
    // current mode/placement after every render.
    this._syncTiles();
    this._applySpace();
    this._rescaleAll();
    // The magnifier only makes sense in bar mode, and only for a window still in the
    // set; drop it (and free its xterm) otherwise — mode flip to single/off, or its
    // window removed.
    if (this._zoomId && (this.mode !== 'bar' || !this._has(this._zoomId))) {
      this._hideZoom();
      this._teardownZoom();
    }
  }

  render() {
    const single = this.mode === 'single';
    const bar = this.mode === 'bar';
    return html`
      <link rel="stylesheet" href=${XTERM_CSS} />
      <div class="tiles"></div>
      <div class="zoom"></div>
      ${single ? this._singleChrome() : ''}
      ${bar ? this._barChrome() : ''}
    `;
  }

  // Classic corner-box controls: the 4 corner-move buttons (each previews where the
  // box will jump) + a close that empties the preview.
  _singleChrome() {
    return html`
      <div class="controls" @click=${(e) => e.stopPropagation()}>
        ${CORNERS.map((c) => html`
          <button
            class="cbtn ${c} ${this.corner === c ? 'active' : ''}"
            title="Move to ${CORNER_NAME[c]}"
            aria-label="Move preview to ${CORNER_NAME[c]}"
            @click=${(e) => { e.stopPropagation(); this.setCorner(c); }}
          >${CORNER_GLYPH[c]}</button>
        `)}
        <button
          class="close"
          title="Close preview (${chord('I')})"
          aria-label="Close preview"
          @click=${(e) => { e.stopPropagation(); this.removeWindow(this._wins[0]?.windowId); }}
        >✕</button>
      </div>
    `;
  }

  // Bar controls: dock-to-edge buttons + a hide toggle, in a compact cluster at the
  // start of the bar (buttons aligned along the bar's cross-axis).
  _barChrome() {
    return html`
      <div class="barctl" @click=${(e) => e.stopPropagation()}>
        <div class="grp">
          ${EDGES.map((e) => html`
            <button
              class="bbtn ${this.edge === e ? 'active' : ''}"
              title="Dock the preview bar to the ${EDGE_NAME[e]}"
              aria-label="Dock preview bar to ${EDGE_NAME[e]}"
              @click=${(ev) => { ev.stopPropagation(); this.setEdge(e); }}
            >${EDGE_GLYPH[e]}</button>
          `)}
        </div>
        <button
          class="bbtn hide"
          title="Hide the preview (keeps these ${this._wins.length} windows; ${chord('I')} on a window re-adds/removes it)"
          aria-label="Hide preview"
          @click=${(ev) => { ev.stopPropagation(); this.setHidden(true); }}
        >⊘</button>
      </div>
    `;
  }

  // ---- imperative tile reconciliation ----------------------------------------

  _syncTiles() {
    const host = this.renderRoot?.querySelector('.tiles');
    if (!host) return;
    // Going 'off' (empty set OR hidden) must DISPOSE the xterm instances, not just
    // drop their tile DOM: each rec.screen lives inside the tile we're about to
    // clear, so keeping the rec around orphans its terminal. On re-show _ensureTerm
    // would then hand back that orphaned rec and never re-attach it to the fresh
    // tile — leaving every preview (and the single-window PiP) blank. Tearing down
    // here forces a clean rebuild+repaint from the cache when the preview returns.
    if (this.mode === 'off') { this._teardownAll(); host.textContent = ''; return; }

    const want = this._wins.map((w) => w.windowId);
    const have = [...host.children].map((el) => el.dataset.window);

    // Remove tiles no longer in the set.
    for (const el of [...host.children]) {
      if (!want.includes(el.dataset.window)) {
        this._teardownTerm(el.dataset.window);
        el.remove();
      }
    }
    // Add / reorder tiles to match the set order.
    this._wins.forEach((w, i) => {
      let el = [...host.children].find((c) => c.dataset.window === w.windowId);
      if (!el) el = this._buildTile(w);
      if (host.children[i] !== el) host.insertBefore(el, host.children[i] || null);
    });
    // Paint whatever's cached now.
    for (const w of this._wins) this._paint(w.windowId);
  }

  _buildTile(w) {
    const tile = document.createElement('div');
    tile.className = 'ptile';
    tile.dataset.window = w.windowId;

    // Re-letterbox this tile's xterm once a size transition settles (single mode's
    // pframe grows on hover; bubbles to the tile within the shadow tree).
    tile.addEventListener('transitionend', () => this._rescale(w.windowId));

    // Bar mode: hovering + pausing over a tile pops the floating 3x magnifier over
    // it (the bar itself never grows). Grace-hide on leave so moving the pointer from
    // the tile onto the magnifier (which sits on top of it) doesn't flap it closed.
    tile.addEventListener('mouseenter', () => this._zoomEnter(w.windowId));
    tile.addEventListener('mouseleave', () => this._zoomLeaveSoon());

    const frame = document.createElement('div');
    frame.className = 'pframe';
    frame.title = 'Click to switch the focused view to this window';
    frame.addEventListener('click', () => this._activate(w.windowId));
    tile.appendChild(frame);

    const host = document.createElement('div');
    host.className = 'screen-host';
    frame.appendChild(host);

    const remove = document.createElement('button');
    remove.className = 'premove';
    remove.textContent = '✕';
    remove.title = 'Remove from preview';
    remove.setAttribute('aria-label', 'Remove from preview');
    remove.addEventListener('click', (e) => { e.stopPropagation(); this.removeWindow(w.windowId); });
    frame.appendChild(remove);

    const label = document.createElement('div');
    label.className = 'plabel';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = w.label || '…';
    const sess = document.createElement('span');
    sess.className = 'sess';
    sess.textContent = w.session || '';
    label.append(name, sess);
    tile.appendChild(label);

    return tile;
  }

  // ---- live painting ----------------------------------------------------------

  _paint(id) {
    if (this.mode === 'off') return;
    const win = this._wins.find((w) => w.windowId === id);
    // Prefer the capture for THIS preview's own session (accurate index/session when
    // the window is linked into several); fall back to any representative — the
    // screen is identical across a window's placements.
    const entry = (win && this.cache?.byPlacement?.get(placementKey(win.session, id)))
      || this.cache?.get(id);
    if (!entry) return;
    const tile = this._tileEl(id);
    if (!tile) return;
    const rec = this._ensureTerm(id, tile, entry);
    if (!rec) return;
    if (entry.cols && entry.rows && (entry.cols !== rec.cols || entry.rows !== rec.rows)) {
      try { rec.term.resize(entry.cols, entry.rows); } catch (e) {}
      rec.cols = entry.cols; rec.rows = entry.rows;
    }
    rec.term.write('\x1b[H\x1b[2J');
    rec.term.write(CaptureCache.decodeAnsi(entry));
    this._rescale(id);

    // Refresh label + session (rename/index can change on any capture). Keep the
    // add-time session unless it was unknown, so a linked window's preview stays
    // anchored to the session it was added from.
    if (win) {
      win.label = `${entry.index}: ${entry.name}`;
      if (!win.session && entry.sessionName) win.session = entry.sessionName;
      const nameEl = tile.querySelector('.plabel .name');
      const sessEl = tile.querySelector('.plabel .sess');
      if (nameEl) nameEl.textContent = win.label;
      if (sessEl) sessEl.textContent = win.session || '';
    }
    // Mark active (matches the focused pane's current window).
    const activeId = this.manager?.focusedUnit?.layout?.activeWindowId;
    tile.classList.toggle('current', id === activeId);
    // A capture just arrived => alive; clear any stale flag.
    if (this._stale.has(id)) { this._stale.delete(id); this._setStaleUI(id, false); }
  }

  _ensureTerm(id, tile, entry) {
    let rec = this._terms.get(id);
    if (rec) return rec;
    const screenHost = tile.querySelector('.screen-host');
    if (!screenHost) return null;
    const screen = document.createElement('div');
    screen.className = 'screen';
    screenHost.appendChild(screen);
    const term = new Terminal({
      cols: entry?.cols || 80,
      rows: entry?.rows || 24,
      fontSize: 14,
      // Match the main terminal's broad-coverage stack so preview glyphs render.
      fontFamily: '"DejaVu Sans Mono", Menlo, Monaco, "Cascadia Mono", "Noto Sans Mono", "Liberation Mono", "Courier New", "Symbols Nerd Font", monospace',
      theme: { background: '#1a1a2e', foreground: '#eaeaea' },
      scrollback: 0,
      disableStdin: true,
      cursorStyle: 'bar',
      cursorInactiveStyle: 'none',
      allowProposedApi: true,
    });
    term.open(screen);
    rec = { term, screen, cols: entry?.cols || 0, rows: entry?.rows || 0 };
    this._terms.set(id, rec);
    return rec;
  }

  _rescale(id) {
    const rec = this._terms.get(id);
    const tile = this._tileEl(id);
    if (!rec || !tile) return;
    const frame = tile.querySelector('.pframe');
    if (!frame) return;
    requestAnimationFrame(() => {
      const nw = rec.screen.offsetWidth || 1;
      const nh = rec.screen.offsetHeight || 1;
      const scale = Math.min(frame.clientWidth / nw, frame.clientHeight / nh);
      rec.screen.style.transform = `scale(${scale})`;
    });
  }

  _rescaleAll() { for (const id of this._terms.keys()) this._rescale(id); }

  // ---- bar-tile hover magnifier ------------------------------------------------
  // A floating, PASSIVE up-to-4x copy of the hovered bar tile, shown NEXT TO the bar
  // so it never covers the thumbnails: sweep the pointer across the tiles and the
  // magnifier follows the hovered one, instantly. The tiles keep their own controls
  // (× / click-to-activate) since the magnifier never covers them. Kept ALIVE via
  // the same capture poll as the tiles (its window is already in _wins). Bar mode only.

  ZOOM_SCALE = 4;               // up to 4x the tile (capped to the room beside the bar)
  ZOOM_DELAY_MS = 300;          // deliberate hover pause before it first appears
  ZOOM_HIDE_GRACE_MS = 120;     // bridge the tiny gap when moving between adjacent tiles

  _zoomEnter(id) {
    if (this.mode !== 'bar') return;
    if (this._zoomHideTimer) { clearTimeout(this._zoomHideTimer); this._zoomHideTimer = null; }
    if (this._zoomId === id) return;                 // already magnifying this tile
    if (this._zoomId) { this._showZoom(id); return; } // already visible → switch instantly
    if (this._zoomTimer) clearTimeout(this._zoomTimer);
    this._zoomTimer = setTimeout(() => this._showZoom(id), this.ZOOM_DELAY_MS);
  }

  // Leave with a short grace so moving between two adjacent tiles (a brief gap where
  // neither is hovered) doesn't flap the magnifier shut; the next tile's mouseenter
  // cancels it. Hides only when the pointer truly leaves the strip.
  _zoomLeaveSoon() {
    if (this._zoomTimer) { clearTimeout(this._zoomTimer); this._zoomTimer = null; }
    if (this._zoomHideTimer) clearTimeout(this._zoomHideTimer);
    this._zoomHideTimer = setTimeout(() => this._hideZoom(), this.ZOOM_HIDE_GRACE_MS);
  }

  _zoomEl() { return this.renderRoot?.querySelector('.zoom'); }

  _showZoom(id) {
    this._zoomTimer = null;
    if (this.mode !== 'bar' || !this._has(id)) return;
    const tile = this._tileEl(id);
    const zoom = this._zoomEl();
    if (!tile || !zoom) return;
    this._zoomId = id;
    this._buildZoomChrome(zoom, id);

    // Position the magnifier in the strip of space NEXT TO the bar (on the terminal
    // side), never over the bar. Its own rect is the bar (:host([mode='bar'])); the
    // room beside it caps the size so the magnifier can neither overlap the bar nor
    // leave the viewport, while staying a proportional (up to ZOOM_SCALE×) copy.
    const tr = tile.getBoundingClientRect();
    const bar = this.getBoundingClientRect();
    const g = 10;                                 // gap between bar and magnifier
    const m = 8;                                  // viewport margin
    const toolbarH = parseInt(getComputedStyle(document.documentElement)
      .getPropertyValue('--wt-toolbar-h')) || 44;

    // Available box beside the bar for each docked edge.
    let availW, availH;
    switch (this.edge) {
      case 'top':    availW = window.innerWidth - 2 * m;  availH = window.innerHeight - bar.bottom - g - m; break;
      case 'bottom': availW = window.innerWidth - 2 * m;  availH = bar.top - g - (toolbarH + m);           break;
      case 'left':   availW = window.innerWidth - bar.right - g - m; availH = bar.height - 2 * m;          break;
      case 'right':  availW = bar.left - g - m;           availH = bar.height - 2 * m;                     break;
      default:       availW = window.innerWidth - 2 * m;  availH = window.innerHeight - 2 * m;
    }
    // Proportional scale, capped so the WHOLE magnifier fits the space beside the bar
    // — this is what keeps an otherwise-4x preview from overflowing when the bar eats
    // most of the screen: it shrinks to fit instead of spilling off. If even a 1x
    // copy wouldn't fit beside the bar (extremely cramped viewport), skip it entirely
    // rather than draw something smaller than the thumbnail or off-screen.
    const scale = Math.min(this.ZOOM_SCALE, availW / tr.width, availH / tr.height);
    if (!(scale >= 1)) { this._hideZoom(); return; }
    const zw = Math.round(tr.width * scale);
    const zh = Math.round(tr.height * scale);
    const cx = tr.left + tr.width / 2;
    const cy = tr.top + tr.height / 2;

    let left, top;
    switch (this.edge) {
      case 'top':    left = cx - zw / 2;      top = bar.bottom + g;      break; // below the bar
      case 'bottom': left = cx - zw / 2;      top = bar.top - g - zh;    break; // above the bar
      case 'left':   left = bar.right + g;    top = cy - zh / 2;         break; // right of the bar
      case 'right':  left = bar.left - g - zw; top = cy - zh / 2;        break; // left of the bar
      default:       left = cx - zw / 2;      top = cy - zh / 2;
    }
    // Clamp along the free (cross) axis so the box stays on-screen; the docked-edge
    // axis is already fixed just beside the bar above.
    left = Math.max(m, Math.min(window.innerWidth - zw - m, left));
    top = Math.max(toolbarH + m, Math.min(window.innerHeight - zh - m, top));

    zoom.style.width = zw + 'px';
    zoom.style.height = zh + 'px';
    zoom.style.left = Math.round(left) + 'px';
    zoom.style.top = Math.round(top) + 'px';
    zoom.classList.add('show');
    this.cache?.request([id], true);   // prime a fresh frame for the magnifier
    this._paintZoom();
  }

  _hideZoom() {
    if (this._zoomHideTimer) { clearTimeout(this._zoomHideTimer); this._zoomHideTimer = null; }
    this._zoomId = null;
    const zoom = this._zoomEl();
    if (zoom) zoom.classList.remove('show');
  }

  // Build the magnifier's chrome (frame + label) once, then reuse it. The xterm lives
  // in a static .screen-host div (like the tiles) so re-showing never orphans it. No
  // controls or handlers here — the magnifier is passive (pointer-events:none); the
  // remove × / click-to-activate stay on the normal-size tiles it sits beside.
  _buildZoomChrome(zoom, id) {
    if (!zoom._wired) {
      const frame = document.createElement('div');
      frame.className = 'zframe';
      const host = document.createElement('div');
      host.className = 'screen-host';
      frame.appendChild(host);
      const label = document.createElement('div');
      label.className = 'zlabel';
      const name = document.createElement('span'); name.className = 'name';
      const sess = document.createElement('span'); sess.className = 'sess';
      label.append(name, sess);
      zoom.append(frame, label);
      zoom._wired = true;
    }
    const win = this._wins.find((w) => w.windowId === id);
    zoom.querySelector('.zlabel .name').textContent = win?.label || '…';
    zoom.querySelector('.zlabel .sess').textContent = win?.session || '';
  }

  _paintZoom() {
    const id = this._zoomId;
    if (!id) return;
    const zoom = this._zoomEl();
    if (!zoom || !zoom.classList.contains('show')) return;
    const win = this._wins.find((w) => w.windowId === id);
    const entry = (win && this.cache?.byPlacement?.get(placementKey(win.session, id)))
      || this.cache?.get(id);
    if (!entry) return;
    const rec = this._ensureZoomTerm(zoom, entry);
    if (!rec) return;
    if (entry.cols && entry.rows && (entry.cols !== rec.cols || entry.rows !== rec.rows)) {
      try { rec.term.resize(entry.cols, entry.rows); } catch (e) {}
      rec.cols = entry.cols; rec.rows = entry.rows;
    }
    rec.term.write('\x1b[H\x1b[2J');
    rec.term.write(CaptureCache.decodeAnsi(entry));
    if (win) {
      const nameEl = zoom.querySelector('.zlabel .name');
      const sessEl = zoom.querySelector('.zlabel .sess');
      if (nameEl) nameEl.textContent = win.label || '…';
      if (sessEl) sessEl.textContent = win.session || '';
    }
    this._rescaleZoom();
  }

  _ensureZoomTerm(zoom, entry) {
    if (this._zoomRec) return this._zoomRec;
    const screenHost = zoom.querySelector('.screen-host');
    if (!screenHost) return null;
    const screen = document.createElement('div');
    screen.className = 'screen';
    screenHost.appendChild(screen);
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
    this._zoomRec = { term, screen, cols: entry?.cols || 0, rows: entry?.rows || 0 };
    return this._zoomRec;
  }

  _rescaleZoom() {
    const rec = this._zoomRec;
    const zoom = this._zoomEl();
    if (!rec || !zoom) return;
    const frame = zoom.querySelector('.zframe');
    if (!frame) return;
    requestAnimationFrame(() => {
      const nw = rec.screen.offsetWidth || 1;
      const nh = rec.screen.offsetHeight || 1;
      const scale = Math.min(frame.clientWidth / nw, frame.clientHeight / nh);
      rec.screen.style.transform = `scale(${scale})`;
    });
  }

  _teardownZoom() {
    if (this._zoomTimer) { clearTimeout(this._zoomTimer); this._zoomTimer = null; }
    if (this._zoomHideTimer) { clearTimeout(this._zoomHideTimer); this._zoomHideTimer = null; }
    if (this._zoomRec) { try { this._zoomRec.term.dispose(); } catch (e) {} this._zoomRec = null; }
    this._zoomId = null;
  }

  // ---- staleness --------------------------------------------------------------

  _checkStale() {
    for (const w of this._wins) {
      const entry = this.cache?.get(w.windowId);
      if (!entry) continue;
      const stale = Date.now() - entry.capturedAt * 1000 > STALE_MS;
      if (stale !== this._stale.has(w.windowId)) {
        if (stale) this._stale.add(w.windowId); else this._stale.delete(w.windowId);
        this._setStaleUI(w.windowId, stale);
      }
    }
  }

  _setStaleUI(id, stale) {
    const tile = this._tileEl(id);
    if (!tile) return;
    const frame = tile.querySelector('.pframe');
    if (frame) frame.classList.toggle('stale', stale);
    let tag = tile.querySelector('.stale-tag');
    if (stale && !tag) {
      tag = document.createElement('div');
      tag.className = 'stale-tag';
      tag.textContent = 'window closed';
      frame?.appendChild(tag);
    } else if (!stale && tag) {
      tag.remove();
    }
  }

  // ---- helpers ----------------------------------------------------------------

  _entry(id, meta) {
    const label = meta.index != null ? `${meta.index}: ${meta.name || 'bash'}` : (meta.name || '…');
    return { windowId: id, session: meta.session || '', label, index: meta.index, name: meta.name };
  }

  _tileEl(id) {
    return this.renderRoot?.querySelector(`.ptile[data-window="${id}"]`) || null;
  }

  _activate(id) {
    if (!id) return;
    const win = this._wins.find((w) => w.windowId === id);
    this.manager?.goToWindow(id, win?.session || '');
  }

  _ensurePolling() {
    if (this._pollTimer) return;
    this.cache?.addEventListener('update', this._onCacheUpdate);
    this._pollTimer = setInterval(() => {
      const ids = this._wins.map((w) => w.windowId);
      if (!ids.length) return;
      this.cache?.request(ids, true);   // keep every preview live
      this._checkStale();
    }, POLL_MS);
  }

  _teardownTerm(id) {
    const rec = this._terms.get(id);
    if (rec) { try { rec.term.dispose(); } catch (e) {} this._terms.delete(id); }
  }

  _teardownAll() {
    for (const id of [...this._terms.keys()]) this._teardownTerm(id);
  }

  // Any change to the set or hidden flag: re-render, stop polling when empty, tell
  // the toolbar (via onChange) to refresh its preview buttons.
  _changed() {
    if (this._wins.length === 0) {
      if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
      this.cache?.removeEventListener('update', this._onCacheUpdate);
    } else {
      this._ensurePolling();
    }
    this.requestUpdate();
    if (this.onChange) this.onChange();
  }

  // Reserve edge space for the docked BAR by publishing --wt-preview-* on :root
  // (consumed as #app padding). The floating corner box reserves nothing.
  _applySpace() {
    const vars = { top: '0px', bottom: '0px', left: '0px', right: '0px' };
    if (this.mode === 'bar') vars[this.edge] = BAR_THICK + 'px';
    try {
      const s = document.documentElement.style;
      s.setProperty('--wt-preview-top', vars.top);
      s.setProperty('--wt-preview-bottom', vars.bottom);
      s.setProperty('--wt-preview-left', vars.left);
      s.setProperty('--wt-preview-right', vars.right);
    } catch (e) {}
  }
}

function readStored(key, allowed, fallback) {
  try {
    const v = localStorage.getItem(key);
    if (allowed.includes(v)) return v;
  } catch (e) { /* storage unavailable */ }
  return fallback;
}

function store(key, v) {
  try { localStorage.setItem(key, v); } catch (e) { /* best-effort */ }
}

customElements.define('webtmux-pip', WebtmuxPip);
