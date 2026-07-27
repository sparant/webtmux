package webtty

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"regexp"
	"strconv"
	"strings"

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
	MoveWindow(windowID string, targetPos int) error
	NewSession() error
	RenameSession(oldName, newName string) error
	KillWindow(windowID string) error
	KillSession(sessionName string) error
	LinkWindow(windowID, targetSession string) error
	UnlinkWindow(windowID string) error
	SplitPane(horizontal bool) error
	ClosePane(paneID string) error
	SetGlobalOption(key, val string) error
	EnterCopyMode() error
	ExitCopyMode() error
	RefreshClient() error
	ScrollUp(lines int) error
	ScrollDown(lines int) error
	NewWindow() error
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
func (wt *WebTTY) afterCmd(what string, err error) error {
	if err != nil {
		log.Printf("tmux %s failed (ignored, pane kept): %v", what, err)
	}
	return wt.SendTmuxLayout()
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
		return wt.afterCmd("new window", wt.tmuxCtrl.NewWindow())

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
		// payload = "<windowID> <targetPos>"; windowIDs are "@N" (no spaces).
		s := string(payload)
		idx := strings.IndexByte(s, ' ')
		if idx < 0 {
			return nil
		}
		windowID := s[:idx]
		targetPos, err := strconv.Atoi(strings.TrimSpace(s[idx+1:]))
		if err != nil {
			return nil
		}
		return wt.afterCmd("move window", wt.tmuxCtrl.MoveWindow(windowID, targetPos))

	case TmuxNewSession:
		return wt.afterCmd("new session", wt.tmuxCtrl.NewSession())

	case TmuxRenameSession:
		// payload = "<oldName> <new name>"; session names have no spaces, so split
		// on the first space and keep the rest as the (possibly-spaced) new name.
		s := string(payload)
		idx := strings.IndexByte(s, ' ')
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
		return wt.afterCmd("unlink window", wt.tmuxCtrl.UnlinkWindow(string(payload)))

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
	force := req.Force
	// An all-windows request yields the COMPLETE current placement set, so the reply
	// is tagged `full`: the client may then prune any cached window/placement absent
	// from it (a closed window, or a session a window was unlinked from). A targeted
	// request only speaks about the windows it named, so it is never full.
	full := len(ids) == 0

	go func() {
		entries, err := wt.captureProvider.CaptureWindows(ids, force)
		if err != nil {
			log.Printf("capture failed: %v", err)
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
	}
	if err := json.Unmarshal(payload, &req); err != nil {
		return wt.sendSaveResult(false, "", "invalid save request", SaveEnv{})
	}
	if strings.TrimSpace(req.Path) == "" {
		return wt.sendSaveResult(false, "", "no path given", SaveEnv{})
	}
	if wt.captureProvider == nil {
		return wt.sendSaveResult(false, "", "saving is unavailable (not a tmux session)", SaveEnv{})
	}
	entries, err := wt.captureProvider.CaptureWindows([]string{req.WindowID}, true)
	if err != nil || len(entries) == 0 {
		return wt.sendSaveResult(false, "", "could not capture the pane buffer", SaveEnv{})
	}
	text := cleanPaneText(entries[0].ANSI)
	// Relative paths land in the pane's own working directory when webtmux can SEE
	// it; when it can't (the container case), describeSaveEnv picks a directory
	// that exists here and the reply says so rather than the save silently
	// landing somewhere the user never named. See savepath.go.
	paneDir, _ := wt.captureProvider.PaneCurrentPath(req.WindowID)
	env := describeSaveEnv(paneDir, req.Dir)
	resolved, err := resolveSavePath(env, req.Path)
	if err != nil {
		return wt.sendSaveResult(false, "", err.Error(), env)
	}
	if err := os.WriteFile(resolved, []byte(text), 0o644); err != nil {
		return wt.sendSaveResult(false, resolved, writeErrorMessage(resolved, err), env)
	}
	log.Printf("saved pane %s buffer -> %s (%d bytes)", req.WindowID, resolved, len(text))
	return wt.sendSaveResult(true, resolved, "", env)
}

// sendSaveResult reports a TmuxSavePaneFile outcome to the browser. The SaveEnv
// rides along so the browser can explain a surprising destination in the same
// breath as reporting success ("saved HERE, because your pane's directory isn't
// visible to webtmux") instead of leaving the user to wonder.
func (wt *WebTTY) sendSaveResult(ok bool, path, errMsg string, env SaveEnv) error {
	data, err := json.Marshal(struct {
		OK    bool    `json:"ok"`
		Path  string  `json:"path"`
		Error string  `json:"error"`
		Env   SaveEnv `json:"env"`
	}{OK: ok, Path: path, Error: errMsg, Env: env})
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
		TmuxSetState, TmuxRefresh:
		return true
	default:
		return false
	}
}
