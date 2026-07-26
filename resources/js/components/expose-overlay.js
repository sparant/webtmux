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
import { CaptureCache, placementKey } from '../capture-cache.js';
import { matchesWords, appendChar, backspace, phraseText } from '../search.js';
import { stateStore } from '../state-store.js';
import { workClass, workLabel, workTip } from '../stoplight.js';
import { Tip, TIP_CSS } from '../tooltip.js';

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
    // The live type-ahead filter phrase (display form, e.g. "cla 2"). Reactive so
    // the header re-renders as you type. The word list backing it is _searchWords.
    _query: { state: true },
    // Whether the type-ahead also searches each window's captured pane output
    // (not just its session + window name). Reactive so the header toggle
    // re-renders. Default off; persisted across sessions.
    _searchBuffers: { state: true },
  };

  // TIP_CSS is appended so a tile's stoplight hint matches the strip's and the
  // sidebar's — same delay, same look, for the very same dot.
  static styles = [css`
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
    /* Live type-ahead filter phrase shown at the top as you type. */
    .head .filter {
      color: #cfd8ff;
      background: #1a1a2e;
      border: 1px solid #4a9eff;
      border-radius: 4px;
      padding: 2px 8px;
    }
    .head .filter b {
      color: #eaf0ff;
      font-weight: 600;
    }
    /* Blinking caret after the filter text so it reads as an active input. */
    .head .filter .cur {
      color: #4a9eff;
      animation: wt-blink 1.1s step-end infinite;
    }
    @keyframes wt-blink { 50% { opacity: 0; } }
    .head .typehint {
      color: #5b6690;
      font-style: italic;
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
       count and row height key off the reflected density="N" attribute below. */
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
      /* A tile is a PICTURE of a window, and the whole of it is one button. Nothing
         in it is text you drag across — see the pointer-events rule below. */
      user-select: none;
      -webkit-user-select: none;
    }
    /* ONE selector, shared by mouse and keyboard. Hovering a tile MOVES the cursor
       to it (see the mouseenter handler in _buildTile); arrow keys move the same
       cursor. There is no separate :hover highlight, so the mouse and keyboard can
       never each show their own blue box — the last input to act owns the single
       selector. */
    .tile.cursor {
      border-color: #4a9eff;
      box-shadow: 0 6px 22px rgba(0, 0, 0, 0.5);
      transform: translateY(-2px) scale(1.02);
    }
    .tile.current {
      border-color: #37d17a;
    }
    /* Read-only xterm tiles carry a hidden helper textarea; suppress any browser
       focus ring so it can't paint a stray blue outline that mimics the selector. */
    .tile-screen .xterm,
    .tile-screen .xterm textarea,
    .tile-screen textarea {
      outline: none !important;
    }
    /* THE THUMBNAIL IS INERT. An xterm is a live control even when it can't be
       typed into: it grabs mousedown to focus its hidden textarea, and it runs its
       own text-selection service — so pressing on a tile started SELECTING the
       snapshot instead of pressing the tile. Two things went wrong with that. The
       highlight lands in the wrong place (the screen is CSS-scaled to letterbox
       into the frame, which xterm's hit-testing knows nothing about), and the press
       is spent on a gesture nobody asked for: only the parts of a tile the terminal
       does NOT cover behaved like the button the whole tile is meant to be.
       Selecting a window's text is what the window itself (or Save pane buffer) is
       for; a thumbnail is a picture. Making it transparent to the pointer gives the
       tile one uniform hit target and removes the phantom selection at the source
       — the xterm never sees the press at all. Same rule for the overflow tiles'
       plain-text preview, and the same reason. */
    .tile-screen,
    .tile-pre {
      pointer-events: none;
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
    /* Working stoplight, top-right of every thumbnail — the same dot, the same
       colours and the same words as the recents strip, the sidebar list and the
       preview tiles (see stoplight.js). Exposé is the one place you see EVERY
       window at once, so it is where "which of these is still going / which is
       asking me something" is worth the most. Nothing else occupies this corner
       here (unlike the preview's ×), so the dot keeps its pointer events and
       answers for itself on hover; a click still falls through to the tile because
       the tile's own click listener catches the bubbled event. */
    .tile-work {
      position: absolute;
      top: 6px; right: 6px;
      width: 9px; height: 9px;
      border-radius: 50%;
      border: 1px solid #5a6a8a;
      background: transparent;
      box-sizing: border-box;
      z-index: 2;
    }
    .tile-work.on   { background: #2ecc71; border-color: #2ecc71; box-shadow: 0 0 5px #2ecc71; }
    .tile-work.off  { background: #e74c3c; border-color: #e74c3c; }
    .tile-work.wait { background: #f5c542; border-color: #f5c542; box-shadow: 0 0 6px #f5c542; animation: wt-wait 1.4s ease-in-out infinite; }
    @keyframes wt-wait { 50% { opacity: 0.35; } }

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
  `, TIP_CSS];

  constructor() {
    super();
    this.open = false;
    // Density (2×2 / 3×3) is a shared 'expose' pref now; seed from the store (default 2).
    this.density = stateStore.section('expose').density || 2;
    this.cache = null; // shared CaptureCache — set by SplitManager
    this.manager = null; // SplitManager — set by SplitManager
    this._tiles = []; // { term? } live xterm instances, for disposal
    this._working = new Map(); // window id -> @wt_working, pushed by the SplitManager
    this._tip = new Tip(this); // shared hover hint — see tooltip.js
    this._cursor = -1; // keyboard-highlighted tile index
    // Cursor + render tracking are keyed by PLACEMENT ("session windowId"), not
    // window id, so a window linked into two sessions has a distinct, individually
    // navigable tile per session and the cursor never conflates them.
    this._cursorKey = null; // placement key under the cursor — survives refresh/rebuild
    this._renderedKeys = []; // placement keys in current tile order
    this._sort = readSort(); // 'session' | 'recent' (persisted)
    // Type-ahead filter (same word-substring algorithm as the sidebar): only
    // windows whose "session index: name" label contains every typed word stay
    // visible. _searchWords is the backing word list; _query mirrors it for
    // display. The filter PERSISTS across close/reopen — it's only cleared by
    // pressing Escape while it's non-empty (the first Escape clears, the second
    // closes). Closing any other way (Enter, tile/backdrop click, re-toggle)
    // keeps it, so reopening lands you back in the same filtered view.
    this._searchWords = [];
    this._query = '';
    // When on, the type-ahead ALSO matches the captured pane content (like tmux's
    // find-mode over a pane's visible buffer); off => only session + window name.
    this._searchBuffers = readSearchBuffers();
    // Re-apply shared expose prefs on a remote change (another client toggled sort /
    // buffer-search / density). Only rebuild the grid when we're actually open.
    stateStore.subscribe(() => {
      this._sort = readSort();
      this._searchBuffers = readSearchBuffers();
      this.density = stateStore.section('expose').density || 2;
      this.requestUpdate();
      if (this.open) this._rebuild();
    });
    this._pollTimer = null;
    // On a capture refresh, update tiles IN PLACE (keep cursor + no xterm churn)
    // when the window set is unchanged; only a membership/sort change rebuilds.
    this._onCacheUpdate = () => this._refresh();
    this._onKey = (e) => this._handleKey(e);
  }

  // Keep xterm out of Lit's control: render the static chrome only; the grid is
  // filled imperatively so a reactive re-render never orphans a tile terminal.
  render() {
    const n = this.cache ? this.cache.placementCount : 0;
    const filtering = this._searchWords.some((w) => w !== '');
    const shown = filtering ? this._visibleEntries().length : n;
    return html`
      <link rel="stylesheet" href=${XTERM_CSS} />
      <div class="backdrop" @click=${this._onBackdrop}>
        <div class="head" @click=${(e) => e.stopPropagation()}>
          <span class="title">Windows</span>
          <span>${filtering ? `${shown} of ${n}` : n} window${(filtering ? shown : n) === 1 ? '' : 's'}</span>
          ${filtering
            ? html`<span class="filter">filter: <b>${this._query}</b><span class="cur">▏</span></span>`
            : html`<span class="typehint">type to filter</span>`}
          <span><kbd>←→↑↓</kbd> move · <kbd>Enter</kbd> switch · <kbd>Esc</kbd> ${filtering ? 'clear filter' : 'close'}</span>
          <span class="spacer"></span>
          <span class="sort">
            <span class="lbl">Search</span>
            <span class="seg">
              <button
                class=${!this._searchBuffers ? 'active' : ''}
                title="Filter by session and window name only"
                @click=${() => this._setSearchBuffers(false)}
              >
                Names
              </button>
              <button
                class=${this._searchBuffers ? 'active' : ''}
                title="Also match text in each window's captured output (like tmux find)"
                @click=${() => this._setSearchBuffers(true)}
              >
                Names + output
              </button>
            </span>
          </span>
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
      <!-- The shared hover hint (position:fixed, so it can sit last here). -->
      <div class="wt-tip"></div>
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
    // Exposé is its own full-screen browser; a hover preview left over from the
    // toolbar/sidebar underneath it would keep a region hostage behind the overlay.
    this.manager?.hover?.cancel();
    // Start the cursor on the focused region's current window's OWN-session tile.
    // (Access recency is owned by SplitManager — the focused window was already
    // recorded when focused — so opening Exposé doesn't itself write recency.)
    this._cursorKey = this._focusedPlacementKey();
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
    stateStore.patchSection('expose', { density });
    this.updateComplete.then(() => {
      for (const rec of this._tiles) this._rescale(rec);
      this._paintCursor();
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.closeOverlay();
    this._tip.dispose();
  }

  // ---- tile building ----------------------------------------------------------

  // Cached entries in sort order, narrowed by the active type-ahead filter. The
  // haystack is "session index: name" so you can filter by any of them (e.g.
  // "claude" or "services 3"). No filter → every entry.
  _visibleEntries() {
    const all = this.cache ? this.cache.all(this._sort) : [];
    const terms = this._searchWords.filter((w) => w !== '');
    if (!terms.length) return all;
    const withBuffers = this._searchBuffers;
    return all.filter((e) => {
      let hay = `${e.sessionName} ${e.index}: ${e.name}`;
      // Opt-in: also fold in the captured pane content so a syllable can match
      // anything visible in the window (memoized per capture to keep per-keystroke
      // re-filtering cheap).
      if (withBuffers) hay += ' ' + entrySearchText(e);
      return matchesWords(hay, terms);
    });
  }

  // The placement key of the focused pane's current window IN its own session —
  // used to mark the "current" tile and seed the cursor. Matches the key the
  // capture cache / tiles use, so the right one of a linked window's tiles lights up.
  _focusedPlacementKey() {
    const u = this.manager?.focusedUnit;
    const id = u?.layout?.activeWindowId;
    if (!id) return null;
    const sess = this.manager?.logicalSession
      ? this.manager.logicalSession(u)
      : (u.layout?.sessionBase || u.layout?.sessionName || '');
    return placementKey(sess, id);
  }

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

    const entries = this._visibleEntries();
    if (!entries.length) {
      const div = document.createElement('div');
      div.className = 'empty';
      // Distinguish "nothing captured yet" from "filter excludes everything".
      const filtering = this._searchWords.some((w) => w !== '');
      const anyCached = this.cache && this.cache.placementCount > 0;
      div.textContent = filtering && anyCached
        ? `No windows match “${this._query}”`
        : 'Capturing windows…';
      grid.appendChild(div);
      this._renderedKeys = [];
      return;
    }

    const currentKey = this._focusedPlacementKey();
    entries.forEach((entry, i) => {
      const rec = this._buildTile(entry, i < N_MAX_TILES);
      if (rec.key === currentKey) rec.tileEl.classList.add('current');
      grid.appendChild(rec.tileEl);
      this._tiles.push(rec);
    });
    this._renderedKeys = entries.map((e) => placementKey(e.sessionName, e.windowId));

    // Keep the highlight on the same placement across a rebuild; fall back to the
    // current window's tile, then the first tile.
    let idx = this._cursorKey ? this._renderedKeys.indexOf(this._cursorKey) : -1;
    if (idx < 0) idx = this._renderedKeys.indexOf(currentKey);
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
    const entries = this._visibleEntries();
    const keys = entries.map((e) => placementKey(e.sessionName, e.windowId));
    const unchanged =
      keys.length === this._renderedKeys.length && keys.every((k, i) => k === this._renderedKeys[i]);
    if (!unchanged) {
      this._rebuild();
      return;
    }

    const currentKey = this._focusedPlacementKey();
    const byKey = new Map(this._tiles.map((r) => [r.key, r]));
    for (const entry of entries) {
      const rec = byKey.get(placementKey(entry.sessionName, entry.windowId));
      if (!rec) continue;
      this._updateTileContent(rec, entry);
      rec.tileEl.classList.toggle('current', rec.key === currentKey);
    }
    // Cursor deliberately untouched — navigation state survives the refresh.
  }

  _buildTile(entry, live) {
    const key = placementKey(entry.sessionName, entry.windowId);
    const tile = document.createElement('div');
    tile.className = 'tile';
    tile.dataset.window = entry.windowId;
    tile.dataset.session = entry.sessionName;
    tile.dataset.key = key;

    const frame = document.createElement('div');
    frame.className = 'tile-frame';
    tile.appendChild(frame);

    // Built here, before the first capture lands, so the corner never pops in late.
    const work = document.createElement('span');
    work.className = 'tile-work';
    work.setAttribute('role', 'img');
    // The shared hint rather than a native `title`: this is the same dot the strip
    // and the sidebar show, and it must not answer more slowly here. _paintWork
    // keeps `_tipText` current, and the handlers read it at hover time so a state
    // change while the hint is up doesn't leave stale words on screen.
    work.addEventListener('mouseenter', (e) => this._tip.enter(e, work._tipText || ''));
    work.addEventListener('mouseleave', () => this._tip.leave());
    frame.appendChild(work);

    const rec = {
      windowId: entry.windowId,
      session: entry.sessionName,
      key,
      tileEl: tile,
      frame,
      screen: null,
      term: null,
      pre: null,
      work,
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

    tile.addEventListener('click', () => this._selectWindow(entry.windowId, entry.sessionName));
    // Mouse and keyboard drive the SAME selector: entering a tile with the pointer
    // moves the cursor onto it, exactly as an arrow key would. mouseenter (not
    // mousemove) fires only when the pointer crosses INTO a tile, so a resting mouse
    // never fights the keyboard — arrow-navigating away from a hovered tile sticks.
    tile.addEventListener('mouseenter', () => this._cursorToTile(tile));
    this._paintWork(rec);
    return rec;
  }

  // ---- working stoplight -------------------------------------------------------

  // Per-window @wt_working, pushed from the SplitManager on every layout refresh —
  // the same map the recents dots and the preview tiles read, so one window's light
  // says the same thing on every surface. Arrives whether or not the overlay is
  // open; a closed overlay has no tiles to paint, and _buildTile paints from the
  // stored map on the way up, so opening it is never a beat behind.
  setWorking(map) {
    if (!map) return;
    let changed = map.size !== this._working.size;
    if (!changed) { for (const [k, v] of map) if (this._working.get(k) !== v) { changed = true; break; } }
    if (!changed) return;                       // this runs on the 500ms poll
    this._working = new Map(map);
    for (const rec of this._tiles) this._paintWork(rec);
  }

  _paintWork(rec) {
    const dot = rec?.work;
    if (!dot) return;
    const v = this._working.get(rec.windowId) || '';
    const cls = workClass(v);
    dot.classList.toggle('on', cls === 'on');
    dot.classList.toggle('off', cls === 'off');
    dot.classList.toggle('wait', cls === 'wait');
    dot._tipText = workTip(v);
    dot.setAttribute('aria-label', workLabel(v));
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
    stateStore.patchSection('expose', { sort: mode });
    this._rebuild(); // reorder tiles; cursor stays on the same window
  }

  // Toggle whether the type-ahead also searches captured pane output. Persisted so
  // the choice survives close/reopen; re-filters immediately when a filter is live.
  _setSearchBuffers(on) {
    if (this._searchBuffers === on) return;
    this._searchBuffers = on; // reactive -> header re-renders the active button
    stateStore.patchSection('expose', { searchBuffers: on });
    if (this.open) this._rebuild(); // re-narrow the grid under the new search scope
  }

  // ---- interaction ------------------------------------------------------------

  _selectWindow(windowId, session = '') {
    // Same navigation path as the toolbar recent-strip: jump to the region that
    // already shows it, or switch the focused region's session if the window lives
    // elsewhere, else select it here (optimistic paint happens in selectWindow). The
    // session comes from the clicked PLACEMENT, so a linked window's two tiles each
    // navigate to their own session's view.
    this.manager?.goToWindow(windowId, session);
    this.closeOverlay();
  }

  _tileEls() {
    return [...(this.renderRoot?.querySelectorAll('.tile') || [])];
  }

  _paintCursor() {
    const tiles = this._tileEls();
    tiles.forEach((t, i) => t.classList.toggle('cursor', i === this._cursor));
    const cur = tiles[this._cursor];
    // Remember WHICH placement is highlighted so the cursor survives a rebuild.
    this._cursorKey = cur ? cur.dataset.key : null;
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  }

  _handleKey(e) {
    if (!this.open) return;
    const tiles = this._tileEls();
    if (e.key === 'Escape') {
      // First Escape clears an active filter; a second (empty filter) closes the
      // overlay. So typing-then-Escape backs out of the filter without closing.
      if (this._searchWords.some((w) => w !== '')) this._setSearch([]);
      else this.closeOverlay();
    } else if (e.key === 'Enter') {
      const t = tiles[this._cursor];
      if (t) this._selectWindow(t.dataset.window, t.dataset.session);
    } else if (e.key === 'ArrowRight') {
      this._moveCursor(1, tiles);
    } else if (e.key === 'ArrowLeft') {
      this._moveCursor(-1, tiles);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      this._moveCursor(e.key === 'ArrowDown' ? colsPerRow(tiles) : -colsPerRow(tiles), tiles);
    } else if (e.key === 'Backspace') {
      this._setSearch(backspace(this._searchWords));
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // Type-ahead filter: printable char grows the phrase (space = new word),
      // using the SAME word-substring algorithm as the sidebar.
      this._setSearch(appendChar(this._searchWords, e.key));
    } else {
      return; // not ours
    }
    e.preventDefault();
    e.stopPropagation();
  }

  // Apply a new filter word list: mirror it into the reactive _query (re-renders the
  // header) and rebuild the (imperative) tile grid so membership matches. The cursor
  // is restored to the same placement inside _rebuild, or the first visible tile.
  _setSearch(words) {
    this._searchWords = words;
    this._query = phraseText(words);
    if (this.open) this._rebuild();
  }

  _moveCursor(delta, tiles) {
    if (!tiles.length) return;
    if (this._cursor < 0) this._cursor = 0;
    else this._cursor = Math.max(0, Math.min(tiles.length - 1, this._cursor + delta));
    this._paintCursor();
  }

  // Move the shared selector onto a tile the mouse just entered. Index is looked up
  // live from the DOM so it stays correct across rebuilds/refreshes; a no-op if the
  // cursor is already there (avoids needless repaints on re-entry).
  _cursorToTile(tile) {
    const i = this._tileEls().indexOf(tile);
    if (i < 0 || i === this._cursor) return;
    this._cursor = i;
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
  return stateStore.section('expose').sort === 'recent' ? 'recent' : 'session';
}

function readSearchBuffers() {
  return stateStore.section('expose').searchBuffers === true;
}

// Decoded + SGR-stripped pane text for content search, memoized on the entry and
// keyed by capture time so re-filtering on each keystroke never re-decodes a
// buffer that hasn't changed.
function entrySearchText(e) {
  if (e.__searchText !== undefined && e.__searchTextAt === e.capturedAt) return e.__searchText;
  const text = stripSgr(decodeUtf8(e.data)).toLowerCase();
  e.__searchText = text;
  e.__searchTextAt = e.capturedAt;
  return text;
}

function stripSgr(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

customElements.define('webtmux-expose', WebtmuxExpose);
