package webtty

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"webtmux/pkg/tmux"
)

// TmuxController interface for tmux operations
type TmuxController interface {
	GetLayout() *tmux.Layout
	RefreshLayout() error
	SelectPane(paneID string) error
	SelectWindow(windowID string) error
	SwitchSession(sessionName string) error
	RenameWindow(windowID, name string) error
	// MoveWindow/UnlinkWindow take the SESSION whose window list is being changed
	// ("" = the pane's own): the sidebar's tree view lists every session on the
	// server, so a reorder or an unlink can target one no pane is attached to.
	MoveWindow(windowID string, targetPos int, session string) error
	NewSession() error
	RenameSession(oldName, newName string) error
	KillWindow(windowID string) error
	KillSession(sessionName string) error
	LinkWindow(windowID, targetSession string) error
	UnlinkWindow(windowID string, session string) error
	SplitPane(horizontal bool) error
	ClosePane(paneID string) error
	SetGlobalOption(key, val string) error
	// Scrollback buffer management. SetDefaultHistoryLimit changes what NEW
	// windows are born with; ResizeWindowHistory rebuilds an existing window's
	// panes at a new size (destructive — see pkg/tmux/history.go); ClearWindowHistory
	// empties them. windowID is passed to the default-setter too, so it can tell
	// whether a session-scope override would shadow the global write.
	SetDefaultHistoryLimit(windowID string, limit int) error
	// PersistDefaultHistoryLimit additionally writes it into the tmux config file,
	// so a tmux server started later comes up with it. Returns the path written.
	PersistDefaultHistoryLimit(windowID string, limit int) (string, error)
	// force is the user's agreement to kill what is running; rerun asks that panes
	// tmux knows a launch command for come back running it rather than as shells.
	ResizeWindowHistory(windowID string, limit int, force, rerun bool) (tmux.HistoryResize, error)
	ClearWindowHistory(windowID string) error
	EnterCopyMode() error
	ExitCopyMode() error
	RefreshClient() error
	ScrollUp(lines int) error
	ScrollDown(lines int) error
	// NewWindow takes the session to create the window in ("" = the pane's own):
	// the sidebar's tree view gives every session its own "+".
	NewWindow(session string) error
	Events() <-chan tmux.Event
}

// SetTmuxController sets the tmux controller for the WebTTY instance
func (wt *WebTTY) SetTmuxController(tc TmuxController) {
	wt.tmuxCtrl = tc
}

// CaptureProvider supplies color-preserving window snapshots. Implemented by the
// server-global *tmux.CaptureStore; a single instance is shared by every
// connection (see SetCaptureProvider).
type CaptureProvider interface {
	CaptureWindows(windowIDs []string, force bool) ([]tmux.CaptureEntry, error)
	// PaneCurrentPath is the active pane's working directory for windowID — the
	// base a relative "save to file" path resolves against (see handleSavePaneFile).
	PaneCurrentPath(windowID string) (string, error)
	// CaptureScrollback is the WHOLE pane buffer (tmux history + screen) as plain
	// text, for a save. Uncached and unbounded; asked for only on a user gesture.
	CaptureScrollback(windowID string) (string, error)
	// HistoryReport is one window's scrollback ACCOUNTING — how big each pane's
	// buffer is and how much of it holds anything. Read-only, so it belongs here
	// with the other reads rather than on the write-side controller.
	HistoryReport(windowID string) (tmux.HistoryReport, error)
}

// SetCaptureProvider hands this connection the shared capture store. Parallel to
// SetTmuxController but deliberately server-global, not per-connection.
func (wt *WebTTY) SetCaptureProvider(cp CaptureProvider) {
	wt.captureProvider = cp
}

// SendTmuxLayout sends the current tmux layout to the client
func (wt *WebTTY) SendTmuxLayout() error {
	if wt.tmuxCtrl == nil {
		return nil
	}

	layout := wt.tmuxCtrl.GetLayout()
	if layout == nil {
		return nil
	}

	data, err := json.Marshal(layout)
	if err != nil {
		return fmt.Errorf("failed to marshal tmux layout: %w", err)
	}

	return wt.masterWrite(append([]byte{TmuxLayoutUpdate}, data...))
}

// SendTmuxModeUpdate sends the copy mode state to the client
func (wt *WebTTY) SendTmuxModeUpdate(inCopyMode bool) error {
	state := tmux.ModeState{
		InCopyMode: inCopyMode,
	}

	data, err := json.Marshal(state)
	if err != nil {
		return fmt.Errorf("failed to marshal tmux mode state: %w", err)
	}

	return wt.masterWrite(append([]byte{TmuxModeUpdate}, data...))
}

// afterCmd reports the outcome of ONE client-requested tmux command.
//
// A tmux command that fails is an ordinary outcome here, not a protocol fault:
// the window was killed a moment before the click landed, the pane had already
// left copy mode, another client renamed the session out from under us. What is
// NOT ordinary is what returning that error used to do. handleMasterReadEvent
// passes a handler error out of Run; processWSConn then unwinds and its
// `defer slave.Close()` signals the pty's process — SIGHUP by default (the
// close-signal flag) — and the tmux client attached in that pty prints its own
// goodbye for a hangup before it dies: `[lost tty]`. So one rejected tmux
// command cost the user the whole pane, and whatever they had just typed or
// pasted into it.
//
// Hence: log it, push the layout so the browser re-syncs to what tmux ACTUALLY
// did (its optimistic update was wrong, and staying wrong is how the NEXT
// impossible command gets sent), and keep the connection. Only a genuine I/O
// failure writing to the master — the connection is already gone — is fatal.
// One exception to "log it and move on": a REFUSAL. tmux saying no is a race the
// layout push repairs, and the user sees the UI correct itself. A refusal is the
// controller declining to guess which object a command would hit — nothing raced,
// nothing will change, and the layout push therefore shows exactly what it showed
// before. Without a word, that is indistinguishable from a broken button. So a
// refusal also goes to the browser as a TmuxError, which the toolbar shows as one
// line of explanation.
func (wt *WebTTY) afterCmd(what string, err error) error {
	if err != nil {
		log.Printf("tmux %s failed (ignored, pane kept): %v", what, err)
		if errors.Is(err, tmux.ErrRefused) {
			wt.sendTmuxError(err)
		}
	}
	return wt.SendTmuxLayout()
}

// sendTmuxError tells the browser why an action did nothing. Best-effort: the
// message is an explanation, never the thing that costs the user their pane.
func (wt *WebTTY) sendTmuxError(err error) {
	msg := strings.TrimPrefix(err.Error(), "refused: ")
	if werr := wt.masterWrite(append([]byte{TmuxError}, []byte(msg)...)); werr != nil {
		log.Printf("failed to send tmux error to client: %v", werr)
	}
}

// handleTmuxMessage handles tmux-specific messages from the client.
//
// No case here returns a tmux command's error: see afterCmd for why a failed
// tmux command must never tear the connection down.
func (wt *WebTTY) handleTmuxMessage(msgType byte, payload []byte) error {
	// Capture requests use the server-global captureProvider, not the
	// per-connection tmuxCtrl, so handle them before the tmuxCtrl guard.
	if msgType == TmuxCaptureRequest {
		return wt.handleCaptureRequest(payload)
	}
	// Saving a pane buffer to a server-side file likewise reads only the shared
	// captureProvider (it re-captures the pane), so handle it before the guard too.
	if msgType == TmuxSavePaneFile {
		return wt.handleSavePaneFile(payload)
	}
	// Same for the read-only "where would a save land?" probe.
	if msgType == TmuxSaveInfoRequest {
		return wt.handleSaveInfo(payload)
	}
	// And for the full-buffer read behind "Download to browser".
	if msgType == TmuxScrollbackRequest {
		return wt.handleScrollbackRequest(payload)
	}
	// "How big is this scrollback and how full is it?" is a read of the same
	// server-global store, so it too answers before the tmuxCtrl guard.
	if msgType == TmuxHistoryInfoRequest {
		return wt.handleHistoryInfoRequest(payload)
	}

	if wt.tmuxCtrl == nil {
		return nil // Silently ignore if no tmux controller
	}

	switch msgType {
	case TmuxSelectPane:
		return wt.afterCmd("select pane", wt.tmuxCtrl.SelectPane(string(payload)))

	case TmuxSelectWindow:
		return wt.afterCmd("select window", wt.tmuxCtrl.SelectWindow(string(payload)))

	case TmuxSplitPane:
		return wt.afterCmd("split pane", wt.tmuxCtrl.SplitPane(string(payload) == "h"))

	case TmuxClosePane:
		return wt.afterCmd("close pane", wt.tmuxCtrl.ClosePane(string(payload)))

	case TmuxCopyMode:
		enter := string(payload) == "1"
		var err error
		if enter {
			err = wt.tmuxCtrl.EnterCopyMode()
		} else {
			err = wt.tmuxCtrl.ExitCopyMode()
		}
		if err != nil {
			log.Printf("tmux copy mode (enter=%v) failed (ignored, pane kept): %v", enter, err)
		}
		// Answer with what tmux is ACTUALLY doing, not with what was asked for.
		// The browser gates copy-mode-only work on this flag — the keystroke
		// arbiter, the wheel, and every `send-keys -X …` the two of them produce —
		// so a client that thinks it is in copy mode when the pane is not is
		// precisely the state that generated impossible commands. The 500ms layout
		// poll would correct it eventually; re-reading it here closes that window
		// on the one event that is most likely to have desynced it, for the price
		// of a couple of forks on a deliberate user gesture.
		wt.tmuxCtrl.RefreshLayout()
		if l := wt.tmuxCtrl.GetLayout(); l != nil {
			return wt.SendTmuxModeUpdate(l.ActivePaneInMode)
		}
		return wt.SendTmuxModeUpdate(enter && err == nil)

	// Scrolling is the one high-frequency control message (one per wheel notch),
	// so a failure is logged but NOT answered with a layout push — a rejected
	// scroll changes nothing there is to re-sync, and a wheel spin would turn
	// into a burst of full layout frames.
	case TmuxScrollUp:
		if err := wt.tmuxCtrl.ScrollUp(scrollLines(payload)); err != nil {
			log.Printf("tmux scroll up failed (ignored, pane kept): %v", err)
		}
		return nil

	case TmuxScrollDown:
		if err := wt.tmuxCtrl.ScrollDown(scrollLines(payload)); err != nil {
			log.Printf("tmux scroll down failed (ignored, pane kept): %v", err)
		}
		return nil

	case TmuxNewWindow:
		// payload = the target session, or empty for the pane's own.
		return wt.afterCmd("new window", wt.tmuxCtrl.NewWindow(strings.TrimSpace(string(payload))))

	case TmuxSwitchSession:
		return wt.afterCmd("switch session", wt.tmuxCtrl.SwitchSession(string(payload)))

	case TmuxRenameWindow:
		// payload = "<windowID> <new name>"; windowIDs are "@N" (no spaces), so
		// split on the first space and keep the rest as the (possibly-spaced) name.
		s := string(payload)
		idx := strings.IndexByte(s, ' ')
		if idx < 0 {
			return nil
		}
		windowID, name := s[:idx], s[idx+1:]
		return wt.afterCmd("rename window", wt.tmuxCtrl.RenameWindow(windowID, name))

	case TmuxMoveWindow:
		// payload = "<windowID> <targetPos> [session]"; windowIDs are "@N" (no spaces).
		// The optional third field names the session whose window list is being
		// reordered — the sidebar's tree view drags rows belonging to sessions this
		// pane isn't attached to. Absent (the single-session view) = the pane's own.
		s := string(payload)
		idx := strings.IndexByte(s, ' ')
		if idx < 0 {
			return nil
		}
		windowID := s[:idx]
		rest := strings.TrimSpace(s[idx+1:])
		session := ""
		if sp := strings.IndexByte(rest, ' '); sp >= 0 {
			rest, session = rest[:sp], strings.TrimSpace(rest[sp+1:])
		}
		targetPos, err := strconv.Atoi(strings.TrimSpace(rest))
		if err != nil {
			return nil
		}
		return wt.afterCmd("move window", wt.tmuxCtrl.MoveWindow(windowID, targetPos, session))

	case TmuxNewSession:
		return wt.afterCmd("new session", wt.tmuxCtrl.NewSession())

	case TmuxRenameSession:
		// payload = "<oldName>\x00<newName>".
		//
		// The only tmux payload with a user-typed string in FRONT, so it is the only
		// one that can't delimit on the first space: this used to take the first
		// token as the target, which meant renaming a session called "my project"
		// aimed at "my" — and tmux resolves a session target by prefix, so that is a
		// silent rename of whichever session starts with it. tmux forbids NUL in a
		// session name, so a NUL is the one separator neither half can contain.
		// A payload without one is dropped rather than guessed at.
		s := string(payload)
		idx := strings.IndexByte(s, 0)
		if idx < 0 {
			return nil
		}
		oldName, newName := s[:idx], s[idx+1:]
		return wt.afterCmd("rename session", wt.tmuxCtrl.RenameSession(oldName, newName))

	case TmuxKillWindow:
		return wt.afterCmd("kill window", wt.tmuxCtrl.KillWindow(string(payload)))

	case TmuxKillSession:
		return wt.afterCmd("kill session", wt.tmuxCtrl.KillSession(string(payload)))

	case TmuxLinkWindow:
		// payload = "<windowID> <targetSession>"; windowIDs are "@N" (no spaces),
		// so split on the first space and keep the rest as the session name.
		s := string(payload)
		idx := strings.IndexByte(s, ' ')
		if idx < 0 {
			return nil
		}
		windowID, targetSession := s[:idx], s[idx+1:]
		return wt.afterCmd("link window", wt.tmuxCtrl.LinkWindow(windowID, targetSession))

	case TmuxUnlinkWindow:
		// payload = "<windowID> [session]" — the session to remove it FROM. Absent
		// (the single-session view) means the pane's own; the tree view names it,
		// because the row you clicked the × on may live in another session entirely.
		s := string(payload)
		windowID, session := s, ""
		if idx := strings.IndexByte(s, ' '); idx >= 0 {
			windowID, session = s[:idx], strings.TrimSpace(s[idx+1:])
		}
		return wt.afterCmd("unlink window", wt.tmuxCtrl.UnlinkWindow(windowID, session))

	case TmuxSetState:
		// Persist the shared UI visual-state blob into the tmux global option
		// @wt_state. The payload is the raw JSON blob; it round-trips back to every
		// client on the next layout push (argv, so no shell escaping). No layout
		// resend here — the 500ms poll picks up the change and pushes it.
		//
		// Validate BEFORE writing: the read side silently drops a non-JSON value
		// (controller RefreshLayout json.Valid check), so accepting one here would
		// quietly void shared state for every client while each keeps its own
		// cache — a fork with no error anywhere. The size cap keeps the blob
		// exec-able (Linux MAX_ARG_STRLEN) and below the ws frame ceiling. Log and
		// DROP rather than error: a returned error tears the whole connection down
		// (handleMasterReadEvent), turning one oversized flush into a reconnect loop.
		if len(payload) > 64*1024 {
			log.Printf("dropping @wt_state write: %d bytes (cap 64K)", len(payload))
			return nil
		}
		if !json.Valid(payload) {
			log.Printf("dropping @wt_state write: payload is not valid JSON")
			return nil
		}
		if err := wt.tmuxCtrl.SetGlobalOption("@wt_state", string(payload)); err != nil {
			log.Printf("@wt_state write failed (ignored, pane kept): %v", err)
		}
		return nil

	case TmuxHistoryAction:
		return wt.handleHistoryAction(payload)

	case TmuxRefresh:
		// Put this region's REAL screen back after a hover preview blitted another
		// window's capture over it. Best-effort: a failed repaint is cosmetic (the
		// next output or a window switch redraws anyway), so it must not tear the
		// connection down.
		if err := wt.tmuxCtrl.RefreshClient(); err != nil {
			log.Printf("refresh-client failed: %v", err)
		}
		return nil

	default:
		// A message type this build doesn't know (a newer browser bundle against an
		// older binary, or a stray frame) is not worth the pane it would cost.
		log.Printf("ignoring unknown tmux message type: %c", msgType)
		return nil
	}
}

// scrollLines reads a scroll message's line count, defaulting to one notch for
// anything absent or nonsensical.
func scrollLines(payload []byte) int {
	lines, _ := strconv.Atoi(string(payload))
	if lines <= 0 {
		return 1
	}
	return lines
}

// ---- capture fan-out ------------------------------------------------------------
//
// A capture request forks `capture-pane` once per window. The client asks on a
// poll AND on every hover, Exposé open, PiP tick and optimistic paint, and each
// request used to spawn its own goroutine unconditionally: nothing bounded how
// many of those could be in flight at once on one connection, and `force:true`
// walked straight past the store's TTL coalescing, which is the only thing that
// makes the polling affordable. A client that asks faster than tmux answers —
// a wedged tmux, or simply a slow one — accumulates goroutines and forks without
// limit, and the connection that "just watches" becomes the expensive one.
//
// Two limits, both per connection:
//
//   • ONE in-flight CaptureWindows at a time. A request that arrives while one is
//     running is dropped rather than queued: the running call is fetching the same
//     buffers from the same server-global store, its reply goes to this same
//     connection, and the client re-asks on its next 500ms tick anyway. Dropping
//     IS the coalescing.
//   • `force` (the TTL bypass) is allowed at most once per window per 500ms. Past
//     that the request still runs — it just takes the cached buffer, which is what
//     the TTL was for.

// forceWindow bounds the force rate limit's bookkeeping. The key set is window
// ids seen on this connection; a server with more live windows than this loses
// only the rate limit's memory of the oldest, never correctness.
const forceLimitMax = 512

// forceInterval is the minimum gap between two TTL-bypassing captures of one
// window on one connection.
const forceInterval = 500 * time.Millisecond

// captureLimiter is the per-connection state behind both limits above.
type captureLimiter struct {
	mu        sync.Mutex
	inFlight  bool
	lastForce map[string]time.Time
}

// begin claims the single in-flight slot. false = another capture is running.
func (l *captureLimiter) begin() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.inFlight {
		return false
	}
	l.inFlight = true
	return true
}

func (l *captureLimiter) end() {
	l.mu.Lock()
	l.inFlight = false
	l.mu.Unlock()
}

// allowForce decides whether this request may bypass the store's TTL. `ids` is
// the requested window set ("" stands for the all-windows request, which is one
// key of its own). A force is granted only if EVERY named window is outside its
// interval, so one hot window cannot drag the whole set past the cache.
func (l *captureLimiter) allowForce(ids []string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.lastForce == nil {
		l.lastForce = map[string]time.Time{}
	}
	keys := ids
	if len(keys) == 0 {
		keys = []string{""} // the all-windows request
	}
	for _, k := range keys {
		if last, ok := l.lastForce[k]; ok && now.Sub(last) < forceInterval {
			return false
		}
	}
	if len(l.lastForce) >= forceLimitMax {
		l.lastForce = map[string]time.Time{}
	}
	for _, k := range keys {
		l.lastForce[k] = now
	}
	return true
}

// handleCaptureRequest parses {windows, force}, refreshes the requested capture
// buffers via the shared store, and streams back a TmuxCaptureData frame. The
// capture runs in a goroutine so a slow tmux fork never blocks this connection's
// read loop; masterWrite serializes the eventual send with all other output.
func (wt *WebTTY) handleCaptureRequest(payload []byte) error {
	if wt.captureProvider == nil {
		return nil // no capture store (non-tmux mode) — ignore
	}

	var req struct {
		Windows json.RawMessage `json:"windows"`
		Force   bool            `json:"force"`
	}
	if len(payload) > 0 {
		if err := json.Unmarshal(payload, &req); err != nil {
			// Drop it: a malformed request costs the user a thumbnail, whereas
			// returning the error would cost them the pane (see afterCmd).
			log.Printf("ignoring invalid tmux capture request: %v", err)
			return nil
		}
	}

	// windows may be a JSON array (["@3","@5"]) or the string "all". Anything that
	// isn't an array (incl. "all", missing, null) resolves to nil == all windows.
	var ids []string
	if len(req.Windows) > 0 {
		_ = json.Unmarshal(req.Windows, &ids)
	}
	force := req.Force && wt.captures.allowForce(ids, time.Now())
	// An all-windows request yields the COMPLETE current placement set, so the reply
	// is tagged `full`: the client may then prune any cached window/placement absent
	// from it (a closed window, or a session a window was unlinked from). A targeted
	// request only speaks about the windows it named, so it is never full.
	full := len(ids) == 0

	if !wt.captures.begin() {
		return nil // coalesced onto the capture already running for this connection
	}
	ctx := wt.connCtx()
	go func() {
		defer wt.captures.end()
		entries, err := wt.captureProvider.CaptureWindows(ids, force)
		if err != nil {
			log.Printf("capture failed: %v", err)
			return
		}
		// The connection may have gone while tmux was forking. Nothing downstream
		// would be wrong about sending anyway — masterWrite just errors — but the
		// marshalling below is a screenful of base64 per window, and a torn-down
		// connection should stop costing anything the moment it is torn down.
		if ctx != nil && ctx.Err() != nil {
			return
		}
		wires := make([]tmux.CaptureWire, 0, len(entries))
		for _, e := range entries {
			wires = append(wires, e.Wire())
		}
		data, err := json.Marshal(struct {
			Captures []tmux.CaptureWire `json:"captures"`
			Full     bool               `json:"full"`
		}{Captures: wires, Full: full})
		if err != nil {
			log.Printf("failed to marshal capture data: %v", err)
			return
		}
		if err := wt.masterWrite(append([]byte{TmuxCaptureData}, data...)); err != nil {
			log.Printf("failed to send capture data: %v", err)
		}
	}()
	return nil
}

// sgrEscape matches SGR (color/attribute) escape sequences — the only escapes
// `capture-pane -e` emits — so we can strip them to plain text for a saved file,
// mirroring the browser download's paneBufferText().
var sgrEscape = regexp.MustCompile("\x1b\\[[0-9;]*m")

// cleanPaneText turns a captured (SGR-annotated, \r\n-joined) screen into the
// plain UTF-8 text written to a saved file: colors stripped, CRLF normalized to
// LF so the file reads cleanly on the (unix) machine tmux runs on.
func cleanPaneText(ansi []byte) string {
	s := sgrEscape.ReplaceAllString(string(ansi), "")
	return strings.ReplaceAll(s, "\r\n", "\n")
}

// ---- save scope -----------------------------------------------------------
//
// A pane has two buffers a person might mean by "save this", and for years the
// UI only ever produced the smaller one: the VISIBLE SCREEN, because the save
// was built on the capture store that feeds Exposé thumbnails, where a screen is
// all anyone wanted. What a terminal is actually FOR — the output that has
// already scrolled past — was the part you could not get out.
//
// So the scope is now named on the wire rather than implied by which code path
// ran, with the same two values honored by both destinations (browser download
// and server-side file). An absent scope means the screen: that is what every
// request predating this field meant, and a client whose cached JS is a version
// behind must keep getting what it asked for rather than a 40MB surprise.
const (
	scopeScreen     = "screen"
	scopeScrollback = "scrollback"
)

// wantsScrollback reads the wire value. Only the explicit word counts.
func wantsScrollback(scope string) bool {
	return strings.TrimSpace(scope) == scopeScrollback
}

// scrollbackLimiter allows ONE in-flight full-buffer capture per connection.
//
// Unlike the screen-capture limiter this does not exist to coalesce a poll —
// nothing polls a scrollback; it is a click. It exists because the click can be
// repeated while the first fork is still walking a 100k-line history, and each
// one costs a tmux fork plus its whole output held in memory twice (the capture
// and its base64). The second request is REFUSED, not dropped: a dropped one
// leaves the browser's download waiting on a reply that will never come.
type scrollbackLimiter struct {
	mu       sync.Mutex
	inFlight bool
}

func (l *scrollbackLimiter) begin() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.inFlight {
		return false
	}
	l.inFlight = true
	return true
}

func (l *scrollbackLimiter) end() {
	l.mu.Lock()
	l.inFlight = false
	l.mu.Unlock()
}

// scrollbackOutcome is the TmuxScrollbackData payload. The text rides as base64
// for the same reason a capture does: it is arbitrary terminal output, and a
// pane that printed a stray invalid UTF-8 byte would otherwise have it silently
// rewritten to U+FFFD by json.Marshal on its way to a file the user asked to be
// a copy of that pane.
type scrollbackOutcome struct {
	WindowID string `json:"windowId"`
	// Token is the client's request id, echoed back. The browser starts a download
	// on the reply, so it has to know that THIS reply is the one it is waiting for
	// and not the answer to a request it already timed out on.
	Token int    `json:"token"`
	Data  string `json:"data"`
	Error string `json:"error"`
}

// handleScrollbackRequest reads one window's entire pane buffer and streams it
// back as a TmuxScrollbackData. Read-only (see authority.go).
//
// The capture runs in a goroutine for the same reason the screen captures do —
// a slow tmux must not block this connection's read loop — and more so here,
// where "slow" is proportional to the history limit rather than to a screen.
func (wt *WebTTY) handleScrollbackRequest(payload []byte) error {
	var req struct {
		WindowID string `json:"windowId"`
		Token    int    `json:"token"`
	}
	if err := json.Unmarshal(payload, &req); err != nil {
		return wt.sendScrollback(scrollbackOutcome{Error: "invalid scrollback request"})
	}
	if wt.captureProvider == nil {
		return wt.sendScrollback(scrollbackOutcome{
			WindowID: req.WindowID, Token: req.Token,
			Error: "reading the buffer is unavailable (not a tmux session)",
		})
	}
	if !wt.scrollbacks.begin() {
		return wt.sendScrollback(scrollbackOutcome{
			WindowID: req.WindowID, Token: req.Token,
			Error: "already reading a buffer — try again in a moment",
		})
	}
	ctx := wt.connCtx()
	go func() {
		defer wt.scrollbacks.end()
		text, err := wt.captureProvider.CaptureScrollback(req.WindowID)
		if ctx != nil && ctx.Err() != nil {
			return // connection gone; don't pay to base64 a dead download
		}
		out := scrollbackOutcome{WindowID: req.WindowID, Token: req.Token}
		if err != nil {
			log.Printf("scrollback capture of %s failed: %v", req.WindowID, err)
			out.Error = "could not read the pane's buffer"
		} else {
			out.Data = base64.StdEncoding.EncodeToString([]byte(text))
			log.Printf("read scrollback of pane %s (%d bytes)", req.WindowID, len(text))
		}
		if err := wt.sendScrollback(out); err != nil {
			log.Printf("failed to send scrollback data: %v", err)
		}
	}()
	return nil
}

// sendScrollback writes one TmuxScrollbackData frame.
func (wt *WebTTY) sendScrollback(out scrollbackOutcome) error {
	data, err := json.Marshal(out)
	if err != nil {
		return fmt.Errorf("failed to marshal scrollback data: %w", err)
	}
	return wt.masterWrite(append([]byte{TmuxScrollbackData}, data...))
}

// handleSaveInfo answers "where would a save go?" for one window, WITHOUT
// writing anything — the save dropdown asks as it opens so it can name the
// directory a relative path will land in, and flag the container case, before
// the user commits to a name. See savepath.go for why that matters.
func (wt *WebTTY) handleSaveInfo(payload []byte) error {
	var req struct {
		WindowID string `json:"windowId"`
		// Dir is the directory the user picked in the dropdown (persisted in the
		// shared UI state, so it rides along with every request). Validated here,
		// never trusted blindly: the reply says whether it checked out.
		Dir string `json:"dir"`
	}
	if err := json.Unmarshal(payload, &req); err != nil {
		return nil // a malformed probe is not worth an error banner
	}
	paneDir := ""
	if wt.captureProvider != nil {
		paneDir, _ = wt.captureProvider.PaneCurrentPath(req.WindowID)
	}
	env := describeSaveEnv(paneDir, req.Dir)
	data, err := json.Marshal(env)
	if err != nil {
		return fmt.Errorf("failed to marshal save info: %w", err)
	}
	return wt.masterWrite(append([]byte{TmuxSaveInfo}, data...))
}

// handleSavePaneFile writes a window's pane buffer to a file on the server (the
// machine tmux runs on). It re-captures the pane fresh through the shared store
// — so the saved text matches what the browser "download" button produces — then
// resolves the target path and writes clean text, replying with a TmuxSaveResult
// so the browser can report the outcome (and the absolute path it landed at).
func (wt *WebTTY) handleSavePaneFile(payload []byte) error {
	var req struct {
		WindowID string `json:"windowId"`
		Path     string `json:"path"`
		// Dir: the user-chosen save directory in force (see handleSaveInfo).
		Dir string `json:"dir"`
		// Overwrite is the answer to the "that file already exists" question. A
		// save NEVER replaces an existing file on the first ask: the suggested
		// filename is derived from the session/window name, so two saves of the
		// same window collide by construction, and the previous one used to
		// disappear without a word. Absent/false = refuse and ask.
		Overwrite bool `json:"overwrite"`
		// Scope: which buffer to write — the whole scrollback or just the visible
		// screen. Absent means the screen (see the scope constants).
		Scope string `json:"scope"`
	}
	if err := json.Unmarshal(payload, &req); err != nil {
		return wt.sendSaveResult(saveOutcome{Error: "invalid save request"})
	}
	if strings.TrimSpace(req.Path) == "" {
		return wt.sendSaveResult(saveOutcome{Error: "no path given"})
	}
	if wt.captureProvider == nil {
		return wt.sendSaveResult(saveOutcome{Error: "saving is unavailable (not a tmux session)"})
	}
	// Relative paths land in the pane's own working directory when webtmux can SEE
	// it; when it can't (the container case), describeSaveEnv picks a directory
	// that exists here and the reply says so rather than the save silently
	// landing somewhere the user never named. See savepath.go.
	paneDir, _ := wt.captureProvider.PaneCurrentPath(req.WindowID)
	env := describeSaveEnv(paneDir, req.Dir)
	// Resolve BEFORE capturing: a refused path (outside the allowlist, or an
	// existing file the user has not agreed to replace) should cost a `capture-pane`
	// fork and a screen's worth of text for nothing.
	resolved, err := resolveSavePath(env, req.Path)
	if err != nil {
		return wt.sendSaveResult(saveOutcome{Error: err.Error(), Env: env})
	}
	if !req.Overwrite && targetExists(resolved) {
		return wt.sendSaveResult(saveOutcome{
			Path: resolved, Error: existsMessage(resolved), Exists: true, Env: env,
		})
	}
	var text string
	if wantsScrollback(req.Scope) {
		// The whole history. Already plain text (captured without -e), but run it
		// through the same cleaner anyway: one function decides what a saved file
		// looks like, and neither scope gets to drift into its own idea of that.
		raw, err := wt.captureProvider.CaptureScrollback(req.WindowID)
		if err != nil {
			log.Printf("scrollback capture of %s failed: %v", req.WindowID, err)
			return wt.sendSaveResult(saveOutcome{Error: "could not read the pane's buffer", Env: env})
		}
		text = cleanPaneText([]byte(raw))
	} else {
		entries, err := wt.captureProvider.CaptureWindows([]string{req.WindowID}, true)
		if err != nil || len(entries) == 0 {
			return wt.sendSaveResult(saveOutcome{Error: "could not capture the pane buffer", Env: env})
		}
		text = cleanPaneText(entries[0].ANSI)
	}
	if err := os.WriteFile(resolved, []byte(text), 0o644); err != nil {
		return wt.sendSaveResult(saveOutcome{
			Path: resolved, Error: writeErrorMessage(resolved, err), Env: env,
		})
	}
	log.Printf("saved pane %s buffer -> %s (%d bytes)", req.WindowID, resolved, len(text))
	return wt.sendSaveResult(saveOutcome{OK: true, Path: resolved, Env: env})
}

// saveOutcome is the TmuxSaveResult payload.
//
// `exists` is a field rather than a phrase the browser has to recognize in
// `error`: it is the one failure the user can answer in place ("Overwrite?"),
// and a UI that decides that by matching on English breaks the first time the
// sentence is reworded.
type saveOutcome struct {
	OK     bool    `json:"ok"`
	Path   string  `json:"path"`
	Error  string  `json:"error"`
	Exists bool    `json:"exists"`
	Env    SaveEnv `json:"env"`
}

// sendSaveResult reports a TmuxSavePaneFile outcome to the browser. The SaveEnv
// rides along so the browser can explain a surprising destination in the same
// breath as reporting success ("saved HERE, because your pane's directory isn't
// visible to webtmux") instead of leaving the user to wonder.
func (wt *WebTTY) sendSaveResult(res saveOutcome) error {
	data, err := json.Marshal(res)
	if err != nil {
		return fmt.Errorf("failed to marshal save result: %w", err)
	}
	return wt.masterWrite(append([]byte{TmuxSaveResult}, data...))
}

// isTmuxMessage returns true if the message type is a tmux-specific message
func isTmuxMessage(msgType byte) bool {
	switch msgType {
	case TmuxSelectPane, TmuxSelectWindow, TmuxSplitPane, TmuxClosePane,
		TmuxCopyMode, TmuxSendCommand, TmuxScrollUp, TmuxScrollDown, TmuxNewWindow,
		TmuxSwitchSession, TmuxRenameWindow, TmuxMoveWindow, TmuxNewSession,
		TmuxRenameSession, TmuxKillWindow, TmuxKillSession, TmuxLinkWindow,
		TmuxUnlinkWindow, TmuxCaptureRequest, TmuxSavePaneFile, TmuxSaveInfoRequest,
		TmuxScrollbackRequest, TmuxHistoryInfoRequest, TmuxHistoryAction,
		TmuxSetState, TmuxRefresh:
		return true
	default:
		return false
	}
}
