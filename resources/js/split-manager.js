// SplitManager — owns an ordered list of TerminalUnits tiled side by side, a
// focused unit, and the split/close controls. The first unit is the PRIMARY
// region on the shared base session (stays in sync with the ssh console); each
// added region gets a freshly generated grouped-session name so it has its own
// current window while sharing the window list. Only the focused region's
// sidebar is shown — the "one sidebar" illusion.
import { TerminalUnit } from './terminal-unit.js';

export class SplitManager {
  constructor(container) {
    this.container = container;   // #app — holds .region elements + .divider bars
    this.units = [];
    this.focusedUnit = null;

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

    // Region DOM: a flex row of [terminal | its sidebar]. A divider precedes
    // every region after the first.
    if (this.units.length > 0) {
      const divider = document.createElement('div');
      divider.className = 'divider';
      this.container.appendChild(divider);
    }
    const region = document.createElement('div');
    region.className = 'region';
    region.dataset.session = sessionName || 'primary';
    const term = document.createElement('div');
    term.className = 'region-term';
    const sidebar = document.createElement('webtmux-sidebar');
    region.appendChild(term);
    region.appendChild(sidebar);
    this.container.appendChild(region);

    const unit = new TerminalUnit({ sessionName, terminalEl: term, sidebar, primary });
    unit.region = region;
    unit.onFocus = (u) => this.focus(u);
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
    // Each region keeps its OWN sidebar (scoped to its region — see the `split`
    // class in _syncSplitClass), so a pane always controls the region it sits in.
    // Focus only moves the highlight + keyboard focus; it never hides a sidebar.
    for (const u of this.units) {
      u.region.classList.toggle('focused', u === unit);
    }
    unit.terminal?.focus();
  }

  // Add a region and, once its layout arrives, auto-select a window not already
  // shown by another region ("next unused window") so the split is immediately useful.
  splitAdd() {
    const unit = this.addUnit({});
    unit._autoPickPending = true;
    unit.onLayout = (u) => {
      if (!u._autoPickPending || !u.layout) return;
      const used = new Set(
        this.units.filter(x => x !== u).map(x => x.layout?.activeWindowId).filter(Boolean)
      );
      const target = (u.layout.windows || []).find(w => !used.has(w.id));
      if (target && target.id !== u.layout.activeWindowId) u.selectWindow(target.id);
      u._autoPickPending = false;
    };
    return unit;
  }

  closeFocused() {
    if (this.focusedUnit && !this.focusedUnit.primary) this.removeUnit(this.focusedUnit);
  }

  // #app gets .split-active only with >1 region, so single-view keeps its exact
  // old look (no focus outline, no divider). In split mode each sidebar also gets
  // the `split` class, which scopes its overlay/collapsed positioning to its own
  // region (position:absolute within the region) instead of viewport-fixed — so a
  // region's pane floats over ITS terminal, not over a neighbouring region.
  _syncSplitClass() {
    const split = this.units.length > 1;
    this.container.classList.toggle('split-active', split);
    for (const u of this.units) {
      if (u.sidebar) {
        u.sidebar.classList.toggle('split', split);
        u.sidebar.style.display = '';   // no focus-based hiding anymore
      }
    }
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
        case 'KeyB':                                   // toggle focused region's sidebar
          this.focusedUnit?.sidebar?.toggleCollapsed();
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
    window.addEventListener('webtmux-split-close', (e) => this.removeUnit(e.detail?.unit));
  }
}
