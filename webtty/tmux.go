package webtty

import (
	"encoding/json"
	"log"
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
	EnterCopyMode() error
	ExitCopyMode() error
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
		}{Captures: wires})
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

// isTmuxMessage returns true if the message type is a tmux-specific message
func isTmuxMessage(msgType byte) bool {
	switch msgType {
	case TmuxSelectPane, TmuxSelectWindow, TmuxSplitPane, TmuxClosePane,
		TmuxCopyMode, TmuxSendCommand, TmuxScrollUp, TmuxScrollDown, TmuxNewWindow,
		TmuxSwitchSession, TmuxRenameWindow, TmuxMoveWindow, TmuxNewSession,
		TmuxRenameSession, TmuxKillWindow, TmuxKillSession, TmuxLinkWindow,
		TmuxUnlinkWindow, TmuxCaptureRequest:
		return true
	default:
		return false
	}
}
