// The strip above each split view: which window the view shows (with its stoplight
// and time-in-state, as on its recents tab), and — when the
// pointer comes near the top of the view — the controls that act on the view itself:
// move it left / right / up / down (keeping every view's size — see split-tree.js
// moveBranch) and close it.
//
// The strip only exists while the screen is split, and it RESERVES its height rather
// than floating over the terminal. Floating, it would sit on the first rows of the
// window exactly when you reached for them; sliding the terminal down to make room
// instead would resize the tmux pane every time the pointer passed by, and every
// full-screen program in it would redraw. A thin strip that is always there is the
// version that never moves or covers anything.
//
// The buttons are the preview tiles' hover controls (pip-overlay.js .tbtn) at strip
// size: same rounded frame, same fade-in, close in the destructive colour. Like the
// tiles, a direction with no view on that side is not drawn rather than drawn dead.
import { LitElement, html, css } from 'lit';
import { Tip, TIP_CSS } from '../tooltip.js';
import { chord } from '../os.js';
import { workClass, workLabel, workTip, workBadgeTip } from '../stoplight.js';
import { STOPLIGHT_CSS } from '../stoplight-dot.js';

// Arrow, and the words the hint uses.
const MOVES = [
  ['left', '←', 'left'],
  ['up', '↑', 'up'],
  ['down', '↓', 'down'],
  ['right', '→', 'right'],
];

class WebtmuxRegionHead extends LitElement {
  static properties = {
    // The window the view shows, already formatted ("session — window N: name").
    label: { type: String },
    // The window's work status: { working, since, activity, badge } (null before a layout).
    work: { type: Object },
    // Which directions have a view to trade places with: { left, right, up, down }.
    moves: { type: Object },
    // The pointer is near the top of the view: show the controls.
    near: { type: Boolean, reflect: true },
    focused: { type: Boolean, reflect: true },
  };

  static styles = [css`
    :host {
      display: flex;
      align-items: center;
      gap: 8px;
      height: var(--wt-region-head-h, 26px);
      flex: 0 0 auto;
      box-sizing: border-box;
      padding: 0 6px 0 10px;
      background: #0b0f1c;
      border-bottom: 1px solid #16213e;
      font: 11.5px Menlo, Monaco, "Courier New", monospace;
      color: #6b7690;
      user-select: none;
      overflow: hidden;
    }
    :host([focused]) { color: #b8f1ff; }
    .work { display: flex; align-items: center; gap: 5px; flex: 0 0 auto; }
    .label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tools { flex: 0 0 auto; display: flex; align-items: center; gap: 4px; }
    .gap { width: 6px; }
    .tbtn {
      display: flex; align-items: center; justify-content: center;
      width: 26px; height: 20px; padding: 0;
      border-radius: 6px;
      border: 2px solid rgba(160, 190, 245, 0.85);
      background: rgba(9, 13, 28, 0.9);
      color: #e2e9fb; cursor: pointer; line-height: 1; font-size: 13px;
      opacity: 0; pointer-events: none;
      transition: opacity 0.12s, transform 0.1s, border-color 0.12s, background 0.12s;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.55);
    }
    :host([near]) .tbtn { opacity: 1; pointer-events: auto; }
    .tbtn:hover { transform: scale(1.12); border-color: #7cc0ff; background: rgba(20, 28, 54, 0.95); color: #fff; }
    .tbtn.close { border-color: rgba(233, 69, 96, 0.7); }
    .tbtn.close:hover { border-color: #e94560; background: #e94560; color: #fff; }
  `, STOPLIGHT_CSS, TIP_CSS];

  constructor() {
    super();
    this.label = '';
    this.work = null;
    this.moves = {};
    this.near = false;
    this.focused = false;
    this.manager = null;   // SplitManager, set directly
    this.unit = null;      // the TerminalUnit this strip belongs to
    this._tip = new Tip(this);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._tip.dispose();
  }

  _act(fn) {
    this._tip.leave();
    fn();
  }

  render() {
    const m = this.moves || {};
    const w = this.work;
    const badge = w?.badge || '';
    return html`
      ${w ? html`<span class="work"><span
        class="stoplight ${workClass(w.working)}"
        role="img"
        aria-label=${workLabel(w.working)}
        @mouseenter=${(e) => this._tip.enter(e, workTip(w.working, w.since, w.activity))}
        @mouseleave=${() => this._tip.leave()}
      ></span>${badge ? html`<span
        class="work-age"
        @mouseenter=${(e) => this._tip.enter(e, workBadgeTip(w.since, w.activity))}
        @mouseleave=${() => this._tip.leave()}
      >${badge}</span>` : ''}</span>` : ''}
      <span class="label">${this.label}</span>
      <span class="tools">
        ${MOVES.filter(([dir]) => m[dir]).map(([dir, glyph, words]) => html`
          <button
            class="tbtn move ${dir}"
            aria-label="Move this view ${words}"
            @mouseenter=${(e) => this._tip.enter(e, `Move this view ${words}.\n\nEvery view keeps its size and its window. If this view sits in a group running the other way, the whole group moves with it.`)}
            @mouseleave=${() => this._tip.leave()}
            @click=${() => this._act(() => this.manager?.moveRegion(this.unit, dir))}
          >${glyph}</button>
        `)}
        <span class="gap"></span>
        <button
          class="tbtn close"
          aria-label="Close this view"
          @mouseenter=${(e) => this._tip.enter(e, `Close this view.\n\nThe window keeps running — only the view goes, and the next view takes the focus.\n\nShortcut: ${chord('X')} closes the focused view.`)}
          @mouseleave=${() => this._tip.leave()}
          @click=${() => this._act(() => this.manager?.removeUnit(this.unit))}
        >✕</button>
      </span>
      <div class="wt-tip"></div>
    `;
  }
}

customElements.define('webtmux-region-head', WebtmuxRegionHead);
