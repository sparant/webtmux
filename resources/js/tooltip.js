// The hover hint — one tooltip, shared by every component that has one to show.
//
// Why not the browser's own `title`: it waits about a second before appearing,
// the delay isn't ours to tune, and it renders in the OS chrome style rather than
// the app's. That's fine for a rarely-needed label and wrong for anything you're
// meant to lean on — a hint you have to WAIT for is one you stop asking for.
//
// This lives in one place because the delay is the whole point. The toolbar had
// its own copy and the sidebar used native `title`, so the same stoplight dot
// answered after ~600ms in the strip and ~1s in the window list — the sort of
// difference that reads as "the sidebar is being slow" rather than as two
// mechanisms. One controller, one delay, one look.
import { css } from 'lit';

// How long the pointer has to rest before the hint appears. Long enough that
// crossing a strip of tabs doesn't strobe hints at you, short enough that
// deliberately pointing at something feels answered rather than endured.
export const TIP_DELAY = 600;

// Drop into a component's `static styles` alongside its own rules, and put a
// <div class="wt-tip"></div> in its render() — the controller finds it there.
export const TIP_CSS = css`
  .wt-tip {
    position: fixed;
    /* Above every piece of chrome in whatever shadow root this is dropped into —
       Exposé's backdrop alone sits at 200, and a hint that renders UNDER the thing
       it is describing is just an invisible hint. */
    z-index: 1000;
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

export class Tip {
  // `host` is the LitElement whose renderRoot holds the .wt-tip element.
  constructor(host) {
    this.host = host;
    this._timer = null;
  }

  _el() {
    return this.host?.renderRoot?.querySelector('.wt-tip');
  }

  // Schedule the hint to appear at `ev.currentTarget` after the delay — OR, if a
  // hint is already up (moving from a tab onto its child ×, or from one tab to the
  // next), swap its text and position INSTANTLY. Waiting again between neighbours
  // would make a row of hinted controls feel stuck; the delay is there to filter
  // out passing through, and you've already stopped passing through.
  enter(ev, text) {
    if (!text) return;
    const target = ev?.currentTarget;
    if (!target) return;
    if (this._timer) clearTimeout(this._timer);
    const tip = this._el();
    if (tip && tip.classList.contains('show')) {
      this.show(target, text);
      return;
    }
    this._timer = setTimeout(() => {
      this._timer = null;
      if (!target.isConnected) return;   // re-rendered away while we waited
      this.show(target, text);
    }, TIP_DELAY);
  }

  // Position + reveal the hint under `target`, clamped into the viewport. Flips
  // ABOVE the target when there isn't room below — a sidebar list runs to the
  // bottom of the screen, so "always below" would put its last few hints offscreen.
  show(target, text) {
    const tip = this._el();
    if (!tip || !target?.isConnected) return;
    tip.textContent = text;
    // Show first (still transparent) so it has real dimensions to measure against.
    tip.classList.add('show');
    const r = target.getBoundingClientRect();
    const margin = 6;

    const tw = tip.offsetWidth;
    let left = r.left;
    if (left + tw > window.innerWidth - margin) left = window.innerWidth - tw - margin;
    if (left < margin) left = margin;

    const th = tip.offsetHeight;
    let top = r.bottom + margin;
    if (top + th > window.innerHeight - margin) top = r.top - th - margin;
    if (top < margin) top = margin;

    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
  }

  leave() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    const tip = this._el();
    if (tip) tip.classList.remove('show');
  }

  // Call from the host's disconnectedCallback so a pending hint can't fire into a
  // detached tree.
  dispose() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
  }
}
