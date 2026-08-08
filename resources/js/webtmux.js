// WebTmux — bootstrap. Creates the SplitManager, which owns the primary region
// (shared base session, in sync with the ssh console) plus any split regions the
// user adds (Ctrl+Alt+Enter, or the sidebar's "Split view" button). All terminal
// logic lives in TerminalUnit; all layout/focus/controls in SplitManager.
import { SplitManager } from './split-manager.js';

// Register the custom elements (side-effect imports).
import './components/sidebar.js';
import './components/copy-sidebar.js';
import './components/mobile-controls.js';
import './components/expose-overlay.js';
import './components/pip-overlay.js';
import './components/toolbar.js';
import './components/shortcuts-overlay.js';

document.addEventListener('DOMContentLoaded', () => {
  const app = document.getElementById('app');
  // Exposed for debugging / the mobile-controls compat path.
  window.splitManager = new SplitManager(app);
});
