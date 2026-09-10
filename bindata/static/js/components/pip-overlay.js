// <webtmux-pip> — the live "Preview": a set of read-only, always-fresh previews of
// tmux windows, fed from the shared CaptureCache (the same per-window capture
// buffers Exposé uses) and polled so they stay live. Clicking a preview switches
// the FOCUSED region to that window.
//
// A previewed window is drawn on ONE of two kinds of surface, and which one is the
// window's own property — its SLOT (see preview-slots.js) — not a function of how many
// windows are being previewed:
//
//   • the docked PREVIEW BAR, spanning a screen edge (top/bottom/left/right). The
//     default, and where Ctrl+Alt+I puts a window. Unlike a floating box the bar does
//     NOT cover the terminal — it RESERVES space (via the --wt-preview-* vars that pad
//     #app), so it sits at the terminal's own level. Holds any number of tiles.
//   • a corner PICTURE-IN-PICTURE box, pinned to one of the four screen corners and
//     floating OVER the terminal (z-index 50). Each corner holds at most one window, so
//     up to four windows can be pipped at once — and one window can be pipped while
//     others sit in the bar.
//
// The two used to be one derived shape: one previewed window WAS a corner box, two or
// more WERE a bar, and neither was askable for. So a single window could not be a bar
// tile, adding a second silently dissolved your corner box, and the other three corners
// were unreachable. Now every tile carries the same hover control cluster — the four
// corner buttons (only the ones that are actually free), a "back to the bar" button when
// it is pinned, and a close — so moving a window between the two surfaces is one click
// from wherever it currently is.
//
// A SEPARATE hide/show toggle blanks the whole preview without forgetting the set, so
// you can tuck it away and bring it back with the same windows in the same places. Owned
// by the SplitManager (one instance); the toolbar drives add/remove/hide.
//
// Chrome (bar frame, corner boxes, bar controls) is Lit-rendered; each window's tile —
// xterm, label, stoplight and control cluster — lives in a static `.tiles` container
// reconciled imperatively in _syncTiles(), so a reactive re-render (a bar re-dock, a
// label update) never orphans a terminal.
import { LitElement, html, css } from 'lit';
import { Terminal } from '@xterm/xterm';
import { CaptureCache, placementKey } from '../capture-cache.js';
import { chord } from '../os.js';
import { stateStore } from '../state-store.js';
import { workClass, workLabel, workTip } from '../stoplight.js';
import { ALERT_CSS, alertClass, alertTip } from '../alert-flash.js';
import { alertOf } from '../work-alerts.js';
import { Tip, TIP_CSS } from '../tooltip.js';
import {
  BAR, CORNERS, EDGES, CORNER_GLYPH, CORNER_NAME, EDGE_GLYPH, EDGE_NAME,
  PREVIEW_DRAG_TYPE, normalizeSlot, cornerOccupancy, freeCorner, placeWindow,
  tileControls, winsFromState, barWins, dropInBar, previewDragPayload, parsePreviewDrag,
  carriesPreviewDrag,
} from '../preview-slots.js';
import {
  terminalContentBox, cropBox, fitTransform, CropTracker, sameBox,
} from '../content-bounds.js';

const XTERM_CSS = 'https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css';
const FRAME_TIP = 'Click to switch the focused view to this window';
const BAR_THICK = 200;     // px: bar height (top/bottom) or width (left/right)
const POLL_MS = 1500;      // keep previews live (server coalesces to 500ms)
const STALE_MS = 5000;     // no fresh capture for this long => the window is gone

class WebtmuxPip extends LitElement {
  static properties = {
    // Reflected so the host CSS (and a debugging eye) can tell a live preview from an
    // empty or tucked-away one: 'on' | 'off'. It no longer names a SHAPE — the shape is
    // per-window now, and both shapes can be on screen at the same time.
    mode: { type: String, reflect: true },
    // Which edge the docked bar is on (reflected for the harness / debugging).
    edge: { type: String, reflect: true },
    _wins: { state: true },     // [{windowId, session, label, index, name, slot}]
    _hidden: { state: true },   // true = tucked away (set kept, nothing drawn)
    _stale: { state: true },    // Set<windowId> of windows whose captures stopped
    _focusedWinId: { state: true }, // window id the FOCUSED terminal is showing (self-preview hint)
    // Live drag-to-place state: the tile being dragged, and the insertion GAP in the
    // bar the drop would land in (-1 = not over the bar). Reactive because the SURFACES
    // are Lit-rendered and light up as targets for the length of the drag; the tiles
    // themselves are imperative, so their dragging/insertion classes are painted in
    // _paintDrag(), which a re-render runs anyway.
    _dragId: { state: true },
    _dropIndex: { state: true },
  };

  static styles = [css`
    /* The host draws nothing itself: it holds the docked bar and up to four corner
       boxes, each of which positions ITSELF against the viewport. display:contents keeps
       the host out of the way entirely rather than making it a fixed full-screen layer —
       a layer would be one stacking context, and the bar (below the sidebars) and the
       corner boxes (above the terminal) deliberately sit at different depths. */
    :host { display: contents; }

    /* ---- the docked BAR: a strip at terminal z-level (space is reserved by #app
       padding via the --wt-preview-* vars, so it never floats over content) --- */
    .bar { display: none; }
    .bar.on {
      display: flex;
      position: fixed;
      z-index: 30;
      background: #0e1220;
      border: 1px solid #0f3460;
      box-sizing: border-box;
      font-family: Menlo, Monaco, "Courier New", monospace;
    }
    .bar[edge='top'] {
      top: var(--wt-toolbar-h, 44px); left: 0; right: 0; height: 200px;
      border-width: 0 0 1px 0; flex-direction: row;
    }
    .bar[edge='bottom'] {
      bottom: 0; left: 0; right: 0; height: 200px;
      border-width: 1px 0 0 0; flex-direction: row;
    }
    .bar[edge='left'] {
      left: 0; top: var(--wt-toolbar-h, 44px); bottom: 0; width: 200px;
      border-width: 0 1px 0 0; flex-direction: column;
    }
    .bar[edge='right'] {
      right: 0; top: var(--wt-toolbar-h, 44px); bottom: 0; width: 200px;
      border-width: 0 0 0 1px; flex-direction: column;
    }

    /* ---- a corner PiP box: one per corner, floating over the terminal ------- */
    .pipbox { display: none; }
    .pipbox.on {
      display: block;
      position: fixed;
      z-index: 50;
      width: 360px;
      background: #12131f;
      border: 1px solid #0f3460;
      border-radius: 8px;
      box-shadow: 0 10px 34px rgba(0, 0, 0, 0.6);
      overflow: hidden;
      font-family: Menlo, Monaco, "Courier New", monospace;
      /* The box no longer balloons on hover: hovering it previews the window in a real
         terminal region, which is bigger and doesn't cover what the box was over. The
         transition stays for the mini↔normal change below. */
      transition: width 0.2s ease;
    }
    /* Corner offsets clear everything that has already spoken for that edge: the
       toolbar, the two right-edge panels (windows sidebar + copy buffers, each
       publishing the width it occupies, 0 when closed) and — new, now that both can be
       on screen at once — the space the docked BAR reserved. A PiP box that floats over
       the bar would be covering the one surface that was built not to cover anything. */
    .pipbox[corner='tl'] {
      top: calc(var(--wt-toolbar-h, 44px) + var(--wt-preview-top, 0px) + 12px);
      left: calc(var(--wt-preview-left, 0px) + 16px);
    }
    .pipbox[corner='tr'] {
      top: calc(var(--wt-toolbar-h, 44px) + var(--wt-preview-top, 0px) + 12px);
      right: calc(var(--wt-sidebar-w, 0px) + var(--wt-copy-sidebar-w, 0px) + var(--wt-preview-right, 0px) + 16px);
    }
    .pipbox[corner='bl'] {
      bottom: calc(var(--wt-preview-bottom, 0px) + 16px);
      left: calc(var(--wt-preview-left, 0px) + 16px);
    }
    .pipbox[corner='br'] {
      bottom: calc(var(--wt-preview-bottom, 0px) + 16px);
      right: calc(var(--wt-sidebar-w, 0px) + var(--wt-copy-sidebar-w, 0px) + var(--wt-preview-right, 0px) + 16px);
    }

    /* Self-preview HINT: a corner box holding the very window the FOCUSED pane is
       already showing is a live copy of what is right in front of you. We don't blank it
       (that made pinning the current window feel like a no-op — nothing appeared);
       instead it shrinks to 1/4 of the normal box (width 360→90, frame 216→54 below) so
       the gesture visibly does something, and pops back to full size on a hover-and-pause
       when you want to read it. Only corner boxes do this; a bar tile reserves its own
       space and covers nothing, so there is nothing to get out of the way. */
    .pipbox.mini { width: 90px; }
    .pipbox.mini:hover { width: 360px; transition-delay: 0.35s; }

    /* The tiles container: a row for top/bottom bars, a column for left/right, and the
       whole box inside a corner PiP. Scrolls when the bar's previews overflow. */
    .tiles {
      flex: 1 1 auto;
      min-width: 0;
      min-height: 0;
      display: flex;
      gap: 8px;
    }
    .pipbox .tiles { padding: 0; gap: 0; height: 100%; }
    .bar[edge='top'] .tiles,
    .bar[edge='bottom'] .tiles { flex-direction: row; overflow-x: auto; overflow-y: hidden; padding: 8px; }
    .bar[edge='left'] .tiles,
    .bar[edge='right'] .tiles { flex-direction: column; overflow-y: auto; overflow-x: hidden; padding: 8px; }

    /* A single preview tile: a scaled screen + a label strip. THE SAME ELEMENT in the
       bar and in a corner box — only its size and border come from the surface it is in.
       Hovering one previews the window in a real terminal region (see hover-preview.js) —
       bigger, in place, and the same gesture everywhere else in the UI. */
    .ptile {
      position: relative;
      display: flex;
      flex-direction: column;
      background: #12131f;
      border: 1px solid #0f3460;
      border-radius: 6px;
      overflow: hidden;
      box-sizing: border-box;
      /* A preview is a picture of a window and the frame is one button; nothing in
         it is text you drag across (see .screen-host below). */
      user-select: none;
      -webkit-user-select: none;
    }
    /* In a corner box the one tile fills the box (no border/radius of its own). */
    .pipbox .ptile {
      flex: 1 1 auto;
      border: none;
      border-radius: 0;
    }
    /* Bar tile sizing: fixed-ish along the scroll axis, full across it. */
    .bar[edge='top'] .ptile,
    .bar[edge='bottom'] .ptile { flex: 0 0 300px; height: 100%; }
    .bar[edge='left'] .ptile,
    .bar[edge='right'] .ptile { flex: 0 0 auto; height: 150px; width: 100%; }
    .ptile.current { border-color: #37d17a; }
    .pipbox .ptile.current { border: none; }

    /* ---- drag to place ------------------------------------------------------
       A tile is picked up and put where you want it. THE BAR IS THE DROP TARGET,
       and the only one: within it a drag is a reorder, and from a corner box into it
       a drag is "dock this, HERE". The corners stay button-only — an empty corner
       draws nothing (a .pipbox with no window is display:none), so three of the four
       could not be aimed at with a pointer even if the drop were wired, and a gesture
       that works on the corner that happens to be occupied is worse than one that
       plainly belongs to the bar.

       The pointer says "you can pick this up" only on the frame — the label already
       answers a hover with its own tooltip, and .plabel is the one part of a tile
       that is text. */
    .ptile[draggable] .pframe { cursor: grab; }
    .ptile.dragging { opacity: 0.4; }
    .ptile.dragging .pframe { cursor: grabbing; }

    /* The insertion line for a bar drop, drawn in the gap before this tile (or after
       the last one). INSIDE the tile's edge, not in the 8px gap beside it: .ptile
       clips its overflow, so a line at a negative offset would not be drawn at all. */
    .ptile.drop-before::before,
    .ptile.drop-end::after {
      content: '';
      position: absolute;
      z-index: 4;
      background: #6ba8ff;
      box-shadow: 0 0 7px rgba(107, 168, 255, 0.95);
      pointer-events: none;
    }
    /* A row bar cuts vertically between tiles; a column bar cuts horizontally. */
    .bar[edge='top'] .ptile.drop-before::before,
    .bar[edge='bottom'] .ptile.drop-before::before { top: 0; bottom: 0; left: 0; width: 3px; }
    .bar[edge='top'] .ptile.drop-end::after,
    .bar[edge='bottom'] .ptile.drop-end::after { top: 0; bottom: 0; right: 0; width: 3px; }
    .bar[edge='left'] .ptile.drop-before::before,
    .bar[edge='right'] .ptile.drop-before::before { left: 0; right: 0; top: 0; height: 3px; }
    .bar[edge='left'] .ptile.drop-end::after,
    .bar[edge='right'] .ptile.drop-end::after { left: 0; right: 0; bottom: 0; height: 3px; }

    /* The bar says it is the target for the length of the drag — which is the whole
       instruction for a corner box being dragged, since until the pointer is over the
       bar there is no insertion line to read. */
    .bar.dragging { border-color: #4a7fd0; }

    .pframe {
      position: relative;
      flex: 1 1 auto;
      min-height: 0;
      background: #1a1a2e;
      overflow: hidden;
      cursor: pointer;                 /* the whole preview is click-to-activate */
      border-bottom: 1px solid #0f3460;
    }
    /* A corner box keeps the classic fixed-height frame. */
    .pipbox .pframe { height: 216px; flex: none; transition: height 0.2s ease; }
    /* Mini self-preview frame: 1/4 height at rest, back to the normal 216 on hover.
       This grow SURVIVES the hover-preview change above, because the mini box holds the
       window the focused region is already showing — so hovering it previews nothing
       (there'd be nothing new to see), and popping it back is the only way to read it. */
    .pipbox.mini .pframe { height: 54px; }
    .pipbox.mini:hover .pframe { height: 216px; transition-delay: 0.35s; }
    /* THE PREVIEW IS INERT — the same rule the Exposé tiles follow, for the same
       reason (see .tile-screen there). The xterm inside a preview is read-only but
       still a live control: it takes mousedown to focus its hidden textarea and
       runs its own selection service, so pressing a preview started selecting the
       snapshot — with the highlight in the wrong place, because the screen is
       CSS-scaled and xterm's hit-testing knows nothing about that — instead of
       pressing the tile. Transparent to the pointer, the whole frame is the single
       click-to-activate target it is documented to be, and the controls / stoplight
       that sit on top of it are unaffected (they are siblings, not children). */
    .screen-host { position: absolute; inset: 0; pointer-events: none; }
    .screen { position: absolute; top: 0; left: 0; transform-origin: top left; }

    /* Dim + tag a preview once its window stops producing captures (closed). */
    .pframe.stale { filter: grayscale(0.8) brightness(0.55); }
    .stale-tag {
      position: absolute; inset: 0;
      display: flex; align-items: center; justify-content: center;
      color: #ffb4b4; font-size: 13px; letter-spacing: 0.04em;
      text-shadow: 0 1px 4px #000; pointer-events: none;
    }

    .plabel {
      flex: 0 0 auto;
      display: flex; align-items: baseline; justify-content: space-between; gap: 8px;
      padding: 5px 9px; font-size: 12px; color: #d6ddf5; white-space: nowrap;
    }
    .plabel .name { overflow: hidden; text-overflow: ellipsis; }
    .plabel .sess { flex: 0 0 auto; color: #7f8bb5; letter-spacing: 0.06em; font-size: 11px; }

    /* Working stoplight, top-right of every preview surface (bar tile and corner
       box alike). A preview exists so you can watch a window you're NOT looking at,
       so its "is it busy / is it waiting for me" state belongs on it — that's most
       of why the window is in the preview at all. Same colours, and the same words,
       as every other stoplight (see stoplight.js): green working, amber prompting
       (pulsing), red waiting for work to do, unfilled not reporting. Sits under the
       hover controls (z-index 3) and passes the pointer through so it never blocks
       the buttons it shares this corner with — which is why the colour key lives on
       the frame's tooltip, not the dot's (see _paintWork). */
    .pwork {
      position: absolute;
      top: 7px; right: 7px;
      width: 9px; height: 9px;
      border-radius: 50%;
      border: 1px solid #5a6a8a;
      background: transparent;
      box-sizing: border-box;
      z-index: 2;
      pointer-events: none;
    }
    .pwork.on   { background: #2ecc71; border-color: #2ecc71; box-shadow: 0 0 5px #2ecc71; }
    .pwork.off  { background: #e74c3c; border-color: #e74c3c; }
    /* Waiting on background work it started: green hue (it does not need you) with an
       open centre (it is at a prompt, so you can talk to it). */
    .pwork.bg   { background: transparent; border-color: #2ecc71; border-width: 2px; box-shadow: 0 0 5px rgba(46, 204, 113, 0.75); }
    .pwork.wait { background: #f5c542; border-color: #f5c542; box-shadow: 0 0 6px #f5c542; animation: wt-wait 1.4s ease-in-out infinite; }
    @keyframes wt-wait { 50% { opacity: 0.35; } }

    /* ---- the tile's hover CONTROLS — one cluster, both surfaces --------------
       Where a previewed window is drawn is a property of the window, so the controls
       that move it are a property of the TILE, and a bar tile and a corner box get the
       same ones from the same builder (_paintControls):
         • four corner buttons, laid out at the tile's own corners so the button's
           position IS the placement it names. Only free corners are drawn — a corner
           another window already holds is not a placement, so it is not offered — plus
           this tile's own corner, marked active.
         • "▤" back to the docked bar, shown only when the tile is pinned to a corner.
         • "✕" take this window out of the preview altogether.
       They differ in exactly one thing: buttons are smaller in the bar, whose tiles are
       smaller. */
    .tctl { position: absolute; inset: 0; pointer-events: none; z-index: 3; }
    .tbtn {
      position: absolute;
      display: flex; align-items: center; justify-content: center;
      border-radius: 6px;
      border: 2px solid rgba(160, 190, 245, 0.85);
      background: rgba(9, 13, 28, 0.9);
      color: #e2e9fb; cursor: pointer; line-height: 1; padding: 0;
      opacity: 0; pointer-events: none;
      transition: opacity 0.12s, transform 0.1s, border-color 0.12s, background 0.12s;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.55);
    }
    .ptile:hover .tbtn { opacity: 1; pointer-events: auto; }
    /* A mini box is 90px wide until the hover-and-pause pops it back to 360; drawing the
       cluster into those 90px would stack every button on top of every other one for a
       third of a second. Hold them until the box has finished growing (the same 0.35s
       delay, plus the 0.2s the width takes). Scoped to :hover so they still vanish the
       instant the pointer leaves. */
    .pipbox.mini .ptile:hover .tbtn { transition-delay: 0.55s; }
    .tbtn.corner { width: 32px; height: 32px; font-size: 18px; }
    .bar .tbtn.corner { width: 26px; height: 26px; font-size: 15px; }
    .tbtn.tl { top: 8px; left: 8px; }
    .tbtn.tr { top: 8px; right: 8px; }
    .tbtn.bl { bottom: 8px; left: 8px; }
    .tbtn.br { bottom: 8px; right: 8px; }
    .tbtn.corner:hover { transform: scale(1.15); border-color: #7cc0ff; background: rgba(20, 28, 54, 0.95); color: #fff; }
    .tbtn.corner.active { border-color: #37d17a; color: #37d17a; }
    .tbtn.corner.active:hover { border-color: #5be39a; color: #fff; }
    /* Close (top centre) and back-to-the-bar (bottom centre): the two controls that are
       not about a corner get the two edges no corner button claims. */
    .tbtn.close, .tbtn.tobar {
      left: 50%; transform: translateX(-50%);
      width: 34px; height: 26px; font-size: 14px;
    }
    .tbtn.close { top: 8px; border-color: rgba(233, 69, 96, 0.7); }
    .tbtn.tobar { bottom: 8px; }
    .tbtn.close:hover { transform: translateX(-50%) scale(1.12); border-color: #e94560; background: #e94560; color: #fff; }
    .tbtn.tobar:hover { transform: translateX(-50%) scale(1.12); border-color: #7cc0ff; background: rgba(20, 28, 54, 0.95); color: #fff; }

    /* ---- bar chrome: a compact always-visible control cluster ---------------- */
    .barctl {
      flex: 0 0 auto;
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 6px;
      background: #0b0f1c;
    }
    .bar[edge='left'] .barctl,
    .bar[edge='right'] .barctl { flex-direction: row; flex-wrap: wrap; justify-content: center; }
    .barctl .grp { display: flex; gap: 4px; }
    .bar[edge='top'] .barctl,
    .bar[edge='bottom'] .barctl { flex-direction: column; justify-content: center; }
    .bbtn {
      width: 28px; height: 28px;
      display: flex; align-items: center; justify-content: center;
      border-radius: 6px;
      border: 1px solid #0f3460;
      background: #1a1a2e; color: #ccc;
      cursor: pointer; font-size: 15px; line-height: 1; padding: 0;
    }
    .bbtn:hover { border-color: #4a9eff; color: #fff; }
    .bbtn.active { border-color: #37d17a; color: #37d17a; }
    .bbtn.hide { border-color: rgba(233, 69, 96, 0.5); color: #f3a7b4; }
    .bbtn.hide:hover { background: #e94560; color: #fff; border-color: #e94560; }

    /* ATTENTION FLASH on a thumbnail: the RING variant from alert-flash.js, drawn
       inset on the tile. A thumbnail is there to be read, so it is the one surface
       that must not fill with the alert colour — that would hide the very screen the
       flash is telling you to go and look at. Inset so the tile's own overflow can't
       clip it and its size never changes mid-pulse. */
  `, ALERT_CSS, TIP_CSS];

  constructor() {
    super();
    this.mode = 'off';
    // The bar's EDGE is a shared 'pip' pref → StateStore, as is `corner` — which is no
    // longer where "the" box lives (each pipped window names its own corner) but which
    // corner a NEW pip prefers, and how a pre-slot blob is read back. The window SET +
    // hidden flag are persisted too (for reload restore) but applied once via
    // restoreState(), not from this subscription — so re-adding restored windows can't
    // loop back through the store.
    const pip = stateStore.section('pip');
    this.edge = EDGES.includes(pip.previewEdge) ? pip.previewEdge : 'bottom';
    this._preferCorner = CORNERS.includes(pip.corner) ? pip.corner : 'tr';
    stateStore.subscribe(() => {
      const p = stateStore.section('pip');
      if (EDGES.includes(p.previewEdge)) this.edge = p.previewEdge;
      if (CORNERS.includes(p.corner)) this._preferCorner = p.corner;
      this.requestUpdate();
    });
    this.cache = null;      // shared CaptureCache — set by SplitManager
    this.manager = null;    // SplitManager — set by SplitManager
    this.onChange = null;   // fired whenever the set / hidden state changes (toolbar sync)
    this._wins = [];        // [{windowId, session, label, index, name, slot}]
    this._hidden = false;
    this._on = false;          // derived in willUpdate: is anything actually drawn?
    this._restoring = false;   // applying a persisted set — writes are suppressed
    // Has the USER changed the preview on this client? Until they have, the shared
    // blob is allowed to re-apply itself over what we restored from the cache.
    this._userTouched = false;
    this._stale = new Set();
    this._focusedWinId = null; // set by SplitManager: the window the focused pane shows
    this._dragId = '';         // window id of the tile being dragged (see _onTileDragStart)
    this._dropIndex = -1;      // insertion gap in the bar under the pointer, -1 = none
    this._terms = new Map(); // windowId -> {term, screen, cols, rows}
    this._pollTimer = null;
    // Per-window @wt_working, pushed by the SplitManager (the same map the recents
    // strip reads) so each tile can show its stoplight.
    this._working = new Map();
    // Per-window attention flash, from the same shared registry the recents strip and
    // the sidebar read (a WorkAlerts.snapshot()). A tile in the preview is often the
    // ONLY place a window is visible at all, so a window that stops while it is sitting
    // in the bar has to say so on the tile itself — otherwise the preview is the one
    // surface showing you the window and staying silent about it.
    this._alerts = null;
    // Repaint only the tiles whose captures actually arrived.
    this._onCacheUpdate = (e) => {
      const caps = (e && e.detail && e.detail.captures) || [];
      for (const c of caps) {
        if (this._has(c.windowId)) this._paint(c.windowId);
      }
    };
    // The hover-to-enlarge CSS resizes a corner box; re-letterbox the xterm inside it
    // when that transition settles. Transitions on the boxes bubble to the host.
    this.addEventListener('transitionend', () => this._rescaleAll());
    this._tip = new Tip(this);  // shared hover hint — see tooltip.js
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._tip.dispose();
    this._teardownAll();
    this.manager?.hover?.cancel();
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
    this.cache?.removeEventListener('update', this._onCacheUpdate);
    this.mode = 'off';    // so _applySpace releases any reserved edge padding
    this._on = false;
    this._applySpace();
  }

  // ---- public API (driven by SplitManager) -----------------------------------

  get count() { return this._wins.length; }
  get hidden() { return this._hidden; }
  hasWindow(id) { return this._has(id); }
  // Where a previewed window is drawn: 'bar', a corner, or null when it isn't previewed.
  slotOf(id) { return this._wins.find((w) => w.windowId === id)?.slot || null; }
  // The windows the preview is currently SHOWING. The SplitManager treats these as
  // covered when deciding what the strip's overflow arrow still has to announce — a
  // tile flashing in the bar (or in a corner box) has already done the arrow's job for
  // that window.
  //
  // Empty while the preview is tucked away: a hidden tile flashes at nobody, and
  // counting it would let the arrow go quiet about a window that has no visible
  // surface anywhere — the exact failure the arrow exists to prevent.
  windowIds() { return this._hidden ? [] : this._wins.map((w) => w.windowId); }
  _has(id) { return this._wins.some((w) => w.windowId === id); }

  // The window the FOCUSED terminal is currently showing. A corner box holding exactly
  // this window shrinks to a hint rather than floating a live copy of what you are
  // already looking at (see the .pipbox.mini rules). Reactive state, so a change
  // re-derives which box is mini; a no-op when unchanged.
  setFocusedWindow(id) {
    const v = id || null;
    if (this._focusedWinId === v) return;
    this._focusedWinId = v;
  }

  // Add a window to the preview (no-op if already present). meta = {index,name,session}.
  // Lands in the docked bar unless a slot is named — the bar is the placement that
  // covers nothing and has no capacity limit, so it is what a keystroke should mean.
  addWindow(id, meta = {}, slot = BAR) {
    if (!id || this._has(id)) return;
    this._wins = placeWindow([...this._wins, this._entry(id, meta, slot)], id, slot);
    this._hidden = false;              // adding always reveals
    this._ensurePolling();
    this.cache?.request([id], true);   // prime a capture immediately
    this._changed();
  }

  // Remove a window from the preview.
  removeWindow(id) {
    if (!this._has(id)) return;
    this._wins = this._wins.filter((w) => w.windowId !== id);
    this._teardownTerm(id);
    this._stale.delete(id);
    this._changed();
  }

  // Add if absent, remove if present — the toolbar button / Ctrl+Alt+I behavior.
  toggleWindow(id, meta = {}, slot = BAR) {
    if (this._has(id)) this.removeWindow(id);
    else this.addWindow(id, meta, slot);
  }

  // Pin a window to a corner (Ctrl+Alt+Shift+I and the tiles' corner buttons), or send
  // it back to the bar if it is already pinned — one key that walks a window between the
  // two surfaces. A window that isn't previewed at all joins at a free corner, falling
  // back to the bar when all four are taken: the corners are a fixed resource, and
  // silently doing nothing is a worse answer than the placement that always works.
  togglePip(id, meta = {}) {
    if (!id) return;
    const slot = this.slotOf(id);
    if (slot && slot !== BAR) { this.setSlot(id, BAR); return; }
    const corner = freeCorner(this._wins, this._preferCorner) || BAR;
    if (slot === BAR) this.setSlot(id, corner);
    else this.addWindow(id, meta, corner);
  }

  // Hide/show the whole preview WITHOUT forgetting the set.
  setHidden(h) {
    const v = !!h;
    if (this._hidden === v) return;
    this._hidden = v;
    // Re-showing rebuilds the tiles from scratch (the hide tore their terminals
    // down), so prime a fresh capture for every previewed window immediately —
    // otherwise they'd sit blank until the next 1.5s poll tick.
    if (!v && this._wins.length) this.cache?.request(this._wins.map((w) => w.windowId), true);
    this._changed();
  }
  toggleHidden() { this.setHidden(!this._hidden); }

  // ---- placement --------------------------------------------------------------

  // Move one previewed window between the bar and the four corners. Corner collisions
  // can't normally happen (the controls only offer free corners), but placeWindow bumps
  // an occupant to the bar rather than drawing two boxes in one place if one ever does.
  setSlot(id, slot) {
    if (!this._has(id)) return;
    const want = normalizeSlot(slot);
    if (this.slotOf(id) === want) return;
    this._wins = placeWindow(this._wins, id, want);
    // Remember the corner as the default for the NEXT pip: whichever corner you keep
    // reaching for is the one an unaimed "pin this" should use.
    // (…but not while a persisted set is being applied: adopting a blob is not the user
    // reaching for a corner, and publishing a preference from it is churn.)
    if (want !== BAR) {
      this._preferCorner = want;
      if (!this._restoring) stateStore.patchSection('pip', { corner: want });
    }
    // A tile that changed surface is rebuilt (see _syncTiles), so re-prime its capture:
    // the cache still holds the last screen, and repainting from it is instant.
    this.cache?.request([id], true);
    this._changed();
  }

  setEdge(e) {
    if (!EDGES.includes(e)) return;
    this.edge = e;
    stateStore.patchSection('pip', { previewEdge: e });
    // The reserved-space axis changes; re-letterbox once the bar re-lays-out.
    this.updateComplete.then(() => { this._applySpace(); this._rescaleAll(); });
  }

  // ---- lit lifecycle ----------------------------------------------------------

  willUpdate() {
    // Is anything drawn at all? Derived BEFORE render so the reflected `mode` attribute
    // is correct this frame, and so _syncTiles knows whether to build or tear down.
    this._on = !this._hidden && this._wins.length > 0;
    this.mode = this._on ? 'on' : 'off';
  }

  updated() {
    // Keep the imperative xterm tiles, reserved space, and scaling in sync with the
    // current placement after every render.
    this._syncTiles();
    this._applySpace();
    this._rescaleAll();
  }

  // Both surfaces are rendered UNCONDITIONALLY and shown with a class, rather than
  // being added and removed from the template. Their `.tiles` containers hold
  // imperatively-built tiles, so a container that Lit is free to recreate is a container
  // that can lose a live terminal on an unrelated re-render; a stable one cannot.
  render() {
    const bar = this._on ? barWins(this._wins) : [];
    const corners = this._on ? cornerOccupancy(this._wins) : new Map();
    return html`
      <link rel="stylesheet" href=${XTERM_CSS} />
      <div
        class="bar ${bar.length ? 'on' : ''} ${this._dragId ? 'dragging' : ''}"
        edge=${this.edge}
        @dragover=${this._onBarDragOver}
        @dragleave=${this._onBarDragLeave}
        @drop=${this._onBarDrop}
      >
        ${bar.length ? this._barChrome() : ''}
        <div class="tiles" data-slot="bar"></div>
      </div>
      ${CORNERS.map((c) => html`
        <div
          class="pipbox ${corners.has(c) ? 'on' : ''} ${corners.get(c) === this._focusedWinId ? 'mini' : ''}"
          corner=${c}
        ><div class="tiles" data-slot=${c}></div></div>
      `)}
      <div class="wt-tip"></div>
    `;
  }

  // Bar controls: dock-to-edge buttons + a hide toggle, in a compact cluster at the
  // start of the bar (buttons aligned along the bar's cross-axis). These are the BAR's
  // own controls — where the strip is docked, and whether the preview is on screen at
  // all — as distinct from the per-tile cluster, which moves one window.
  _barChrome() {
    return html`
      <div class="barctl" @click=${(e) => e.stopPropagation()}>
        <div class="grp">
          ${EDGES.map((e) => html`
            <button
              class="bbtn ${this.edge === e ? 'active' : ''}"
              title="Dock the preview bar to the ${EDGE_NAME[e]}"
              aria-label="Dock preview bar to ${EDGE_NAME[e]}"
              @click=${(ev) => { ev.stopPropagation(); this.setEdge(e); }}
            >${EDGE_GLYPH[e]}</button>
          `)}
        </div>
        <button
          class="bbtn hide"
          title="Hide the preview (keeps these ${this._wins.length} windows; ${chord('I')} on a window re-adds/removes it)"
          aria-label="Hide preview"
          @click=${(ev) => { ev.stopPropagation(); this.setHidden(true); }}
        >⊘</button>
      </div>
    `;
  }

  // ---- imperative tile reconciliation ----------------------------------------

  _syncTiles() {
    // Going 'off' (empty set OR hidden) must DISPOSE the xterm instances, not just
    // drop their tile DOM: each rec.screen lives inside the tile we're about to
    // clear, so keeping the rec around orphans its terminal. On re-show _ensureTerm
    // would then hand back that orphaned rec and never re-attach it to the fresh
    // tile — leaving every preview blank. Tearing down here forces a clean
    // rebuild+repaint from the cache when the preview returns.
    const hosts = new Map();
    for (const el of this.renderRoot?.querySelectorAll('.tiles') || []) hosts.set(el.dataset.slot, el);
    if (!this._on) {
      this._teardownAll();
      for (const el of hosts.values()) el.textContent = '';
      return;
    }

    // Drop tiles that left the preview or CHANGED SURFACE. A tile that moved is rebuilt
    // in its new container rather than re-parented: an xterm carries measurement state
    // tied to where it is laid out, and the capture cache still holds this window's last
    // screen, so a fresh tile repaints from it in the same frame it is created.
    for (const [slot, host] of hosts) {
      for (const el of [...host.children]) {
        const w = this._wins.find((x) => x.windowId === el.dataset.window);
        if (!w || w.slot !== slot) { this._teardownTerm(el.dataset.window); el.remove(); }
      }
    }
    // …and sweep any terminal whose tile is no longer in the tree at all (a corner box
    // that went away takes its container's children with it, without passing through the
    // loop above).
    for (const id of [...this._terms.keys()]) {
      if (!this._tileEl(id)) this._teardownTerm(id);
    }

    // Add / reorder tiles to match the set order within each surface.
    for (const [slot, host] of hosts) {
      const want = this._wins.filter((w) => w.slot === slot);
      want.forEach((w, i) => {
        let el = [...host.children].find((c) => c.dataset.window === w.windowId);
        if (!el) el = this._buildTile(w);
        if (host.children[i] !== el) host.insertBefore(el, host.children[i] || null);
      });
    }
    // Paint whatever's cached now — screen, controls, stoplight and flash. The status
    // pass has to run here and not only from setWorking/setAlerts: those only fire when
    // the VALUE changes, so a tile rebuilt while nothing was moving (re-showing the
    // preview, moving another window to a corner) would come back with a blank dot and no
    // ring on a window that has been asking for attention the whole time. The controls
    // pass has to run here too, and for a related reason: which corners a tile may offer
    // depends on where the OTHER windows are, so every tile's cluster is re-derived
    // whenever any window moves.
    for (const w of this._wins) {
      this._paint(w.windowId);
      this._paintControls(w);
      this._paintWork(w.windowId);
    }
    this._paintDrag();
  }

  _buildTile(w) {
    const tile = document.createElement('div');
    tile.className = 'ptile';
    tile.dataset.window = w.windowId;

    // Pick it up and put it where you want it — a bar tile among its neighbours, a
    // corner box down into the bar. Every tile is draggable, not just the bar's: the
    // drop TARGET is the bar either way, and "drag it out of the corner" is the gesture
    // the ▬ button spells out in words.
    tile.draggable = true;
    tile.addEventListener('dragstart', (e) => this._onTileDragStart(e, w));
    tile.addEventListener('dragend', () => this._endDrag());

    // Re-letterbox this tile's xterm once a size transition settles (a corner box's
    // pframe grows on hover; bubbles to the tile within the shadow tree).
    tile.addEventListener('transitionend', () => this._rescale(w.windowId));

    // Hovering a preview shows that window full size in a terminal region (the
    // shared browse gesture — see hover-preview.js). A thumbnail is for noticing
    // that something happened; when you want to actually READ it, you get a region.
    tile.addEventListener('mouseenter', () => this.manager?.hover?.enter(w.windowId, w.session || ''));
    tile.addEventListener('mouseleave', () => this.manager?.hover?.leave());

    const frame = document.createElement('div');
    frame.className = 'pframe';
    frame.title = FRAME_TIP;   // _paintWork appends the stoplight key to this
    frame.addEventListener('click', () => this._activate(w.windowId));
    tile.appendChild(frame);

    const host = document.createElement('div');
    host.className = 'screen-host';
    frame.appendChild(host);

    // Working stoplight, top-right (see the .pwork rules). Built here rather than in
    // _paint so it exists before the first capture lands.
    const work = document.createElement('span');
    work.className = 'pwork';
    work.setAttribute('role', 'img');
    frame.appendChild(work);

    // The placement/close cluster. Filled by _paintControls, which is re-run for every
    // tile whenever the set moves — its contents depend on the other windows.
    const ctl = document.createElement('div');
    ctl.className = 'tctl';
    frame.appendChild(ctl);

    const label = document.createElement('div');
    label.className = 'plabel';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = w.label || '…';
    const sess = document.createElement('span');
    sess.className = 'sess';
    sess.textContent = w.session || '';
    label.append(name, sess);
    tile.appendChild(label);

    // The name clips with an ellipsis in .plabel .name (bar tiles are narrow, and a
    // window's name has no length limit) — hovering the label answers the same
    // question the recents strip answers on hover: which window, in full. Scoped to
    // the label rather than the whole tile so it doesn't fight the frame's own native
    // title (click hint + stoplight key — see FRAME_TIP / _paintWork) while you're
    // looking at the live screen. See tooltip.js and toolbar.js's _tabTip.
    label.addEventListener('mouseenter', () => this._tip.enter({ currentTarget: label }, this._tileTip(w)));
    label.addEventListener('mouseleave', () => this._tip.leave());

    return tile;
  }

  // Fill (or refresh) one tile's hover controls from the shared placement model — the
  // SAME call for a bar tile and for a corner box, because "where should this window be
  // drawn" is one question with one answer wherever it is asked from.
  //
  // Rebuilt only when the answer actually changes: this runs for every tile on every
  // reconcile, and replacing the buttons under a pointer that is resting on one would
  // restart their fade and drop the press.
  _paintControls(w) {
    const tile = this._tileEl(w.windowId);
    const ctl = tile?.querySelector('.tctl');
    if (!ctl) return;
    const model = tileControls(this._wins, w.windowId);
    const sig = JSON.stringify(model);
    if (ctl.dataset.sig === sig) return;
    ctl.dataset.sig = sig;
    ctl.textContent = '';

    const button = (cls, glyph, title, fn) => {
      const b = document.createElement('button');
      b.className = `tbtn ${cls}`;
      b.textContent = glyph;
      b.title = title;
      b.setAttribute('aria-label', title);
      b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
      ctl.appendChild(b);
      return b;
    };

    for (const { corner, active } of model.corners) {
      button(
        `corner ${corner}${active ? ' active' : ''}`,
        CORNER_GLYPH[corner],
        active
          ? `Pinned to the ${CORNER_NAME[corner]} corner`
          : `Pin to the ${CORNER_NAME[corner]} corner`,
        () => this.setSlot(w.windowId, corner),
      );
    }
    if (model.toBar) {
      // ▬ rather than ▤: at this size ▤ is three lines in a box, which is the sidebar's
      // ☰ with extra steps. A solid strip is what the docked bar looks like.
      button('tobar', '▬', 'Move back to the preview bar', () => this.setSlot(w.windowId, BAR));
    }
    button('close', '✕', `Remove from the preview (${chord('I')})`, () => this.removeWindow(w.windowId));
  }

  // ---- drag to place ----------------------------------------------------------
  // The bar's order is the user's: tiles are drawn in set order and nothing reshuffles
  // them, which is what makes the bar a place you can leave things — so it has to be
  // arrangeable by hand. Insertion-GAP semantics along whichever axis the bar is docked
  // on, mirroring the recents strip's reorder (toolbar.js) and the sidebar's: a line
  // shows the gap the tile will land in, and the drop moves it there.
  //
  // The same drop also DOCKS a corner box, at the position you point at — which is why
  // the move is computed by dropInBar (preview-slots.js) rather than by a plain splice:
  // it is one gesture with one answer, and the pinned windows that stayed put must not
  // be renumbered around the one that moved.

  _onTileDragStart(e, w) {
    this._dragId = w.windowId;
    this._dropIndex = -1;
    this._tip.leave();
    // Pointing at a tile previews its window in a real region (the tile's own
    // mouseenter — see _buildTile). Picking the tile UP is a rearrangement, not a
    // browse, so that preview is dismissed for the length of the drag; otherwise a
    // reorder is done while the pane behind it is showing something you didn't ask
    // for, and the mouseleave that would have ended it never fires mid-drag.
    this.manager?.hover?.cancel();
    try {
      e.dataTransfer.effectAllowed = 'move';
      // A private type: `types` is all a dragover handler can read, and it keeps this
      // drag out of every other drop handler in the app — see PREVIEW_DRAG_TYPE.
      e.dataTransfer.setData(PREVIEW_DRAG_TYPE, previewDragPayload(w.windowId));
    } catch (_) {}
  }

  _endDrag() {
    if (!this._dragId && this._dropIndex < 0) return;
    this._dragId = '';
    this._dropIndex = -1;
  }

  _onBarDragOver(e) {
    if (!this._dragId && !carriesPreviewDrag(e.dataTransfer)) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = 'move'; } catch (_) {}
    const idx = this._dropIndexAt(e);
    if (idx !== this._dropIndex) this._dropIndex = idx;
  }

  // Only clear the line when the pointer truly leaves the bar — dragleave also fires
  // when crossing between the tiles inside it, where relatedTarget is still within.
  _onBarDragLeave(e) {
    if (!e.currentTarget.contains(e.relatedTarget)) this._dropIndex = -1;
  }

  _onBarDrop(e) {
    if (!this._dragId && !carriesPreviewDrag(e.dataTransfer)) return;
    e.preventDefault();
    // Prefer the live drag state; fall back to the payload so a re-render that cleared
    // _dragId (the poll repaints constantly) can never eat the drop.
    const id = this._dragId || this._dtWindow(e);
    const gap = this._dropIndex >= 0 ? this._dropIndex : this._dropIndexAt(e);
    this._endDrag();
    if (!id) return;
    const next = dropInBar(this._wins, id, gap);
    if (!next) return;
    this._wins = next;
    // A tile that came from a corner changed surface, so _syncTiles rebuilds it: prime
    // a capture the way setSlot does, and it repaints from the cache in the same frame.
    this.cache?.request([id], true);
    this._changed();
  }

  // The insertion gap under the pointer: the first tile whose midpoint is past it,
  // measured along the bar's OWN axis — a top/bottom bar is a row and a left/right bar
  // is a column, and a reorder that read the wrong coordinate would land every drop in
  // the same place.
  _dropIndexAt(e) {
    const host = this.renderRoot?.querySelector('.tiles[data-slot="bar"]');
    const tiles = [...(host?.children || [])];
    const vertical = this.edge === 'left' || this.edge === 'right';
    const pos = vertical ? e.clientY : e.clientX;
    for (let i = 0; i < tiles.length; i++) {
      const r = tiles[i].getBoundingClientRect();
      if (pos < (vertical ? r.top + r.height / 2 : r.left + r.width / 2)) return i;
    }
    return tiles.length;
  }

  // The dragged window recovered from the drop payload. Matched back against the
  // preview rather than trusted, so a payload from anywhere else can't name a window.
  _dtWindow(e) {
    let raw = '';
    try { raw = e.dataTransfer.getData(PREVIEW_DRAG_TYPE) || ''; } catch (_) { return ''; }
    const id = parsePreviewDrag(raw);
    return id && this._has(id) ? id : '';
  }

  // Paint the drag's two marks onto the imperative tiles: which one is in the air, and
  // which gap the drop would land in. Run from _syncTiles, so the reactive drag state
  // reaches the tiles through the same reconcile every other tile property does.
  _paintDrag() {
    const host = this.renderRoot?.querySelector('.tiles[data-slot="bar"]');
    const bar = [...(host?.children || [])];
    for (const el of this.renderRoot?.querySelectorAll('.ptile') || []) {
      el.classList.toggle('dragging', !!this._dragId && el.dataset.window === this._dragId);
      el.classList.remove('drop-before', 'drop-end');
    }
    if (!this._dragId || this._dropIndex < 0) return;
    // Past the last tile there is no tile to draw a line BEFORE, so the last one draws
    // it on its far edge instead.
    if (this._dropIndex < bar.length) bar[this._dropIndex].classList.add('drop-before');
    else if (bar.length) bar[bar.length - 1].classList.add('drop-end');
  }

  // Full "session — window N: name" for a tile's hover hint. Reads `w` live (the
  // same object _paint mutates in place as fresh captures land — `label` there, not
  // `index`/`name`, which are only ever set once at add time), so a rename or a
  // linked-window session change shows up without rebuilding the tile.
  _tileTip(w) {
    return w.session ? `${w.session} — window ${w.label}` : `window ${w.label}`;
  }

  // ---- live painting ----------------------------------------------------------

  _paint(id) {
    if (!this._on) return;
    const win = this._wins.find((w) => w.windowId === id);
    // Prefer the capture for THIS preview's own session (accurate index/session when
    // the window is linked into several); fall back to any representative — the
    // screen is identical across a window's placements.
    const entry = (win && this.cache?.byPlacement?.get(placementKey(win.session, id)))
      || this.cache?.get(id);
    if (!entry) return;
    const tile = this._tileEl(id);
    if (!tile) return;
    const rec = this._ensureTerm(id, tile, entry);
    if (!rec) return;
    if (entry.cols && entry.rows && (entry.cols !== rec.cols || entry.rows !== rec.rows)) {
      try { rec.term.resize(entry.cols, entry.rows); } catch (e) {}
      rec.cols = entry.cols; rec.rows = entry.rows;
    }
    rec.term.write('\x1b[H\x1b[2J');
    // Re-crop from the WRITE CALLBACK, not from here: xterm parses off a queue, so
    // the buffer this frame's crop is measured from is only current once the write
    // has actually been applied. _rescale re-uses the last crop whenever it is
    // called for another reason (a resize, a transition ending), so the tile is
    // never left un-scaled waiting for this.
    rec.term.write(CaptureCache.decodeAnsi(entry), () => this._recrop(id));
    this._rescale(id);

    // Refresh label + session (rename/index can change on any capture). Keep the
    // add-time session unless it was unknown, so a linked window's preview stays
    // anchored to the session it was added from.
    if (win) {
      win.label = `${entry.index}: ${entry.name}`;
      if (!win.session && entry.sessionName) win.session = entry.sessionName;
      const nameEl = tile.querySelector('.plabel .name');
      const sessEl = tile.querySelector('.plabel .sess');
      if (nameEl) nameEl.textContent = win.label;
      if (sessEl) sessEl.textContent = win.session || '';
    }
    // Mark active (matches the focused pane's current window).
    const activeId = this.manager?.focusedUnit?.layout?.activeWindowId;
    tile.classList.toggle('current', id === activeId);
    this._paintWork(id);
    // A capture just arrived => alive; clear any stale flag.
    if (this._stale.has(id)) { this._stale.delete(id); this._setStaleUI(id, false); }
  }

  _ensureTerm(id, tile, entry) {
    let rec = this._terms.get(id);
    if (rec) return rec;
    const screenHost = tile.querySelector('.screen-host');
    if (!screenHost) return null;
    const screen = document.createElement('div');
    screen.className = 'screen';
    screenHost.appendChild(screen);
    const term = new Terminal({
      cols: entry?.cols || 80,
      rows: entry?.rows || 24,
      fontSize: 14,
      // Match the main terminal's broad-coverage stack so preview glyphs render.
      fontFamily: '"DejaVu Sans Mono", Menlo, Monaco, "Cascadia Mono", "Noto Sans Mono", "Liberation Mono", "Courier New", "Symbols Nerd Font", monospace',
      theme: { background: '#1a1a2e', foreground: '#eaeaea' },
      scrollback: 0,
      disableStdin: true,
      cursorStyle: 'bar',
      cursorInactiveStyle: 'none',
      allowProposedApi: true,
    });
    term.open(screen);
    rec = {
      term, screen, cols: entry?.cols || 0, rows: entry?.rows || 0,
      // Which part of the grid this tile is showing, and the hysteresis that keeps
      // it from re-scaling on every capture. null crop = the whole grid.
      crop: null,
      cropTracker: new CropTracker(),
    };
    this._terms.set(id, rec);
    return rec;
  }

  // Measure where this window's ink is and let the tracker decide whether to move
  // the crop. Only re-scales when the applied box actually changed — this runs on
  // every capture, and most captures don't move the box at all.
  _recrop(id) {
    const rec = this._terms.get(id);
    if (!rec) return;
    const gc = rec.term.cols;
    const gr = rec.term.rows;
    const box = rec.cropTracker.update(
      cropBox(terminalContentBox(rec.term), gc, gr), gc, gr,
    );
    const full = box.col === 0 && box.row === 0 && box.cols === gc && box.rows === gr;
    const next = full ? null : box;
    if (sameBox(rec.crop, next)) return;
    rec.crop = next;
    this._rescale(id);
  }

  // Fit the tile's terminal into its frame — the whole grid when there is no crop,
  // otherwise just the cropped rectangle, blown up to fill the frame instead.
  _rescale(id) {
    const rec = this._terms.get(id);
    const tile = this._tileEl(id);
    if (!rec || !tile) return;
    const frame = tile.querySelector('.pframe');
    if (!frame) return;
    requestAnimationFrame(() => {
      const t = fitTransform({
        box: rec.crop,
        gridCols: rec.term.cols,
        gridRows: rec.term.rows,
        screenW: rec.screen.offsetWidth || 1,
        screenH: rec.screen.offsetHeight || 1,
        frameW: frame.clientWidth,
        frameH: frame.clientHeight,
      });
      rec.screen.style.transform = t.css;
    });
  }

  _rescaleAll() { for (const id of this._terms.keys()) this._rescale(id); }

  // ---- staleness --------------------------------------------------------------

  _checkStale() {
    for (const w of this._wins) {
      const entry = this.cache?.get(w.windowId);
      if (!entry) continue;
      const stale = Date.now() - entry.capturedAt * 1000 > STALE_MS;
      if (stale !== this._stale.has(w.windowId)) {
        if (stale) this._stale.add(w.windowId); else this._stale.delete(w.windowId);
        this._setStaleUI(w.windowId, stale);
      }
    }
  }

  _setStaleUI(id, stale) {
    const tile = this._tileEl(id);
    if (!tile) return;
    const frame = tile.querySelector('.pframe');
    if (frame) frame.classList.toggle('stale', stale);
    let tag = tile.querySelector('.stale-tag');
    if (stale && !tag) {
      tag = document.createElement('div');
      tag.className = 'stale-tag';
      tag.textContent = 'window closed';
      frame?.appendChild(tag);
    } else if (!stale && tag) {
      tag.remove();
    }
  }

  // ---- helpers ----------------------------------------------------------------

  _entry(id, meta, slot) {
    const label = meta.index != null ? `${meta.index}: ${meta.name || 'bash'}` : (meta.name || '…');
    return {
      windowId: id, session: meta.session || '', label,
      index: meta.index, name: meta.name, slot: normalizeSlot(slot),
    };
  }

  _tileEl(id) {
    return this.renderRoot?.querySelector(`.ptile[data-window="${id}"]`) || null;
  }

  _activate(id) {
    if (!id) return;
    const win = this._wins.find((w) => w.windowId === id);
    // Commit through the shared preview so the window lands in the region that was
    // showing it while you hovered — clicking a preview means "put THAT where I was
    // just looking at it", not "hijack whichever pane happens to be focused".
    this.manager?.hover.commit(id, win?.session || '');
  }

  // ---- working stoplight -------------------------------------------------------

  // Per-window @wt_working, pushed from the SplitManager on every layout refresh.
  // Only repaints when something actually changed — this runs on the 500ms poll.
  setWorking(map) {
    if (!map) return;
    let changed = map.size !== this._working.size;
    if (!changed) { for (const [k, v] of map) if (this._working.get(k) !== v) { changed = true; break; } }
    if (!changed) return;
    this._working = new Map(map);
    for (const w of this._wins) this._paintWork(w.windowId);
  }

  // Per-window attention flashes, pushed on the same refresh as setWorking. Cheap
  // change detection for the same reason: this runs on the 500ms poll, and rewriting
  // class lists every tick would restart the CSS animation twice a second, leaving
  // every tile stuck on the first frame of a pulse that never visibly moves.
  setAlerts(snapshot) {
    if (!snapshot) return;
    const changed = !this._alerts || snapshot.size !== this._alerts.size
      || [...snapshot].some(([k, v]) => this._alerts.get(k) !== v);
    if (!changed) return;
    this._alerts = new Map(snapshot);
    for (const w of this._wins) this._paintWork(w.windowId);
  }

  _paintWork(id) {
    const tile = this._tileEl(id);
    const dot = tile?.querySelector('.pwork');
    if (!dot) return;
    const v = this._working.get(id) || '';
    const cls = workClass(v);
    dot.classList.toggle('on', cls === 'on');
    dot.classList.toggle('off', cls === 'off');
    dot.classList.toggle('wait', cls === 'wait');
    dot.setAttribute('aria-label', workLabel(v));
    this._paintAlert(id, tile);
    // The colour key belongs on the FRAME, not on the dot itself. The dot is
    // deliberately pointer-events:none — it shares the tile's top-right corner with
    // the hover-revealed controls — so making it hoverable would eat part of their hit
    // area. Because it lets the pointer through, hovering the dot IS hovering the
    // frame, so the frame's tooltip is what a user pointing at the dot actually reads.
    const frame = tile.querySelector('.pframe');
    if (frame) frame.title = `${FRAME_TIP}\n\n${workTip(v)}${alertTip(this._alertFor(id))}`;
  }

  // This window's flash, keyed by the session the tile was ADDED from (a linked
  // window's tile is anchored to one placement — see _paint's label refresh).
  _alertFor(id) {
    const win = this._wins.find((w) => w.windowId === id);
    return alertOf(this._alerts, win?.session || '', id);
  }

  // Put the ring flash on (or take it off) a tile. Applied to the TILE rather than
  // the frame so it rings the label too — in the bar the label is what tells you
  // WHICH window is asking, and a ring that stops short of it reads as decoration on
  // a screenshot rather than a flag on a window.
  _paintAlert(id, tile) {
    const el = tile || this._tileEl(id);
    if (!el) return;
    const want = alertClass(this._alertFor(id), 'ring').split(' ').filter(Boolean);
    for (const c of ['wt-alert-ring', 'wt-alert-off', 'wt-alert-wait']) {
      el.classList.toggle(c, want.includes(c));
    }
  }

  _ensurePolling() {
    if (this._pollTimer) return;
    this.cache?.addEventListener('update', this._onCacheUpdate);
    this._pollTimer = setInterval(() => {
      const ids = this._wins.map((w) => w.windowId);
      if (!ids.length) return;
      this.cache?.request(ids, true);   // keep every preview live
      this._checkStale();
    }, POLL_MS);
  }

  _teardownTerm(id) {
    const rec = this._terms.get(id);
    if (rec) { try { rec.term.dispose(); } catch (e) {} this._terms.delete(id); }
  }

  _teardownAll() {
    for (const id of [...this._terms.keys()]) this._teardownTerm(id);
  }

  // Any change to the set, a window's placement, or the hidden flag: re-render, stop
  // polling when empty or tucked away (a hidden preview has no tiles to feed —
  // force-polling captures for it would fork tmux every 1.5s indefinitely for nothing),
  // tell the toolbar (via onChange) to refresh its preview buttons. setHidden(false)
  // re-primes.
  _changed() {
    // Anything that reaches here while we are NOT restoring is the user adding,
    // removing, moving or hiding a preview — so the shared blob stops re-applying
    // itself over this client's set (see the adopt in restoreState).
    if (!this._restoring) this._userTouched = true;
    if (this._wins.length === 0 || this._hidden) {
      if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
      this.cache?.removeEventListener('update', this._onCacheUpdate);
    } else {
      this._ensurePolling();
    }
    this.requestUpdate();
    this._persist();
    if (this.onChange) this.onChange();
  }

  // Persist the preview SET (window ids, labels and PLACEMENTS) and the hidden flag into
  // the shared 'pip' section so a reload restores the preview exactly as it was drawn.
  // Full entries (not bare ids) so labels are right before the first capture arrives.
  // Merged (patchSection) so corner/previewEdge are preserved. Skipped while
  // restoreState() is applying, so re-adding restored windows can't re-enter here
  // mid-restore.
  //
  // …and skipped before the first layout push, which is the guard that matters: until
  // then everything we hold came out of THIS browser's localStorage cache, and on a
  // first-ever visit that is an empty preview. The 'pip' section is shared, so
  // publishing it would close the preview every other browser has open.
  _persist() {
    if (this._restoring) return false;
    if (!stateStore.loadedOnce) return false;
    const wins = this._wins.map((w) => ({
      windowId: w.windowId, session: w.session, index: w.index, name: w.name, slot: w.slot,
    }));
    return stateStore.patchSection('pip', { wins, hidden: this._hidden });
  }

  // Restore the preview set + placements + hidden flag from the shared 'pip' section
  // (reload recovery). Called once by the SplitManager after cache/manager are wired.
  // Guarded so the re-adds it performs don't write back through _persist() (idempotent
  // churn).
  //
  // ADOPT, DON'T RESTORE-ONCE. The cache read here makes the preview reappear
  // instantly, but it is this browser's private guess; the tmux server's copy is the
  // shared truth and arrives one layout push later. So the same apply runs again from
  // the authoritative blob — unless the user has already touched the preview, in
  // which case their set wins and nothing is yanked away.
  restoreState() {
    this._applyPersisted(stateStore.section('pip'));
    stateStore.onFirstLoad(() => {
      if (this._userTouched) return;
      this._applyPersisted(stateStore.section('pip'));
    });
  }

  // Make the live preview match a persisted 'pip' section: add what's missing, drop
  // what's no longer listed, move anything whose placement changed, and match the hidden
  // flag. RECONCILES rather than just adding, because the adopt above can run against a
  // blob holding FEWER windows than the cache did — and a preview that only ever grows
  // would keep resurrecting tiles another browser closed.
  //
  // winsFromState also upgrades a blob written before placements existed, so a preview
  // that was open across the change comes back looking like what it was (see
  // preview-slots.js).
  //
  // The unconditional re-persist this used to end with is gone. Its stated purpose
  // was "so its rev is current", which is precisely the bug: a restore is not an
  // edit, and republishing a cache-derived set at a fresh rev is how a stale (or
  // empty) preview overwrote the shared one.
  _applyPersisted(pip) {
    const want = winsFromState(pip);
    const wantIds = new Set(want.map((w) => w.windowId));
    const hidden = !!(pip && pip.hidden);
    if (!want.length && !this._wins.length && this._hidden === hidden) return;
    this._restoring = true;
    try {
      for (const w of this._wins.map((x) => x.windowId)) {
        if (!wantIds.has(w)) this.removeWindow(w);
      }
      for (const w of want) {
        this.addWindow(w.windowId, { index: w.index, name: w.name, session: w.session }, w.slot);
        this.setSlot(w.windowId, w.slot);   // already present? move it to where the blob says
      }
      this.setHidden(hidden);
    } finally {
      this._restoring = false;
    }
  }

  // Reserve edge space for the docked BAR by publishing --wt-preview-* on :root
  // (consumed as #app padding, and read back by the corner boxes so they clear it). A
  // floating corner box reserves nothing — that is the difference between the two.
  _applySpace() {
    const vars = { top: '0px', bottom: '0px', left: '0px', right: '0px' };
    if (this._on && this._wins.some((w) => w.slot === BAR)) vars[this.edge] = BAR_THICK + 'px';
    try {
      const s = document.documentElement.style;
      s.setProperty('--wt-preview-top', vars.top);
      s.setProperty('--wt-preview-bottom', vars.bottom);
      s.setProperty('--wt-preview-left', vars.left);
      s.setProperty('--wt-preview-right', vars.right);
    } catch (e) {}
  }
}

customElements.define('webtmux-pip', WebtmuxPip);
