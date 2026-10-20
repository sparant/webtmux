// Keyboard-shortcuts overlay: a discoverable cheat-sheet of every webtmux hotkey.
// Opened from the toolbar's ⌨ button or Ctrl+Alt+K (k = keys; tmux's
// `?`/list-keys), and dismissed with Esc, the same key, or a backdrop click.
//
// The global chords use the Ctrl+Alt modifier (Ctrl+Option on macOS) and, where
// tmux has a natural key after its Ctrl-b prefix, reuse that same letter so the
// muscle memory carries over — w=choose-tree, p/n and ⇧P/⇧N=prev/next-window, 0-9,
// x=kill-pane, &=kill-window, o/;=next/last pane, ]=paste, f=find (Exposé),
// ?=list-keys, %=split left|right, "=split top/bottom (Enter splits left|right too).
import { LitElement, html, css } from 'lit';
import { MOD_LABEL, MOD_CHIPS, IS_MAC } from '../os.js';

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
      { keys: [...M, 'F'], desc: 'Exposé — find a window among every window across all sessions; press again to close. Its header sets 2×2 or 3×3 — tmux ⌃b f' },
      { keys: [...M, '0–9'], desc: 'Go to window 0–9 of the focused pane’s session — tmux ⌃b 0–9' },
      { keys: [...M, 'I'], desc: 'Preview — add/remove the focused window. It joins the docked edge bar, which reserves space rather than covering the terminal. A previewed window gives up its recents tab while it is in there, and gets it back when it leaves' },
      { keys: [...M, '⇧', 'I'], desc: 'Preview — pin the focused window to a free screen corner as a floating box instead (again: back to the bar). One window per corner, so up to four float at once; a tile’s hover controls aim it at a particular corner' },
      { keys: [...M, 'H'], desc: 'Preview — hide / show it (keeps its windows, and where each one is drawn)' },
      { keys: [...M, 'D'], desc: 'Recents — remove the current window from the strip & view (same as its tab ×)' },
      { keys: [...M, 'C'], desc: 'New window in the focused pane’s session (also ⌘⌥C on a Mac)' },
      { keys: [...M, '%'], desc: 'Split view — split the focused view left | right (⏎ works too) — tmux ⌃b %' },
      { keys: [...M, '"'], desc: 'Split view — split the focused view top / bottom — tmux ⌃b "' },
      { keys: [...M, 'O'], desc: 'Focus the next view — tmux ⌃b o' },
      { keys: [...M, ';'], desc: 'Focus the view you were in before (again: back) — tmux ⌃b ;' },
      { keys: [...M, 'X'], desc: 'Close the focused view; the next view takes the focus (⌫ works too) — tmux ⌃b x' },
      { keys: [...M, '&'], desc: 'Kill the focused window, after asking (a window linked into other sessions is only unlinked from this one) — tmux ⌃b &' },
      { keys: [...M, '['], desc: 'Toggle copy / normal (scrollback) mode — tmux ⌃b [' },
      { keys: [...M, ']'], desc: 'Paste the focused copy buffer into the pane — tmux ⌃b ]' },
      { keys: [...M, '='], desc: 'Toggle the copy-buffer panel — the things you have copied, and which one the clipboard holds — tmux ⌃b =' },
      { keys: [...M, 'P'], desc: 'Recents — previous tab (left) — tmux ⌃b p' },
      { keys: [...M, 'N'], desc: 'Recents — next tab (right) — tmux ⌃b n' },
      { keys: [...M, '⇧', 'P'], desc: 'This session’s window list — previous window, in tmux index order (also ⌘⌥⇧P on a Mac)' },
      { keys: [...M, '⇧', 'N'], desc: 'This session’s window list — next window, in tmux index order (also ⌘⌥⇧N on a Mac)' },
      { keys: [...M, 'L'], desc: 'Cycle most-recently-used windows — hold the chord and tap L to walk back through history (⇧L reverses); releasing the chord commits where you landed, like alt-tab' },
      { keys: [...M, ','], desc: 'Rename the current window (caret at the end, ready to add to the name) — tmux ⌃b ,' },
      { keys: [...M, 'B'], desc: 'Show / hide the build-id chip (top-left)' },
      { keys: [...M, 'K'], desc: 'Show this shortcuts list (k = keys)' },
      { keys: [...M, '?'], desc: 'The help overlay, staying up without holding — arrows and notes on every part of the screen (tap the two keys, Enter or Esc to close it) — tmux ⌃b ?' },
      { keys: [...M, 'hold'], desc: 'Hold just the two keys for a moment (no other key): the help overlay — notes and arrows on every part of the screen, with their keys. Point toward a part for more detail; keys and clicks keep working; let go to hide' },
    ],
  },
  {
    title: 'Sidebar (while the panel is focused)',
    rows: [
      { keys: ['↑'], desc: 'Preview the previous window' },
      { keys: ['↓'], desc: 'Preview the next window' },
      { keys: ['←'], desc: 'Preview the previous session (in the all-windows view: fold the session away)' },
      { keys: ['→'], desc: 'Preview the next session (in the all-windows view: unfold it)' },
      { keys: ['⏎'], desc: 'Commit the previewed window — it becomes the region’s real window & the keyboard returns to the terminal (clicking also commits)' },
      { keys: ['Esc'], desc: 'Clear the filter first; pressed again, discard the preview — nothing switched, so the region simply goes back to its own window' },
      { keys: ['a–z'], desc: 'Type to filter the list & preview the first match (space = new word). The filter stays until you clear it; ⌫ rubs out a character' },
      { keys: ['drag'], desc: 'Drag a window between rows to reorder, or onto a session to link it' },
      { keys: ['hover'], desc: 'Point at a window to preview it in a terminal region; click to switch to it' },
      { keys: ['dbl-click'], desc: 'Rename a window or session (name selected, ready to replace; ⏎ commits and refocuses the terminal, Esc cancels). Pasting a path keeps just the file name' },
    ],
  },
  {
    title: 'Hover preview (pointing at a recents tab or preview tile)',
    rows: [
      { keys: ['⏎'], desc: 'Switch to the window being previewed (same as clicking)' },
      { keys: ['Esc'], desc: 'Put the region back the way it was (same as moving the pointer away)' },
    ],
  },
  {
    title: 'Copy buffers (while the panel is focused)',
    rows: [
      { keys: ['↑'], desc: 'Focus the previous buffer — it goes on the clipboard as you land on it' },
      { keys: ['↓'], desc: 'Focus the next buffer' },
      { keys: ['⌫'], desc: 'Remove the focused buffer (Del too); the list always keeps at least one' },
      { keys: ['⏎'], desc: 'Close the panel and return to the terminal (Esc does the same)' },
      { keys: ['click'], desc: 'Put a buffer on the clipboard; its × removes it, "+" adds an empty one, Clear keeps only the focused one' },
    ],
  },
  {
    title: 'Exposé (while open)',
    rows: [
      { keys: ['←', '→', '↑', '↓'], desc: 'Move the tile cursor' },
      { keys: ['⏎'], desc: 'Switch the focused region to the selected window' },
      { keys: ['a–z'], desc: 'Type to filter tiles by name (the toggle also searches captured window content); ⌫ deletes' },
      { keys: ['Esc'], desc: 'Clear the filter first; pressed again, close Exposé' },
    ],
  },
  {
    title: 'Terminal',
    rows: [
      { keys: ['Drag'], desc: 'Click and drag over the pane to select text — no need to enter copy mode by hand, even over a program holding the mouse (Claude/vim/htop). Starting the selection enters copy mode for you, so dragging to the edge scrolls for more. The toolbar\'s mouse-capture dropdown (click+drag:) decides who gets a press: app / buf / auto / auto+ (the default: clicks reach the program, drags select — and clicking away leaves copy mode again)' },
      { keys: ['⇧', 'Click'], desc: 'Move the far end of the current selection, keeping the end you started from — fixes an overshoot without redoing the drag (works over a mouse-grabbing program too)' },
      { keys: [IS_MAC ? '⌥' : '⇧', 'Drag'], desc: 'Force a selection whatever the mode says — xterm\'s own escape hatch, still there' },
      { keys: ['⌘/⌃', 'C'], desc: 'Copy the selection; stays in copy mode so you can copy several regions in a row. Copying AGAIN before you paste keeps both — the second one becomes a new copy buffer (⌃⌥=). If that panel is shut, the copy floats it in for a couple of seconds without taking the keyboard; carry on typing and it goes away. With nothing selected, ⌃C passes through as an interrupt' },
      { keys: ['⌘/⌃', 'V'], desc: 'Paste the focused copy buffer, i.e. the clipboard (auto-exits copy mode first so the text lands at the prompt)' },
      { keys: ['a–z'], desc: 'Typing at a pane that is scrolled up in copy mode leaves copy mode and goes to the prompt — copy-mode motions (hjkl, g/G, q, arrows, ␣, y, /) still work' },
    ],
  },
  {
    title: 'Confirmations (the small popup next to a ×)',
    rows: [
      { keys: ['Esc'], desc: 'Dismiss the question without acting' },
      { keys: ['←', '→', 'Tab'], desc: 'Walk to a button; ⏎/␣ presses it — a stray ⏎ can’t confirm, reaching Yes takes a deliberate step' },
    ],
  },
  ...(IS_MAC ? [{
    title: 'Trackpad (Mac)',
    rows: [
      { keys: ['spread'], desc: 'Spread two fingers apart to open Exposé' },
      { keys: ['pinch'], desc: 'Pinch together to close Exposé' },
    ],
  }] : []),
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

  // While open, Escape closes. (Ctrl+Alt+K re-toggle is handled globally by the
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
        <div class="foot">${MOD_LABEL} chords sit above tmux's own ⌃b prefix, so both keymaps coexist. Esc closes this list.</div>
      </div>
    `;
  }
}

customElements.define('webtmux-shortcuts', WebtmuxShortcuts);
