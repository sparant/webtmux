package webtty

import (
	"encoding/json"
	"log"
	"os"
	"regexp"
	"strconv"
	"strings"

	"github.com/pkg/errors"
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
		return errors.Wrap(err, "failed to marshal tmux layout")
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
		return errors.Wrap(err, "failed to marshal tmux mode state")
	}

	return wt.masterWrite(append([]byte{TmuxModeUpdate}, data...))
}

// handleTmuxMessage handles tmux-specific messages from the client
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
		paneID := string(payload)
		if err := wt.tmuxCtrl.SelectPane(paneID); err != nil {
			return errors.Wrap(err, "failed to select pane")
		}
		return wt.SendTmuxLayout()

	case TmuxSelectWindow:
		windowID := string(payload)
		if err := wt.tmuxCtrl.SelectWindow(windowID); err != nil {
			return errors.Wrap(err, "failed to select window")
		}
		return wt.SendTmuxLayout()

	case TmuxSplitPane:
		horizontal := string(payload) == "h"
		if err := wt.tmuxCtrl.SplitPane(horizontal); err != nil {
			return errors.Wrap(err, "failed to split pane")
		}
		return wt.SendTmuxLayout()

	case TmuxClosePane:
		paneID := string(payload)
		if err := wt.tmuxCtrl.ClosePane(paneID); err != nil {
			return errors.Wrap(err, "failed to close pane")
		}
		return wt.SendTmuxLayout()

	case TmuxCopyMode:
		enter := string(payload) == "1"
		var err error
		if enter {
			err = wt.tmuxCtrl.EnterCopyMode()
		} else {
			err = wt.tmuxCtrl.ExitCopyMode()
		}
		if err != nil {
			return errors.Wrap(err, "failed to toggle copy mode")
		}
		return wt.SendTmuxModeUpdate(enter)

	case TmuxScrollUp:
		lines, _ := strconv.Atoi(string(payload))
		if lines <= 0 {
			lines = 1
		}
		return wt.tmuxCtrl.ScrollUp(lines)

	case TmuxScrollDown:
		lines, _ := strconv.Atoi(string(payload))
		if lines <= 0 {
			lines = 1
		}
		return wt.tmuxCtrl.ScrollDown(lines)

	case TmuxNewWindow:
		if err := wt.tmuxCtrl.NewWindow(); err != nil {
			return errors.Wrap(err, "failed to create new window")
		}
		return wt.SendTmuxLayout()

	case TmuxSwitchSession:
		sessionName := string(payload)
		if err := wt.tmuxCtrl.SwitchSession(sessionName); err != nil {
			return errors.Wrap(err, "failed to switch session")
		}
		return wt.SendTmuxLayout()

	case TmuxRenameWindow:
		// payload = "<windowID> <new name>"; windowIDs are "@N" (no spaces), so
		// split on the first space and keep the rest as the (possibly-spaced) name.
		s := string(payload)
		idx := strings.IndexByte(s, ' ')
		if idx < 0 {
			return nil
		}
		windowID, name := s[:idx], s[idx+1:]
		if err := wt.tmuxCtrl.RenameWindow(windowID, name); err != nil {
			return errors.Wrap(err, "failed to rename window")
		}
		return wt.SendTmuxLayout()

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
		if err := wt.tmuxCtrl.MoveWindow(windowID, targetPos); err != nil {
			return errors.Wrap(err, "failed to move window")
		}
		return wt.SendTmuxLayout()

	case TmuxNewSession:
		if err := wt.tmuxCtrl.NewSession(); err != nil {
			return errors.Wrap(err, "failed to create new session")
		}
		return wt.SendTmuxLayout()

	case TmuxRenameSession:
		// payload = "<oldName> <new name>"; session names have no spaces, so split
		// on the first space and keep the rest as the (possibly-spaced) new name.
		s := string(payload)
		idx := strings.IndexByte(s, ' ')
		if idx < 0 {
			return nil
		}
		oldName, newName := s[:idx], s[idx+1:]
		if err := wt.tmuxCtrl.RenameSession(oldName, newName); err != nil {
			return errors.Wrap(err, "failed to rename session")
		}
		return wt.SendTmuxLayout()

	case TmuxKillWindow:
		windowID := string(payload)
		if err := wt.tmuxCtrl.KillWindow(windowID); err != nil {
			return errors.Wrap(err, "failed to kill window")
		}
		return wt.SendTmuxLayout()

	case TmuxKillSession:
		sessionName := string(payload)
		if err := wt.tmuxCtrl.KillSession(sessionName); err != nil {
			return errors.Wrap(err, "failed to kill session")
		}
		return wt.SendTmuxLayout()

	case TmuxLinkWindow:
		// payload = "<windowID> <targetSession>"; windowIDs are "@N" (no spaces),
		// so split on the first space and keep the rest as the session name.
		s := string(payload)
		idx := strings.IndexByte(s, ' ')
		if idx < 0 {
			return nil
		}
		windowID, targetSession := s[:idx], s[idx+1:]
		if err := wt.tmuxCtrl.LinkWindow(windowID, targetSession); err != nil {
			return errors.Wrap(err, "failed to link window")
		}
		return wt.SendTmuxLayout()

	case TmuxUnlinkWindow:
		windowID := string(payload)
		if err := wt.tmuxCtrl.UnlinkWindow(windowID); err != nil {
			return errors.Wrap(err, "failed to unlink window")
		}
		return wt.SendTmuxLayout()

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
			return errors.Wrap(err, "failed to set tmux state")
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
		return errors.Errorf("unknown tmux message type: %c", msgType)
	}
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
			return errors.Wrap(err, "invalid tmux capture request")
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
		return errors.Wrap(err, "failed to marshal save info")
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
		return errors.Wrap(err, "failed to marshal save result")
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
