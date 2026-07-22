// WebTmux — bootstrap. Wires up a single TerminalUnit (the primary/shared region)
// for the classic single-view. Phase C swaps this for a SplitManager that owns N
// units; the split-view work keeps all terminal logic in TerminalUnit so this
// stays a thin entry point.
import { TerminalUnit } from './terminal-unit.js';

// Register the custom elements (side-effect imports).
import './components/sidebar.js';
import './components/mobile-controls.js';

// Global sidebar toggle (Ctrl+Alt+B / mac Control+Option+B). Registered once on
// window in the CAPTURE phase so it works regardless of what has keyboard focus
// — a terminal, a sidebar window tab, or nothing. (It used to live only in the
// terminal's key handler, so it silently died whenever focus left the terminal.)
// stopPropagation keeps xterm from also seeing the key. Requires Alt so it can't
// collide with tmux's Ctrl-b prefix; ev.code dodges macOS Option-key remapping.
// resolveSidebar() returns the sidebar to toggle (the focused unit's in a split).
function installGlobalShortcuts(resolveSidebar) {
  window.addEventListener('keydown', (ev) => {
    if (ev.ctrlKey && ev.altKey && !ev.metaKey && ev.code === 'KeyB') {
      const sb = resolveSidebar();
      if (sb) sb.toggleCollapsed();
      ev.preventDefault();
      ev.stopPropagation();
    }
  }, true);
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  const terminalEl = document.getElementById('terminal');
  const sidebar = document.querySelector('webtmux-sidebar');

  const unit = new TerminalUnit({
    sessionName: '',        // primary/shared base session (services)
    terminalEl,
    sidebar,
    primary: true,
  });

  // Compatibility shim: mobile-controls (single-terminal, never splits) still
  // reaches the active terminal via window.webtmux. Points at the primary unit.
  window.webtmux = unit;

  installGlobalShortcuts(() => sidebar);
});
