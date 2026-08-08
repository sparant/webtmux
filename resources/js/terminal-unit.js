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
// @xterm/addon-webgl is NOT imported here — see the renderer block in init().
// It is 104 KB and the WebGL renderer is opt-in, so it is loaded with a dynamic
// import() only when someone has actually opted in.
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { CaptureCache } from './capture-cache.js';
import { CopyModeArbiter, layoutModeWins } from './copy-mode.js';
// A copy from a pane goes through the ring, not straight to the clipboard: the
// ring writes it to the clipboard AND keeps what was there before, which is the
// whole point of it (see copy-buffers.js).
import { copyBuffers } from './copy-buffer-store.js';
import { stateStore } from './state-store.js';
import { arrowSequence } from './arrow-keys.js';
import { IS_MAC } from './os.js';
import { renameSessionPayload } from './tmux-payloads.js';
import { planReconnectLanding } from './restore-view.js';
import {
  normalizeMouseMode, resolvePress, needsForcedSelection, forceSelectionModifier,
  movedEnough, leaveCopyModeFirst, PressArbiter,
  isExtendPress, extendAnchor, selectionSpan, cellOffset, viewLeftItsWindow,
} from './mouse-mode.js';
import { writeAuthority, READ_ONLY_NOTICE } from './write-guard.js';

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
  TmuxSavePaneFile: 'O',
  TmuxSetState: 'P',
  TmuxRefresh: 'Q',
  TmuxSaveInfoRequest: 'R',
  TmuxScrollbackRequest: 'S',
  TmuxHistoryInfoRequest: 'T',
  TmuxHistoryAction: 'U',

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
  // A command webtmux REFUSED to send, with the reason. Not the same thing as a
  // tmux command that failed (those are routine races the layout push repairs and
  // are never sent here) — this is "I could not tell which object you meant, so I
  // did nothing", which looks exactly like a broken button unless it is said.
  TmuxError: 'B',
  TmuxSaveResult: 'C',
  TmuxSaveInfo: 'D',
  // One window's ENTIRE pane buffer, base64, answering a TmuxScrollbackRequest.
  // Not a TmuxCaptureData: it is not a screen and must never reach the capture
  // cache — it is handed straight to a download and dropped.
  TmuxScrollbackData: 'E',
  // One window's scrollback ACCOUNTING — how big each pane's buffer is, how much
  // of it is used, and what new windows will be born with. Answers both the
  // question and the three actions, so the panel's numbers are always the ones
  // tmux held after the last thing that was done to them.
  TmuxHistoryInfo: 'F',
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

// Client messages that make webtmux TALK TO TMUX (as opposed to writing bytes to
// the pty, which is the shell's business). The toolbar's activity spinner ticks on
// these — it's a "webtmux is driving tmux right now" light. Input/Ping/resize are
// deliberately absent: they're pty traffic and would keep it spinning while you type.
const TMUX_MSG_TYPES = new Set([
  MSG.TmuxSelectPane, MSG.TmuxSelectWindow, MSG.TmuxSplitPane, MSG.TmuxClosePane,
  MSG.TmuxCopyMode, MSG.TmuxScrollUp, MSG.TmuxScrollDown, MSG.TmuxNewWindow,
  MSG.TmuxSwitchSession, MSG.TmuxRenameWindow, MSG.TmuxCaptureRequest,
  MSG.TmuxMoveWindow, MSG.TmuxNewSession, MSG.TmuxRenameSession, MSG.TmuxKillWindow,
  MSG.TmuxKillSession, MSG.TmuxLinkWindow, MSG.TmuxUnlinkWindow,
  MSG.TmuxSavePaneFile, MSG.TmuxSaveInfoRequest, MSG.TmuxScrollbackRequest,
  MSG.TmuxHistoryInfoRequest, MSG.TmuxHistoryAction,
  MSG.TmuxSetState, MSG.TmuxRefresh,
]);

// --- liveness heartbeat -------------------------------------------------------
// A CLOSED socket is the easy half of "we lost tmux" and the rarer one. The failure
// that actually strands you leaves the socket wide OPEN: the server (or tmux, or the
// box) wedges, nothing comes back, readyState stays OPEN forever, and the UI goes on
// looking perfectly healthy while your keystrokes vanish. TCP will not tell us — a
// stalled peer that never closes is indistinguishable from an idle one at that layer.
//
// So we ask. The protocol has had a Ping/Pong pair since gotty and nothing ever sent
// one; the server answers Ping from the SAME serialized handler loop that writes your
// keystrokes into the pty, so a Pong is proof of exactly the thing typing needs. If
// that loop is blocked, the Pong stops for the same reason your input does.
//
// LAYOUT PUSHES CANNOT BE USED FOR THIS. The server only sends a layout when it
// CHANGES (handlers.go: `if currentLayout != lastLayout`), so silence from an idle
// tmux is entirely normal and "no push for N seconds" would fire constantly.
const HEARTBEAT_MS = 3000;
// Two missed beats, so one dropped/slow Pong is not a warning. ~8s is also comfortably
// longer than any tmux command round trip on a loaded box.
const STALL_MS = 8000;

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
    // Has this region's socket ever CLOSED? Latched, and never cleared, because it is
    // what separates "still opening for the first time" from "we had tmux and lost
    // it" — see connectionLost(). Without the latch the boot's own CONNECTING state
    // reads identically to a drop, and the toolbar would flash a connection warning on
    // every single page load.
    this._wasClosed = false;
    // Liveness heartbeat state (see HEARTBEAT_MS): when the last Pong came back, when
    // the last tick ran (to tell a real stall from a throttled/suspended tab), and
    // whether we are currently calling this connection stalled.
    this._lastPongAt = 0;
    this._lastTickAt = 0;
    this._heartbeat = null;
    this._stalled = false;
    // Called on every open/close/stall change so the owner (SplitManager) can surface it.
    this.onConnectionChange = null;
    this.bufferSize = 1024 * 1024;
    this._inCopyMode = false;
    this._modeSetAt = 0;      // when _inCopyMode was last decided locally
    // Scroll-wheel behavior: 'buffer' (default) = wheel drives tmux copy-mode
    // history scrolling; 'passthrough' = let xterm forward the wheel to the app
    // (so a TUI like Claude, vim, less handles its own scrolling). Persisted +
    // toggled from the sidebar. Read here so the handlers below see it on load.
    this.scrollMode = normalizeScrollMode(stateStore.section('renderer').scrollMode);
    // Mouse click/drag behavior — the same four-way choice for the OTHER gesture:
    // who gets a button press, the program or a local text selection. Separate from
    // scrollMode because the answers genuinely differ (Claude Code wants the wheel
    // AND the clicks, but you still want to drag-select its output). See
    // mouse-mode.js for what each mode means.
    this.mouseMode = normalizeMouseMode(stateStore.section('renderer').mouseMode);
    // Keep both modes live-synced: they're shared 'renderer' prefs, so a change from
    // any region's sidebar/toolbar (or another client) updates every unit. Store the
    // unsubscribe so a removed split region doesn't leak the closure.
    this._unsubState = stateStore.subscribe(() => {
      this.scrollMode = normalizeScrollMode(stateStore.section('renderer').scrollMode);
      this.mouseMode = normalizeMouseMode(stateStore.section('renderer').mouseMode);
    });
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
    // The window whose text is on screen right now, as far as any highlight is
    // concerned. Not the same thing as desiredWindowId, which is where we WANT to
    // be (and is set mid-restore, before the content arrives) — see _viewChanged.
    this._shownWindowId = null;
    // While a post-reconnect restore hop is in flight, the window this region is
    // PARKED on — where the fresh attach dropped us, not anywhere the user went.
    // Read by SplitManager._markWorkAlerts, which otherwise treats "on screen in a
    // region" as having looked at it and would clear that window's attention flash
    // for you. Null whenever the region has actually landed (see _rememberOrRestore).
    this._parkedWindowId = null;
    // Toolbar MRU bookkeeping (read by SplitManager): last window it recorded as a
    // toolbar "access", and window ids whose next arrival should NOT count (they
    // came from sidebar arrow-key WINDOW browsing). _suppressAccessNext is the
    // by-id-unknown variant for ←/→ SESSION browsing: the landing window id isn't
    // known until the new session's layout arrives, so we suppress the NEXT access.
    this._accessSeenId = null;
    this._suppressAccessIds = new Set();
    this._suppressAccessNext = false;
    // A cross-session hop can briefly emit an intermediate layout that still shows
    // the TARGET window in the OLD session before the switch lands. That transient
    // must not be recorded as an access (it would resurrect a recents tab you just
    // removed). SplitManager.goToWindow sets this to {id, session} = the exact
    // (window, old-session) pair to skip; the access path clears it on landing.
    this._navSuppress = null;
    this.oscBuffer = ''; // Buffer for OSC sequence detection
    this.resizeObserver = null;
    // Copy-mode keystroke arbitration: works out whether keys typed at a pane in
    // copy mode are motions or someone typing, holding them until it can tell.
    this._copyArbiter = new CopyModeArbiter({
      sendKeys: (s) => this.sendInput(s),
      exitCopyMode: () => { if (this.inCopyMode) this.exitCopyMode(); },
    });
    // Preview hold: while a HoverPreview is borrowing this region's xterm to show
    // ANOTHER window, our own output is buffered here instead of being painted over
    // the preview, and replayed when the region is handed back.
    this._previewHold = false;
    this._previewBuf = [];

    this.init();
  }

  // Copy-mode flag. An accessor rather than a plain field so the ONE thing that must
  // happen on every entry into copy mode — rearming the keystroke arbiter — can't be
  // forgotten at any of the half-dozen places that set it (wheel, drag-select, touch,
  // the probe, the toolbar pill, the server's mode push).
  get inCopyMode() { return this._inCopyMode; }
  set inCopyMode(v) {
    const on = !!v;
    if (on && !this._inCopyMode) this._copyArbiter?.reset();
    this._inCopyMode = on;
    // When this was last decided here. _syncCopyModeFromLayout uses it to tell a
    // layout that hasn't caught up yet from one that is correcting us.
    this._modeSetAt = Date.now();
  }

  // Reconcile the copy-mode flag with tmux's own #{pane_in_mode}, which rides
  // every layout push. Most of the flag's writers are optimistic (wheel, drag,
  // touch, the paste path), and tmux can leave copy mode without telling anyone
  // — `q`, a `y` that copies-and-cancels, Enter, a mouse copy, or the ssh console
  // sharing the session. Nothing used to close that gap, so the flag could sit
  // stale-true indefinitely, and every wheel notch or paste while it did aimed a
  // copy-mode-only command at a pane in normal mode.
  _syncCopyModeFromLayout() {
    const truth = !!this.layout?.activePaneInMode;
    if (truth === this._inCopyMode) return;
    if (!layoutModeWins(this._modeSetAt, Date.now())) return;
    this.inCopyMode = truth;
    // Left copy mode without us asking: keys the arbiter is still holding for a
    // verdict belong at the prompt now (same rule as the server's mode push).
    if (!truth && this._copyArbiter?.held) this._copyArbiter.flush('typing');
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
      // Required by the mouse-mode toggle, not a Mac preference. xterm's one way
      // to say "this press is a selection, not a mouse report" is a modifier —
      // shift on Windows/Linux, but option on a Mac ONLY if this option is on
      // (SelectionService.shouldForceSelection). Without it there is no forced
      // selection on a Mac at all. It also restores the ⌥-drag-to-select that
      // every native terminal offers over a mouse-grabbing program.
      macOptionClickForcesSelection: true,
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

    // Renderer choice — the crux of the glyph-rendering bug. xterm's WebGL renderer
    // rasterizes glyphs into its own texture atlas and does NOT fall back to the
    // browser's system fonts for codepoints the configured fontFamily lacks: a glyph
    // missing from every listed font renders as tofu / a wrong shape. That's why the
    // SAME Mac shows Claude's symbols (●, ⎿, ✓, box rules…) correctly in Terminal.app
    // over ssh — the OS supplies them from Apple Symbols / a system fallback — but the
    // browser terminal did not: WebGL never reached that fallback.
    //
    // xterm's DEFAULT (DOM) renderer draws through normal browser text layout, which
    // DOES do full native font fallback — the same mechanism Terminal.app benefits
    // from — so those glyphs resolve on every client regardless of which fonts happen
    // to be installed. Correctness beats the WebGL throughput here, so we default to
    // the DOM renderer and make WebGL strictly opt-in (StateStore renderer.webgl)
    // for anyone who wants the GPU path and has a font stack that covers their glyphs.
    //
    // Because it is opt-in, the addon is fetched with a dynamic import() rather
    // than a static one at the top of the file: at 104 KB it was the largest
    // thing every page load downloaded for a renderer almost nobody enables.
    // The importmap entry in index.html resolves import() identically.
    //
    // Deliberately NOT awaited. init() is called from the constructor, so it
    // cannot be async, and everything below this block — fit, focus, the resize
    // observer, input handling — must be wired synchronously. xterm accepts an
    // addon on an already-open terminal, so the DOM renderer simply draws until
    // the fetch lands and WebGL takes over.
    //
    // A stored preference wins; the server's --enable-webgl only seeds clients
    // that have never chosen. (Before that seed existed the flag was read by
    // nothing, so it advertised a renderer it could not select.)
    const rendererPrefs = stateStore.section('renderer');
    const wantsWebgl = rendererPrefs.webgl === undefined
      ? (typeof window !== 'undefined' && window.webtmux_webgl === true)
      : rendererPrefs.webgl === true;
    if (wantsWebgl) {
      import('@xterm/addon-webgl')
        .then(({ WebglAddon }) => this.terminal.loadAddon(new WebglAddon()))
        .catch((e) => console.warn('WebGL addon not supported:', e));
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

      // Allow Cmd+C / Ctrl+C to copy selected text. Exclude the Option/Alt variant:
      // Ctrl/Cmd+Option+C is the "new window" global chord (owned by SplitManager),
      // not a copy — without the !altKey guard a Control+Option+C with no selection
      // fell through here and was sent to the pane as a bare Ctrl+C, interrupting
      // the foreground job and stealing the shortcut.
      if ((ev.metaKey || ev.ctrlKey) && !ev.altKey && ev.key === 'c') {
        const selection = this.terminal.getSelection();
        if (selection) {
          // Into the copy-buffer ring, which also puts it on the system clipboard
          // (execCommand fallback covers plain-HTTP LAN access). Copying twice
          // without pasting in between keeps BOTH — see copy-buffers.js.
          copyBuffers.copy(selection);
          // Clear the highlight once copied — and with it the anchor, since the
          // next selection will be a new gesture with an anchor of its own.
          this.terminal.clearSelection();
          this._selAnchor = null;
          // Deliberately STAY in copy-mode after copying: you often want to copy
          // several regions in a row (e.g. to paste into different windows) without
          // re-entering the scrollback each time. Paste is what drops you back to
          // normal mode (see the V handler) — copy no longer does.
          return false; // Handled
        }
        // No selection - let it pass through as Ctrl+C (interrupt)
        return true;
      }

      // Allow Cmd+V / Ctrl+V to paste
      if ((ev.metaKey || ev.ctrlKey) && ev.key === 'v') {
        ev.preventDefault(); // Prevent browser's native paste
        // If the pane is in tmux copy/view mode, pasted bytes would be swallowed as
        // copy-mode key commands instead of inserted at the prompt. Drop back to
        // normal mode FIRST — this send rides the same serialized ws ahead of the
        // (async, clipboard-gated) paste, so copy mode is already gone when it lands.
        // The exit is harmless when the pane turns out NOT to be in copy mode: the
        // server exits the mode idempotently (`copy-mode -q`), which matters because
        // this flag is only ever as fresh as the last layout push.
        if (this.inCopyMode) this.exitCopyMode();
        navigator.clipboard.readText().then(text => {
          // sendInput, not a hand-rolled frame: it chunks. A paste sent as ONE
          // Input message overflowed the server's per-message read buffer above
          // ~96KB of text, which drops the WebSocket and takes the pane's tmux
          // client with it ([lost tty]), and `String.fromCharCode(...bytes)` blew
          // the stack on a large paste before it even got that far.
          if (text) this.sendInput(text);
          // The SYSTEM CLIPBOARD is what gets pasted, always — the ring chooses
          // what is in it, it never substitutes for it. Telling the ring what just
          // went out does two things: it marks the focused buffer as used (so the
          // next copy reuses that slot instead of growing the list), and it adopts
          // text that came from outside webtmux, so the panel can never point at a
          // buffer that is not what ⌘V just delivered.
          copyBuffers.pasted(text);
        }).catch(err => {
          console.warn('Failed to paste:', err);
        });
        return false; // Handled
      }

      // Map arrow keys to CSI sequences (ESC [ A/B/C/D)
      // Using CSI instead of SS3 for better compatibility.
      // Modifiers are part of the mapping, not dropped: an earlier version keyed
      // on ev.key alone, which turned Option+→ (word jump) into a plain →.
      const seq = arrowSequence(ev, IS_MAC);
      if (seq) {
        // Send raw CSI sequence
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

    // The selection guard's primary trigger: entering copy mode can wipe a drag's
    // selection, and this fires in the same tick as that wipe — early enough to put
    // it back before the pane repaints under the anchor. See _guardSelection.
    this.terminal.onSelectionChange(() => this._onSelectionChange());

    this.terminal.onData((data) => {
      // While a hover preview borrows this terminal, the screen shows ANOTHER
      // window but keyboard focus (and this handler) still belong to the region's
      // real, hidden one. Sending would type into a window the user can't see —
      // the preview badge marks the screen as borrowed, so honor it for input too.
      if (this._previewHold) return;
      // In copy mode a keystroke is ambiguous: a command, or someone typing at a
      // pane they forgot was scrolled up. The arbiter decides (see copy-mode.js) and
      // owns the send when it takes the keys.
      if (this.inCopyMode && this._copyArbiter.handle(data)) return;
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
            this._scrollBuffer(false, lines);
          } else {
            this._scrollBuffer(true, lines);
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
        this._scrollBuffer(event.deltaY < 0, lines);
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

  // "Does the program in this pane want the mouse?" — which is NOT the same
  // question as _mouseTracking() once copy mode is in play.
  //
  // Entering tmux copy mode makes tmux stop forwarding the pane program's mouse
  // mode to the client, so xterm reports 'none' no matter what Claude/vim asked
  // for. Read live, that says "plain shell" about a pane running a full TUI — and
  // since selecting now ENTERS copy mode, the very first drag-select would flip
  // that answer and strand every later click in the buffer.
  //
  // So the last answer seen OUTSIDE copy mode is remembered and used while inside
  // it, forgotten when the window changes (a different program, a different
  // answer). Callers that need the other question — "will xterm eat this press?",
  // which is about mouse REPORTING and nothing else — must still use
  // _mouseTracking() directly.
  _programWantsMouse() {
    const live = this._mouseTracking();
    const win = this.layout?.activeWindowId || '';
    if (!this.inCopyMode) {
      this._trackingSeen = live;
      this._trackingWin = win;
      return live;
    }
    if (live) return true;
    return this._trackingWin === win && !!this._trackingSeen;
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
      this._scrollBuffer(true, this._probeLines);
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

  // Click-to-focus, click-and-drag to select, and edge auto-scroll.
  //
  // The hard part is WHO GETS THE PRESS. While a program has mouse tracking on
  // (Claude Code, vim, htop) xterm disables its own text selection and forwards
  // every press to the program, so a drag over the pane highlights nothing. This
  // used to be "fixed" by entering tmux copy mode once a drag was recognised, on
  // the theory that it takes the pane out of the app's mouse grab — but xterm's
  // selection is gated on the mouse-reporting ESCAPE SEQUENCES it has seen, which
  // a tmux mode change does not necessarily retract, and the press it needed to
  // anchor on was already spent. Hence the constant "enter copy mode FIRST, then
  // drag" dance.
  //
  // What actually works is xterm's own escape hatch: a press carrying the
  // force-selection modifier skips the mouse report and starts a local selection
  // (see mouse-mode.js). So the press is intercepted in the CAPTURE phase, before
  // either of xterm's handlers sees it, and re-dispatched as whichever kind of
  // press this.mouseMode says it should have been. Nothing tmux-side is touched:
  // copy mode is now entered only where it is genuinely needed, at the edge, to
  // drag a selection PAST the visible screen.
  setupMouseSelection() {
    const container = this.terminalEl;
    let press = null;               // the live gesture, or null between them
    let edgeDir = 0, edgeTimer = null;

    const setEdge = (dir) => {
      if (dir === edgeDir) return;
      edgeDir = dir;
      if (edgeTimer) { clearInterval(edgeTimer); edgeTimer = null; }
      if (dir !== 0) {
        edgeTimer = setInterval(() => {
          // beginSelection has already put us here, but a stale flag or a pane that
          // left copy mode on its own would otherwise aim a scroll at a pane in
          // normal mode.
          beginSelection();
          this._scrollBuffer(edgeDir < 0, 2);
        }, 120);
      }
    };

    // A selection is genuinely under way — a drag, or a multi-click that selected a
    // word — as opposed to a press that merely might become one. This is where the
    // pane goes into tmux copy mode: selecting IS reading the buffer, so the mode
    // should say so without anyone having to remember to set it, and it is what
    // lets a drag to the pane edge scroll for more. Idempotent per gesture, so a
    // long drag doesn't re-send it on every mousemove.
    const beginSelection = () => {
      if (press) {
        if (press.selecting) return;
        press.selecting = true;
      }
      if (!this.inCopyMode) {
        this.sendMessage(MSG.TmuxCopyMode, '1');
        this.inCopyMode = true;
      }
    };

    // A deferred press finally declared itself: give it to whoever it belongs to.
    const arbiter = new PressArbiter({
      resolve: (verdict) => {
        if (!press) return;
        press.verdict = verdict;
        if (verdict === 'buffer') {
          // The drag is what resolved it, so the selection starts now. Note the
          // order: re-dispatch BEFORE entering copy mode, so the anchor is decided
          // against the mouse-reporting state the press was judged under.
          this._startSelection(press);
          beginSelection();
          // ...and put it back if entering copy mode wipes it — see _guardSelection.
          this._guardSelection(press);
          return;
        }
        // Going to the program instead. If a previous selection left the pane in
        // copy mode, this click's job is to get out of it: the pane is scrolled up
        // and reading, so a press replayed into it would land on the wrong thing.
        // Clicking away means "done reading" — the mode drops, the highlight goes,
        // and the NEXT click reaches the program with mouse reporting restored.
        // (It can't be done in one press: the exit is a round-trip to tmux, and
        // until it lands xterm is still not reporting.)
        if (leaveCopyModeFirst({ mode: this.mouseMode, verdict, inCopyMode: this.inCopyMode })) {
          this.exitCopyMode();
          this.terminal?.clearSelection();
          this._selAnchor = null;
          return;
        }
        this._replayPressToApp(press);
      },
    });

    // The gesture is over (or being abandoned): stop edge-scrolling and stop
    // listening at the document. The listeners live only for the duration of a
    // press so a page-wide mousemove handler isn't running per split region.
    const release = () => {
      setEdge(0);
      arbiter.cancel();
      if (!press) return;
      press = null;
      document.removeEventListener('mousemove', onDocMove, true);
      document.removeEventListener('mouseup', onDocUp, true);
    };
    this._releaseGesture = release;

    // Capture phase on OUR container — an ancestor of everything xterm binds to,
    // so this runs before both xterm's selection handler and its mouse-report one
    // and can still decide which of them gets to see the press.
    container.addEventListener('mousedown', (e) => {
      if (this._syntheticMouse) return;   // our own re-dispatch: it is meant for xterm
      if (e.button !== 0) return;         // right/middle stay the program's (and the browser's)
      this.focus();                       // click brings keyboard focus (+ focuses this unit)
      // Clicking into the terminal collapses the (single, shared) sidebar out of
      // the way — the owner (SplitManager) decides, honoring the pin toggle.
      if (this.onTerminalMousedown) this.onTerminalMousedown();

      release();                          // whatever came before is done with

      // Shift-click adjusts the selection already on screen instead of starting a
      // new one: same anchor, new endpoint. It is decided before anything else
      // because none of the questions below apply to it — the program is not being
      // given this press either way, and the pane's copy mode is left exactly as
      // the drag that made the selection left it (dropping out of it here would
      // take the highlight with it, which is the opposite of adjusting it).
      if (isExtendPress({ shiftKey: e.shiftKey, button: e.button,
                          hasSelection: !!this.terminal?.hasSelection?.() })
          && this._extendSelectionTo(e.clientX, e.clientY)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        press = { x: e.clientX, y: e.clientY, lastX: e.clientX, lastY: e.clientY,
                  detail: e.detail, verdict: 'extend', live: this._mouseTracking(),
                  extending: true, dragging: false, selecting: true,
                  done: false, reasserts: 0, anchorText: '' };
        // Held and dragged, the same press keeps moving that endpoint — so an
        // adjustment that overshoots is fixed without letting go, and a shift-drag
        // reads the same way as the click it starts with.
        document.addEventListener('mousemove', onDocMove, true);
        document.addEventListener('mouseup', onDocUp, true);
        return;
      }

      // Two different questions, and conflating them is a bug in both directions:
      //   wants — does a program want the mouse? decides WHO gets the press.
      //   live  — is xterm reporting the mouse right now? decides whether the
      //           press has to be forced past that reporting to select.
      // Copy mode drives them apart: it masks the program's mouse mode, so `live`
      // goes false while the program still wants clicks.
      const wants = this._programWantsMouse();
      const live = this._mouseTracking();
      const verdict = resolvePress({
        mode: this.mouseMode,
        mouseTracking: wants,
        inCopyMode: this.inCopyMode,
        detail: e.detail,
      });
      press = {
        x: e.clientX, y: e.clientY,       // the ANCHOR: where the selection starts
        lastX: e.clientX, lastY: e.clientY,
        detail: e.detail, verdict, live, dragging: false, selecting: false,
        done: false, reasserts: 0,
        // What the anchor was pointing AT, so a repair can follow the line if the
        // pane scrolls underneath it — see _anchorY.
        anchorText: this._lineText(this._rowAtY(e.clientY)),
      };
      document.addEventListener('mousemove', onDocMove, true);
      document.addEventListener('mouseup', onDocUp, true);

      // A multi-click has ALREADY selected something (a word, a line) — there is no
      // drag to wait for, so this is a selection as of right now. A single press is
      // not: it may still turn out to be a click, and putting the pane in copy mode
      // for every click would be worse than the problem being solved.
      if (verdict === 'buffer' && e.detail >= 2) beginSelection();


      // Cases that need no interference: the program's press, or a selection that
      // xterm is already able to make for itself (nothing is reporting the mouse).
      if (verdict !== 'defer' && !needsForcedSelection(verdict, live)) return;

      // From here the program must not see this press at all.
      e.preventDefault();
      e.stopImmediatePropagation();
      if (verdict === 'buffer') this._startSelection(press);
      else arbiter.start(e.clientX, e.clientY);
    }, true);

    // Auto-scroll only when dragging near/past the top or bottom edge. Measured
    // at the document, so it keeps scrolling once the pointer leaves the pane —
    // which is exactly where a drag-to-select-more ends up.
    const trackEdge = (clientY) => {
      const rect = container.getBoundingClientRect();
      const edge = 28;
      let dir = 0;
      if (clientY < rect.top + edge) dir = -1;          // older history
      else if (clientY > rect.bottom - edge) dir = 1;   // newer
      setEdge(dir);
    };

    const onDocMove = (e) => {
      if (!press) return;
      if ((e.buttons & 1) === 0) { release(); return; }   // only while left-dragging
      press.lastX = e.clientX; press.lastY = e.clientY;
      // A shift-click being dragged: every move is another endpoint, re-selected
      // from the anchor that has not moved.
      if (press.extending) {
        this._extendSelectionTo(e.clientX, e.clientY);
        trackEdge(e.clientY);
        return;
      }
      // Still undecided: this move may be what settles it (and if it does, the
      // selection is started from the anchor, not from here).
      if (arbiter.pending) { arbiter.move(e.clientX, e.clientY); return; }
      if (press.verdict !== 'buffer') return;             // the program owns this drag
      if (!press.dragging) {
        if (!movedEnough(e.clientX - press.x, e.clientY - press.y)) return;
        press.dragging = true;
        // The press has become a drag, so a selection is being made — including on
        // the paths that never touch a synthetic event at all ('buf', and 'auto' in
        // a plain shell, where xterm was already selecting natively).
        beginSelection();
        // These paths enter copy mode too, so they can be wiped by the same
        // protocol change; the repair works whether or not xterm's own selection
        // was the one that started it.
        this._guardSelection(press);
      }
      trackEdge(e.clientY);
    };

    const onDocUp = () => {
      // A press that never moved is a click, and the program has been waiting for
      // it. Resolving from the CAPTURE phase matters: the re-dispatched press
      // reaches xterm in time to register the release listener for this very
      // mouseup, so the program gets a press/release pair rather than a lone press.
      if (arbiter.pending) arbiter.up();
      // Noted BEFORE release() drops the gesture: the selection guard outlives the
      // button, and a repair made after the release has to close itself with a
      // mouseup or xterm is left mid-drag.
      if (press) press.done = true;
      // ...and so does the anchor, which is the only record of WHICH end of the
      // finished selection the gesture started from. A shift-click reads it much
      // later, by which time the press is long gone.
      if (press && !press.extending) this._recordSelectionAnchor(press);
      release();
    };
  }

  // xterm's screen element — the node below both of its mouse listeners, so an
  // event dispatched here reaches the selection handler AND, if that one declines
  // it, the mouse-report handler above it. Looked up per use because the terminal
  // is re-created on some reattach paths.
  _xtermScreen() {
    const el = this.terminal?.element;
    return el?.querySelector('.xterm-screen') || el || null;
  }

  // Re-dispatch a press we swallowed. `mods` carries the force-selection modifier
  // (or nothing, to hand the press to the program untouched). Flagged while it is
  // in flight so the capture handler above lets its own event through.
  _dispatchPress(press, mods, { x = press.x, y = press.y, type = 'mousedown' } = {}) {
    const target = this._xtermScreen();
    if (!target) return;
    const ev = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: x,
      clientY: y,
      button: 0,
      buttons: 1,
      // Preserved so double/triple-click still select a word/line rather than
      // arriving as three unrelated single clicks.
      detail: type === 'mousedown' ? press.detail : 0,
      ...mods,
    });
    this._syntheticMouse = true;
    try { target.dispatchEvent(ev); } finally { this._syntheticMouse = false; }
  }

  // Start a local text selection at the anchor, re-dispatching the press we
  // swallowed. The force-selection modifier goes on ONLY if xterm was reporting
  // the mouse when the press happened (press.live) — that is the only case it is
  // needed, and adding it when xterm's own selection is already enabled means
  // _handleIncrementalClick, i.e. extending the previous selection instead of
  // starting a new one. That case is reachable: inside copy mode tmux stops
  // reporting the mouse, so a deferred press there resolves with live === false.
  _startSelection(press) {
    this._dispatchPress(press, press.live ? forceSelectionModifier(IS_MAC) : {});
    // If the press only became a selection once the pointer had moved, xterm has
    // just anchored at the press point and knows nothing of the travel since.
    // Catch it up so the highlight covers the drag so far instead of appearing to
    // start a few pixels late.
    if (press.lastX !== press.x || press.lastY !== press.y) {
      this._dispatchPress(press, { buttons: 1 },
        { x: press.lastX, y: press.lastY, type: 'mousemove' });
    }
  }

  // Entering copy mode can WIPE the selection that started the gesture, roughly
  // 20ms after the press — and then the drag looks like it did nothing, so you
  // drag once to "enter copy mode" and again to actually select.
  //
  // The cause is xterm's, not tmux's. Any change of mouse-reporting PROTOCOL runs
  //     onProtocolChange -> selectionService.disable() -> clearSelection()
  // and a pane entering copy mode is exactly such a change: with tmux's own
  // `mouse on`, tmux stops forwarding the program's mode and starts using its own,
  // so a program tracking ANY-event motion (1003 — what Claude Code and other
  // hover-aware TUIs ask for) flips 'any' -> 'drag'. Non-zero to non-zero, which
  // takes the disable() branch. Programs using 1000/1002 happen to match what tmux
  // switches to, which is why this only bites on some TUIs.
  //
  // Nothing can be done about the clear (it is inside xterm, and the mode change is
  // legitimate), so the selection is re-asserted after it, from the remembered
  // ANCHOR to wherever the pointer has reached.
  //
  // WHEN it is re-asserted is the whole game, because the anchor is a PIXEL and a
  // pixel only means a line until the pane redraws. Repairing from a 40ms poll put
  // the redraw that follows the mode change INSIDE the gap: the selection was
  // rebuilt against content that had already scrolled, so it landed a line or two
  // off — usually the line above. Doing it from xterm's own selection-change event
  // instead means the repair runs in the same tick as the clear, with the screen
  // exactly as it was when the press was judged. Everything after that is xterm's
  // problem again, and it handles it: once a selection exists, xterm keeps its
  // buffer coordinates correct across scrolls and trims. The poll survives only as
  // a backstop, at a coarse interval, for a clear that somehow fires no event.
  SELECTION_GUARD_MS = 800;
  SELECTION_REASSERT_MAX = 6;
  SELECTION_BACKSTOP_MS = 150;

  _guardSelection(press) {
    if (this._selGuard) { clearTimeout(this._selGuard); this._selGuard = null; }
    this._selGuardPress = press;
    this._selGuardUntil = Date.now() + this.SELECTION_GUARD_MS;
    const tick = () => {
      this._selGuard = null;
      if (this.destroyed || this._selGuardPress !== press) return;
      this._repairSelection();
      if (Date.now() < this._selGuardUntil) {
        this._selGuard = setTimeout(tick, this.SELECTION_BACKSTOP_MS);
      } else {
        this._selGuardPress = null;
      }
    };
    this._selGuard = setTimeout(tick, this.SELECTION_BACKSTOP_MS);
  }

  // xterm says the selection changed. If it just went empty inside a guard window,
  // put it back NOW — synchronously, before the pane can repaint underneath it.
  _onSelectionChange() {
    if (this._restoringSelection) return;
    if (!this._selGuardPress || Date.now() > this._selGuardUntil) return;
    this._repairSelection();
  }

  _repairSelection() {
    const press = this._selGuardPress;
    if (!press || !press.selecting) return;
    // A drag with nowhere to go has nothing to restore, and re-anchoring on it
    // would loop for the whole window for no reason.
    if (press.lastX === press.x && press.lastY === press.y) return;
    if (press.reasserts >= this.SELECTION_REASSERT_MAX) return;
    if (this.terminal?.getSelection()) return;   // still there — nothing to repair
    press.reasserts++;
    this._reassertSelection(press);
  }

  // Re-create the selection from the anchor to the pointer's latest position.
  // `live` is read FRESH rather than reused from the press: the protocol change is
  // the whole reason we are here, so whether the modifier is needed may have
  // flipped since. If the button has already been released, the synthetic gesture
  // has to be closed with a mouseup or xterm stays mid-drag.
  // Viewport row under a client y, and the y at the middle of a viewport row.
  _rowAtY(y) {
    const el = this._xtermScreen();
    const rows = this.terminal?.rows || 0;
    if (!el || !rows) return -1;
    const box = el.getBoundingClientRect();
    if (!box.height) return -1;
    return Math.floor(((y - box.top) / box.height) * rows);
  }

  _yForRow(row) {
    const el = this._xtermScreen();
    const rows = this.terminal?.rows || 0;
    if (!el || !rows) return null;
    const box = el.getBoundingClientRect();
    return box.top + ((row + 0.5) / rows) * box.height;
  }

  _lineText(row) {
    const buf = this.terminal?.buffer?.active;
    const ln = buf?.getLine(buf.viewportY + row);
    return ln ? ln.translateToString(true) : '';
  }

  // Where the anchor LINE is now. A pixel only names a line until the pane scrolls,
  // and a streaming program (Claude Code prints constantly, and xterm here keeps no
  // scrollback of its own — tmux owns that — so every printed line moves the buffer)
  // can scroll several times during the round trip that wipes the selection. Re-
  // anchoring on the raw pixel then rebuilds the selection one or two lines off,
  // which is what "it selects the line above" is.
  //
  // So the anchor's line CONTENT is remembered with it, and if that content has
  // moved a little, the repair follows it. Only a small search: past a few lines
  // this stops being the same gesture, and selecting nothing beats selecting
  // something the user never pointed at.
  ANCHOR_SEARCH_ROWS = 4;

  _anchorY(press) {
    const fallback = press.y;
    if (!press.anchorText) return fallback;
    const row = this._rowAtY(press.y);
    if (row < 0) return fallback;
    if (this._lineText(row) === press.anchorText) return fallback;   // hasn't moved
    for (let d = 1; d <= this.ANCHOR_SEARCH_ROWS; d++) {
      for (const r of [row - d, row + d]) {
        if (r < 0 || r >= (this.terminal?.rows || 0)) continue;
        if (this._lineText(r) === press.anchorText) {
          const y = this._yForRow(r);
          return y === null ? fallback : y;
        }
      }
    }
    return fallback;
  }

  _reassertSelection(press) {
    const mods = this._mouseTracking() ? forceSelectionModifier(IS_MAC) : {};
    const anchorY = this._anchorY(press);
    // The drag end moves with the same scroll, by the same number of rows.
    const endY = press.lastY + (anchorY - press.y);
    // Flagged so the selection-change events this very repair produces don't
    // re-enter _onSelectionChange and repair the repair.
    this._restoringSelection = true;
    try {
      this._dispatchPress(press, mods, { y: anchorY });
      this._dispatchPress(press, { buttons: 1 },
        { x: press.lastX, y: endY, type: 'mousemove' });
      if (press.done) {
        this._dispatchPress(press, { buttons: 0 },
          { x: press.lastX, y: endY, type: 'mouseup' });
      }
    } finally {
      this._restoringSelection = false;
    }
  }

  // Hand the program the press it never got. No modifier, so xterm takes its
  // normal mouse-report path.
  _replayPressToApp(press) {
    this._dispatchPress(press, {});
  }

  // The buffer cell a screen point names. Rows floor into the row they land on;
  // columns round to the nearest column BOUNDARY instead, because a selection's
  // edge lives between characters — clicking the right half of a character takes
  // it, the left half doesn't. (xterm decides its own drags the same way: half a
  // cell added before rounding, in getCoords(..., isSelection).)
  _cellAtPoint(clientX, clientY) {
    const el = this._xtermScreen();
    const t = this.terminal;
    const rows = t?.rows || 0, cols = t?.cols || 0;
    if (!el || !rows || !cols) return null;
    const box = el.getBoundingClientRect();
    if (!box.width || !box.height) return null;
    const row = Math.floor(((clientY - box.top) / box.height) * rows);
    const col = Math.round(((clientX - box.left) / box.width) * cols);
    return {
      x: Math.min(cols, Math.max(0, col)),
      // Absolute buffer row: terminal.select() and getSelectionPosition() both
      // speak buffer coordinates, and the viewport is only at 0 while nothing has
      // scrolled.
      y: (t.buffer?.active?.viewportY || 0) + Math.min(rows - 1, Math.max(0, row)),
    };
  }

  // Re-select from the anchor to this point. The selection is written straight into
  // xterm rather than replayed as a press, so it works the same over a program that
  // is grabbing the mouse (where xterm's own shift-click does nothing at all — see
  // mouse-mode.js). Returns false when there is nothing to extend, which is the
  // caller's cue to let the press be an ordinary one.
  _extendSelectionTo(clientX, clientY) {
    const t = this.terminal;
    const sel = t?.getSelectionPosition?.();
    if (!sel) return false;
    const point = this._cellAtPoint(clientX, clientY);
    if (!point) return false;
    const anchor = extendAnchor(this._selAnchor, sel, point, t.cols);
    const span = selectionSpan(anchor, point, t.cols);
    if (span.y < 0) return false;
    this._selAnchor = anchor;
    // The repair watcher belongs to the drag that made this selection, and it
    // remembers that drag's endpoints. Left running it would answer the next wipe
    // by rebuilding the span this adjustment just replaced.
    if (this._selGuard) { clearTimeout(this._selGuard); this._selGuard = null; }
    this._selGuardPress = null;
    // Setting a selection fires the change event; the guard above is gone, but the
    // flag also covers a guard armed by some other in-flight gesture.
    this._restoringSelection = true;
    try { t.select(span.x, span.y, span.length); } finally { this._restoringSelection = false; }
    return true;
  }

  // Remember which END of the selection the gesture that made it started from, so a
  // later shift-click pivots on the right one — a drag made upwards anchors at the
  // BOTTOM, and extending it from the top would grow the wrong way.
  //
  // The press point is matched against the (order-normalised) ends rather than
  // trusted as the anchor itself, so a double-click that snapped to a word boundary
  // and a drag that ended a few pixels off both still name a real end.
  _recordSelectionAnchor(press) {
    const t = this.terminal;
    const sel = t?.getSelectionPosition?.();
    if (!sel) { this._selAnchor = null; return; }
    // Followed to wherever the press's line has scrolled to, for the same reason
    // the repair follows it (see _anchorY).
    const from = this._cellAtPoint(press.x, this._anchorY(press));
    if (!from) { this._selAnchor = { ...sel.start }; return; }
    const off = (c) => cellOffset(c, t.cols);
    this._selAnchor = Math.abs(off(from) - off(sel.start)) <= Math.abs(off(from) - off(sel.end))
      ? { ...sel.start } : { ...sel.end };
  }

  // Scroll the tmux buffer, and take any highlight with it.
  //
  // Every scroll goes through here rather than sending the message directly,
  // because scrolling in copy mode is not an xterm scroll and xterm cannot know
  // about it. This terminal runs with scrollback: 0 — tmux owns the history — so
  // asking tmux to scroll makes it REPAINT the same viewport with different text.
  // No line ever moves as far as xterm is concerned, so nothing adjusts a selection
  // the way xterm's own trim handling would, and the highlight sits at fixed screen
  // coordinates while other text slides underneath it.
  //
  // We are the ones who know the scroll happened, and by how many lines, so we are
  // the ones who have to move the selection: `up` shows OLDER text, which pushes
  // the content already on screen DOWN by that many rows.
  _scrollBuffer(up, lines) {
    const n = Math.max(1, Number(lines) || 1);
    // Scrolling ends the copy-mode-transition repair watcher. Without this it
    // fights the scroll: a selection that this shift deliberately drops (because it
    // scrolled out of view) looks to the watcher like the wipe it exists to undo,
    // and it puts the highlight back at the old screen position — over whatever
    // text has just slid into that spot. A scroll means the drag is well behind us.
    if (this._selGuard) { clearTimeout(this._selGuard); this._selGuard = null; }
    this._selGuardPress = null;
    this.sendMessage(up ? MSG.TmuxScrollUp : MSG.TmuxScrollDown, String(n));
    this._shiftSelection(up ? n : -n);
  }

  // Drop the highlight, and everything that would put it back — for when the text it
  // named has left the screen (see viewLeftItsWindow for why that ends a selection).
  //
  // The guard goes with it. That watcher exists to undo a wipe (see _guardSelection),
  // and this wipe is deliberate: left armed, it would re-assert the very highlight
  // being removed, against the new window's text.
  _dropSelection() {
    if (this._selGuard) { clearTimeout(this._selGuard); this._selGuard = null; }
    this._selGuardPress = null;
    this._selAnchor = null;
    this.terminal?.clearSelection();
  }

  // Record which window this pane is now showing, and say whether that is a change.
  // Read from the LAYOUT rather than from our own selectWindow calls, so switches we
  // did not make are caught too: tmux's own `prefix n` typed into the pane, another
  // client moving this session, the hop a reconnect restores.
  _noteShownWindow() {
    const next = this.layout?.activeWindowId || null;
    const changed = viewLeftItsWindow({ shown: this._shownWindowId, next });
    this._shownWindowId = next;
    return changed;
  }

  // Move the selection `rows` down the buffer (negative = up), clipping it to what
  // is still on screen and dropping it once it has scrolled entirely out of view —
  // a highlight parked on a line nobody can see is worse than none.
  _shiftSelection(rows) {
    const t = this.terminal;
    if (!rows || !t) return;
    const pos = t.getSelectionPosition();
    if (!pos) return;
    const cols = t.cols;
    const lastRow = (t.buffer?.active?.length || t.rows) - 1;
    let sy = pos.start.y + rows, sx = pos.start.x;
    let ey = pos.end.y + rows, ex = pos.end.x;
    // Guarded because re-selecting fires selection-change events, and the repair
    // watcher from a just-finished drag must not read this as a wipe to undo.
    // The shift-click anchor names a cell in the same buffer, so it moves with it —
    // and once it has been scrolled off, it is dropped rather than left pointing at
    // a row that no longer exists (extendAnchor falls back on its own from there).
    const dropAnchor = () => { this._selAnchor = null; };
    if (this._selAnchor) {
      const ay = this._selAnchor.y + rows;
      if (ay < 0 || ay > lastRow) dropAnchor();
      else this._selAnchor = { x: this._selAnchor.x, y: ay };
    }
    this._restoringSelection = true;
    try {
      if (ey < 0 || sy > lastRow) { t.clearSelection(); dropAnchor(); return; }
      if (sy < 0) { sy = 0; sx = 0; }                 // clip the part scrolled off the top
      if (ey > lastRow) { ey = lastRow; ex = cols; }  // ...and off the bottom
      const length = (ey - sy) * cols + (ex - sx);
      if (length <= 0) { t.clearSelection(); dropAnchor(); return; }
      t.select(sx, sy, length);
    } finally {
      this._restoringSelection = false;
    }
  }

  connect() {
    // A reconnect timer scheduled before this unit was destroyed must not
    // resurrect it: a fresh ws would make the server recreate the region's
    // grouped web-* session and stream output into a disposed xterm.
    if (this.destroyed) return;
    this._reconnectTimer = null;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}${window.location.pathname}ws`;

    this.ws = new WebSocket(wsUrl, ['webtty']);

    this.ws.onopen = () => {
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
      //
      // Shared UI state has the same problem and needs telling too: a write that
      // was handed to a socket that had already gone was never sent (sendMessage
      // reports that below), so the store is still holding it. Nothing else would
      // ever ask it to try again — the debounce that would have re-flushed it fired
      // long ago — so the reconnect is the trigger. Only the PRIMARY unit owns the
      // store's transport, so only it re-arms.
      if (this.primary) stateStore.resync();
      this._startHeartbeat();
      if (this.onConnectionChange) this.onConnectionChange(this);
    };

    this.ws.onmessage = (event) => {
      this.handleMessage(event.data);
    };

    this.ws.onclose = () => {
      if (this.destroyed) return;
      this._wasClosed = true;
      // A closed socket is reported as closed, not as stalled — and there is nothing
      // left to ping.
      this._stopHeartbeat();
      this._stalled = false;
      if (this.onConnectionChange) this.onConnectionChange(this);

      // Reconnect to the SAME session (a grouped region's session is recreated by
      // attach-web.sh under the same name) and RESTORE the window we were viewing
      // — otherwise the fresh attach resets us to the base's current window. We no
      // longer hop to a different session on reconnect (that reset the view).
      if (this.reconnectInterval) {
        this.restorePending = true;
        this._reconnectTimer = setTimeout(() => this.connect(), this.reconnectInterval * 1000);
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
        // Held for a hover preview? Park the bytes rather than painting them over
        // the preview (and rather than dropping them — they replay on release).
        if (this._previewHold) this._holdOutput(bytes);
        else this.terminal.write(bytes);
        break;

      case MSG.Pong:
        // Proof the server's input loop is still turning — see the heartbeat above.
        this._notePong();
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
        // This connection's write authority (webtty/authority.go). Absent only
        // from a server older than the gate, where everything was permitted — so
        // an omitted field must NOT be read as read-only, or a new bundle against
        // an old binary would grey out a UI that works.
        if (prefs.permitWrite !== undefined) {
          writeAuthority.set(prefs.permitWrite !== false);
          if (this.onWriteAuthority) this.onWriteAuthority(prefs.permitWrite !== false);
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
        // A different window is on screen now, so any highlight is over text that is
        // no longer there — see viewLeftItsWindow.
        if (this._noteShownWindow()) this._dropSelection();
        this._syncCopyModeFromLayout();
        this._rememberOrRestore();
        this.dispatchLayoutUpdate();
        break;

      case MSG.TmuxModeUpdate:
        const modeState = JSON.parse(payload);
        this.inCopyMode = modeState.inCopyMode;
        // Left copy mode (from anywhere — the toolbar pill, tmux itself, `q`): any
        // keys still held for arbitration belong at the prompt now.
        if (!this.inCopyMode && this._copyArbiter.held) this._copyArbiter.flush('typing');
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

      case MSG.TmuxScrollbackData:
        // A whole pane buffer came back. Routed straight through to the
        // SplitManager, which matches it against the request it is waiting on and
        // hands it to a download — it is never cached anywhere.
        try {
          this.onScrollbackData?.(JSON.parse(payload));
        } catch (e) {
          console.warn('Bad scrollback data:', e);
        }
        break;

      case MSG.TmuxSaveResult:
        // Result of a "save pane buffer to a server file" request; SplitManager
        // routes it to the toolbar's save dropdown for success/error feedback.
        try {
          this.onSaveResult?.(JSON.parse(payload));
        } catch (e) {
          console.warn('Bad save result:', e);
        }
        break;

      case MSG.TmuxError:
        // Surfaced in the toolbar (see SplitManager.showNotice) rather than
        // swallowed: nothing changed, so the layout push that follows looks
        // identical to the one before it and says nothing at all.
        console.warn('tmux refused:', payload);
        if (this.onNotice) this.onNotice(payload);
        break;

      case MSG.TmuxSaveInfo:
        // Answer to "where would a save land?" — routed to the toolbar's save
        // dropdown so it can say so before anything is written.
        try {
          this.onSaveInfo?.(JSON.parse(payload));
        } catch (e) {
          console.warn('Bad save info:', e);
        }
        break;

      case MSG.TmuxHistoryInfo:
        // Scrollback sizes/usage, and the outcome of whatever action asked for
        // them. Routed to the toolbar's scrollback dropdown.
        try {
          this.onHistoryInfo?.(JSON.parse(payload));
        } catch (e) {
          console.warn('Bad scrollback info:', e);
        }
        break;

      default:
        console.warn('Unknown message type:', type);
    }
  }

  // Returns whether the message actually went out. Most callers ignore it — a
  // dropped keystroke or resize is corrected by the next one — but the shared
  // StateStore cannot: a persisted change handed to a closed socket is simply gone,
  // and the store has to know to keep holding it rather than mark it written.
  sendMessage(type, payload = '') {
    // A server without `-w` drops mutating messages at its own gate
    // (webtty/authority.go). Refusing here too is not belt-and-braces for
    // security — the server is the boundary — it is what makes the refusal
    // VISIBLE: the frame never leaves, the caller learns it failed, and the
    // notice below says why once rather than the UI optimistically painting a
    // tmux server that did not move.
    if (!writeAuthority.allows(type)) {
      this._noteReadOnly();
      return false;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      // Tick the toolbar's activity spinner for anything that drives tmux (the
      // callback debounces, so a burst is one increment).
      if (TMUX_MSG_TYPES.has(type) && this.onTmuxActivity) this.onTmuxActivity();
      this.ws.send(type + payload);
      return true;
    }
    console.warn('WebSocket not ready, state:', this.ws?.readyState);
    return false;
  }

  // Surface the read-only refusal, throttled: a keystroke, a wheel spin and the
  // 500ms state flush all end up here, and a banner per frame is noise. One
  // notice every few seconds is enough to explain a dead-feeling UI.
  _noteReadOnly() {
    const now = Date.now();
    if (this._roNoticeAt && now - this._roNoticeAt < 4000) return;
    this._roNoticeAt = now;
    if (this.onNotice) this.onNotice(READ_ONLY_NOTICE);
  }

  // ----- preview hold -----------------------------------------------------------
  // Lend this region's xterm to a HoverPreview. While held, our own output is
  // buffered (see the Output case) so it neither paints over the preview nor goes
  // missing. Cap the buffer: a chatty window under a long hover shouldn't grow it
  // without bound — past the cap the oldest chunks are dropped, and the repaint on
  // release fixes up the visible screen anyway.
  beginPreviewHold() {
    this._previewHold = true;
    this._previewBuf = [];
  }

  _holdOutput(bytes) {
    this._previewBuf.push(bytes);
    let total = 0;
    for (const b of this._previewBuf) total += b.length;
    while (total > 512 * 1024 && this._previewBuf.length > 1) total -= this._previewBuf.shift().length;
  }

  // Hand the region back.
  //
  // restore:true (the normal end-of-hover path) — replay what this region's own
  //   window printed while we held it, and ask tmux to repaint. The replay alone
  //   can't be trusted to undo the preview's full-screen blit, and the repaint alone
  //   would be a beat late; together the screen is right immediately and exact
  //   shortly after.
  // restore:false — the caller is COMMITTING, i.e. this region is about to switch to
  //   a different window entirely. The buffered bytes belong to the window we're
  //   leaving, so they're dropped rather than flashed on screen just before the new
  //   window paints over them.
  endPreviewHold({ restore = true } = {}) {
    if (!this._previewHold) return;
    this._previewHold = false;
    const buf = this._previewBuf;
    this._previewBuf = [];
    if (!restore) return;
    this.refreshClient();
    for (const bytes of buf) { try { this.terminal?.write(bytes); } catch (e) {} }
  }

  // Ask tmux to fully repaint this pane's client.
  refreshClient() {
    this.sendMessage(MSG.TmuxRefresh, '');
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
  //
  // WHICH of those two moves each region is allowed to make — and why the primary
  // may hop sessions but not pick its own window — is planReconnectLanding's job
  // (restore-view.js), where the rules are pinned by tests.
  _rememberOrRestore() {
    const active = this.layout.activeWindowId;
    const activeWin = (this.layout.windows || []).find(w => w.id === active);
    const base = this.layout.sessionBase || this.layout.sessionName;
    if (this.restorePending) {
      this.restorePending = false;
      const plan = planReconnectLanding({
        primary: this.primary,
        base,
        activeWindowId: active,
        desiredSession: this.desiredSession,
        desiredWindowId: this.desiredWindowId,
        desiredWindowIndex: this.desiredWindowIndex,
        windows: this.layout.windows || [],
        placements: (this.layout.allWindows || []).map(w => ({ id: w.id, session: w.session || '' })),
        sessions: (this.layout.sessions || []).map(s => s.name),
      });
      // The window this first post-reconnect layout shows is where the fresh attach
      // PARKED us — the base session's current window — not somewhere the user went.
      // SplitManager's access-note (which sees this layout right after us) treats
      // any unseen window as a visit, so without this mark every reconnect stamped
      // the base session's parked window (typically its window 0) into the recents
      // strip. Marking it seen suppresses only this layout; the hop back below
      // lands on the desired window, whose OWN layout records the view as before.
      this._accessSeenId = plan.markSeen;
      if (plan.hop || plan.select) {
        // Same transient guard as goToWindow: the hop can emit an intermediate
        // layout showing the target window while still naming the base session,
        // which must not be recorded as a visit in a session it never had.
        if (plan.hop && plan.select) this._navSuppress = { id: plan.select, session: base };
        // Same reasoning one level up, for attention flashes rather than recents:
        // this layout is dispatched to SplitManager before the restore below lands,
        // so for one poll the region "shows" the parked window. Left unmarked, that
        // counts as having looked at it and cancels its flash.
        this._parkedWindowId = plan.park;
        // Claim the view we are on our way to, the same way a live switch does.
        // SplitManager saves a region's view from these when they are set, so a
        // persist triggered by this parked layout (the session half of the view
        // just changed, which is itself a trigger) records where we are GOING
        // rather than overwriting the saved view with the parking spot.
        if (plan.select) this._targetWindowId = plan.select;
        if (plan.hop) this._targetSession = plan.hop;
        // Both sends ride the same serialized ws (see goToWindow).
        if (plan.hop) this.switchSession(plan.hop);
        if (plan.select) this.selectWindow(plan.select);
        return;   // the resulting layout re-remembers the restored view
      }
    }
    // Reached on every layout that is NOT an in-flight restore hop — including the
    // one the hop above lands on — so the parked marker clears itself the moment the
    // region is genuinely showing something.
    this._parkedWindowId = null;
    this.desiredWindowId = active;
    this.desiredSession = base;
    if (activeWin) this.desiredWindowIndex = activeWin.index;
    // Access recency is recorded centrally by SplitManager (focus + layout
    // transition, with arrow-browse suppression) — the single write path shared
    // by the toolbar strip and the Exposé sort. Nothing to mark here.
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
    this._stopHeartbeat();   // else a closed region keeps pinging a dead socket forever
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    if (this._unsubState) { try { this._unsubState(); } catch (e) {} this._unsubState = null; }
    // A gesture in flight holds document-level listeners; the container going away
    // does not take those with it.
    try { this._releaseGesture?.(); } catch (e) {}
    if (this._selGuard) { clearTimeout(this._selGuard); this._selGuard = null; }
    this._selGuardPress = null;
    if (this.resizeObserver) { try { this.resizeObserver.disconnect(); } catch (e) {} }
    if (this.ws) { try { this.ws.onclose = null; this.ws.close(); } catch (e) {} }
    if (this.terminal) { try { this.terminal.dispose(); } catch (e) {} }
  }

  // Public API for components (sidebar / mobile controls) — resolve to THIS unit.
  selectPane(paneId) {
    this.sendMessage(MSG.TmuxSelectPane, paneId);
  }

  selectWindow(windowId) {
    // The highlight belongs to the window being left. Dropped BEFORE the optimistic
    // paint below, so it never gets a frame over the new window's text — the layout
    // that follows would drop it anyway, but a round-trip later.
    if (viewLeftItsWindow({ shown: this._shownWindowId, next: windowId })) this._dropSelection();
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

  // Create a window in `session` (empty = this pane's own session, which is what
  // the toolbar chord and the default sidebar view want). The sidebar's tree view
  // names the session, because there its "+" sits under a specific one.
  newWindow(session = '') {
    this.sendMessage(MSG.TmuxNewWindow, session || '');
  }

  // Reorder a window to ordinal position `targetPos` (0-based, in index order)
  // within `session`'s window list — the server bubbles it there via swap-window.
  // Driven by drag-and-drop in the sidebar; `session` is what lets its tree view
  // reorder a session this pane isn't attached to (empty = this pane's own).
  moveWindow(windowId, targetPos, session = '') {
    this.sendMessage(MSG.TmuxMoveWindow, windowId + ' ' + targetPos + (session ? ' ' + session : ''));
  }

  // Create a fresh session and switch this pane's view to it (the server picks the
  // name). Parity with newWindow(); driven by the sidebar's Sessions "+" button.
  newSession() {
    this.sendMessage(MSG.TmuxNewSession, '');
  }

  // Rename a session by its (current) logical name. Parity with renameWindow;
  // driven by double-clicking a session tab in the sidebar.
  renameSession(oldName, newName) {
    // "<oldName>\0<newName>" — BOTH halves are user-typed session names, so the
    // payload needs a separator neither can contain (see tmux-payloads.js). The
    // old first-space split aimed a rename of "my project" at "my".
    this.sendMessage(MSG.TmuxRenameSession, renameSessionPayload(oldName, newName));
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

  // Unlink a window from `session` (empty = THIS pane's own), leaving it running in
  // the other sessions it's linked into (sidebar hover × when the window lives
  // elsewhere too). The sidebar's tree view names the session, because the row whose
  // × was clicked can belong to any of them.
  unlinkWindow(windowId, session = '') {
    this.sendMessage(MSG.TmuxUnlinkWindow, windowId + (session ? ' ' + session : ''));
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

  // ----- liveness ---------------------------------------------------------------

  _startHeartbeat() {
    this._stopHeartbeat();
    const now = Date.now();
    this._lastPongAt = now;      // a fresh socket is alive until it proves otherwise
    this._lastTickAt = now;
    this._heartbeat = setInterval(() => this._heartbeatTick(), HEARTBEAT_MS);
  }

  _stopHeartbeat() {
    if (this._heartbeat) { clearInterval(this._heartbeat); this._heartbeat = null; }
  }

  _heartbeatTick() {
    const now = Date.now();
    const gap = now - this._lastTickAt;
    this._lastTickAt = now;
    // OUR clock stopped, not theirs. Browsers throttle timers in background tabs to
    // once a minute or so, and a suspended laptop stops them outright — either way we
    // wake with a huge apparent silence that we caused. Reporting that as a lost
    // connection would mean every tab you come back to greets you with a false alarm.
    if (gap > HEARTBEAT_MS * 2.5) {
      this._lastPongAt = now;
      this._setStalled(false);
      return;                    // let the next beat judge, with an honest clock
    }
    if (!this.isConnected()) return;
    this.sendMessage(MSG.Ping);
    this._setStalled(now - this._lastPongAt > STALL_MS);
  }

  _notePong() {
    this._lastPongAt = Date.now();
    this._setStalled(false);
  }

  _setStalled(v) {
    if (this._stalled === v) return;
    this._stalled = v;
    if (this.onConnectionChange) this.onConnectionChange(this);
  }

  // Open, but not answering — see the heartbeat block above.
  isStalled() {
    return this._stalled;
  }

  // Have we LOST the connection to tmux (as opposed to never having had it yet)?
  //
  // Two different failures, one answer. The socket may be CLOSED: the server runs this
  // region's tmux client on the far end of it, so tmux dying, the server dying and the
  // network dropping all arrive as a close. Or the socket may be OPEN AND MUTE, which
  // is the one that actually strands you — see the heartbeat block above.
  //
  // What the closed half must not report is the ordinary boot: the socket spends its
  // first moments in CONNECTING, which is indistinguishable from a reconnect attempt by
  // readyState alone. Hence the latch — only a socket that has closed at least once can
  // be "lost", and it stays lost across the CONNECTING gaps of the retry loop (which
  // would otherwise strobe the warning once per retry) until a retry actually opens.
  connectionLost() {
    return (this._wasClosed && !this.isConnected()) || this._stalled;
  }

  // Request server-global capture buffers over THIS unit's ws. The reply (a
  // TmuxCaptureData frame) returns on the same ws and is routed to the shared
  // CaptureCache via onCaptureData. windows: 'all' or an array of window ids.
  sendCaptureRequest(windows = 'all', force = false) {
    if (!this.isConnected()) return false;
    this.sendMessage(MSG.TmuxCaptureRequest, JSON.stringify({ windows, force }));
    return true;
  }

  // Ask the server to save a window's pane buffer to a file on the machine tmux
  // runs on. The server re-captures the pane itself (so the file matches the
  // browser download) and resolves a relative path against the pane's own working
  // directory. The outcome comes back as a TmuxSaveResult -> onSaveResult.
  // `dir` is the save directory the user picked in the dropdown (see
  // save-target.js); the server validates it and may still refuse.
  // `overwrite` is the answer to the server's "that file already exists"
  // refusal, which it never assumes: a save into a taken name comes back as a
  // question (see savepath.go) and only a request carrying this replaces the file.
  // `scope` picks WHICH buffer gets written — the whole scrollback or just the
  // visible screen (see save-scope.js). The server honors the same two words for
  // the download below, so the dropdown's choice means one thing everywhere.
  sendSavePaneFile(windowId, path, dir = '', overwrite = false, scope = '') {
    if (!this.isConnected()) return false;
    return this.sendMessage(MSG.TmuxSavePaneFile,
      JSON.stringify({ windowId, path, dir, overwrite, scope }));
  }

  // Ask for a window's ENTIRE pane buffer — tmux history plus the visible screen
  // — for a browser download. Read-only on the server (it forks `capture-pane
  // -S -`), so it works on a read-only webtmux, which is the point: downloading
  // is the one save that asks nothing of anyone's filesystem.
  //
  // `token` comes back on the reply. The browser gives up on a slow read and the
  // user can click again, so a reply has to identify the request it answers —
  // without that, a late first answer would satisfy the second download with the
  // buffer from before.
  sendScrollbackRequest(windowId, token) {
    if (!this.isConnected()) return false;
    return this.sendMessage(MSG.TmuxScrollbackRequest, JSON.stringify({ windowId, token }));
  }

  // Ask where a save for this window WOULD land — which directory a relative path
  // resolves against, whether webtmux can see the pane's own directory at all, and
  // whether it is containerized. Writes nothing; the reply is a TmuxSaveInfo ->
  // onSaveInfo. Sent when the save dropdown opens, so the answer is on screen
  // before the user commits to a name (see save-target.js).
  sendSaveInfoRequest(windowId, dir = '') {
    if (!this.isConnected()) return false;
    this.sendMessage(MSG.TmuxSaveInfoRequest, JSON.stringify({ windowId, dir }));
    return true;
  }

  // Ask how big this window's scrollback is and how much of it is used. Read-only
  // on the server (`list-panes -F` + `show-options -v`), so it answers on a
  // read-only webtmux too: seeing how full a buffer is changes nothing. The reply
  // is a TmuxHistoryInfo -> onHistoryInfo.
  sendHistoryInfoRequest(windowId) {
    if (!this.isConnected()) return false;
    return this.sendMessage(MSG.TmuxHistoryInfoRequest, JSON.stringify({ windowId }));
  }

  // Change a scrollback buffer: 'default' (what NEW windows are born with),
  // 'resize' (rebuild this window's panes at a new size — destructive, hence
  // `force`; `rerun` asks that panes tmux knows a launch command for come back
  // running it rather than as bare shells), or 'clear'. The reply is the same TmuxHistoryInfo frame, carrying
  // the outcome AND the numbers it produced, so the panel can never report a
  // change beside figures from before it.
  sendHistoryAction(windowId, action, limit = 0, force = false, rerun = false) {
    if (!this.isConnected()) return false;
    return this.sendMessage(MSG.TmuxHistoryAction,
      JSON.stringify({ windowId, action, limit, force, rerun }));
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
    stateStore.patchSection('renderer', { scrollMode: this.scrollMode });
    if (this.scrollMode === 'app' && this.inCopyMode) {
      this.exitCopyMode();
    }
  }

  // Switch mouse click/drag behavior (one of MOUSE_MODES); called from the toolbar
  // cycle button. Unlike the scroll modes this never touches copy mode: the whole
  // point of the setting is that selecting no longer requires a mode change, so
  // changing it shouldn't cause one either.
  setMouseMode(mode) {
    this.mouseMode = normalizeMouseMode(mode);
    stateStore.patchSection('renderer', { mouseMode: this.mouseMode });
    // A gesture that was mid-flight was arbitrated under the OLD rules; drop it
    // rather than resolve it under rules the user just changed.
    this._releaseGesture?.();
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
            // tmux's OWN copy (a mouse drag in copy mode, `y`, copy-pipe) arrives
            // here, so it fills the ring exactly as ⌘C does — otherwise half the
            // ways to copy in this app would bypass the buffers. When the same
            // copy reaches the ring twice (⌘C over an xterm selection, then this),
            // the ring's duplicate guard collapses it to one entry.
            copyBuffers.copy(text);
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
