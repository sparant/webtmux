// HoverPreview — the ONE transient "show me that window" path, shared by every
// switcher in the app (toolbar recents, sidebar window rows + arrow-key browsing,
// Preview/PiP tiles).
//
// THE MODEL (it came from the sidebar's keyboard browsing, which people liked):
// pointing at a window is a PREVIEW, not a navigation. The window's screen appears
// in a real terminal region so you can actually read it, the region is visibly
// marked as temporary, and nothing is committed until you take an action — a click,
// or Enter. Moving away restores the region; Escape cancels.
//
// This replaces the family of floating popup thumbnails that used to hang off the
// toolbar tabs and the preview bar. A popup is small, covers the thing you were
// reading, and needs its own xterm; showing the window in a region you already have
// is bigger, in place, and costs nothing extra.
//
// WHICH REGION a preview lands in:
//   1. the region that LAST actually displayed this window (so a window keeps
//      reappearing where you're used to seeing it), if that region still exists;
//   2. otherwise the focused region.
//   3. …unless some region is ALREADY showing the window, in which case there is
//      nothing to do — it's on screen, and mirroring it into a second region would
//      just take a region away for no gain.
//
// The screen itself is the shared CaptureCache frame (the same snapshot Exposé and
// the Preview read) blitted into the region's xterm — tmux is never asked to
// actually switch, so previewing is free and can't disturb anyone else's view.
// While a region is held for preview its own live output is BUFFERED (not dropped)
// and replayed on restore, then tmux is asked to repaint (TmuxRefresh) so the
// region's real screen comes back authoritatively.
//
// WHAT A PREVIEW IS ALLOWED TO SHOW. Capture buffers are only refreshed while some
// surface is asking for them (the sidebar/Exposé/Preview polls) — with all of those
// off they go cold indefinitely, so "whatever is in the cache" can be an hour old and
// looks exactly as live as a fresh frame. A preview therefore never opens on a cached
// screen: it asks for a new capture and WAITS for it, and only a frame captured at or
// after that request may be drawn. The wait is what the enter delay is spent on — the
// request goes out the moment you point at something (_prefetch), so by the time the
// delay is up the frame is normally already here and the preview opens instantly. If
// it isn't, the region is left alone — showing its own live window, unheld and
// unmarked — until the frame lands. Nothing is ever painted that we can't date.
import { CaptureCache, placementKey } from './capture-cache.js';

// How long the pointer must rest before the FIRST preview appears. Once one is up,
// moving to another target switches instantly (see _engaged) — the pause is there
// to stop a sweep across the strip from strobing, not to slow down browsing.
const ENTER_DELAY_MS = 220;

// Grace after the pointer leaves a target before the preview is torn down. Bridges
// the gap between two adjacent tabs/rows (a moment where nothing is hovered) so
// sweeping along them keeps ONE engaged preview rather than re-pausing on each.
const LEAVE_GRACE_MS = 260;

// Keep the previewed window's frames coming while it's up, so a preview of a busy
// window is live rather than a still.
const POLL_MS = 1200;

// Settle time before pointing at something turns into a capture request. Short enough
// that the request still gets most of the enter delay as a head start, long enough
// that sweeping the pointer across a strip of tabs doesn't fork a capture for every
// tab it crosses on the way to the one you meant.
const PREFETCH_DELAY_MS = 60;

// How long a capture request is assumed to be either in flight or already answered.
// Within it we don't ask again for the same window — the reply we'd be forking tmux
// for is the one already coming. Past it, assume it was lost and re-ask.
const REQUEST_TRUST_MS = 1500;

// capturedAt is stamped in whole unix SECONDS, so a capture taken microseconds AFTER
// we asked can carry a timestamp up to a second earlier. Freshness comparisons allow
// for that; without the slack the very frame we requested could read as stale and a
// preview would never open.
const CAPTURE_TS_RESOLUTION_MS = 1000;

export class HoverPreview {
  constructor(manager) {
    this.manager = manager;
    // windowId -> the TerminalUnit that last actually displayed it. Fed by
    // SplitManager on every layout change; the "where does this window live" memory.
    this._lastUnit = new Map();
    this._enterTimer = null;
    this._leaveTimer = null;
    this._pollTimer = null;
    this._prefetchTimer = null;
    this._prefetchWindowId = null;
    this._engaged = false;   // a preview is up (or within its leave grace)
    // The most recent capture request we made on a hover's behalf, so a second one
    // for the same window doesn't fork tmux again while the first is in flight.
    this._asked = null;      // { windowId, at }
    // The live preview: which window we're showing, in which unit, what that unit was
    // REALLY on so we can put it back, and `since` — the request whose reply we are
    // waiting for. Set from the moment we commit to a target, which is BEFORE anything
    // is drawn: until a frame dated >= since arrives the region is untouched.
    this._active = null;     // { unit, windowId, session, realWindowId, since }
    // The region currently lent to us, with the geometry it had when we took it. Held
    // separately from _active because switching targets within one region keeps the
    // same hold (and must restore the ORIGINAL size, not an intervening capture's).
    this._held = null;       // { unit, cols, rows, realWindowId }
    // The hovered target even when nothing is drawn (already visible elsewhere, or
    // still inside the enter delay) — commit()/Enter must work in that case too.
    this._target = null;     // { windowId, session }
    this._onCacheUpdate = (e) => {
      const caps = (e && e.detail && e.detail.captures) || [];
      if (this._active && caps.some((c) => c.windowId === this._active.windowId)) this._paint();
    };
  }

  // The window currently being previewed or pointed at ('' when idle) — switchers
  // read it to highlight the row/tab the preview belongs to.
  get windowId() { return this._target?.windowId || ''; }
  get session() { return this._target?.session || ''; }

  // The region currently lent out to a preview (null when nothing is drawn — the
  // target may still be set, e.g. when it's already visible elsewhere, or when we've
  // picked a region but are still waiting for its first frame). Callers use this to
  // mean "the region you are looking at a preview in", so it tracks the HOLD: a region
  // that is still showing its own window hasn't been lent to anything yet.
  get activeUnit() { return this._held?.unit || null; }

  // Remember where a window really lives. Called by SplitManager whenever a region
  // lands on a window, so rule 1 above has something to consult.
  noteRendered(windowId, unit) {
    if (windowId && unit) this._lastUnit.set(windowId, unit);
  }

  // A region went away: drop it from the memory so a stale unit can never be chosen
  // as a preview host (rule 1's "if that region still exists"), and give up any hold
  // on it. No restore — the region is being torn down, so repainting it is pointless.
  forgetUnit(unit) {
    for (const [id, u] of [...this._lastUnit]) if (u === unit) this._lastUnit.delete(id);
    if (this._held?.unit === unit || this._active?.unit === unit) this._dropActive(false);
  }

  // ---- hover lifecycle ---------------------------------------------------------

  // Point at a window. The first call pauses briefly; while a preview is already
  // engaged, later calls switch instantly. `session` is the logical session the
  // target belongs to (a linked window can be reached through several).
  enter(windowId, session = '') {
    if (!windowId) return;
    if (this._leaveTimer) { clearTimeout(this._leaveTimer); this._leaveTimer = null; }
    this._target = { windowId, session };
    if (this._active && this._active.windowId === windowId) return;   // already showing it
    if (this._enterTimer) { clearTimeout(this._enterTimer); this._enterTimer = null; }
    // Start the capture NOW, not when the delay is over. A preview may only draw a
    // frame captured after it was asked for (see _entryFor), so that round trip has to
    // happen either way — running it DURING the enter delay is the difference between
    // the preview opening instantly and it opening a round trip late. On the engaged
    // path _show asks immediately anyway; this settles briefly first so a sweep across
    // a strip of tabs doesn't fork a capture per tab.
    this._schedulePrefetch(windowId);
    if (this._engaged) { this._show(windowId, session); return; }
    this._enterTimer = setTimeout(() => {
      this._enterTimer = null;
      // Only proceed if this is still the target (a fast sweep may have moved on).
      if (this._target?.windowId === windowId) this._show(windowId, session);
    }, ENTER_DELAY_MS);
  }

  // Stop pointing at a target. Deliberately does NOT tear down at once: the grace
  // window lets the pointer cross a gap onto the next tab/row without the preview
  // blinking out and re-pausing. Ending the hover for real (leaving the whole strip)
  // is just this call with nothing cancelling it.
  leave() {
    if (this._enterTimer) { clearTimeout(this._enterTimer); this._enterTimer = null; }
    this._cancelPrefetch();
    if (this._leaveTimer) clearTimeout(this._leaveTimer);
    this._leaveTimer = setTimeout(() => this.cancel(), LEAVE_GRACE_MS);
  }

  // Drop the preview NOW and restore the region — Escape, or any state change that
  // invalidates the browse (the tab was removed, the overlay closed, …). No grace.
  cancel() {
    if (this._enterTimer) { clearTimeout(this._enterTimer); this._enterTimer = null; }
    if (this._leaveTimer) { clearTimeout(this._leaveTimer); this._leaveTimer = null; }
    this._cancelPrefetch();
    this._engaged = false;
    this._target = null;
    this._dropActive(true);
    this._notify();
  }

  // COMMIT: make the previewed window the region's real window. This is the only
  // durable action — everything above is transient. Committing lands the window in
  // the SAME region the preview was showing in (what you looked at is what switches),
  // falling back to the focused region when nothing was drawn.
  commit(windowId, session = '') {
    const id = windowId || this._target?.windowId;
    if (!id) return;
    const sess = windowId ? session : (this._target?.session || '');
    const unit = this._active?.unit || this._unitFor(id) || this.manager.focusedUnit;
    // Restore WITHOUT asking tmux to repaint — the switch below repaints anyway, and
    // a refresh racing a select-window just flashes the old screen.
    if (this._enterTimer) { clearTimeout(this._enterTimer); this._enterTimer = null; }
    if (this._leaveTimer) { clearTimeout(this._leaveTimer); this._leaveTimer = null; }
    this._cancelPrefetch();
    this._engaged = false;
    this._target = null;
    this._dropActive(false);
    this.manager.goToWindowIn(unit, id, sess);
    this._notify();
  }

  // ---- internals ---------------------------------------------------------------

  // Queue the capture request for a window we've started pointing at. Runs after a
  // short settle so crossing a tab on the way somewhere else costs nothing.
  _schedulePrefetch(windowId) {
    // Already queued for this window: leave it be. Restarting the timer on a repeat
    // enter() for the same target would push the request back every time and, for any
    // caller that re-enters on a tick, mean it never goes out at all.
    if (this._prefetchTimer && this._prefetchWindowId === windowId) return;
    this._cancelPrefetch();
    this._prefetchWindowId = windowId;
    this._prefetchTimer = setTimeout(() => {
      this._prefetchTimer = null;
      if (this._target?.windowId !== windowId) return;   // swept past it
      this._ask(windowId);
    }, PREFETCH_DELAY_MS);
  }

  _cancelPrefetch() {
    if (this._prefetchTimer) { clearTimeout(this._prefetchTimer); this._prefetchTimer = null; }
    this._prefetchWindowId = null;
  }

  // Ask the server for `windowId`'s screen and return the timestamp the reply must
  // beat to count as fresh. A request for this window that's still plausibly in flight
  // is reused rather than duplicated — that's what makes _prefetch and _show agree on
  // ONE capture per hover rather than two a fifth of a second apart.
  _ask(windowId) {
    const now = Date.now();
    const prior = this._asked;
    if (prior && prior.windowId === windowId && now - prior.at < REQUEST_TRUST_MS) return prior.at;
    this._cancelPrefetch();
    this._asked = { windowId, at: now };
    this.manager.captureCache?.request([windowId], true);
    return now;
  }

  // Draw `windowId` somewhere sensible, per the three rules at the top.
  _show(windowId, session) {
    const mgr = this.manager;
    // Already on screen in some region → nothing to draw. Stay "engaged" so moving
    // on to the NEXT tab still previews instantly (the pointer never left the strip),
    // and restore any region we were holding for a previous target.
    if (this._visibleUnit(windowId)) {
      this._engaged = true;
      this._dropActive(true);
      this._notify();
      return;
    }
    const unit = this._unitFor(windowId) || mgr.focusedUnit;
    if (!unit || !unit.terminal) return;
    const realId = unit._targetWindowId || unit.layout?.activeWindowId || null;
    if (realId === windowId) { this._engaged = true; this._dropActive(true); this._notify(); return; }

    // Re-host onto a different region: put the old one back first.
    if (this._active && this._active.unit !== unit) this._dropActive(true);

    if (!this._active) {
      mgr.captureCache?.addEventListener('update', this._onCacheUpdate);
      this._pollTimer = setInterval(() => {
        if (this._active) mgr.captureCache?.request([this._active.windowId], true);
      }, POLL_MS);
    }
    // Commit to the target BEFORE anything is drawn, stamped with the request whose
    // reply we're waiting on. The region isn't taken and isn't marked yet — that
    // happens in _paint, if and when a frame dated at/after `since` arrives.
    this._active = { unit, windowId, session, realWindowId: realId, since: this._ask(windowId) };
    this._engaged = true;
    this._paint();
    this._notify();
  }

  // The capture to draw for the active target, or null while we're still WAITING for
  // one. Prefers the capture for the placement we're browsing THROUGH (a linked
  // window's index differs per session) and falls back to the window's representative
  // frame.
  //
  // A frame older than the request is REFUSED rather than drawn. The cache only
  // refreshes while something is polling it, so a leftover entry can be arbitrarily
  // old, and a preview that opens on one is indistinguishable from a live view of a
  // window that happens to be quiet — the worst kind of wrong, because there is
  // nothing on screen to doubt.
  _entryFor(a) {
    const cache = this.manager.captureCache;
    const entry = cache?.byPlacement?.get(placementKey(a.session, a.windowId)) || cache?.get(a.windowId);
    if (!entry) return null;
    return entry.capturedAt * 1000 >= a.since - CAPTURE_TS_RESOLUTION_MS ? entry : null;
  }

  // Blit the previewed window's frame into the host region's xterm, taking the region
  // (and marking it) on the first frame. Until then this is a no-op and the region
  // carries on showing its own live window — a preview that hasn't got a screen yet
  // must look like no preview at all, not like a preview of the wrong thing.
  _paint() {
    const a = this._active;
    if (!a) return;
    const entry = this._entryFor(a);
    if (!entry) return;
    const term = a.unit.terminal;
    if (!term) return;
    this._hold(a.unit);
    this._fit(a.unit, entry);
    term.write('\x1b[H\x1b[2J');
    term.write(CaptureCache.decodeAnsi(entry));
  }

  // Take a region for previewing: buffer its own output (replayed on release) and
  // mark it. Idempotent for the region we already hold, so browsing from one window
  // to another within a region keeps the single hold — and the ORIGINAL geometry it
  // recorded, which is what release has to restore.
  _hold(unit) {
    if (this._held?.unit === unit) return;
    if (this._held) this._release(true, this._held.realWindowId);
    unit.beginPreviewHold();
    unit.region?.classList.add('previewing');
    this._held = {
      unit,
      cols: unit.terminal?.cols || 0,
      rows: unit.terminal?.rows || 0,
      // What this region was really on — remembered on the HOLD, not just on _active,
      // so releasing it always knows what to put back even if the target has moved on.
      realWindowId: this._active?.realWindowId || null,
    };
  }

  // Match the host xterm to the captured pane's geometry. A capture is a fixed
  // cols×rows grid of ALREADY-WRAPPED lines: written into a terminal of a different
  // width, every line past the edge wraps again (or is clipped) and the screen reads
  // as garbage — box drawing, TUI panels and wrapped prose all shear. Exposé and the
  // PiP dodge this by building a throwaway xterm per capture; a preview borrows a REAL
  // region, so it resizes the region's terminal instead and scales it down when the
  // captured pane is larger than the region can show. Safe because sendResize() only
  // fires from the region's ResizeObserver (a DOM box change) — resizing the xterm
  // programmatically, and CSS-scaling it, tell tmux nothing.
  _fit(unit, entry) {
    const term = unit.terminal;
    const held = this._held;
    const cols = entry.cols | 0;
    const rows = entry.rows | 0;
    if (!term || !held || !cols || !rows) return;
    try {
      if (term.cols !== cols || term.rows !== rows) term.resize(cols, rows);
    } catch (e) {
      return;   // resize refused — better a mis-wrapped preview than a broken region
    }
    const host = unit.terminalEl;
    if (!host || !held.cols || !held.rows) return;
    // Scale only DOWN, and derive the factor from the GRIDS rather than by measuring
    // pixels: the region's own cols×rows (recorded at hold time) is what the fit addon
    // sized to fill this container, so at a fixed cell size the ratio of grids IS the
    // ratio of pixels. No waiting for the resize to reach the DOM, and — unlike a
    // bounding-rect measurement — nothing that the scale already on the element from
    // the previous frame could feed back into.
    const k = Math.min(1, held.cols / cols, held.rows / rows);
    host.style.transformOrigin = 'top left';
    host.style.transform = k < 1 ? `scale(${k})` : '';
  }

  // Hand the region back completely: undo the geometry, restore its own screen, and
  // stop buffering its output. `restore` false means the caller is switching the
  // region to another window anyway (commit), so the buffered bytes and the repaint
  // would only flash the window we're leaving.
  _release(restore, realWindowId) {
    const h = this._held;
    this._held = null;
    if (!h) return;
    const unit = h.unit;
    unit.region?.classList.remove('previewing');
    // Geometry FIRST: the optimistic repaint below and the buffered bytes replayed
    // inside endPreviewHold are both in the region's real dimensions, so they must
    // land in a terminal that is back to those dimensions. fit() has to run unscaled
    // — it sizes from the host's bounding box, which a leftover transform would lie
    // about.
    try {
      const host = unit.terminalEl;
      if (host) { host.style.transform = ''; host.style.transformOrigin = ''; }
      if (h.cols && h.rows && unit.terminal
          && (unit.terminal.cols !== h.cols || unit.terminal.rows !== h.rows)) {
        unit.terminal.resize(h.cols, h.rows);
      }
      unit.fitAddon?.fit();
    } catch (e) { /* the region may be tearing down — the repaint below still tries */ }
    // Put the region's OWN screen back straight away from the capture cache, so the
    // handover looks instant, then replay what it printed while we held it. tmux's
    // repaint (inside endPreviewHold) lands a moment later and makes it exact — this
    // is only to avoid a beat of the previewed window still sitting there.
    const realId = realWindowId || h.realWindowId;
    let painted = false;
    if (restore && realId) { try { painted = unit.paintOptimistic(realId); } catch (e) {} }
    // Nothing fresh enough to paint back (the region's own window isn't the one we've
    // been polling, so its buffer may well have aged out): clear instead of leaving the
    // previewed window's screen — now reflowed by the resize above — sitting there
    // looking like this region's content until tmux's repaint arrives.
    if (restore && !painted) { try { unit.terminal?.write('\x1b[H\x1b[2J'); } catch (e) {} }
    unit.endPreviewHold({ restore });
  }

  // Release the held region (if we ever took one) and stop tracking the target.
  // `restore` asks tmux to repaint it (the normal path); commit() passes false because
  // its own window switch repaints.
  _dropActive(restore) {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
    this.manager.captureCache?.removeEventListener('update', this._onCacheUpdate);
    const a = this._active;
    this._active = null;
    // No hold means we were still waiting for a frame and never touched the region —
    // there is nothing to give back.
    this._release(restore, a?.realWindowId);
  }

  // The unit a preview of `windowId` should land in (rule 1), or null for "use the
  // focused one". A remembered unit that has since been closed is ignored.
  _unitFor(windowId) {
    const u = this._lastUnit.get(windowId);
    if (u && this.manager.units.includes(u)) return u;
    return null;
  }

  // The unit currently DISPLAYING windowId for real, if any (rule 3). The region we
  // are ourselves HOLDING doesn't count — its real window is hidden behind a preview.
  // (A region we've targeted but not yet drawn into is still showing its own window,
  // so it does count.)
  _visibleUnit(windowId) {
    return this.manager.units.find((u) =>
      u !== this._held?.unit && (u._targetWindowId || u.layout?.activeWindowId) === windowId) || null;
  }

  // Let the switchers repaint their "this row is being previewed" highlight.
  _notify() {
    try { this.manager.onHoverPreviewChange?.(); } catch (e) { /* cosmetic only */ }
  }
}
