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
    .grid {
      flex: 1 1 auto;
      overflow-y: auto;
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
      gap: 16px;
      align-content: start;
    }
    .tile {
      cursor: pointer;
      border: 2px solid transparent;
      border-radius: 8px;
      background: #12131f;
      overflow: hidden;
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
      height: 200px;
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
    this.cache = null; // shared CaptureCache — set by SplitManager
    this.manager = null; // SplitManager — set by SplitManager
    this._tiles = []; // { term? } live xterm instances, for disposal
    this._cursor = -1; // keyboard-highlighted tile index
    this._pollTimer = null;
    this._onCacheUpdate = () => this._rebuild();
    this._onKey = (e) => this._handleKey(e);
  }

  // Keep xterm out of Lit's control: render the static chrome only; the grid is
  // filled imperatively so a reactive re-render never orphans a tile terminal.
  render() {
    const n = this.cache ? this.cache.byWindow.size : 0;
    return html`
      <link rel="stylesheet" href=${XTERM_CSS} />
      <div class="backdrop" @click=${this._onBackdrop}>
        <div class="head">
          <span class="title">Windows</span>
          <span>${n} window${n === 1 ? '' : 's'}</span>
          <span><kbd>←→↑↓</kbd> move · <kbd>Enter</kbd> switch · <kbd>Esc</kbd> close</span>
        </div>
        <div class="grid" @click=${(e) => e.stopPropagation()}></div>
      </div>
    `;
  }

  // ---- open / close lifecycle -------------------------------------------------

  openOverlay() {
    if (this.open) return;
    this.open = true;
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

  toggle() {
    this.open ? this.closeOverlay() : this.openOverlay();
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

  _rebuild() {
    if (!this.open) return;
    const grid = this.renderRoot?.querySelector('.grid');
    if (!grid) return;
    this._disposeTiles();

    const entries = this.cache ? this.cache.all() : [];
    if (!entries.length) {
      const div = document.createElement('div');
      div.className = 'empty';
      div.textContent = 'Capturing windows…';
      grid.appendChild(div);
      return;
    }

    const currentId = this.manager?.focusedUnit?.layout?.activeWindowId || '';
    entries.forEach((entry, i) => {
      const tile = this._buildTile(entry, i < N_MAX_TILES);
      if (entry.windowId === currentId) tile.classList.add('current');
      grid.appendChild(tile);
    });

    // Highlight the current window by default for immediate keyboard nav.
    this._cursor = Math.max(0, entries.findIndex((e) => e.windowId === currentId));
    this._paintCursor();
  }

  _buildTile(entry, live) {
    const tile = document.createElement('div');
    tile.className = 'tile';
    tile.dataset.window = entry.windowId;

    const frame = document.createElement('div');
    frame.className = 'tile-frame';
    tile.appendChild(frame);

    if (live) {
      const screen = document.createElement('div');
      screen.className = 'tile-screen';
      frame.appendChild(screen);
      this._renderXtermTile(screen, frame, entry);
    } else {
      // Overflow: cheap plain-text preview (SGR stripped) — no renderer cost.
      const pre = document.createElement('pre');
      pre.className = 'tile-pre';
      pre.textContent = stripSgr(decodeUtf8(entry.data));
      frame.appendChild(pre);
    }

    const label = document.createElement('div');
    label.className = 'tile-label';
    const left = document.createElement('span');
    left.innerHTML = `<span class="idx">${entry.index}:</span> ${escapeHtml(entry.name)}`;
    const right = document.createElement('span');
    right.className = 'sess';
    right.textContent = entry.sessionName;
    label.append(left, right);
    tile.appendChild(label);

    tile.addEventListener('click', () => this._selectWindow(entry.windowId));
    return tile;
  }

  // A read-only xterm sized to the capture's cols×rows, then CSS-scaled to fit the
  // tile frame (letterboxed). No WebGL addon: many tiles would exhaust GL contexts.
  _renderXtermTile(screen, frame, entry) {
    const term = new Terminal({
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
    this._tiles.push({ term });
    term.open(screen);
    term.write(CaptureCache.decodeAnsi(entry));

    // Scale to fit once the terminal has laid out its natural size.
    requestAnimationFrame(() => {
      const nw = screen.offsetWidth || 1;
      const nh = screen.offsetHeight || 1;
      const scale = Math.min(frame.clientWidth / nw, frame.clientHeight / nh);
      screen.style.transform = `scale(${scale})`;
    });
  }

  // ---- interaction ------------------------------------------------------------

  _selectWindow(windowId) {
    // selectWindow already paints optimistically from the shared cache, so the
    // switch feels instant; the server's select-window repaint then overwrites.
    this.manager?.focusedUnit?.selectWindow(windowId);
    this.closeOverlay();
  }

  _tileEls() {
    return [...(this.renderRoot?.querySelectorAll('.tile') || [])];
  }

  _paintCursor() {
    const tiles = this._tileEls();
    tiles.forEach((t, i) => t.classList.toggle('cursor', i === this._cursor));
    if (this._cursor >= 0 && tiles[this._cursor]) {
      tiles[this._cursor].scrollIntoView({ block: 'nearest' });
    }
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

function stripSgr(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

customElements.define('webtmux-expose', WebtmuxExpose);
