// The confirm popup — one small themed "are you sure?" that opens NEXT TO the
// control you just clicked, shared by every destructive affordance in the app.
//
// Why not the browser's own confirm(): it is a modal centred on the window, so
// answering a question about a 18px × in the sidebar means a trip to the middle
// of the screen and back — the mouse travel costs more than the decision does.
// It also blocks the whole page (the terminals stop painting while it is up),
// and it renders in OS chrome that has nothing to do with this app. The question
// belongs where the click was.
//
// THE RULE, and it is deliberately lopsided: only "Yes" acts. The No button, a
// click anywhere else, Escape, scrolling the list the anchor lives in — every one
// of those dismisses and does nothing. An outside click is SWALLOWED rather than
// passed through, so dismissing the popup can never also press whatever was
// underneath it. The destructive path is the single narrow one you have to aim at.
//
// Same shape as the hover hint (see tooltip.js): drop CONFIRM_CSS into the
// component's `static styles`, put <div class="wt-confirm"></div> in its render(),
// and hold one ConfirmPopup per component. The element's CONTENTS are built
// imperatively so a Lit re-render (the sidebar re-renders on every 500ms layout
// push) can never orphan a half-answered question.
import { css } from 'lit';
import { placePopup } from './popup-place.js';

export const CONFIRM_CSS = css`
  .wt-confirm {
    position: fixed;
    /* Above the sidebar (50) and any chrome it may open over; below Exposé's
       backdrop (200), which closes before anything here could be asked. */
    z-index: 180;
    display: none;
    /* border-box + a width that fits a 330px sidebar with its margins, so the
       question can sit INSIDE the panel it was asked in (see _position). */
    box-sizing: border-box;
    width: max-content;
    max-width: min(280px, calc(100vw - 16px));
    padding: 10px 12px;
    border-radius: 6px;
    background: #16213e;
    border: 1px solid #e94560;
    box-shadow: 0 8px 26px rgba(0, 0, 0, 0.55);
    color: #eaf0ff;
    font: 13px/1.45 Menlo, Monaco, "Courier New", monospace;
    /* The question can be a sentence; let it wrap into a readable column. */
    white-space: pre-line;
    overflow-wrap: anywhere;
  }
  .wt-confirm.show {
    display: block;
  }
  .wt-confirm:focus,
  .wt-confirm:focus-visible {
    outline: none;
  }
  .wt-confirm .wt-confirm-msg {
    margin-bottom: 9px;
  }
  .wt-confirm .wt-confirm-row {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }
  .wt-confirm button {
    border-radius: 4px;
    padding: 4px 14px;
    font: 12px Menlo, Monaco, "Courier New", monospace;
    cursor: pointer;
    border: 1px solid #0f3460;
    background: #1a1a2e;
    color: #9fb0d8;
  }
  .wt-confirm button:hover {
    border-color: #4a9eff;
    color: #fff;
  }
  /* The one button that acts is the one that looks like the app's destructive
     colour — the same #e94560 the × itself turns on hover. */
  .wt-confirm button.yes {
    border-color: #e94560;
    color: #f3a7b4;
  }
  .wt-confirm button.yes:hover {
    background: #e94560;
    color: #fff;
  }
  .wt-confirm button:focus-visible {
    outline: 2px solid #4a9eff;
    outline-offset: 1px;
  }
`;

export class ConfirmPopup {
  // `host` is the LitElement whose renderRoot holds the .wt-confirm element.
  constructor(host) {
    this.host = host;
    this._onConfirm = null;
    // Bound once so the same reference can always be removed again.
    this._onOutside = (e) => this._handleOutside(e);
    this._onKey = (e) => this._handleKey(e);
    this._onScroll = () => this.close();
    this._listening = false;
  }

  get open() {
    return !!this._onConfirm;
  }

  _el() {
    return this.host?.renderRoot?.querySelector('.wt-confirm');
  }

  // Ask, anchored at `anchor` (the element that was clicked). `onConfirm` runs
  // ONLY on Yes. Asking again while a question is up replaces it — clicking a
  // second × moves the question to that × rather than stacking two.
  ask(anchor, { message, yes = 'Yes', no = 'No', onConfirm } = {}) {
    const el = this._el();
    if (!el || !anchor || !onConfirm) return;
    this._onConfirm = onConfirm;
    this._build(el, message, yes, no);
    el.classList.add('show');
    this._position(el, anchor);
    // Take focus so Escape/Tab work and the terminal underneath stops receiving
    // keys. The CONTAINER, not a button: a stray Enter must not be able to
    // confirm a kill — reaching Yes takes a deliberate Tab or a click.
    el.tabIndex = -1;
    el.focus({ preventScroll: true });
    // Listen on the NEXT frame: the very click that opened this popup is still
    // propagating, and would otherwise immediately dismiss it.
    requestAnimationFrame(() => {
      if (!this.open || this._listening) return;
      this._listening = true;
      window.addEventListener('pointerdown', this._onOutside, true);
      window.addEventListener('keydown', this._onKey, true);
      // Any scroll moves the anchor out from under a position:fixed popup, so the
      // question would end up pointing at the wrong row. Capture, so it catches
      // the sidebar's own scroller and not just the page.
      window.addEventListener('scroll', this._onScroll, true);
      window.addEventListener('resize', this._onScroll);
    });
  }

  // Dismiss without acting. Safe to call when nothing is open.
  close() {
    this._onConfirm = null;
    const el = this._el();
    if (el) {
      el.classList.remove('show');
      // Don't strand focus on a hidden element — hand it back to the component,
      // which knows where its own keyboard focus belongs.
      if (el.contains?.(this.host?.renderRoot?.activeElement)) this.host?.focusPanel?.();
    }
    if (!this._listening) return;
    this._listening = false;
    window.removeEventListener('pointerdown', this._onOutside, true);
    window.removeEventListener('keydown', this._onKey, true);
    window.removeEventListener('scroll', this._onScroll, true);
    window.removeEventListener('resize', this._onScroll);
  }

  // Call from the host's disconnectedCallback so a popup on a removed component
  // can't leave window listeners behind.
  dispose() {
    this.close();
  }

  // ---- internals --------------------------------------------------------------

  _confirm() {
    const fn = this._onConfirm;
    this.close();
    if (fn) fn();
  }

  // Rebuild the contents for this question. Plain DOM (not Lit) — see the header.
  _build(el, message, yes, no) {
    el.textContent = '';
    const msg = document.createElement('div');
    msg.className = 'wt-confirm-msg';
    msg.textContent = message || 'Are you sure?';
    const row = document.createElement('div');
    row.className = 'wt-confirm-row';
    const yesBtn = document.createElement('button');
    yesBtn.className = 'yes';
    yesBtn.textContent = yes;
    yesBtn.addEventListener('click', (e) => { e.stopPropagation(); this._confirm(); });
    const noBtn = document.createElement('button');
    noBtn.className = 'no';
    noBtn.textContent = no;
    noBtn.addEventListener('click', (e) => { e.stopPropagation(); this.close(); });
    row.append(yesBtn, noBtn);
    el.append(msg, row);
  }

  // Sit under the anchor by the shared rule (see popup-place.js), right-aligned
  // and kept inside the HOST component: these anchors are the × at the right edge
  // of a tab in a narrow panel, and a question about a row in that list belongs in
  // the panel — clamped only to the viewport it would hang out over the terminal,
  // attached to nothing, which is most of what made the native dialog wrong.
  _position(el, anchor) {
    const host = this.host?.getBoundingClientRect?.();
    const { left, top } = placePopup(
      anchor.getBoundingClientRect(),
      { width: el.offsetWidth, height: el.offsetHeight },
      {
        viewport: { width: window.innerWidth, height: window.innerHeight },
        align: 'right',
        bounds: host ? { left: host.left, right: host.right } : null,
      },
    );
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }

  // A pointerdown anywhere outside dismisses AND is swallowed — see the header.
  // composedPath is what makes "inside" mean inside across the shadow boundary.
  _handleOutside(e) {
    const el = this._el();
    if (!el) { this.close(); return; }
    if (e.composedPath().includes(el)) return;   // the buttons handle themselves
    e.preventDefault();
    e.stopPropagation();
    this.close();
    this._swallowNextClick();
  }

  // pointerdown is only half the gesture. Stopping it keeps the mousedown-driven
  // handlers (region focus, drag starts) from firing, but the browser still
  // dispatches the CLICK that follows — which would press whatever was under the
  // pointer, so dismissing a question by clicking away would also switch you to
  // the window you happened to dismiss it over. Eat exactly that one click.
  _swallowNextClick() {
    let timer = null;
    const stop = () => {
      window.removeEventListener('click', eat, true);
      if (timer) clearTimeout(timer);
    };
    const eat = (ev) => { ev.preventDefault(); ev.stopPropagation(); stop(); };
    window.addEventListener('click', eat, true);
    // No click followed — a drag, or a press that ended somewhere else. Stop
    // waiting rather than eating an unrelated click later on.
    timer = setTimeout(stop, 500);
  }

  // While the question is up the keyboard belongs to it: Escape dismisses,
  // ←/→ walk the two buttons, and everything else is swallowed so the app's
  // global shortcuts (and the terminal) can't act behind an open question.
  _handleKey(e) {
    const el = this._el();
    if (!el) { this.close(); return; }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.close();
      return;
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const btns = [...el.querySelectorAll('button')];
      const i = btns.indexOf(this.host?.renderRoot?.activeElement);
      const next = e.key === 'ArrowRight'
        ? btns[Math.min(btns.length - 1, i + 1)] || btns[0]
        : btns[Math.max(0, i - 1)] || btns[btns.length - 1];
      next?.focus();
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    // Tab stays native (it walks the popup's own buttons); Enter/Space are left
    // to the focused button. Everything else is stopped here.
    if (e.key === 'Tab' || e.key === 'Enter' || e.key === ' ') return;
    e.preventDefault();
    e.stopPropagation();
  }
}
