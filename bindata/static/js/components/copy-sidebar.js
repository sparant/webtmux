// The COPY BUFFER panel — the second sidebar.
//
// It is deliberately the same object as the windows & sessions sidebar, wearing a
// different list: it floats or mounts, it pins or auto-hides, it has a chord of
// its own (⌃⌥= — tmux's own `⌃b =`, choose-buffer), its rows focus with a click or
// ↑/↓, and its "+" and hover-× sit exactly where the window list's do. Someone who
// has learned one panel has learned this one; the only thing to learn is what the
// list holds.
//
// WHAT THE LIST MEANS. One row per copy buffer, exactly one of them FOCUSED, and
// the focused one is what the system clipboard holds — so choosing a row is how
// you choose what ⌘V will paste, in this app and in every other one. The rules
// that decide when a copy appends a row instead of overwriting one live in
// copy-buffers.js, which is where they can be tested; this file renders them and
// says, on the row itself, what the next copy is about to do.
//
// The mode toggle lives here too. Copy/normal mode and the copy buffers are one
// subject — you enter copy mode TO fill these rows — so the toolbar's mode pill
// now opens this panel, and the button that actually flips the mode is the first
// control inside it.
import { LitElement, html, css } from 'lit';
import { MOD_KEYS, chord } from '../os.js';
import { copyBuffers } from '../copy-buffer-store.js';
import { previewText, entryMeta, isEmptyEntry, PREVIEW_CHARS } from '../copy-buffers.js';
import { stateStore } from '../state-store.js';
import { clientStore } from '../client-store.js';
import { Tip, TIP_CSS } from '../tooltip.js';
import { ConfirmPopup, CONFIRM_CSS } from '../confirm-popup.js';

// How much of a buffer the hover hint shows. Far more than the row's one-line
// preview — the hint is where you go when the preview wasn't enough to tell two
// similar buffers apart — but still bounded, because a hint the height of the
// screen is not a hint.
const HINT_CHARS = 600;

// How long the panel stays up after a copy has auto-shown it (see peek()). Long
// enough to read which row the copy landed in and whether the list grew; short
// enough that ignoring it costs nothing. The countdown pauses while the pointer
// is on the panel, so this is a floor on how long you get, not a ceiling.
const PEEK_MS = 3200;

class WebtmuxCopySidebar extends LitElement {
  static properties = {
    collapsed: { type: Boolean },
    overlay: { type: Boolean },
    pinned: { type: Boolean },
    // The focused pane's tmux mode, pushed by the SplitManager exactly as it is
    // pushed to the toolbar's pill — the panel shows it and toggles it.
    copyMode: { type: Boolean },
    // Bumped by the ring's subscription to force a re-render. The ring is a plain
    // object outside lit's reactivity, and it MUTATES its entries in place (a copy
    // into a spent slot changes text without changing identity), so nothing lit
    // watches would otherwise change.
    rev: { type: Number },
    // Read-only server (started without -w): tmux writes are refused, so the mode
    // toggle goes inert. The buffer list itself is entirely client-side and keeps
    // working — copying from a pane you may only watch is still copying.
    readOnly: { type: Boolean, reflect: true, attribute: 'readonly' },
  };

  static styles = [css`
    /* Sized, coloured and animated as the windows sidebar, because it is the same
       piece of furniture on the same edge — see components/sidebar.js. */
    :host {
      display: block;
      width: 330px;
      background: #16213e;
      border-left: 1px solid #0f3460;
      padding: 12px;
      overflow-y: auto;
      transition: width 0.2s, padding 0.2s;
    }

    /* Floating mode. Offset by the WINDOWS sidebar's occupied width so the two
       panels stack side by side instead of one hiding the other — that width is
       published as --wt-sidebar-w whether it is floating or mounted, and is 0 when
       it is closed, so this lands flush against the right edge on its own. */
    :host(.overlay) {
      position: fixed;
      top: var(--wt-toolbar-h, 0);
      right: var(--wt-sidebar-w, 0px);
      height: calc(100% - var(--wt-toolbar-h, 0));
      z-index: 50;
      box-shadow: -8px 0 24px rgba(0, 0, 0, 0.5);
    }

    :host(.collapsed) { display: none; }

    :host([readonly]) .mode-toggle { opacity: 0.45; pointer-events: none; }
    .ro-note {
      display: block;
      margin-top: 6px;
      color: #f2c774;
      font-size: 10.5px;
      line-height: 1.4;
    }

    .mode-row {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-bottom: 12px;
    }

    .shortcut-hint { color: #888; font-size: 13px; }
    .shortcut-hint kbd {
      background: #1a1a2e;
      border: 1px solid #0f3460;
      border-radius: 4px;
      padding: 1px 6px;
      color: #4a9eff;
      font-family: monospace;
      font-size: 12px;
    }

    .mode-pair { display: flex; flex-wrap: wrap; gap: 8px; }
    .mode-pair .mode-btn {
      flex: 1 1 120px;
      width: auto;
      padding-left: 4px;
      padding-right: 4px;
      white-space: nowrap;
    }

    .mode-btn {
      width: 100%;
      background: #1a1a2e;
      border: 1px solid #0f3460;
      border-radius: 4px;
      color: #4a9eff;
      padding: 9px;
      font-size: 14px;
      cursor: pointer;
      transition: all 0.2s;
    }
    .mode-btn:hover { border-color: #4a9eff; color: #fff; }

    /* The pane's tmux mode, in the toolbar pill's own colours so the control you
       clicked to get here and the control that does the work read as one thing:
       green-dot navy = NORMAL (input), amber = COPY (scrollback). */
    .mode-toggle {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      font-family: Menlo, Monaco, "Courier New", monospace;
      font-weight: 600;
      letter-spacing: 0.04em;
      color: #9fe3bd;
    }
    .mode-toggle .mdot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #37d17a;
      box-shadow: 0 0 5px rgba(55, 209, 122, 0.7);
    }
    .mode-toggle.on {
      background: #f0a742;
      border-color: #f0a742;
      color: #2a1902;
    }
    .mode-toggle.on:hover { color: #2a1902; border-color: #fff; }
    .mode-toggle.on .mdot { background: #2a1902; box-shadow: none; }

    .panel { position: relative; }
    .panel:focus, .panel:focus-visible { outline: none; }

    h3 {
      display: flex;
      align-items: baseline;
      gap: 8px;
      color: #e94560;
      font-size: 16px;
      text-transform: uppercase;
      letter-spacing: 1px;
      margin: 0 0 12px 0;
    }

    /* Shown only while the panel is here BECAUSE of a copy (see peek()). Without
       it a panel that appeared on its own is a panel that appeared for no reason —
       and the reader has no way to tell it from one they opened and forgot. */
    .peek-tag {
      color: #9fe3bd;
      background: rgba(55, 209, 122, 0.12);
      border: 1px solid rgba(55, 209, 122, 0.5);
      border-radius: 10px;
      padding: 1px 8px;
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: none;
    }

    .buffers {
      display: flex;
      flex-direction: column;
      align-items: stretch;
      gap: 4px;
      margin-bottom: 12px;
    }

    /* One row = the clipboard marker + the entry button, laid out exactly like a
       window row's stoplight + tab. The marker sits OUTSIDE the button for the same
       reason the stoplight does: the focused row is filled solid, and a marker on
       that fill is hardest to see precisely when it matters most. */
    .brow {
      --dotcol: 14px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .brow > .buf { flex: 1 1 auto; min-width: 0; }

    /* On the clipboard right now. Hollow on every other row, so the list has one
       obvious answer to "what will ⌘V paste?". */
    .clip, .clip-gap {
      flex: 0 0 auto; width: 8px; height: 8px; box-sizing: border-box;
    }
    .clip {
      border-radius: 50%;
      border: 1px solid #5a6a8a;
      background: transparent;
    }
    .clip.on { background: #37d17a; border-color: #37d17a; box-shadow: 0 0 4px #37d17a; }

    .buf {
      display: block;
      position: relative;
      width: 100%;
      box-sizing: border-box;
      text-align: left;
      background: #1a1a2e;
      color: #888;
      border: 1px solid #0f3460;
      border-radius: 4px;
      padding: 6px 10px;
      font-size: 14px;
      cursor: pointer;
      transition: all 0.2s;
    }
    .buf:hover { border-color: #e94560; color: #fff; padding-right: 26px; }
    .buf.focused {
      background: #e94560;
      border-color: #e94560;
      color: #fff;
    }

    /* The buffer's own text, in the terminal's font — it came from a terminal, and
       a proportional font makes two similar command lines look alike. */
    .btext {
      display: block;
      font-family: Menlo, Monaco, "Courier New", monospace;
      font-size: 12.5px;
      line-height: 1.35;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .bempty { font-style: italic; opacity: 0.75; }
    /* Size + what-happens-next, dim under the preview. */
    .bmeta {
      display: block;
      margin-top: 2px;
      font-size: 10.5px;
      letter-spacing: 0.02em;
      opacity: 0.7;
    }

    .buf .kill {
      display: none;
      position: absolute;
      top: 50%;
      right: 5px;
      transform: translateY(-50%);
      width: 18px;
      height: 18px;
      line-height: 17px;
      text-align: center;
      border-radius: 3px;
      color: #f3a7b4;
      font-size: 15px;
    }
    .buf:hover .kill { display: block; }
    .buf .kill:hover { background: #e94560; color: #fff; }

    /* "+" and "Clear" share the last row: one adds, one destroys, and putting them
       side by side keeps the pair readable while the × that removes a single row
       stays on the row itself. Clear is muted until there is something to clear. */
    .actions { display: flex; gap: 8px; }
    .actions .mode-btn { flex: 1 1 auto; }
    .clear-btn { color: #f3a7b4; }
    .clear-btn:hover { border-color: #e94560; }
    .clear-btn[disabled] {
      opacity: 0.4;
      cursor: default;
      pointer-events: none;
    }

    .note {
      color: #666;
      font-size: 12px;
      line-height: 1.5;
      margin-top: 16px;
      padding-top: 12px;
      border-top: 1px solid #0f3460;
    }
  `, TIP_CSS, CONFIRM_CSS];

  constructor() {
    super();
    this._tip = new Tip(this);
    this._confirm = new ConfirmPopup(this);
    // Same lifetime split as the windows sidebar: collapse is this tab's viewport
    // state, float/pin are shared prefs that should follow you to another browser.
    this.collapsed = clientStore.section('copySidebar').collapsed !== false;   // starts closed
    const cs = stateStore.section('copySidebar');
    this.overlay = cs.overlay !== false;
    this.pinned = cs.pinned === true;
    this.copyMode = false;
    this.readOnly = false;
    this.rev = 0;
    this.manager = null;   // set by the SplitManager
    // --- auto-peek state (see peek() below) -----------------------------------
    this._peeking = false;      // on screen only because a copy just happened
    this._peekTimer = null;     // the countdown to closing it again
    this._onOutside = null;     // the "anything else you do ends it" listener
    this._overlayOverride = null;  // the float/mount pref a peek is standing on
    stateStore.subscribe(() => this._applySharedState());
    this._unsubscribe = copyBuffers.subscribe((reason) => {
      this.rev++;
      // A copy is the one change that happens somewhere else — in a pane, with
      // this panel shut — so it is the one worth showing you.
      if (reason === 'copy') this.peek();
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._tip.dispose();
    this._confirm.dispose();
    this._unsubscribe?.();
    this._clearPeekTimer();
    this._unwatchOutside();
  }

  _applySharedState() {
    const cs = stateStore.section('copySidebar');
    // A peek is standing ON the float/mount pref rather than changing it, so a
    // remote blob arriving mid-peek must not yank the panel back into the flow
    // and resize every terminal underneath it. The pref is re-read when the peek
    // ends and puts it back itself.
    if (!this._overlayOverride) this.overlay = cs.overlay !== false;
    this.pinned = cs.pinned === true;
    this.requestUpdate();
  }

  updated(changed) {
    if (changed.has('collapsed')) {
      this.classList.toggle('collapsed', this.collapsed);
      if (this.collapsed) {
        // An unanswered Clear question lives INSIDE this panel; hiding it mid-
        // question would leave it holding the keyboard somewhere off screen.
        this._confirm.close();
        // A peek is over the moment the panel is shut, HOWEVER that happened —
        // the countdown, an outside click, the chord, or the SplitManager's
        // click-into-the-terminal rule, which sets `collapsed` directly and knows
        // nothing about peeks. Tearing down here rather than in each of those
        // paths is what stops a stale countdown or a borrowed float pref
        // outliving the panel that borrowed them.
        this._peeking = false;
        this._clearPeekTimer();
        this._unwatchOutside();
        this._restoreOverlay();
      } else if (!this._peeking) {
        // A peek deliberately does NOT take the keyboard: you are mid-copy in a
        // pane, and a panel that grabs focus to tell you the copy worked has
        // interrupted the very thing it was reporting on.
        this.focusPanel();
      }
      // …and it does not persist "open" either. The panel was never opened; a
      // reload that restored it would turn a two-second glance into a panel you
      // now have to close.
      if (!this._peeking) clientStore.patchSection('copySidebar', { collapsed: this.collapsed });
      this.dispatchEvent(new CustomEvent('webtmux-copy-sidebar-collapsed', {
        bubbles: true, composed: true, detail: { collapsed: this.collapsed, peek: this._peeking },
      }));
    }
    if (changed.has('overlay')) {
      this.classList.toggle('overlay', this.overlay);
      // Leaving/entering the flex flow changes every region's width; their
      // ResizeObservers re-fit xterm, and this nudge covers the reflow timing.
      this.manager?._refitSoon?.();
    }
    if (changed.has('collapsed') || changed.has('overlay')) {
      // Publish the width this panel occupies on the right edge, so the
      // Picture-in-Picture box treats BOTH open sidebars as its boundary rather
      // than sliding under this one. Again after the width transition settles.
      //
      // A PEEK publishes nothing. It is a transient notice, like a tooltip, and
      // having the PiP box scoot sideways and back on every single copy is worse
      // than letting a two-second overlay pass in front of it.
      this._publishWidth();
      setTimeout(() => this._publishWidth(), 240);
    }
  }

  // ---- auto-peek ---------------------------------------------------------------
  //
  // A copy happens in a PANE, and until now it happened silently: the buffer list
  // grew (or didn't) behind a closed panel, and the one rule worth knowing — this
  // copy was KEPT alongside the last one, or REPLACED it — was invisible until you
  // went looking. So a copy shows you the list for a moment.
  //
  // Four things make it a notice rather than an interruption:
  //
  //   IT ONLY EVER APPEARS WHEN IT WASN'T THERE. If the panel is already open —
  //   because you opened it, or pinned it — a copy changes nothing about it. It
  //   is never auto-collapsed, because it was never auto-shown; closing a panel
  //   the user deliberately opened is the rudest thing this could do.
  //
  //   IT ALWAYS FLOATS. Never mounted, whatever the pref says: mounting shrinks
  //   every terminal and reflows the tmux windows underneath, which is a real
  //   disturbance to charge for a glance. The pref is restored on the way out.
  //
  //   IT NEVER TAKES THE KEYBOARD. You are typing in a pane; keep typing.
  //
  //   ANYTHING ELSE YOU DO ENDS IT EARLY. A keystroke, a click, a scroll, a
  //   touch — anywhere but in the panel — and it goes immediately, rather than
  //   sitting there for the rest of its countdown over work you have moved on to.
  peek() {
    if (!this.collapsed && !this._peeking) return;   // already on screen for real
    if (this._peeking) { this._armPeekTimer(); return; }   // a second copy re-arms it
    this._peeking = true;
    this._overlayOverride = { overlay: this.overlay };
    this.overlay = true;
    this.collapsed = false;
    this._armPeekTimer();
    this._watchOutside();
  }

  // Engagement: you reached for the panel while it was peeking, so it stops being
  // a two-second notice and becomes an open panel — countdown cancelled, and now
  // it persists as open, because from here on you did open it. The float override
  // stays until it closes: snapping back into the flow under a pointer that is
  // already moving toward a row would move the row out from under it.
  _promotePeek() {
    if (!this._peeking) return;
    this._peeking = false;
    this._clearPeekTimer();
    this._unwatchOutside();
    clientStore.patchSection('copySidebar', { collapsed: false });
    this.requestUpdate();   // drop the "a copy just landed" tag — this is a real panel now
  }

  // Close a peek. The teardown itself lives in updated()'s collapse branch, which
  // every other way of shutting the panel also goes through — so this is just
  // "shut it", and there is exactly one place that undoes what a peek borrowed.
  _endPeek() {
    if (!this._peeking) return;
    this.collapsed = true;
  }

  // Put the float/mount pref back. Also called when a PROMOTED peek is closed
  // normally, which is why it does not live inside _endPeek.
  _restoreOverlay() {
    if (!this._overlayOverride) return;
    const { overlay } = this._overlayOverride;
    this._overlayOverride = null;
    this.overlay = overlay;
  }

  _armPeekTimer() {
    this._clearPeekTimer();
    this._peekTimer = setTimeout(() => { this._peekTimer = null; this._endPeek(); }, PEEK_MS);
  }

  _clearPeekTimer() {
    if (this._peekTimer) { clearTimeout(this._peekTimer); this._peekTimer = null; }
  }

  // Capture-phase and PASSIVE: this only ever watches. A peek must not swallow
  // the keystroke or the click that dismissed it — you pressed Escape at the
  // shell, or clicked into another pane, and that has to still happen.
  _watchOutside() {
    if (this._onOutside) return;
    this._onOutside = (e) => {
      const inside = typeof e.composedPath === 'function' && e.composedPath().includes(this);
      if (inside) this._promotePeek();
      else this._endPeek();
    };
    for (const type of ['keydown', 'mousedown', 'wheel', 'touchstart']) {
      window.addEventListener(type, this._onOutside, { capture: true, passive: true });
    }
  }

  _unwatchOutside() {
    if (!this._onOutside) return;
    for (const type of ['keydown', 'mousedown', 'wheel', 'touchstart']) {
      window.removeEventListener(type, this._onOutside, { capture: true });
    }
    this._onOutside = null;
  }

  // Pointing at a peeking panel holds it open — you are reading it, and having it
  // vanish as the pointer arrives is the one way a notice this short becomes a
  // thing you have to fight. Leaving restarts the countdown.
  _peekHover(over) {
    if (!this._peeking) return;
    if (over) this._clearPeekTimer();
    else this._armPeekTimer();
  }

  firstUpdated() {
    this._publishWidth();
  }

  _publishWidth() {
    const w = (this.collapsed || this._peeking) ? 0 : Math.round(this.getBoundingClientRect().width);
    try { document.documentElement.style.setProperty('--wt-copy-sidebar-w', w + 'px'); } catch (e) {}
  }

  // ⌃⌥= and the toolbar pill. During a peek this reads as "get rid of it" — the
  // panel is on screen, so a toggle can only sensibly mean close — rather than as
  // "open the thing that is already open", which is what a naive flip would do
  // once the peek's own dismissal had shut it in the same event.
  toggleCollapsed() {
    if (this._peeking) { this._endPeek(); return; }
    this.collapsed = !this.collapsed;
  }

  toggleOverlay() {
    this.overlay = !this.overlay;
    stateStore.patchSection('copySidebar', { overlay: this.overlay });
  }

  togglePin() {
    this.pinned = !this.pinned;
    stateStore.patchSection('copySidebar', { pinned: this.pinned });
  }

  focusPanel() {
    this.updateComplete.then(() => {
      const el = this.renderRoot.querySelector('.panel');
      if (el) el.focus({ preventScroll: true });
    });
  }

  // ↑/↓ walk the buffers — and landing on a row IS the commit (it goes straight to
  // the clipboard), so there is no second key to remember before switching windows
  // and pasting. Escape closes; ⌫/Del drops the focused buffer.
  onKeyDown(e) {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      copyBuffers.step(-1);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      copyBuffers.step(1);
    } else if (e.key === 'Escape' || (e.key === 'Enter' && e.target?.tagName !== 'BUTTON')) {
      e.preventDefault();
      this.dismiss();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      copyBuffers.remove(copyBuffers.focusId);
      this.focusPanel();
    } else {
      return;
    }
    this.focusPanel();
  }

  // Close and hand the keyboard back to the terminal — unless pinned, which means
  // "this panel stays open" (same promise the windows sidebar's pin makes).
  dismiss() {
    if (this.pinned) { this.focusPanel(); return; }
    this.collapsed = true;
    try { this.manager?.focusedUnit?.terminal?.focus(); } catch (e) { /* nothing focusable */ }
  }

  selectBuffer(id) {
    copyBuffers.focus(id);
    // The panel stays open (a row click has always meant "and now keep going" in
    // the windows sidebar), so the keyboard comes back here rather than falling to
    // <body>, where ↑/↓ would go dead after the first click.
    this.focusPanel();
  }

  addBuffer() {
    copyBuffers.add();
    this.focusPanel();
  }

  // A row's ×. No confirmation: unlike killing a window this ends no process, and
  // the panel's own Clear — which destroys several at once — is the one that asks.
  removeBuffer(id) {
    copyBuffers.remove(id);
    this.focusPanel();
  }

  // Clear asks first when it would destroy something. The kept entry is the
  // focused one — the clipboard's — so the question can promise that ⌘V still
  // pastes what it pasted a moment ago.
  clearBuffers(anchor) {
    const doomed = copyBuffers.length - 1;
    if (doomed <= 0) return;
    this._confirm.ask(anchor, {
      message: `Clear ${doomed} buffer${doomed === 1 ? '' : 's'}?\nThe focused one stays, and so does the clipboard.`,
      yes: 'Clear',
      onConfirm: () => { copyBuffers.clear(); this.focusPanel(); },
    });
  }

  toggleMode() {
    this.manager?.toggleCopyMode();
  }

  render() {
    const entries = copyBuffers.entries;
    return html`
      <div
        class="panel"
        tabindex="0"
        @keydown=${this.onKeyDown}
        @mouseenter=${() => this._peekHover(true)}
        @mouseleave=${() => this._peekHover(false)}
      >
        ${this.modeRow()}
        <h3>Copy buffers${this._peeking ? html`<span class="peek-tag">a copy just landed</span>` : ''}</h3>
        <div class="buffers">
          ${entries.map((e) => this.renderBuffer(e))}
        </div>
        <div class="actions">
          <button
            class="mode-btn"
            @mouseenter=${(ev) => this._tip.enter(ev, 'Add an empty buffer and focus it.\nThe next copy lands there, so nothing you have already collected is touched.')}
            @mouseleave=${() => this._tip.leave()}
            @click=${() => { this._tip.leave(); this.addBuffer(); }}
          >+ buffer</button>
          <button
            class="mode-btn clear-btn"
            ?disabled=${copyBuffers.length < 2}
            @mouseenter=${(ev) => this._tip.enter(ev, 'Remove every buffer except the focused one.\nThe clipboard is unchanged — the entry it holds is the one that stays.')}
            @mouseleave=${() => this._tip.leave()}
            @click=${(ev) => { this._tip.leave(); this.clearBuffers(ev.currentTarget); }}
          >Clear</button>
        </div>
        ${this.note()}
      </div>
      <div class="wt-tip"></div>
      <div class="wt-confirm"></div>
    `;
  }

  modeRow() {
    return html`
      <div class="mode-row">
        <div class="shortcut-hint">Toggle panel: <kbd>${MOD_KEYS[0]}</kbd>+<kbd>${MOD_KEYS[1]}</kbd>+<kbd>=</kbd></div>
        <button
          class="mode-btn mode-toggle ${this.copyMode ? 'on' : ''}"
          @mouseenter=${(e) => this._tip.enter(e, `The focused pane is in ${this.copyMode ? 'COPY (scrollback)' : 'NORMAL (input)'} mode.\n`
            + `Click to ${this.copyMode ? 'leave' : 'enter'} copy mode — where the wheel and the arrows walk the pane’s history and a drag selects text to copy.\n`
            + `Shortcut: ${chord('[')} (tmux ⌃b [).`)}
          @mouseleave=${() => this._tip.leave()}
          @click=${() => { this._tip.leave(); this.toggleMode(); }}
        ><span class="mdot"></span>${this.copyMode ? 'COPY mode' : 'NORMAL mode'}</button>
        <div class="mode-pair">
          <button
            class="mode-btn"
            @mouseenter=${(e) => this._tip.enter(e, 'How the panel shares space with the terminal.\n'
              + `▸ ${this.overlay ? 'float' : 'mount'} — ${this.overlay
                ? 'floating OVER the terminal; the terminal keeps its full width'
                : 'MOUNTED beside the terminal, which shrinks to make room'}\n`
              + `Click for ${this.overlay ? 'mount' : 'float'}.`)}
            @mouseleave=${() => this._tip.leave()}
            @click=${this.toggleOverlay}
          >${this.overlay ? '▣ float' : '⇔ mount'}</button>
          <button
            class="mode-btn"
            @mouseenter=${(e) => this._tip.enter(e, 'What closes the panel.\n'
              + `▸ ${this.pinned ? 'pinned' : 'auto hide'} — ${this.pinned
                ? `it stays open when you click into the terminal; only ${chord('=')} or Escape close it`
                : 'it closes when you click into the terminal, or press Enter/Escape'}\n`
              + `Click to ${this.pinned ? 'let it auto hide' : 'pin it open'}.`)}
            @mouseleave=${() => this._tip.leave()}
            @click=${this.togglePin}
          >${this.pinned ? '📌 pinned' : '📌 auto hide'}</button>
        </div>
      </div>
    `;
  }

  // One buffer row. The dim second line answers the two questions a one-line
  // preview cannot: how much is actually in there, and what the next copy will do
  // to this entry — which is the one piece of this feature that is otherwise
  // invisible until it has already happened.
  renderBuffer(entry) {
    const focused = entry.id === copyBuffers.focusId;
    const empty = isEmptyEntry(entry);
    const meta = entryMeta(entry.text);
    return html`
      <div class="brow">
        <span
          class="clip ${focused ? 'on' : ''}"
          role="img"
          aria-label=${focused ? 'On the clipboard' : 'Not on the clipboard'}
          @mouseenter=${(e) => this._tip.enter(e, focused
            ? 'This buffer is on the system clipboard — it is what ⌘V/Ctrl+V pastes.'
            : 'Click this row to put this buffer on the clipboard.')}
          @mouseleave=${() => this._tip.leave()}
        ></span>
        <button
          class="buf ${focused ? 'focused' : ''}"
          data-buf=${entry.id}
          @mouseenter=${(e) => this._tip.enter(e, this._hint(entry, focused))}
          @mouseleave=${() => this._tip.leave()}
          @click=${() => { this._tip.leave(); this.selectBuffer(entry.id); }}
        >
          <span class="btext ${empty ? 'bempty' : ''}">${empty ? 'empty — the next copy lands here' : previewText(entry.text, PREVIEW_CHARS)}</span>
          <span class="bmeta">${this._metaLine(entry, focused, meta)}</span>
          <span
            class="kill"
            aria-label="Remove this buffer"
            title="Remove this buffer"
            @click=${(e) => { e.stopPropagation(); this._tip.leave(); this.removeBuffer(entry.id); }}
          >×</span>
        </button>
      </div>
    `;
  }

  // The dim line under a row's preview: size first (a fact), then what the next
  // copy does to THIS row (a consequence), and only on the focused row — the
  // append/overwrite rule is only ever about the focused buffer.
  _metaLine(entry, focused, meta) {
    const size = meta.chars
      ? (meta.whole ? '' : `${meta.lines} line${meta.lines === 1 ? '' : 's'} · ${meta.chars} chars`)
      : '';
    if (!focused) return size;
    const next = isEmptyEntry(entry) || copyBuffers.spent
      ? 'next copy replaces this'
      : 'next copy adds a buffer';
    return size ? `${size} · ${next}` : next;
  }

  _hint(entry, focused) {
    if (isEmptyEntry(entry)) {
      return 'An empty buffer.\nCopy something (⌘C / Ctrl+C, or a tmux copy) and it lands here.';
    }
    const meta = entryMeta(entry.text);
    const head = focused
      ? 'On the clipboard — ⌘V/Ctrl+V pastes this.'
      : 'Click to put this buffer on the clipboard.';
    const body = entry.text.length > HINT_CHARS
      ? entry.text.slice(0, HINT_CHARS) + '\n…'
      : entry.text;
    return `${head}\n${meta.lines} line${meta.lines === 1 ? '' : 's'} · ${meta.chars} chars\n\n${body}`;
  }

  note() {
    return html`
      <div class="note">
        The focused buffer is the clipboard. Copy again before pasting and the new
        text becomes a buffer of its own; copy after pasting and it replaces the one
        you just used — so gathering grows the list and ordinary copy-paste doesn’t.
        Copying while this panel is shut floats it here for a moment so you can see
        where the copy landed; it takes no focus, and anything else you do sends it
        away again.
        ${this.readOnly ? html`<span class="ro-note">Read-only server (started without -w) — copying still works, but
          the mode toggle and pasting into a pane do not.</span>` : ''}
      </div>
    `;
  }
}

customElements.define('webtmux-copy-sidebar', WebtmuxCopySidebar);
