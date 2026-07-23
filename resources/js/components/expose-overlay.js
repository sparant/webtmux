// <webtmux-expose> — a full-screen mosaic of every deduped window across every
// (grouped) session, each tile a faithful colored thumbnail of that window's
// active-pane capture. Click (or arrow-nav + Enter) switches the FOCUSED region
// to that window; Esc / backdrop click dismisses.
//
// The overlay is a browser/window NAVIGATOR, not a new tmux client: a tile click
// calls manager.focusedUnit.selectWindow(id), which the per-connection controller
// qualifies to that unit's own session. Tiles come straight from the shared
// CaptureCache (one entry per window_id), so "one tile per window regardless of
// how many split sessions" is intrinsic.
//
// Shadow DOM + an injected xterm stylesheet link so each tile's read-only xterm
// renders with correct cell geometry. Live xterm tiles are capped at N_MAX; the
// overflow degrades to a plain-text <pre> (SGR stripped) so huge window counts
// never exhaust renderer resources.
import { LitElement, html, css } from 'lit';
import { Terminal } from '@xterm/xterm';
import { CaptureCache } from '../capture-cache.js';

const N_MAX_TILES = 24;
const XTERM_CSS = 'https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css';

class WebtmuxExpose extends LitElement {
  static properties = {
    open: { type: Boolean, reflect: true },
    // How many tiles are visible at once, as an N×N block: 2 => 2×2 (4),
    // 3 => 3×3 (9). Reflected so the grid CSS above can key off it. Overflow
    // still scrolls — this only controls how many fit on screen at once.
    density: { type: Number, reflect: true },
    _sort: { state: true }, // 'session' | 'recent'
  };

  static styles = css`
    :host {
      display: none;
    }
    :host([open]) {
      display: block;
    }
    .backdrop {
      position: fixed;
      inset: 0;
      z-index: 200;
      background: rgba(10, 12, 24, 0.82);
      backdrop-filter: blur(3px);
      display: flex;
      flex-direction: column;
      padding: 24px;
      box-sizing: border-box;
    }
    .head {
      color: #cfd8ff;
      font: 13px/1.4 Menlo, Monaco, monospace;
      margin-bottom: 14px;
      display: flex;
      gap: 16px;
      align-items: center;
      flex: 0 0 auto;
    }
    .head .title {
      font-size: 15px;
      font-weight: 600;
      color: #eaf0ff;
    }
    .head kbd {
      background: #1a1a2e;
      border: 1px solid #0f3460;
      border-radius: 4px;
      padding: 1px 6px;
      color: #4a9eff;
      font-family: monospace;
      font-size: 12px;
    }
    .head .spacer {
      flex: 1 1 auto;
    }
    .sort {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .sort .lbl {
      color: #7f8bb5;
    }
    .sort .seg {
      display: inline-flex;
      border: 1px solid #0f3460;
      border-radius: 6px;
      overflow: hidden;
    }
    .sort button {
      background: #1a1a2e;
      color: #9fb0d8;
      border: none;
      padding: 4px 12px;
      font: 12px Menlo, Monaco, monospace;
      cursor: pointer;
    }
    .sort button:not(:last-child) {
      border-right: 1px solid #0f3460;
    }
    .sort button.active {
      background: #0f3460;
      color: #eaf0ff;
    }
    /* The grid shows an N×N block at once (density: 2 => 2×2 = 4, 3 => 3×3 = 9)
       and scrolls vertically for the rest. grid-auto-rows is an EXPLICIT
       viewport-based height so exactly N rows fill the screen. This is
       deliberate: the grid is a flex item with overflow-y:auto, so its flex
       min-height collapses to 0 and, with *auto* rows, the browser distributes
       the shrunken height across ALL rows (squashing 37 tiles into one screen).
       A fixed row track can't be distributed away, so the extra rows overflow
       and scroll as intended. min-height:0 keeps it the scroller. The column
       count and row height key off the reflected `density` attribute below. */
    .grid {
      flex: 1 1 auto;
      min-height: 0;
      overflow-y: auto;
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      grid-auto-rows: max(200px, calc((100vh - 120px) / 3));
      gap: 16px;
      align-content: start;
    }
    :host([density='2']) .grid {
      grid-template-columns: repeat(2, 1fr);
      grid-auto-rows: max(200px, calc((100vh - 120px) / 2));
    }
    :host([density='3']) .grid {
      grid-template-columns: repeat(3, 1fr);
      grid-auto-rows: max(200px, calc((100vh - 120px) / 3));
    }
    .tile {
      cursor: pointer;
      border: 2px solid transparent;
      border-radius: 8px;
      background: #12131f;
      overflow: hidden;
      /* Fill the fixed row: frame grows, label stays its natural height. */
      display: flex;
      flex-direction: column;
      min-height: 0;
      transition: transform 0.12s, border-color 0.12s, box-shadow 0.12s;
    }
    .tile:hover,
    .tile.cursor {
      border-color: #4a9eff;
      box-shadow: 0 6px 22px rgba(0, 0, 0, 0.5);
      transform: translateY(-2px) scale(1.02);
    }
    .tile.current {
      border-color: #37d17a;
    }
    .tile-frame {
      position: relative;
      width: 100%;
      /* Fill the tile's row (grid-auto-rows) minus the label. */
      flex: 1 1 auto;
      min-height: 0;
      overflow: hidden;
      background: #1a1a2e;
      border-bottom: 1px solid #0f3460;
    }
    .tile-screen {
      position: absolute;
      top: 0;
      left: 0;
      transform-origin: top left;
    }
    .tile-pre {
      margin: 0;
      padding: 6px;
      font: 7px/1.1 Menlo, Monaco, monospace;
      color: #b8c0d8;
      white-space: pre;
      overflow: hidden;
      width: 100%;
      height: 100%;
      box-sizing: border-box;
    }
    .tile-label {
      flex: 0 0 auto;
      padding: 6px 10px;
      color: #d6ddf5;
      font: 12px/1.3 Menlo, Monaco, monospace;
      display: flex;
      justify-content: space-between;
      gap: 8px;
    }
    .tile-label .sess {
      color: #7f8bb5;
    }
    .tile.current .tile-label .idx {
      color: #37d17a;
    }
    .empty {
      color: #7f8bb5;
      font: 14px Menlo, Monaco, monospace;
      margin: auto;
    }
  `;

  constructor() {
    super();
    this.open = false;
    this.density = 2; // first open shows a 2×2 block; a toggle steps it to 3×3
    this.cache = null; // shared CaptureCache — set by SplitManager
    this.manager = null; // SplitManager — set by SplitManager
    this._tiles = []; // { term? } live xterm instances, for disposal
    this._cursor = -1; // keyboard-highlighted tile index
    this._cursorId = null; // window_id under the cursor — survives refresh/rebuild
    this._renderedIds = []; // window_ids in current tile order
    this._sort = readSort(); // 'session' | 'recent' (persisted)
    this._pollTimer = null;
    // On a capture refresh, update tiles IN PLACE (keep cursor + no xterm churn)
    // when the window set is unchanged; only a membership/sort change rebuilds.
    this._onCacheUpdate = () => this._refresh();
    this._onKey = (e) => this._handleKey(e);
  }

  // Keep xterm out of Lit's control: render the static chrome only; the grid is
  // filled imperatively so a reactive re-render never orphans a tile terminal.
  render() {
    const n = this.cache ? this.cache.byWindow.size : 0;
    return html`
      <link rel="stylesheet" href=${XTERM_CSS} />
      <div class="backdrop" @click=${this._onBackdrop}>
        <div class="head" @click=${(e) => e.stopPropagation()}>
          <span class="title">Windows</span>
          <span>${n} window${n === 1 ? '' : 's'}</span>
          <span><kbd>←→↑↓</kbd> move · <kbd>Enter</kbd> switch · <kbd>Esc</kbd> close</span>
          <span class="spacer"></span>
          <span class="sort">
            <span class="lbl">Sort</span>
            <span class="seg">
              <button class=${this._sort === 'session' ? 'active' : ''} @click=${() => this._setSort('session')}>
                Session / window
              </button>
              <button class=${this._sort === 'recent' ? 'active' : ''} @click=${() => this._setSort('recent')}>
                Last accessed
              </button>
            </span>
          </span>
        </div>
        <div class="grid" @click=${(e) => e.stopPropagation()}></div>
      </div>
    `;
  }

  // ---- open / close lifecycle -------------------------------------------------

  openOverlay(density = 2) {
    if (this.open) {
      this.setDensity(density);
      return;
    }
    this.density = density;
    this.open = true;
    // Start the cursor on the focused region's current window. (Access recency is
    // owned by SplitManager — the focused window was already recorded when focused
    // — so opening Exposé doesn't itself write recency: one write path.)
    this._cursorId = this.manager?.focusedUnit?.layout?.activeWindowId || null;
    this.cache?.addEventListener('update', this._onCacheUpdate);
    window.addEventListener('keydown', this._onKey, true);
    // Force a fresh capture of every window, then paint whatever's cached now.
    this.cache?.request('all', true);
    this.updateComplete.then(() => this._rebuild());
    // Optional light poll so tiles stay live while the overlay is open.
    this._pollTimer = setInterval(() => this.cache?.request('all', false), 1500);
  }

  closeOverlay() {
    if (!this.open) return;
    this.open = false;
    this.cache?.removeEventListener('update', this._onCacheUpdate);
    window.removeEventListener('keydown', this._onKey, true);
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
    this._disposeTiles();
    this._cursor = -1;
  }

  // Cycle the overlay: closed → 2×2 → 3×3 → closed. Each toggle (Ctrl-Alt-E)
  // steps to the next state, growing how many tiles are visible before dismissing.
  toggle() {
    if (!this.open) this.openOverlay(2);
    else if (this.density < 3) this.setDensity(3);
    else this.closeOverlay();
  }

  // Change how many tiles fill the screen without a teardown. The tile DOM is
  // imperative (not Lit-managed), so it survives the attribute flip; we only need
  // to re-letterbox each live xterm to its resized frame and keep the cursor in view.
  setDensity(density) {
    if (!this.open || this.density === density) return;
    this.density = density;
    this.updateComplete.then(() => {
      for (const rec of this._tiles) this._rescale(rec);
      this._paintCursor();
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.closeOverlay();
  }

  // ---- tile building ----------------------------------------------------------

  _disposeTiles() {
    for (const t of this._tiles) {
      if (t.term) {
        try {
          t.term.dispose();
        } catch (e) {}
      }
    }
    this._tiles = [];
    const grid = this.renderRoot?.querySelector('.grid');
    if (grid) grid.textContent = '';
  }

  // Full teardown + build. Used on open, sort change, or a membership change.
  // Restores the cursor to the SAME window it was on (by id), so it never jumps.
  _rebuild() {
    if (!this.open) return;
    const grid = this.renderRoot?.querySelector('.grid');
    if (!grid) return;
    this._disposeTiles();

    const entries = this.cache ? this.cache.all(this._sort) : [];
    if (!entries.length) {
      const div = document.createElement('div');
      div.className = 'empty';
      div.textContent = 'Capturing windows…';
      grid.appendChild(div);
      this._renderedIds = [];
      return;
    }

    const currentId = this.manager?.focusedUnit?.layout?.activeWindowId || '';
    entries.forEach((entry, i) => {
      const rec = this._buildTile(entry, i < N_MAX_TILES);
      if (entry.windowId === currentId) rec.tileEl.classList.add('current');
      grid.appendChild(rec.tileEl);
      this._tiles.push(rec);
    });
    this._renderedIds = entries.map((e) => e.windowId);

    // Keep the highlight on the same window across a rebuild; fall back to the
    // current window, then the first tile.
    let idx = this._cursorId ? this._renderedIds.indexOf(this._cursorId) : -1;
    if (idx < 0) idx = this._renderedIds.indexOf(currentId);
    if (idx < 0) idx = 0;
    this._cursor = idx;
    this._paintCursor();
  }

  // Called on every capture refresh. If the window set + order is unchanged,
  // repaint each tile's content IN PLACE — preserving the cursor, scroll
  // position, and xterm instances (no flicker, no lost navigation). Only a
  // membership/order change (window opened/closed) falls back to a full rebuild.
  _refresh() {
    if (!this.open) return;
    const entries = this.cache ? this.cache.all(this._sort) : [];
    const ids = entries.map((e) => e.windowId);
    const unchanged =
      ids.length === this._renderedIds.length && ids.every((id, i) => id === this._renderedIds[i]);
    if (!unchanged) {
      this._rebuild();
      return;
    }

    const currentId = this.manager?.focusedUnit?.layout?.activeWindowId || '';
    const byId = new Map(this._tiles.map((r) => [r.windowId, r]));
    for (const entry of entries) {
      const rec = byId.get(entry.windowId);
      if (!rec) continue;
      this._updateTileContent(rec, entry);
      rec.tileEl.classList.toggle('current', entry.windowId === currentId);
    }
    // Cursor deliberately untouched — navigation state survives the refresh.
  }

  _buildTile(entry, live) {
    const tile = document.createElement('div');
    tile.className = 'tile';
    tile.dataset.window = entry.windowId;

    const frame = document.createElement('div');
    frame.className = 'tile-frame';
    tile.appendChild(frame);

    const rec = {
      windowId: entry.windowId,
      tileEl: tile,
      frame,
      screen: null,
      term: null,
      pre: null,
      cols: entry.cols,
      rows: entry.rows,
      labelLeft: null,
    };

    if (live) {
      const screen = document.createElement('div');
      screen.className = 'tile-screen';
      frame.appendChild(screen);
      rec.screen = screen;
      rec.term = this._makeTerm(entry);
      rec.term.open(screen);
      rec.term.write(CaptureCache.decodeAnsi(entry));
      this._rescale(rec);
    } else {
      // Overflow: cheap plain-text preview (SGR stripped) — no renderer cost.
      const pre = document.createElement('pre');
      pre.className = 'tile-pre';
      pre.textContent = stripSgr(decodeUtf8(entry.data));
      frame.appendChild(pre);
      rec.pre = pre;
    }

    const label = document.createElement('div');
    label.className = 'tile-label';
    const left = document.createElement('span');
    left.innerHTML = labelHtml(entry);
    rec.labelLeft = left;
    const right = document.createElement('span');
    right.className = 'sess';
    right.textContent = entry.sessionName;
    label.append(left, right);
    tile.appendChild(label);

    tile.addEventListener('click', () => this._selectWindow(entry.windowId));
    return rec;
  }

  // Repaint an existing tile with a fresh capture — no teardown.
  _updateTileContent(rec, entry) {
    if (rec.term) {
      if (entry.cols && entry.rows && (entry.cols !== rec.cols || entry.rows !== rec.rows)) {
        try {
          rec.term.resize(entry.cols, entry.rows);
        } catch (e) {}
        rec.cols = entry.cols;
        rec.rows = entry.rows;
      }
      rec.term.write('\x1b[H\x1b[2J');
      rec.term.write(CaptureCache.decodeAnsi(entry));
      this._rescale(rec);
    } else if (rec.pre) {
      rec.pre.textContent = stripSgr(decodeUtf8(entry.data));
    }
    if (rec.labelLeft) rec.labelLeft.innerHTML = labelHtml(entry); // name/index may change
  }

  // A read-only xterm sized to the capture's cols×rows. No WebGL addon: many
  // tiles would exhaust GL contexts.
  _makeTerm(entry) {
    return new Terminal({
      cols: entry.cols || 80,
      rows: entry.rows || 24,
      fontSize: 14,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: { background: '#1a1a2e', foreground: '#eaeaea' },
      scrollback: 0,
      disableStdin: true,
      cursorStyle: 'bar',
      cursorInactiveStyle: 'none',
      allowProposedApi: true,
    });
  }

  // CSS-scale a tile's terminal to fit its frame (letterboxed) once laid out.
  _rescale(rec) {
    if (!rec.screen || !rec.frame) return;
    requestAnimationFrame(() => {
      const nw = rec.screen.offsetWidth || 1;
      const nh = rec.screen.offsetHeight || 1;
      const scale = Math.min(rec.frame.clientWidth / nw, rec.frame.clientHeight / nh);
      rec.screen.style.transform = `scale(${scale})`;
    });
  }

  _setSort(mode) {
    if (this._sort === mode) return;
    this._sort = mode; // reactive -> header re-renders with the new active button
    try {
      localStorage.setItem('webtmux-expose-sort', mode);
    } catch (e) {}
    this._rebuild(); // reorder tiles; cursor stays on the same window
  }

  // ---- interaction ------------------------------------------------------------

  _selectWindow(windowId) {
    // Same navigation path as the toolbar recent-strip: jump to the region that
    // already shows it, or switch the focused region's session if the window
    // lives elsewhere, else select it here (optimistic paint happens in selectWindow).
    const entry = this.cache?.get(windowId);
    this.manager?.goToWindow(windowId, entry?.sessionName || '');
    this.closeOverlay();
  }

  _tileEls() {
    return [...(this.renderRoot?.querySelectorAll('.tile') || [])];
  }

  _paintCursor() {
    const tiles = this._tileEls();
    tiles.forEach((t, i) => t.classList.toggle('cursor', i === this._cursor));
    const cur = tiles[this._cursor];
    // Remember WHICH window is highlighted so the cursor survives a rebuild.
    this._cursorId = cur ? cur.dataset.window : null;
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  }

  _handleKey(e) {
    if (!this.open) return;
    const tiles = this._tileEls();
    if (e.key === 'Escape') {
      this.closeOverlay();
    } else if (e.key === 'Enter') {
      const t = tiles[this._cursor];
      if (t) this._selectWindow(t.dataset.window);
    } else if (e.key === 'ArrowRight') {
      this._moveCursor(1, tiles);
    } else if (e.key === 'ArrowLeft') {
      this._moveCursor(-1, tiles);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      this._moveCursor(e.key === 'ArrowDown' ? colsPerRow(tiles) : -colsPerRow(tiles), tiles);
    } else {
      return; // not ours
    }
    e.preventDefault();
    e.stopPropagation();
  }

  _moveCursor(delta, tiles) {
    if (!tiles.length) return;
    if (this._cursor < 0) this._cursor = 0;
    else this._cursor = Math.max(0, Math.min(tiles.length - 1, this._cursor + delta));
    this._paintCursor();
  }

  _onBackdrop() {
    this.closeOverlay();
  }
}

// How many tiles fit per grid row (for up/down arrow nav) — derived from the DOM.
function colsPerRow(tiles) {
  if (tiles.length < 2) return 1;
  const top0 = tiles[0].offsetTop;
  let n = 0;
  for (const t of tiles) {
    if (t.offsetTop !== top0) break;
    n++;
  }
  return Math.max(1, n);
}

function decodeUtf8(b64) {
  if (!b64) return '';
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch (e) {
    return '';
  }
}

function labelHtml(entry) {
  return `<span class="idx">${entry.index}:</span> ${escapeHtml(entry.name)}`;
}

function readSort() {
  try {
    return localStorage.getItem('webtmux-expose-sort') === 'recent' ? 'recent' : 'session';
  } catch (e) {
    return 'session';
  }
}

function stripSgr(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

customElements.define('webtmux-expose', WebtmuxExpose);
