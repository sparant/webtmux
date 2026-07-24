// Keyboard-shortcuts overlay: a discoverable cheat-sheet of every webtmux hotkey.
// Opened from the sidebar's "Keyboard shortcuts" button or Ctrl+Alt+/ (tmux's
// `?`/list-keys), and dismissed with Esc, the same key, or a backdrop click.
//
// The global chords use the Ctrl+Alt modifier (Ctrl+Option on macOS) and, where
// tmux has a natural key after its Ctrl-b prefix, reuse that same letter so the
// muscle memory carries over — w=choose-tree, p/n=prev/next-window, x=kill-pane,
// ?=list-keys. Split-add has no unmodified tmux letter (% / " need Shift) so it
// keeps Enter; Exposé is webtmux-only so it keeps E.
import { LitElement, html, css } from 'lit';
import { MOD_LABEL, MOD_CHIPS } from '../os.js';

// The two modifier keycaps, labelled for the CONNECTING client's OS (⌃⌥ on a Mac,
// Ctrl/Alt on Windows/Linux) — the page may be viewed from any of them even though
// the server is Linux.
const M = MOD_CHIPS;

// Each group: a heading + rows of { keys: [..], desc }. Keys render as <kbd>.
const GROUPS = [
  {
    title: `Global — ${MOD_LABEL}`,
    rows: [
      { keys: [...M, 'W'], desc: 'Toggle the sidebar (windows & sessions) — tmux ⌃b w' },
      { keys: [...M, 'E'], desc: 'Exposé — every window across all sessions' },
      { keys: [...M, 'I'], desc: 'Preview — add/remove the focused window (1 = corner box, 2+ = docked edge bar)' },
      { keys: [...M, 'H'], desc: 'Preview — hide / show it (keeps its windows)' },
      { keys: [...M, 'D'], desc: 'Recents — remove the current window from the strip & view (same as its tab ×)' },
      { keys: [...M, 'C'], desc: 'New window in the focused pane’s session (also ⌘⌥C on a Mac)' },
      { keys: [...M, '⏎'], desc: 'Split view — add another terminal region' },
      { keys: [...M, 'X'], desc: 'Close the focused region — tmux ⌃b x' },
      { keys: [...M, '['], desc: 'Toggle copy / normal (scrollback) mode — tmux ⌃b [' },
      { keys: [...M, 'P'], desc: 'Recents — previous window (left) — tmux ⌃b p' },
      { keys: [...M, 'N'], desc: 'Recents — next window (right) — tmux ⌃b n' },
      { keys: [...M, 'L'], desc: 'Cycle most-recently-used windows — hold the chord and tap L to walk back through history (⇧L reverses); like alt-tab' },
      { keys: [...M, ','], desc: 'Rename the current window — tmux ⌃b ,' },
      { keys: [...M, 'B'], desc: 'Show / hide the build-id chip (top-left)' },
      { keys: [...M, '/'], desc: 'Show this shortcuts list — tmux ⌃b ?' },
    ],
  },
  {
    title: 'Sidebar (while the panel is focused)',
    rows: [
      { keys: ['↑'], desc: 'Preview the previous window' },
      { keys: ['↓'], desc: 'Preview the next window' },
      { keys: ['←'], desc: 'Preview the previous session' },
      { keys: ['→'], desc: 'Preview the next session' },
      { keys: ['⏎'], desc: 'Accept the previewed window as the new focus & return to the terminal (clicking the terminal also accepts)' },
      { keys: ['Esc'], desc: 'Discard the preview — restore the window you were on before opening the panel' },
      { keys: ['a–z'], desc: 'Type to find & select a window (space = new word; a short pause resets)' },
      { keys: ['drag'], desc: 'Drag a window between rows to reorder, or onto a session to link it' },
      { keys: ['dbl-click'], desc: 'Rename a window' },
    ],
  },
  {
    title: 'Terminal',
    rows: [
      { keys: ['⌘/⌃', 'C'], desc: 'Copy the selection (or interrupt if nothing is selected); stays in copy mode so you can copy several regions in a row' },
      { keys: ['⌘/⌃', 'V'], desc: 'Paste (auto-exits copy mode first so the text lands at the prompt)' },
    ],
  },
  {
    title: 'Trackpad (Mac)',
    rows: [
      { keys: ['pinch'], desc: 'Spread two fingers apart to open Exposé; pinch them together to close it' },
    ],
  },
];

class WebtmuxShortcuts extends LitElement {
  static properties = {
    open: { type: Boolean, reflect: true },
  };

  static styles = css`
    :host {
      display: none;
      position: fixed;
      inset: 0;
      z-index: 200;
    }
    :host([open]) { display: block; }

    .backdrop {
      position: absolute;
      inset: 0;
      background: rgba(6, 10, 22, 0.66);
      backdrop-filter: blur(2px);
    }

    .card {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: min(560px, calc(100vw - 32px));
      max-height: calc(100vh - 64px);
      overflow-y: auto;
      box-sizing: border-box;
      background: #16213e;
      border: 1px solid #0f3460;
      border-radius: 10px;
      box-shadow: 0 18px 50px rgba(0, 0, 0, 0.6);
      padding: 20px 22px;
      color: #dfe6f5;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    .head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 14px;
    }
    h2 {
      margin: 0;
      font-size: 17px;
      color: #e94560;
      text-transform: uppercase;
      letter-spacing: 1px;
    }
    .close-x {
      background: #1a1a2e;
      border: 1px solid #0f3460;
      border-radius: 6px;
      color: #ccc;
      width: 30px;
      height: 30px;
      cursor: pointer;
      font-size: 15px;
      line-height: 1;
    }
    .close-x:hover { border-color: #e94560; color: #fff; }

    h3 {
      margin: 16px 0 8px;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: #4a9eff;
    }
    h3:first-of-type { margin-top: 0; }

    .row {
      display: flex;
      align-items: baseline;
      gap: 12px;
      padding: 5px 0;
      border-top: 1px solid rgba(15, 52, 96, 0.5);
    }
    .keys {
      flex: 0 0 132px;
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }
    .desc { color: #b9c4dc; font-size: 13px; }

    kbd {
      background: #1a1a2e;
      border: 1px solid #0f3460;
      border-bottom-width: 2px;
      border-radius: 4px;
      padding: 1px 7px;
      color: #9fc4ff;
      font-family: Menlo, Monaco, "Courier New", monospace;
      font-size: 12px;
      white-space: nowrap;
    }

    .foot {
      margin-top: 16px;
      padding-top: 10px;
      border-top: 1px solid #0f3460;
      color: #7f8db0;
      font-size: 12px;
    }
  `;

  constructor() {
    super();
    this.open = false;
    this._onKey = this._onKey.bind(this);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('keydown', this._onKey, true);
  }

  openOverlay() {
    if (this.open) return;
    this.open = true;
    window.addEventListener('keydown', this._onKey, true);
  }

  closeOverlay() {
    if (!this.open) return;
    this.open = false;
    window.removeEventListener('keydown', this._onKey, true);
  }

  toggle() {
    if (this.open) this.closeOverlay();
    else this.openOverlay();
  }

  // While open, Escape closes. (Ctrl+Alt+/ re-toggle is handled globally by the
  // SplitManager, which calls toggle() and closes us.)
  _onKey(e) {
    if (!this.open) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.closeOverlay();
    }
  }

  render() {
    return html`
      <div class="backdrop" @click=${() => this.closeOverlay()}></div>
      <div class="card" role="dialog" aria-label="Keyboard shortcuts">
        <div class="head">
          <h2>Keyboard shortcuts</h2>
          <button class="close-x" title="Close (Esc)" @click=${() => this.closeOverlay()}>✕</button>
        </div>
        ${GROUPS.map(g => html`
          <h3>${g.title}</h3>
          ${g.rows.map(r => html`
            <div class="row">
              <span class="keys">${r.keys.map(k => html`<kbd>${k}</kbd>`)}</span>
              <span class="desc">${r.desc}</span>
            </div>
          `)}
        `)}
        <div class="foot">${MOD_LABEL} chords sit above tmux's own ⌃b prefix, so both keymaps coexist.</div>
      </div>
    `;
  }
}

customElements.define('webtmux-shortcuts', WebtmuxShortcuts);
