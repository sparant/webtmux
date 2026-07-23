// <webtmux-pip> — Picture-in-Picture: a small, always-on-top LIVE preview of ONE
// tmux window pinned to a screen corner. The preview is a read-only xterm fed from
// the shared CaptureCache (the very same per-window capture buffers Exposé uses),
// polled so it stays live. Hovering the box reveals four corner-move buttons and a
// close ×; clicking the preview switches the FOCUSED region to that window.
//
// Owned by the SplitManager (one instance). Toggled on/off via the toolbar's PiP
// button or Ctrl+Alt+I; toggling on pins the FOCUSED region's current window.
// Starts in the top-right corner (persisted per browser).
//
// Chrome (frame, controls, label) is rendered by Lit; the xterm lives in a static
// `.screen-host` div that Lit never re-touches, so a reactive re-render (corner
// move, label update) can never orphan the terminal — the same split-of-concerns
// Exposé uses for its tiles.
import { LitElement, html, css } from 'lit';
import { Terminal } from '@xterm/xterm';
import { CaptureCache } from '../capture-cache.js';

const XTERM_CSS = 'https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css';
const CORNERS = ['tl', 'tr', 'bl', 'br'];
const CORNER_GLYPH = { tl: '⌜', tr: '⌝', bl: '⌞', br: '⌟' };
const CORNER_NAME = { tl: 'top-left', tr: 'top-right', bl: 'bottom-left', br: 'bottom-right' };
const CORNER_KEY = 'webtmux-pip-corner';
const POLL_MS = 1500;      // keep the preview live (server coalesces to 500ms)
const STALE_MS = 5000;     // no fresh capture for this long => the window is gone

class WebtmuxPip extends LitElement {
  static properties = {
    open: { type: Boolean, reflect: true },
    // Which corner the box is pinned to; reflected so :host([corner=..]) positions it.
    corner: { type: String, reflect: true },
    _label: { state: true },   // "index: name" of the pinned window
    _stale: { state: true },   // true once the window stops producing captures
  };

  static styles = css`
    :host {
      display: none;
    }
    /* The host IS the floating box (position:fixed takes it out of #app's flex flow,
       so it overlays the terminals without disturbing their layout). */
    :host([open]) {
      display: block;
      position: fixed;
      z-index: 150;
      width: 360px;
      background: #12131f;
      border: 1px solid #0f3460;
      border-radius: 8px;
      box-shadow: 0 10px 34px rgba(0, 0, 0, 0.6);
      overflow: hidden;
      font-family: Menlo, Monaco, "Courier New", monospace;
    }
    /* Corner pinning. Top corners sit BELOW the toolbar (--wt-toolbar-h pierces the
       shadow boundary as an inherited custom property). */
    :host([open][corner='tl']) { top: calc(var(--wt-toolbar-h, 44px) + 12px); left: 16px; }
    :host([open][corner='tr']) { top: calc(var(--wt-toolbar-h, 44px) + 12px); right: 16px; }
    :host([open][corner='bl']) { bottom: 16px; left: 16px; }
    :host([open][corner='br']) { bottom: 16px; right: 16px; }

    .frame {
      position: relative;
      width: 100%;
      height: 216px;
      background: #1a1a2e;
      overflow: hidden;
      cursor: pointer;                 /* the whole preview is click-to-activate */
      border-bottom: 1px solid #0f3460;
    }
    /* The static xterm host — Lit renders it once and never touches its children. */
    .screen-host {
      position: absolute;
      inset: 0;
    }
    .screen {
      position: absolute;
      top: 0;
      left: 0;
      transform-origin: top left;      /* letterbox-scaled to the frame (see _rescale) */
    }
    /* Dim + tag the preview once its window stops producing captures (closed). */
    :host([open]) .frame.stale { filter: grayscale(0.8) brightness(0.55); }
    .stale-tag {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #ffb4b4;
      font-size: 13px;
      letter-spacing: 0.04em;
      text-shadow: 0 1px 4px #000;
      pointer-events: none;
    }

    /* Hover-revealed controls: four corner-move buttons on the left, close on the
       right. Hidden (and click-through) until the box is hovered. */
    .controls {
      position: absolute;
      top: 6px;
      left: 6px;
      right: 6px;
      display: flex;
      align-items: center;
      gap: 4px;
      opacity: 0;
      transition: opacity 0.12s;
      pointer-events: none;
    }
    :host(:hover) .controls {
      opacity: 1;
      pointer-events: auto;
    }
    .spacer { flex: 1 1 auto; }
    .cbtn, .close {
      width: 22px;
      height: 22px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 4px;
      border: 1px solid #0f3460;
      background: rgba(12, 16, 32, 0.85);
      color: #cbd5f0;
      cursor: pointer;
      font-size: 13px;
      line-height: 1;
      padding: 0;
    }
    .cbtn:hover { border-color: #4a9eff; color: #fff; }
    .cbtn.active {
      border-color: #37d17a;
      color: #37d17a;
    }
    .close:hover { border-color: #e94560; background: #e94560; color: #fff; }

    .label {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 8px;
      padding: 5px 9px;
      font-size: 12px;
      color: #d6ddf5;
      white-space: nowrap;
    }
    .label .name {
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .label .tag {
      flex: 0 0 auto;
      color: #7f8bb5;
      letter-spacing: 0.08em;
      font-size: 11px;
    }
  `;

  constructor() {
    super();
    this.open = false;
    this.corner = readCorner();
    this.cache = null;      // shared CaptureCache — set by SplitManager
    this.manager = null;    // SplitManager — set by SplitManager
    this.onClose = null;    // callback fired whenever the PiP closes (toolbar sync)
    this.windowId = null;   // the pinned window's tmux @id
    this.sessionName = '';  // its LOGICAL session (for click-to-activate navigation)
    this._label = '';
    this._stale = false;
    this._term = null;
    this._screen = null;
    this._cols = 0;
    this._rows = 0;
    this._pollTimer = null;
    // Repaint only when a capture for OUR window actually arrives (markAccessed and
    // other windows' updates fire 'update' too — ignore those).
    this._onCacheUpdate = (e) => {
      const caps = (e && e.detail && e.detail.captures) || [];
      if (caps.some((c) => c.windowId === this.windowId)) this._paint();
    };
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.close();
  }

  // ---- open / close -----------------------------------------------------------

  // Pin `windowId` (meta = {index,name,session} snapshot from the accessing region).
  openFor(windowId, meta = {}) {
    if (!windowId) return;
    // Re-pinning a different window while open: tear the old preview down first.
    if (this.open && this.windowId !== windowId) this._teardownTerm();
    this.windowId = windowId;
    this.sessionName = meta.session || '';
    this._label = meta.index != null ? `${meta.index}: ${meta.name || 'bash'}` : (meta.name || '…');
    this._stale = false;
    this.open = true;
    this.cache?.addEventListener('update', this._onCacheUpdate);
    // Force a fresh capture of just this window, then paint whatever's cached now.
    this.cache?.request([windowId], true);
    this.updateComplete.then(() => this._paint());
    if (this._pollTimer) clearInterval(this._pollTimer);
    this._pollTimer = setInterval(() => {
      if (!this.windowId) return;
      this.cache?.request([this.windowId], true);   // one-window capture, keeps it live
      this._checkStale();
    }, POLL_MS);
  }

  close() {
    if (!this.open) return;
    this.open = false;
    this.cache?.removeEventListener('update', this._onCacheUpdate);
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
    this._teardownTerm();
    this.windowId = null;
    this._stale = false;
    if (this.onClose) this.onClose();
  }

  // Toggle for the shortcut/button path. The manager resolves the focused window
  // and calls openFor()/close() directly, so this is mainly a convenience.
  toggle(windowId, meta) {
    if (this.open) this.close();
    else this.openFor(windowId, meta);
  }

  _teardownTerm() {
    if (this._term) { try { this._term.dispose(); } catch (e) {} this._term = null; }
    if (this._screen) { try { this._screen.remove(); } catch (e) {} this._screen = null; }
    this._cols = this._rows = 0;
  }

  // ---- corner placement -------------------------------------------------------

  setCorner(c) {
    if (!CORNERS.includes(c)) return;
    this.corner = c;
    saveCorner(c);
    // Size is unchanged, but the frame's box may re-layout — re-letterbox next frame.
    this._rescale();
  }

  // ---- live preview -----------------------------------------------------------

  _ensureTerm(entry) {
    if (this._term) return;
    const hostEl = this.renderRoot?.querySelector('.screen-host');
    if (!hostEl) return;
    const screen = document.createElement('div');
    screen.className = 'screen';
    hostEl.appendChild(screen);
    this._screen = screen;
    // Read-only xterm sized to the capture; no WebGL (a tiny preview never needs it).
    this._term = new Terminal({
      cols: entry?.cols || 80,
      rows: entry?.rows || 24,
      fontSize: 14,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: { background: '#1a1a2e', foreground: '#eaeaea' },
      scrollback: 0,
      disableStdin: true,
      cursorStyle: 'bar',
      cursorInactiveStyle: 'none',
      allowProposedApi: true,
    });
    this._term.open(screen);
  }

  _paint() {
    if (!this.open || !this.cache || !this.windowId) return;
    const entry = this.cache.get(this.windowId);
    if (!entry) return;                        // nothing captured yet — keep "…"
    this._ensureTerm(entry);
    if (!this._term) return;
    if (entry.cols && entry.rows && (entry.cols !== this._cols || entry.rows !== this._rows)) {
      try { this._term.resize(entry.cols, entry.rows); } catch (e) {}
      this._cols = entry.cols;
      this._rows = entry.rows;
    }
    this._term.write('\x1b[H\x1b[2J');
    this._term.write(CaptureCache.decodeAnsi(entry));
    this._rescale();
    // Keep the label fresh (a rename/index change shows up on the next capture).
    this._label = `${entry.index}: ${entry.name}`;
    // A capture just arrived => the window is alive; clear any stale flag.
    if (this._stale) this._stale = false;
  }

  // CSS-scale the terminal to fit the frame, letterboxed (once laid out).
  _rescale() {
    if (!this._screen) return;
    requestAnimationFrame(() => {
      const frame = this.renderRoot?.querySelector('.frame');
      if (!frame || !this._screen) return;
      const nw = this._screen.offsetWidth || 1;
      const nh = this._screen.offsetHeight || 1;
      const scale = Math.min(frame.clientWidth / nw, frame.clientHeight / nh);
      this._screen.style.transform = `scale(${scale})`;
    });
  }

  // The poll actively re-requests OUR window each tick, so a live window's capture
  // keeps advancing capturedAt; if it hasn't in STALE_MS the window is gone.
  _checkStale() {
    const entry = this.cache?.get(this.windowId);
    if (!entry) return;
    const stale = Date.now() - entry.capturedAt * 1000 > STALE_MS;
    if (stale !== this._stale) this._stale = stale;
  }

  // ---- interaction ------------------------------------------------------------

  // Click the preview => make this window active in the FOCUSED region (same shared
  // navigation path as the toolbar recents strip / Exposé). The PiP stays pinned.
  _activate() {
    if (!this.windowId) return;
    this.manager?.goToWindow(this.windowId, this.sessionName || '');
  }

  render() {
    return html`
      <link rel="stylesheet" href=${XTERM_CSS} />
      <div class="frame ${this._stale ? 'stale' : ''}" @click=${this._activate}
        title="Click to switch the focused view to this window">
        <div class="screen-host"></div>
        ${this._stale ? html`<div class="stale-tag">window closed</div>` : ''}
      </div>
      <div class="controls" @click=${(e) => e.stopPropagation()}>
        ${CORNERS.map((c) => html`
          <button
            class="cbtn ${this.corner === c ? 'active' : ''}"
            title="Move to ${CORNER_NAME[c]}"
            aria-label="Move picture-in-picture to ${CORNER_NAME[c]}"
            @click=${() => this.setCorner(c)}
          >${CORNER_GLYPH[c]}</button>
        `)}
        <span class="spacer"></span>
        <button
          class="close"
          title="Close picture-in-picture (Ctrl+Alt+I)"
          aria-label="Close picture-in-picture"
          @click=${() => this.close()}
        >✕</button>
      </div>
      <div class="label">
        <span class="name">${this._label || '…'}</span>
        <span class="tag">PiP</span>
      </div>
    `;
  }
}

function readCorner() {
  try {
    const c = localStorage.getItem(CORNER_KEY);
    if (CORNERS.includes(c)) return c;
  } catch (e) {
    /* storage unavailable — fall through to the default */
  }
  return 'tr';   // starts top-right
}

function saveCorner(c) {
  try {
    localStorage.setItem(CORNER_KEY, c);
  } catch (e) {
    /* best-effort persistence */
  }
}

customElements.define('webtmux-pip', WebtmuxPip);
