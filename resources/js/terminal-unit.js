// TerminalUnit — one self-contained terminal region: an xterm instance, its own
// websocket to a specific tmux session (grouped or the shared base), all of the
// input/copy/scroll/selection handling, and the sidebar element bound to it.
//
// Extracted from the former monolithic WebTmux class so the split view can run N
// of these side by side, each driving its OWN grouped session + sidebar. A unit
// is keyed to a `sessionName` (empty = the shared base / primary region) and a
// pair of DOM elements: the div xterm opens into, and its sidebar component.
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { CaptureCache } from './capture-cache.js';

// Protocol message types (must match Go constants)
export const MSG = {
  // Input (client -> server)
  Input: '1',
  Ping: '2',
  ResizeTerminal: '3',
  SetEncoding: '4',
  TmuxSelectPane: '5',
  TmuxSelectWindow: '6',
  TmuxSplitPane: '7',
  TmuxClosePane: '8',
  TmuxCopyMode: '9',
  TmuxScrollUp: 'B',
  TmuxScrollDown: 'C',
  TmuxNewWindow: 'D',
  TmuxSwitchSession: 'E',
  TmuxRenameWindow: 'F',
  TmuxCaptureRequest: 'G',
  TmuxMoveWindow: 'H',
  TmuxNewSession: 'I',
  TmuxRenameSession: 'J',
  TmuxKillWindow: 'K',
  TmuxKillSession: 'L',
  TmuxLinkWindow: 'M',
  TmuxUnlinkWindow: 'N',

  // Output (server -> client)
  Output: '1',
  Pong: '2',
  SetWindowTitle: '3',
  SetPreferences: '4',
  SetReconnect: '5',
  SetBufferSize: '6',
  TmuxLayoutUpdate: '7',
  TmuxModeUpdate: '9',
  TmuxCaptureData: 'A',
};

// Scroll-wheel behavior. Cycled by the sidebar button through all four:
//   app            — always pass the wheel to the program (Claude/vim/less)
//   buffer         — always scroll tmux history (copy-mode)
//   adaptive-mode  — decide per-event from xterm's terminal mode state
//                    (mouse-tracking / alt-screen): apps that grab the mouse or
//                    own the screen get the wheel; a plain shell scrolls history
//   adaptive-probe — like adaptive, but for the ambiguous no-mouse case it PROBES:
//                    let the wheel hit the app, then compare the viewport a moment
//                    later; if it barely changed the app ignored it, so switch to
//                    history scroll. Decision is cached per (window, command).
export const SCROLL_MODES = ['app', 'buffer', 'adaptive-mode', 'adaptive-probe'];

// Map any stored/legacy value onto a valid mode. The old two-state setting used
// 'passthrough' for what is now 'app'.
export function normalizeScrollMode(m) {
  if (m === 'passthrough') return 'app';
  // Default (unset / unknown) is 'auto+' (adaptive-probe): the smartest mode —
  // full-screen / mouse-tracking apps get the wheel, a plain shell scrolls history,
  // and the ambiguous no-mouse case is probed. Kept in sync with the sidebar mirror.
  return SCROLL_MODES.includes(m) ? m : 'adaptive-probe';
}

export class TerminalUnit {
  // opts:
  //   sessionName: '' for the primary/shared region, or a grouped session name.
  //   terminalEl:  the div xterm opens into (this unit's terminal area).
  //   primary:     true for the first/primary unit — it also broadcasts the
  //                global 'tmux-layout-update' event that mobile-controls listens
  //                to (mobile is single-terminal and never splits).
  //   onTitle:     optional callback(title) when the server sets the window title.
  // The sidebar is NOT per-unit: SplitManager owns one shared sidebar and binds it
  // to the focused unit. This unit signals via onFocus/onLayout/onTerminalMousedown.
  constructor({ sessionName = '', terminalEl, primary = false, onTitle = null } = {}) {
    this.sessionName = sessionName;
    this.terminalEl = terminalEl;
    this.primary = primary;
    this.onTitle = onTitle;

    this.terminal = null;
    this.fitAddon = null;
    this.ws = null;
    this.reconnectInterval = null;
    this.bufferSize = 1024 * 1024;
    this.inCopyMode = false;
    // Scroll-wheel behavior: 'buffer' (default) = wheel drives tmux copy-mode
    // history scrolling; 'passthrough' = let xterm forward the wheel to the app
    // (so a TUI like Claude, vim, less handles its own scrolling). Persisted +
    // toggled from the sidebar. Read here so the handlers below see it on load.
    this.scrollMode = normalizeScrollMode(localStorage.getItem('webtmux-scroll-mode'));
    // adaptive-probe state: per-window cached decision + in-flight probe.
    this._scrollDecisions = new Map();   // windowId -> {cmd, decision:'app'|'buffer', ts}
    this._probing = false;
    this._probeBefore = null;
    this._probeLines = 0;
    this.PROBE_DELAY_MS = 130;           // wait this long for the app to react
    this.PROBE_COOLDOWN_MS = 15000;      // reuse a decision this long (refreshed while scrolling)
    this.PROBE_CELL_FRAC = 0.15;         // >=15% of cells changed => the app reacted
    this.PROBE_LINE_FRAC = 0.30;         // >=30% of lines changed => the app reacted
    this.layout = null;
    // View we're on (logical session + window), remembered so we can restore it
    // after a reconnect (tty loss) — the fresh attach otherwise resets us to the
    // base session's current window.
    this.desiredWindowId = null;
    this.desiredWindowIndex = null;
    this.desiredSession = null;
    this.restorePending = false;
    // Toolbar MRU bookkeeping (read by SplitManager): last window it recorded as a
    // toolbar "access", and window ids whose next arrival should NOT count (they
    // came from sidebar arrow-key WINDOW browsing). _suppressAccessNext is the
    // by-id-unknown variant for ←/→ SESSION browsing: the landing window id isn't
    // known until the new session's layout arrives, so we suppress the NEXT access.
    this._accessSeenId = null;
    this._suppressAccessIds = new Set();
    this._suppressAccessNext = false;
    this.oscBuffer = ''; // Buffer for OSC sequence detection
    this.resizeObserver = null;

    this.init();
  }

  init() {
    // Create terminal
    this.terminal = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      // The WebGL renderer rasterizes each glyph through the browser's canvas,
      // which falls back per-character across THIS list (and then system fonts).
      // The old stack was Mac-only (Menlo/Monaco/Courier New); on a Linux client
      // none resolve, so symbol/box-drawing glyphs Claude emits (●, ⎿, ✓, tree
      // rules) landed on a fallback that lacks them and rendered as broken boxes.
      // Lead with DejaVu Sans Mono (ubiquitous on Linux, full box-drawing + geometric
      // shapes) and keep the Mac fonts + a Noto symbol fallback so coverage is broad
      // on every client.
      fontFamily: '"DejaVu Sans Mono", Menlo, Monaco, "Cascadia Mono", "Noto Sans Mono", "Liberation Mono", "Courier New", "Symbols Nerd Font", monospace',
      // Correct wcwidth for modern Unicode (default tables are v6, which mis-measure
      // some of those same symbols → a width-2 glyph clipped into one cell reads as
      // garbage). Activated after loadAddon below.
      allowProposedApi: true,
      theme: {
        background: '#000000',
        foreground: '#eaeaea',
        cursor: '#f0f0f0',
        selection: 'rgba(255, 255, 255, 0.3)',
      },
      scrollback: 0, // tmux handles scrollback via copy mode
    });

    // Unicode 11 width tables — must load BEFORE the first write so wide glyphs
    // (geometric shapes, box-drawing, emoji) are measured correctly and don't clip.
    try {
      this.terminal.loadAddon(new Unicode11Addon());
      this.terminal.unicode.activeVersion = '11';
    } catch (e) {
      console.warn('Unicode11 addon not supported:', e);
    }

    // Add fit addon
    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);

    // Open terminal
    const container = this.terminalEl;
    this.terminal.open(container);

    // Try to load WebGL addon
    try {
      const webglAddon = new WebglAddon();
      this.terminal.loadAddon(webglAddon);
    } catch (e) {
      console.warn('WebGL addon not supported:', e);
    }

    // Fit terminal and focus
    this.fitAddon.fit();
    this.terminal.focus();

    // Setup resize observer
    this.resizeObserver = new ResizeObserver(() => {
      this.fitAddon.fit();
      this.sendResize();
    });
    this.resizeObserver.observe(container);

    // Setup input handling
    this.encoder = new TextEncoder();

    // Intercept arrow keys and control chars to ensure correct sequences
    this.terminal.attachCustomKeyEventHandler((ev) => {
      // Only handle keydown events
      if (ev.type !== 'keydown') return true;

      // (Ctrl+Alt+W sidebar toggle is a global shortcut owned by the bootstrap /
      // split manager so it works regardless of which unit/pane has focus.)

      // Allow Cmd+C / Ctrl+C to copy selected text
      if ((ev.metaKey || ev.ctrlKey) && ev.key === 'c') {
        const selection = this.terminal.getSelection();
        if (selection) {
          navigator.clipboard.writeText(selection).catch(err => {
            console.warn('Failed to copy:', err);
          });
          // Clear the highlight once copied.
          this.terminal.clearSelection();
          // If we were scrolled into tmux copy-mode (buffer mode), drop back to
          // normal (edit) mode after copying so typing resumes at the prompt.
          if (this.inCopyMode) this.exitCopyMode();
          return false; // Handled
        }
        // No selection - let it pass through as Ctrl+C (interrupt)
        return true;
      }

      // Allow Cmd+V / Ctrl+V to paste
      if ((ev.metaKey || ev.ctrlKey) && ev.key === 'v') {
        ev.preventDefault(); // Prevent browser's native paste
        navigator.clipboard.readText().then(text => {
          if (text) {
            const bytes = this.encoder.encode(text);
            const binary = String.fromCharCode(...bytes);
            this.sendMessage(MSG.Input, btoa(binary));
          }
        }).catch(err => {
          console.warn('Failed to paste:', err);
        });
        return false; // Handled
      }

      // Map arrow keys to CSI sequences (ESC [ A/B/C/D)
      // Using CSI instead of SS3 for better compatibility
      const arrowMap = {
        'ArrowUp': '\x1b[A',
        'ArrowDown': '\x1b[B',
        'ArrowRight': '\x1b[C',
        'ArrowLeft': '\x1b[D',
      };

      if (arrowMap[ev.key]) {
        // Send raw CSI sequence
        const seq = arrowMap[ev.key];
        const binary = String.fromCharCode(...[...seq].map(c => c.charCodeAt(0)));
        this.sendMessage(MSG.Input, btoa(binary));
        return false; // Prevent xterm.js default handling
      }

      // Handle Ctrl+N (down) and Ctrl+P (up) for fzf navigation
      if (ev.ctrlKey && !ev.altKey && !ev.metaKey) {
        const ctrlMap = {
          'n': '\x0e', // Ctrl+N = 0x0e = 14
          'p': '\x10', // Ctrl+P = 0x10 = 16
          'j': '\x0a', // Ctrl+J = newline
          'k': '\x0b', // Ctrl+K
        };
        const key = ev.key.toLowerCase();
        if (ctrlMap[key]) {
          const binary = String.fromCharCode(ctrlMap[key].charCodeAt(0));
          this.sendMessage(MSG.Input, btoa(binary));
          return false;
        }
      }

      return true; // Let xterm.js handle other keys
    });

    this.terminal.onData((data) => {
      if (this.inCopyMode && data.length === 1) {
        // Exit copy mode on any key press (except scroll keys)
        this.sendMessage(MSG.TmuxCopyMode, '0');
        this.inCopyMode = false;
      }
      this.sendInput(data);
    });

    // Setup touch/scroll handling for copy mode
    this.setupTouchHandling();

    // Click-to-focus + drag-to-select with edge auto-scroll
    this.setupMouseSelection();

    // Connect WebSocket
    this.connect();
  }

  setupTouchHandling() {
    const container = this.terminalEl;
    let touchStartY = 0;

    // Touch handling for mobile scroll -> copy mode
    container.addEventListener('touchstart', (e) => {
      touchStartY = e.touches[0].clientY;
    }, { passive: true });

    container.addEventListener('touchmove', (e) => {
      // App-effective mode: leave touch scrolling to the app (mirror the wheel).
      if (this._resolveScroll() === 'app') return;
      const deltaY = touchStartY - e.touches[0].clientY;
      const threshold = 30;

      if (Math.abs(deltaY) > threshold) {
        if (!this.inCopyMode) {
          this.sendMessage(MSG.TmuxCopyMode, '1');
          this.inCopyMode = true;
        }

        const lines = Math.floor(Math.abs(deltaY) / 20);
        if (lines > 0) {
          // Swipe up (deltaY > 0) = scroll DOWN in history (show newer)
          // Swipe down (deltaY < 0) = scroll UP in history (show older)
          if (deltaY > 0) {
            this.sendMessage(MSG.TmuxScrollDown, String(lines));
          } else {
            this.sendMessage(MSG.TmuxScrollUp, String(lines));
          }
          touchStartY = e.touches[0].clientY;
        }
      }
    }, { passive: true });

    // Mouse wheel for desktop scroll -> copy mode. The effective behavior ('app'
    // = let xterm forward the wheel to the program; 'buffer' = scroll tmux
    // history) depends on this.scrollMode — see _resolveWheel / _resolveScroll.
    this.terminal.attachCustomWheelEventHandler((event) => {
      const lines = Math.max(1, Math.floor(Math.abs(event.deltaY) / 50));
      if (this._resolveWheel(event, lines) === 'app') {
        return true;   // don't hijack — xterm forwards to the app (or does nothing)
      }
      // Buffer behavior: wheel-up enters copy mode (entering history); then the
      // tmux scroll follows the wheel direction.
      if (event.deltaY < 0 && !this.inCopyMode) {
        this.sendMessage(MSG.TmuxCopyMode, '1');
        this.inCopyMode = true;
      }
      if (this.inCopyMode) {
        // Wheel up (deltaY < 0) = older history; down = newer.
        this.sendMessage(event.deltaY < 0 ? MSG.TmuxScrollUp : MSG.TmuxScrollDown, String(lines));
        return false; // Prevent default scroll
      }
      return true; // not in copy mode + wheel-down => nothing to do, pass through
    });
  }

  // ----- Scroll-mode resolution -------------------------------------------------

  // The effective behavior ('app' | 'buffer') for NON-wheel gestures (touch,
  // drag-select). The wheel uses _resolveWheel, which can additionally kick off
  // the adaptive-probe. Already in copy mode => always keep scrolling history.
  _resolveScroll() {
    if (this.inCopyMode) return 'buffer';
    switch (this.scrollMode) {
      case 'app': return 'app';
      case 'buffer': return 'buffer';
      case 'adaptive-mode': return this._modeDecision();
      case 'adaptive-probe': {
        if (this._mouseTracking()) return 'app';
        const cached = this._probeDecision(this.layout?.activeWindowId || '', this._activeCommand());
        return cached || this._modeDecision();   // no probe result yet -> best guess
      }
      default: return 'buffer';
    }
  }

  // The effective behavior for a wheel event. For adaptive-probe this may start a
  // probe (returning 'app' to let the event reach the program during the probe
  // window; if the program ignores it, _finishProbe replays the scroll to tmux).
  _resolveWheel(event, lines) {
    if (this.inCopyMode) return 'buffer';
    switch (this.scrollMode) {
      case 'app': return 'app';
      case 'buffer': return 'buffer';
      case 'adaptive-mode': return this._modeDecision();
      case 'adaptive-probe': {
        if (this._mouseTracking()) return 'app';     // app definitively owns the wheel
        const winId = this.layout?.activeWindowId || '';
        const cmd = this._activeCommand();
        const cached = this._probeDecision(winId, cmd);
        if (cached) return cached;
        // No fresh decision. Only wheel-UP (entering history) is worth probing;
        // let wheel-down pass through until we have a verdict.
        if (event.deltaY < 0) {
          if (this._probing) this._probeLines += lines;
          else this._beginProbe(winId, cmd, lines);
        }
        return 'app';   // pass through while probing
      }
      default: return 'buffer';
    }
  }

  // Deterministic decision from xterm's terminal mode state. An app that grabbed
  // the mouse, or that owns the whole screen (alt-screen), gets the wheel; a plain
  // shell on the normal screen scrolls tmux history.
  _modeDecision() {
    if (this._mouseTracking()) return 'app';
    if (this.terminal?.buffer?.active?.type === 'alternate') return 'app';
    return 'buffer';
  }

  _mouseTracking() {
    const m = this.terminal?.modes?.mouseTrackingMode;
    return !!m && m !== 'none';
  }

  // The foreground command of the focused pane, used to key probe decisions so a
  // decision auto-invalidates when the running program changes (bash -> vim -> bash).
  _activeCommand() {
    const l = this.layout;
    if (!l) return '';
    const w = (l.windows || []).find(x => x.id === l.activeWindowId);
    if (!w) return '';
    const p = (w.panes || []).find(x => x.id === l.activePaneId)
      || (w.panes || []).find(x => x.active);
    return p ? (p.command || '') : '';
  }

  // Cached probe verdict for (winId, cmd), or null if absent/stale/for another
  // command. A hit refreshes the timestamp so continuous scrolling never re-probes.
  _probeDecision(winId, cmd) {
    const e = this._scrollDecisions.get(winId);
    if (!e || e.cmd !== cmd) return null;
    if (Date.now() - e.ts > this.PROBE_COOLDOWN_MS) return null;
    e.ts = Date.now();
    return e.decision;
  }

  _beginProbe(winId, cmd, lines) {
    this._probing = true;
    this._probeWin = winId;
    this._probeCmd = cmd;
    this._probeLines = lines;
    this._probeBefore = this._snapshotViewport();
    setTimeout(() => this._finishProbe(), this.PROBE_DELAY_MS);
  }

  _finishProbe() {
    // Bail if we were torn down or the user left adaptive-probe mid-probe.
    if (this.destroyed || this.scrollMode !== 'adaptive-probe') {
      this._probing = false;
      this._probeBefore = null;
      return;
    }
    const reacted = this._viewportReacted(this._probeBefore, this._snapshotViewport());
    const decision = reacted ? 'app' : 'buffer';
    this._scrollDecisions.set(this._probeWin, { cmd: this._probeCmd, decision, ts: Date.now() });
    // The app ignored the wheel -> replay the ticks we swallowed into tmux history.
    if (decision === 'buffer' && this._probeLines > 0) {
      if (!this.inCopyMode) {
        this.sendMessage(MSG.TmuxCopyMode, '1');
        this.inCopyMode = true;
      }
      this.sendMessage(MSG.TmuxScrollUp, String(this._probeLines));
    }
    this._probing = false;
    this._probeBefore = null;
  }

  // The visible rows as trimmed strings (xterm's own buffer — no server round-trip).
  _snapshotViewport() {
    const buf = this.terminal?.buffer?.active;
    if (!buf) return [];
    const rows = this.terminal.rows || 24;
    const top = buf.viewportY;
    const out = [];
    for (let i = 0; i < rows; i++) {
      const ln = buf.getLine(top + i);
      out.push(ln ? ln.translateToString(true) : '');
    }
    return out;
  }

  // "Did the screen change substantially?" — count differing lines and, position
  // by position, differing cells; a real scroll shifts most of both, while a
  // spinner/clock/cursor touches only a sliver. Either fraction crossing its
  // threshold counts as a reaction.
  _viewportReacted(before, after) {
    if (!before || !after) return false;
    const rows = Math.min(before.length, after.length);
    if (!rows) return false;
    let changedLines = 0, changedCells = 0;
    for (let i = 0; i < rows; i++) {
      const a = before[i], b = after[i];
      if (a === b) continue;
      changedLines++;
      const n = Math.max(a.length, b.length);
      for (let j = 0; j < n; j++) { if (a[j] !== b[j]) changedCells++; }
    }
    const cols = this.terminal.cols || 80;
    const cellFrac = changedCells / (rows * cols);
    const lineFrac = changedLines / rows;
    return cellFrac >= this.PROBE_CELL_FRAC || lineFrac >= this.PROBE_LINE_FRAC;
  }

  // Click focuses the terminal; dragging to the top/bottom edge auto-scrolls the
  // tmux buffer (entering copy-mode) so a text selection can extend past the
  // visible screen. Only active in 'buffer' scroll mode (passthrough leaves the
  // mouse entirely to the app). We never preventDefault, so xterm's own text
  // selection keeps working underneath.
  setupMouseSelection() {
    const container = this.terminalEl;
    let startX = 0, startY = 0, dragging = false, edgeDir = 0, timer = null;

    const setEdge = (dir) => {
      if (dir === edgeDir) return;
      edgeDir = dir;
      if (timer) { clearInterval(timer); timer = null; }
      if (dir !== 0) {
        timer = setInterval(() => {
          if (!this.inCopyMode) {
            this.sendMessage(MSG.TmuxCopyMode, '1');
            this.inCopyMode = true;
          }
          this.sendMessage(edgeDir < 0 ? MSG.TmuxScrollUp : MSG.TmuxScrollDown, '2');
        }, 120);
      }
    };
    const endDrag = () => { dragging = false; setEdge(0); };

    container.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      this.focus();                     // click brings keyboard focus (+ focuses this unit)
      // Clicking into the terminal collapses the (single, shared) sidebar out of
      // the way — the owner (SplitManager) decides, honoring the pin toggle.
      if (this.onTerminalMousedown) this.onTerminalMousedown();
      startX = e.clientX; startY = e.clientY; dragging = false;
    });

    container.addEventListener('mousemove', (e) => {
      if ((e.buttons & 1) === 0) { endDrag(); return; }   // only while left-dragging
      if (this._resolveScroll() === 'app') return;        // leave the mouse to the app
      if (!dragging) {
        if (Math.abs(e.clientX - startX) + Math.abs(e.clientY - startY) < 5) return;
        dragging = true;
        // Enter tmux copy-mode as soon as a drag starts. This takes the pane out
        // of the app's mouse grab (Claude/vim), so xterm does a LOCAL text
        // selection immediately instead of forwarding the drag to the app —
        // matching the behavior you otherwise only get after scrolling first.
        if (!this.inCopyMode) {
          this.sendMessage(MSG.TmuxCopyMode, '1');
          this.inCopyMode = true;
        }
      }
      // Auto-scroll only when dragging near/past the top or bottom edge.
      const rect = container.getBoundingClientRect();
      const edge = 28;
      let dir = 0;
      if (e.clientY < rect.top + edge) dir = -1;          // older history
      else if (e.clientY > rect.bottom - edge) dir = 1;   // newer
      setEdge(dir);
    });

    window.addEventListener('mouseup', endDrag);
    container.addEventListener('mouseleave', () => setEdge(0));
  }

  connect() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}${window.location.pathname}ws`;

    this.ws = new WebSocket(wsUrl, ['webtty']);

    this.ws.onopen = () => {
      console.log('WebSocket connected', this.sessionName || '(primary)');

      // Send auth token + this unit's chosen tmux session (grouped split region,
      // or '' for the shared base). The server threads Session into the pty env
      // and its per-connection layout controller.
      const authToken = window.gotty_auth_token || '';
      this.ws.send(JSON.stringify({ AuthToken: authToken, Arguments: '', Session: this.sessionName || '' }));

      // Tell server to expect base64 encoded input
      this.sendMessage(MSG.SetEncoding, 'base64');

      // Send initial size and focus terminal
      setTimeout(() => {
        this.sendResize();
        this.terminal.focus();
      }, 100);
      // (Window restore after a reconnect happens when the first layout arrives —
      // see _rememberOrRestore, gated by this.restorePending.)
    };

    this.ws.onmessage = (event) => {
      this.handleMessage(event.data);
    };

    this.ws.onclose = () => {
      console.log('WebSocket closed', this.sessionName || '(primary)');
      if (this.destroyed) return;

      // Reconnect to the SAME session (a grouped region's session is recreated by
      // attach-web.sh under the same name) and RESTORE the window we were viewing
      // — otherwise the fresh attach resets us to the base's current window. We no
      // longer hop to a different session on reconnect (that reset the view).
      if (this.reconnectInterval) {
        this.restorePending = true;
        setTimeout(() => this.connect(), this.reconnectInterval * 1000);
      }
    };

    this.ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };
  }

  handleMessage(data) {
    const type = data[0];
    const payload = data.slice(1);

    switch (type) {
      case MSG.Output:
        // Decode base64 to Uint8Array for proper UTF-8 handling
        const binaryString = atob(payload);

        // Check for OSC 52 clipboard sequences and handle them
        const processed = this.handleOSC52(binaryString);

        const bytes = new Uint8Array(processed.length);
        for (let i = 0; i < processed.length; i++) {
          bytes[i] = processed.charCodeAt(i);
        }
        this.terminal.write(bytes);
        break;

      case MSG.Pong:
        // Ignore pong
        break;

      case MSG.SetWindowTitle:
        // Only the primary unit owns the browser tab title; extra split regions
        // report theirs via the onTitle callback (used for region labels).
        if (this.primary) document.title = payload;
        if (this.onTitle) this.onTitle(payload);
        break;

      case MSG.SetPreferences:
        const prefs = JSON.parse(payload);
        if (prefs.fontSize) {
          this.terminal.options.fontSize = prefs.fontSize;
          this.fitAddon.fit();
        }
        break;

      case MSG.SetReconnect:
        this.reconnectInterval = parseInt(payload, 10);
        break;

      case MSG.SetBufferSize:
        this.bufferSize = parseInt(payload, 10);
        break;

      case MSG.TmuxLayoutUpdate:
        this.layout = JSON.parse(payload);
        this._rememberOrRestore();
        this.dispatchLayoutUpdate();
        break;

      case MSG.TmuxModeUpdate:
        const modeState = JSON.parse(payload);
        this.inCopyMode = modeState.inCopyMode;
        break;

      case MSG.TmuxCaptureData:
        // Server-global capture buffers came back on this unit's ws; route them
        // to the shared CaptureCache (SplitManager sets onCaptureData).
        try {
          this.onCaptureData?.(JSON.parse(payload));
        } catch (e) {
          console.warn('Bad capture data:', e);
        }
        break;

      default:
        console.warn('Unknown message type:', type);
    }
  }

  sendMessage(type, payload = '') {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(type + payload);
    } else {
      console.warn('WebSocket not ready, state:', this.ws?.readyState);
    }
  }

  // Send terminal input (keystrokes OR a paste) to the server as one or more
  // base64 Input messages. A large paste arrives from xterm as a SINGLE onData
  // call; sending it as one message overflowed the server's per-message read
  // buffer — which tore down the WebSocket and dropped the paste ("lost TTY") —
  // and `String.fromCharCode(...bytes)` on a big array threw a RangeError. So we
  // chunk the RAW bytes: each chunk is independently base64-encoded and decoded
  // server-side, and concatenating them in order reproduces the original input.
  // CHUNK is well under the server bufferSize even after base64's 4/3 growth.
  sendInput(data) {
    const bytes = this.encoder.encode(data);
    if (bytes.length === 0) { this.sendMessage(MSG.Input, ''); return; }
    const CHUNK = 8192;
    for (let off = 0; off < bytes.length; off += CHUNK) {
      const slice = bytes.subarray(off, off + CHUNK);
      // Build the binary string without spread (avoids the arg-count / stack limit).
      let binary = '';
      for (let i = 0; i < slice.length; i++) binary += String.fromCharCode(slice[i]);
      this.sendMessage(MSG.Input, btoa(binary));
    }
  }

  sendResize() {
    const dims = { columns: this.terminal.cols, rows: this.terminal.rows };
    this.sendMessage(MSG.ResizeTerminal, JSON.stringify(dims));
  }

  // Push the layout to THIS unit's bound sidebar (scoped — not a global event).
  // The primary unit additionally broadcasts the global event that the mobile
  // controls listen to (mobile is single-terminal and never splits).
  dispatchLayoutUpdate() {
    if (this.primary) {
      window.dispatchEvent(new CustomEvent('tmux-layout-update', {
        detail: this.layout
      }));
    }
    // Let the owner (SplitManager) react to this unit's layout: forward it to the
    // single shared sidebar IF this unit is focused, and handle add-region
    // auto-pick. The sidebar is no longer per-unit.
    if (this.onLayout) this.onLayout(this);
  }

  // On every layout: normally remember the view (logical session + window) so a
  // later reconnect can restore it. When a reconnect just happened
  // (restorePending), the fresh attach lands us on the base session's current
  // window — instead re-select what we remembered: hop back to the session we
  // were on first (the fresh grouped attach is always on the base), then the
  // window (by id, falling back to index — index only valid same-session).
  _rememberOrRestore() {
    const active = this.layout.activeWindowId;
    const activeWin = (this.layout.windows || []).find(w => w.id === active);
    const base = this.layout.sessionBase || this.layout.sessionName;
    if (this.restorePending) {
      this.restorePending = false;
      // Only restore INDEPENDENT (grouped) split regions. The primary region is
      // shared with the ssh console; forcing its window would move the console too,
      // so let it simply re-sync to whatever the console is viewing.
      if (!this.primary) {
        if (this.desiredSession && base && this.desiredSession !== base) {
          // We were viewing another session — hop there, then re-select the
          // window. Both sends ride the same serialized ws (see goToWindow).
          this.switchSession(this.desiredSession);
          if (this.desiredWindowId) this.selectWindow(this.desiredWindowId);
          return;   // the resulting layout re-remembers the restored view
        }
        const want = this._findWindow(this.desiredWindowId, this.desiredWindowIndex);
        if (want && want.id !== active) {
          this.selectWindow(want.id);   // restore; the resulting layout re-remembers it
          return;
        }
      }
    }
    this.desiredWindowId = active;
    this.desiredSession = base;
    if (activeWin) this.desiredWindowIndex = activeWin.index;
    // Access recency is recorded centrally by SplitManager (focus + layout
    // transition, with arrow-browse suppression) — the single write path shared
    // by the toolbar strip and the Exposé sort. Nothing to mark here.
  }

  _findWindow(id, index) {
    const ws = this.layout.windows || [];
    return ws.find(w => w.id === id)
      || (index != null ? ws.find(w => w.index === index) : null)
      || null;
  }

  // Give this unit keyboard focus. In the split, SplitManager overrides/augments
  // this to also mark the unit focused (show its sidebar, route shortcuts).
  focus() {
    this.terminal?.focus();
    if (this.onFocus) this.onFocus(this);
  }

  fit() {
    this.fitAddon?.fit();
  }

  // Tear the unit down: stop reconnecting, close the socket, dispose xterm and
  // observers. Used by the split manager when a region is closed.
  destroy() {
    this.destroyed = true;
    if (this.resizeObserver) { try { this.resizeObserver.disconnect(); } catch (e) {} }
    if (this.ws) { try { this.ws.onclose = null; this.ws.close(); } catch (e) {} }
    if (this.terminal) { try { this.terminal.dispose(); } catch (e) {} }
  }

  // Public API for components (sidebar / mobile controls) — resolve to THIS unit.
  selectPane(paneId) {
    this.sendMessage(MSG.TmuxSelectPane, paneId);
  }

  selectWindow(windowId) {
    // Optimistic paint FIRST so the switch looks instant on every path that ends
    // here (sidebar click, ↑/↓ arrow-nav, Exposé click); the server's
    // select-window repaint overwrites it a beat later (authoritative).
    this.paintOptimistic(windowId);
    // (Access recency is recorded by SplitManager on the resulting layout change,
    // so arrow-browse suppression applies uniformly — see noteAccess.)
    this.sendMessage(MSG.TmuxSelectWindow, windowId);
  }

  // Blit the target window's cached capture into this unit's xterm immediately,
  // if a fresh-enough buffer exists. Guarded no-op otherwise (unchanged behavior).
  // captureCache is set by the SplitManager.
  paintOptimistic(windowId) {
    const cache = this.captureCache;
    if (!cache || !this.terminal) return false;
    const entry = cache.fresh(windowId);
    if (!entry) return false;
    // Home + clear, then write the color-preserving snapshot.
    this.terminal.write('\x1b[H\x1b[2J');
    this.terminal.write(CaptureCache.decodeAnsi(entry));
    return true;
  }

  renameWindow(windowId, name) {
    // "<windowID> <name>" — windowID is "@N" so the first space delimits.
    this.sendMessage(MSG.TmuxRenameWindow, windowId + ' ' + name);
  }

  splitPane(horizontal) {
    this.sendMessage(MSG.TmuxSplitPane, horizontal ? 'h' : 'v');
  }

  closePane(paneId) {
    this.sendMessage(MSG.TmuxClosePane, paneId);
  }

  newWindow() {
    this.sendMessage(MSG.TmuxNewWindow, '');
  }

  // Reorder a window to ordinal position `targetPos` (0-based, in index order)
  // within the shared window list — the server bubbles it there via swap-window.
  // Driven by drag-and-drop in the sidebar.
  moveWindow(windowId, targetPos) {
    this.sendMessage(MSG.TmuxMoveWindow, windowId + ' ' + targetPos);
  }

  // Create a fresh session and switch this pane's view to it (the server picks the
  // name). Parity with newWindow(); driven by the sidebar's Sessions "+" button.
  newSession() {
    this.sendMessage(MSG.TmuxNewSession, '');
  }

  // Rename a session by its (current) logical name. Parity with renameWindow;
  // driven by double-clicking a session tab in the sidebar.
  renameSession(oldName, newName) {
    // "<oldName> <newName>" — session names have no spaces, so the first space
    // delimits (server keeps the rest as the possibly-spaced new name).
    this.sendMessage(MSG.TmuxRenameSession, oldName + ' ' + newName);
  }

  // Kill a window by id (sidebar hover ×). Grouped sessions share the list, so the
  // server's kill-window by @id removes it from every pane.
  killWindow(windowId) {
    this.sendMessage(MSG.TmuxKillWindow, windowId);
  }

  // Kill a session by logical name (sidebar hover ×).
  killSession(sessionName) {
    this.sendMessage(MSG.TmuxKillSession, sessionName);
  }

  // Link a window into another session (drag a window tab onto a session tab).
  // The window keeps running and appears in both sessions afterwards.
  linkWindow(windowId, targetSession) {
    // "<windowID> <targetSession>" — windowID is "@N" so the first space delimits.
    this.sendMessage(MSG.TmuxLinkWindow, windowId + ' ' + targetSession);
  }

  // Unlink a window from THIS pane's session, leaving it running in the other
  // sessions it's linked into (sidebar hover × when the window lives elsewhere too).
  unlinkWindow(windowId) {
    this.sendMessage(MSG.TmuxUnlinkWindow, windowId);
  }

  switchSession(sessionName) {
    // Any region may switch sessions. The backend switches only THIS pane's own
    // tmux client (-c <its tty>) and RE-GROUPS a split onto the target session
    // (fresh grouped web-* session), so no pane ever couples with the console or
    // another pane — cross-session navigation is safe for every pane.
    this.sendMessage(MSG.TmuxSwitchSession, sessionName);
  }

  // Is this unit's ws currently usable for sending a request?
  isConnected() {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  // Request server-global capture buffers over THIS unit's ws. The reply (a
  // TmuxCaptureData frame) returns on the same ws and is routed to the shared
  // CaptureCache via onCaptureData. windows: 'all' or an array of window ids.
  sendCaptureRequest(windows = 'all', force = false) {
    if (!this.isConnected()) return false;
    this.sendMessage(MSG.TmuxCaptureRequest, JSON.stringify({ windows, force }));
    return true;
  }

  enterCopyMode() {
    this.sendMessage(MSG.TmuxCopyMode, '1');
    this.inCopyMode = true;
  }

  exitCopyMode() {
    this.sendMessage(MSG.TmuxCopyMode, '0');
    this.inCopyMode = false;
  }

  // Switch scroll-wheel behavior (one of SCROLL_MODES); called from the sidebar
  // cycle button. Switching to plain 'app' leaves copy mode so you aren't stuck
  // scrolled up in history; the adaptive modes may re-enter it on their own.
  setScrollMode(mode) {
    this.scrollMode = normalizeScrollMode(mode);
    localStorage.setItem('webtmux-scroll-mode', this.scrollMode);
    if (this.scrollMode === 'app' && this.inCopyMode) {
      this.exitCopyMode();
    }
  }

  // Handle OSC 52 clipboard sequences from tmux
  // Format: ESC ] 52 ; Pc ; Pd BEL  or  ESC ] 52 ; Pc ; Pd ESC \
  handleOSC52(data) {
    const ESC = String.fromCharCode(0x1b);
    const oscStart = ESC + ']52;';
    let result = data;
    let startIdx = data.indexOf(oscStart);

    while (startIdx !== -1) {
      // Find the terminator (BEL \x07 or ST \x1b\\)
      let endIdx = -1;
      let termLen = 1;

      for (let i = startIdx + oscStart.length; i < data.length; i++) {
        if (data.charCodeAt(i) === 0x07) { // BEL
          endIdx = i;
          termLen = 1;
          break;
        }
        if (data.charCodeAt(i) === 0x1b && i + 1 < data.length && data[i + 1] === '\\') { // ST
          endIdx = i;
          termLen = 2;
          break;
        }
      }

      if (endIdx === -1) break;

      // Extract the content between start and terminator
      const content = data.substring(startIdx + oscStart.length, endIdx);

      // Content format: Pc;Pd where Pc is selection and Pd is base64 data
      const semiIdx = content.indexOf(';');
      if (semiIdx !== -1) {
        const base64Data = content.substring(semiIdx + 1);

        if (base64Data && base64Data !== '?') {
          try {
            // Decode base64 to bytes, then UTF-8 decode for proper emoji support
            const binaryStr = atob(base64Data);
            const bytes = Uint8Array.from(binaryStr, c => c.charCodeAt(0));
            const text = new TextDecoder('utf-8').decode(bytes);
            navigator.clipboard.writeText(text);
          } catch (e) {
            // Silently ignore decode errors
          }
        }
      }

      // Remove this OSC sequence from output
      const fullSeq = data.substring(startIdx, endIdx + termLen);
      result = result.replace(fullSeq, '');

      // Look for more
      startIdx = data.indexOf(oscStart, startIdx + 1);
    }

    return result;
  }
}
