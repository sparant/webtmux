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
    this.scrollMode = localStorage.getItem('webtmux-scroll-mode') || 'buffer';
    this.layout = null;
    // Window we're viewing, remembered so we can restore it after a reconnect
    // (tty loss) — the fresh attach otherwise resets us to the base's current window.
    this.desiredWindowId = null;
    this.desiredWindowIndex = null;
    this.restorePending = false;
    // Toolbar MRU bookkeeping (read by SplitManager): last window it recorded as a
    // toolbar "access", and window ids whose next arrival should NOT count (they
    // came from sidebar arrow-key browsing).
    this._accessSeenId = null;
    this._suppressAccessIds = new Set();
    this.oscBuffer = ''; // Buffer for OSC sequence detection
    this.resizeObserver = null;

    this.init();
  }

  init() {
    // Create terminal
    this.terminal = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: '#1a1a2e',
        foreground: '#eaeaea',
        cursor: '#f0f0f0',
        selection: 'rgba(255, 255, 255, 0.3)',
      },
      scrollback: 0, // tmux handles scrollback via copy mode
      allowProposedApi: true,
    });

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

      // (Ctrl+Alt+B sidebar toggle is a global shortcut owned by the bootstrap /
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
      // Encode string to bytes, then to base64 (matches original gotty)
      const bytes = this.encoder.encode(data);
      const binary = String.fromCharCode(...bytes);
      this.sendMessage(MSG.Input, btoa(binary));
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
      // Passthrough mode: leave touch scrolling to the app (mirror the wheel).
      if (this.scrollMode === 'passthrough') return;
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

    // Mouse wheel for desktop scroll -> copy mode
    this.terminal.attachCustomWheelEventHandler((event) => {
      // Passthrough mode: don't hijack the wheel — let xterm forward it to the
      // app (mouse-wheel sequences), so Claude/vim/less scroll themselves.
      if (this.scrollMode === 'passthrough') {
        return true;
      }
      // Only intercept scroll up (entering history) - deltaY < 0 = wheel up
      if (event.deltaY < 0) {
        if (!this.inCopyMode) {
          this.sendMessage(MSG.TmuxCopyMode, '1');
          this.inCopyMode = true;
        }
      }

      if (this.inCopyMode) {
        const lines = Math.max(1, Math.floor(Math.abs(event.deltaY) / 50));
        // Wheel up (deltaY < 0) = scroll UP in tmux (show older history)
        // Wheel down (deltaY > 0) = scroll DOWN in tmux (show newer)
        if (event.deltaY < 0) {
          this.sendMessage(MSG.TmuxScrollUp, String(lines));
        } else {
          this.sendMessage(MSG.TmuxScrollDown, String(lines));
        }
        return false; // Prevent default scroll
      }

      return true; // Allow normal handling when not in copy mode
    });
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
      if (this.scrollMode === 'passthrough') return;      // leave the mouse to the app
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

  // On every layout: normally remember the window we're viewing so a later
  // reconnect can restore it. When a reconnect just happened (restorePending), the
  // fresh attach lands us on the base's current window — instead re-select the
  // window we remembered (by id, falling back to index) if it still exists.
  _rememberOrRestore() {
    const active = this.layout.activeWindowId;
    const activeWin = (this.layout.windows || []).find(w => w.id === active);
    if (this.restorePending) {
      this.restorePending = false;
      // Only restore INDEPENDENT (grouped) split regions. The primary region is
      // shared with the ssh console; forcing its window would move the console too,
      // so let it simply re-sync to whatever the console is viewing.
      if (!this.primary) {
        const want = this._findWindow(this.desiredWindowId, this.desiredWindowIndex);
        if (want && want.id !== active) {
          this.selectWindow(want.id);   // restore; the resulting layout re-remembers it
          return;
        }
      }
    }
    this.desiredWindowId = active;
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

  switchSession(sessionName) {
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

  // Switch scroll-wheel behavior ('buffer' | 'passthrough'); called from the
  // sidebar toggle. Leaving copy mode on switch to passthrough avoids getting
  // stuck scrolled up in history.
  setScrollMode(mode) {
    this.scrollMode = mode === 'passthrough' ? 'passthrough' : 'buffer';
    localStorage.setItem('webtmux-scroll-mode', this.scrollMode);
    if (this.scrollMode === 'passthrough' && this.inCopyMode) {
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
