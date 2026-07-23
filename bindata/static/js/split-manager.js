// SplitManager — owns an ordered list of TerminalUnits tiled side by side, a
// focused unit, and ONE shared sidebar. The first unit is the PRIMARY region on
// the shared base session (stays in sync with the ssh console); each added region
// gets a freshly generated grouped-session name so it has its own current window
// while sharing the window list.
//
// One-sidebar illusion: there is a SINGLE <webtmux-sidebar> element, always in the
// same spot, bound to whichever region is FOCUSED. Clicking a region's terminal
// focuses it and the shared sidebar re-points to reflect/control that region.
import { TerminalUnit } from './terminal-unit.js';

export class SplitManager {
  constructor(container) {
    this.container = container;   // #app — holds .region elements, .divider bars, and the shared sidebar
    this.units = [];
    this.focusedUnit = null;

    // The single shared sidebar (last child of #app; its own CSS floats it at the
    // right — viewport-fixed in overlay/collapsed mode, or a 330px column in
    // side-by-side mode). Regions are inserted BEFORE it.
    this.sidebar = document.createElement('webtmux-sidebar');
    this.container.appendChild(this.sidebar);

    this._installControls();

    // The primary/shared region (session '' => base 'services').
    this.addUnit({ sessionName: '', primary: true });
  }

  // Short, sanitized, unique-ish grouped session name (server also sanitizes).
  genSessionName() {
    const rnd = Math.random().toString(36).slice(2, 8);
    return `web-${rnd}`;
  }

  addUnit({ sessionName = null, primary = false } = {}) {
    if (sessionName === null) sessionName = this.genSessionName();

    // Region DOM = just the terminal area (the sidebar is shared, not per-region).
    // A divider precedes every region after the first. Insert BEFORE the shared
    // sidebar so it stays rightmost.
    if (this.units.length > 0) {
      const divider = document.createElement('div');
      divider.className = 'divider';
      this.container.insertBefore(divider, this.sidebar);
    }
    const region = document.createElement('div');
    region.className = 'region';
    region.dataset.session = sessionName || 'primary';
    const term = document.createElement('div');
    term.className = 'region-term';
    region.appendChild(term);
    this.container.insertBefore(region, this.sidebar);

    const unit = new TerminalUnit({ sessionName, terminalEl: term, primary });
    unit.region = region;
    unit.onFocus = (u) => this.focus(u);
    unit.onLayout = (u) => this._onUnitLayout(u);
    // Clicking the terminal collapses the shared sidebar out of the way (unless pinned).
    unit.onTerminalMousedown = () => {
      const sb = this.sidebar;
      if (sb && !sb.collapsed && !sb.pinned) sb.collapsed = true;
    };
    // Clicking anywhere in the region (even outside the terminal) focuses it.
    region.addEventListener('mousedown', () => this.focus(unit), true);

    this.units.push(unit);
    this._syncSplitClass();
    this.focus(unit);
    this._refitSoon();
    return unit;
  }

  removeUnit(unit) {
    if (!unit || unit.primary) return;   // never remove the console-synced primary
    const idx = this.units.indexOf(unit);
    if (idx === -1) return;

    unit.destroy();   // closes its ws -> the grouped session self-reaps (destroy-unattached)

    // Remove the region and exactly one adjacent divider.
    const region = unit.region;
    const prev = region.previousElementSibling;
    const next = region.nextElementSibling;
    if (prev && prev.classList.contains('divider')) prev.remove();
    else if (next && next.classList.contains('divider')) next.remove();
    region.remove();

    this.units.splice(idx, 1);
    this._syncSplitClass();
    this.focus(this.units[Math.min(idx, this.units.length - 1)] || this.units[0]);
    this._refitSoon();
  }

  focus(unit) {
    if (!unit) return;
    this.focusedUnit = unit;
    // Compat shim: mobile-controls + any global shortcut target the focused unit.
    window.webtmux = unit;
    for (const u of this.units) {
      u.region.classList.toggle('focused', u === unit);
    }
    // Re-point the single shared sidebar at the focused region and paint its state.
    this.sidebar.unit = unit;
    this._pushLayout(unit);
    unit.terminal?.focus();
  }

  // Forward a unit's layout to the shared sidebar ONLY when it is the focused
  // region (so the one sidebar always reflects the focused window), and drive the
  // "next unused window" auto-pick for a freshly added region.
  _onUnitLayout(unit) {
    if (unit === this.focusedUnit) this._pushLayout(unit);
    else this._pushDisabled();   // another region moved -> refresh what's occupied

    if (unit._autoPickPending && unit.layout) {
      const used = new Set(
        this.units.filter(x => x !== unit).map(x => x.layout?.activeWindowId).filter(Boolean)
      );
      const target = (unit.layout.windows || []).find(w => !used.has(w.id));
      if (target && target.id !== unit.layout.activeWindowId) unit.selectWindow(target.id);
      unit._autoPickPending = false;
    }
  }

  _pushLayout(unit) {
    const sb = this.sidebar;
    sb.layout = unit.layout || null;
    sb.activePane = unit.layout?.activePaneId || '';
    sb.activeWindow = unit.layout?.activeWindowId || '';
    this._pushDisabled();
  }

  // Tell the shared sidebar which windows are already shown by OTHER regions, so it
  // can grey them out / skip them — two panes on the same window share it (tmux
  // grouped sessions) and would stay in sync, which is exactly what we prevent.
  _pushDisabled() {
    const focused = this.focusedUnit;
    if (!focused) return;
    this.sidebar.disabledWindows = this.units
      .filter(u => u !== focused)
      .map(u => u.layout?.activeWindowId)
      .filter(Boolean);
  }

  // Add a region and, once its layout arrives, auto-select a window not already
  // shown by another region ("next unused window") so the split is immediately useful.
  splitAdd() {
    const unit = this.addUnit({});
    unit._autoPickPending = true;
    return unit;
  }

  closeFocused() {
    if (this.focusedUnit && !this.focusedUnit.primary) this.removeUnit(this.focusedUnit);
  }

  // #app gets .split-active only with >1 region, so single-view keeps its exact
  // old look (no focus outline, no divider).
  _syncSplitClass() {
    this.container.classList.toggle('split-active', this.units.length > 1);
  }

  _refitSoon() {
    setTimeout(() => { for (const u of this.units) { try { u.fit(); } catch (e) {} } }, 60);
  }

  _installControls() {
    // Global shortcuts (capture phase, Alt-based so they never hit tmux's Ctrl-b
    // and browsers don't reserve them). stopPropagation keeps xterm from seeing them.
    window.addEventListener('keydown', (ev) => {
      if (!ev.ctrlKey || !ev.altKey || ev.metaKey) return;
      switch (ev.code) {
        case 'KeyB':                                   // toggle the shared sidebar
          this.sidebar?.toggleCollapsed();
          break;
        case 'Enter':                                  // add a split region
          this.splitAdd();
          break;
        case 'Backspace':                              // close focused region
          this.closeFocused();
          break;
        default:
          return;                                      // not ours — let it through
      }
      ev.preventDefault();
      ev.stopPropagation();
    }, true);

    // Buttons in the sidebar dispatch these (composed, cross shadow DOM).
    window.addEventListener('webtmux-split-add', () => this.splitAdd());
    window.addEventListener('webtmux-split-close', (e) => this.removeUnit(e.detail?.unit || this.focusedUnit));
  }
}
