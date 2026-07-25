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

export class HoverPreview {
  constructor(manager) {
    this.manager = manager;
    // windowId -> the TerminalUnit that last actually displayed it. Fed by
    // SplitManager on every layout change; the "where does this window live" memory.
    this._lastUnit = new Map();
    this._enterTimer = null;
    this._leaveTimer = null;
    this._pollTimer = null;
    this._engaged = false;   // a preview is up (or within its leave grace)
    // The live preview: which window is shown, in which unit, and what that unit
    // was REALLY on so we can put it back.
    this._active = null;     // { unit, windowId, session, realWindowId }
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
  // target may still be set, e.g. when it's already visible elsewhere).
  get activeUnit() { return this._active?.unit || null; }

  // Remember where a window really lives. Called by SplitManager whenever a region
  // lands on a window, so rule 1 above has something to consult.
  noteRendered(windowId, unit) {
    if (windowId && unit) this._lastUnit.set(windowId, unit);
  }

  // A region went away: drop it from the memory so a stale unit can never be chosen
  // as a preview host (rule 1's "if that region still exists").
  forgetUnit(unit) {
    for (const [id, u] of [...this._lastUnit]) if (u === unit) this._lastUnit.delete(id);
    if (this._active?.unit === unit) this._dropActive(false);
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
    if (this._leaveTimer) clearTimeout(this._leaveTimer);
    this._leaveTimer = setTimeout(() => this.cancel(), LEAVE_GRACE_MS);
  }

  // Drop the preview NOW and restore the region — Escape, or any state change that
  // invalidates the browse (the tab was removed, the overlay closed, …). No grace.
  cancel() {
    if (this._enterTimer) { clearTimeout(this._enterTimer); this._enterTimer = null; }
    if (this._leaveTimer) { clearTimeout(this._leaveTimer); this._leaveTimer = null; }
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
    this._engaged = false;
    this._target = null;
    this._dropActive(false);
    this.manager.goToWindowIn(unit, id, sess);
    this._notify();
  }

  // ---- internals ---------------------------------------------------------------

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
      unit.beginPreviewHold();
      unit.region?.classList.add('previewing');
      mgr.captureCache?.addEventListener('update', this._onCacheUpdate);
      this._pollTimer = setInterval(() => {
        if (this._active) mgr.captureCache?.request([this._active.windowId], true);
      }, POLL_MS);
    }
    this._active = { unit, windowId, session, realWindowId: realId };
    this._engaged = true;
    mgr.captureCache?.request([windowId], true);
    this._paint();
    this._notify();
  }

  // Blit the previewed window's cached frame into the held region's xterm. Prefers
  // the capture for the placement we're browsing THROUGH (a linked window's index
  // differs per session) and falls back to the window's representative frame.
  _paint() {
    const a = this._active;
    if (!a) return;
    const cache = this.manager.captureCache;
    const entry = cache?.byPlacement?.get(placementKey(a.session, a.windowId)) || cache?.get(a.windowId);
    if (!entry) return;   // nothing captured yet — leave the region as it was
    const term = a.unit.terminal;
    if (!term) return;
    term.write('\x1b[H\x1b[2J');
    term.write(CaptureCache.decodeAnsi(entry));
  }

  // Release the held region. `restore` asks tmux to repaint it (the normal path);
  // commit() passes false because its own window switch repaints.
  _dropActive(restore) {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
    this.manager.captureCache?.removeEventListener('update', this._onCacheUpdate);
    const a = this._active;
    this._active = null;
    if (!a) return;
    a.unit.region?.classList.remove('previewing');
    // Put the region's OWN screen back straight away from the capture cache, so the
    // handover looks instant, then replay what it printed while we held it. tmux's
    // repaint (inside endPreviewHold) lands a moment later and makes it exact — this
    // is only to avoid a beat of the previewed window still sitting there.
    if (restore && a.realWindowId) { try { a.unit.paintOptimistic(a.realWindowId); } catch (e) {} }
    a.unit.endPreviewHold({ restore });
  }

  // The unit a preview of `windowId` should land in (rule 1), or null for "use the
  // focused one". A remembered unit that has since been closed is ignored.
  _unitFor(windowId) {
    const u = this._lastUnit.get(windowId);
    if (u && this.manager.units.includes(u)) return u;
    return null;
  }

  // The unit currently DISPLAYING windowId for real, if any (rule 3). The region we
  // are ourselves holding for a preview doesn't count — its real window is hidden.
  _visibleUnit(windowId) {
    return this.manager.units.find((u) =>
      u !== this._active?.unit && (u._targetWindowId || u.layout?.activeWindowId) === windowId) || null;
  }

  // Let the switchers repaint their "this row is being previewed" highlight.
  _notify() {
    try { this.manager.onHoverPreviewChange?.(); } catch (e) { /* cosmetic only */ }
  }
}
