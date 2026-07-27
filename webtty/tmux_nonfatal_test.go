package webtty

import (
	"encoding/json"
	"errors"
	"testing"

	"webtmux/pkg/tmux"
)

// The contract under test: NO tmux command failure may be returned from
// handleTmuxMessage.
//
// Why it is worth a test of its own. A returned error travels
// handleMasterReadEvent -> Run -> processWSConn, whose `defer slave.Close()`
// signals the pty's process; the default close-signal is SIGHUP, and a tmux
// client that is hung up prints `[lost tty]` and exits. So the blast radius of
// "tmux said no" was the user's whole pane plus whatever they had just typed
// into it — and tmux says no routinely: a window closed between the click and
// the command, a pane that left copy mode since the last poll, a session
// renamed by another client. This test fails the moment a handler goes back to
// returning one.

// failCtrl is a TmuxController whose every operation fails, like a tmux server
// rejecting commands aimed at state that has moved on.
type failCtrl struct {
	layout    *tmux.Layout
	refreshed int
}

var errNope = errors.New("tmux command failed: exit status 1")

func (c *failCtrl) GetLayout() *tmux.Layout              { return c.layout }
func (c *failCtrl) RefreshLayout() error                 { c.refreshed++; return errNope }
func (c *failCtrl) SelectPane(string) error              { return errNope }
func (c *failCtrl) SelectWindow(string) error            { return errNope }
func (c *failCtrl) SwitchSession(string) error           { return errNope }
func (c *failCtrl) RenameWindow(string, string) error    { return errNope }
func (c *failCtrl) MoveWindow(string, int, string) error { return errNope }
func (c *failCtrl) NewSession() error                    { return errNope }
func (c *failCtrl) RenameSession(string, string) error   { return errNope }
func (c *failCtrl) KillWindow(string) error              { return errNope }
func (c *failCtrl) KillSession(string) error             { return errNope }
func (c *failCtrl) LinkWindow(string, string) error      { return errNope }
func (c *failCtrl) UnlinkWindow(string, string) error    { return errNope }
func (c *failCtrl) SplitPane(bool) error                 { return errNope }
func (c *failCtrl) ClosePane(string) error               { return errNope }
func (c *failCtrl) SetGlobalOption(string, string) error { return errNope }
func (c *failCtrl) EnterCopyMode() error                 { return errNope }
func (c *failCtrl) ExitCopyMode() error                  { return errNope }
func (c *failCtrl) RefreshClient() error                 { return errNope }
func (c *failCtrl) ScrollUp(int) error                   { return errNope }
func (c *failCtrl) ScrollDown(int) error                 { return errNope }
func (c *failCtrl) NewWindow(string) error               { return errNope }
func (c *failCtrl) Events() <-chan tmux.Event            { return nil }

// recordMaster is a PTY master that accepts and keeps every frame.
type recordMaster struct{ frames [][]byte }

func (m *recordMaster) Read(p []byte) (int, error) { select {} } // never called (no Run)
func (m *recordMaster) Write(p []byte) (int, error) {
	m.frames = append(m.frames, append([]byte(nil), p...))
	return len(p), nil
}

func newFailingWebTTY(t *testing.T, layout *tmux.Layout) (*WebTTY, *recordMaster, *failCtrl) {
	t.Helper()
	m := &recordMaster{}
	wt, err := New(m, nil)
	if err != nil {
		t.Fatal(err)
	}
	ctrl := &failCtrl{layout: layout}
	wt.SetTmuxController(ctrl)
	return wt, m, ctrl
}

func TestTmuxCommandFailureNeverEndsTheConnection(t *testing.T) {
	cases := []struct {
		name    string
		msgType byte
		payload string
	}{
		{"select pane", TmuxSelectPane, "%1"},
		{"select window", TmuxSelectWindow, "@3"},
		{"split pane", TmuxSplitPane, "h"},
		{"close pane", TmuxClosePane, "%1"},
		{"enter copy mode", TmuxCopyMode, "1"},
		// The one that bit hardest: the browser asks to leave copy mode before
		// every paste, and asks whenever its 500ms-old flag says it is in copy
		// mode. `send-keys -X cancel` on a pane that already left is exit 1.
		{"exit copy mode", TmuxCopyMode, "0"},
		{"scroll up", TmuxScrollUp, "3"},
		{"scroll down", TmuxScrollDown, "3"},
		{"new window", TmuxNewWindow, ""},
		{"new window in another session", TmuxNewWindow, "editors"},
		{"switch session", TmuxSwitchSession, "services"},
		{"rename window", TmuxRenameWindow, "@3 build"},
		{"move window", TmuxMoveWindow, "@3 2"},
		// The tree view's form of the same two commands: a third/second field naming
		// the session being reordered / unlinked from.
		{"move window in another session", TmuxMoveWindow, "@3 2 editors"},
		{"new session", TmuxNewSession, ""},
		{"rename session", TmuxRenameSession, "old new"},
		{"kill window", TmuxKillWindow, "@3"},
		{"kill session", TmuxKillSession, "scratch"},
		{"link window", TmuxLinkWindow, "@3 services"},
		{"unlink window", TmuxUnlinkWindow, "@3"},
		{"unlink window from another session", TmuxUnlinkWindow, "@3 editors"},
		{"set state", TmuxSetState, `{"v":1}`},
		{"refresh client", TmuxRefresh, ""},
		{"unknown message type", 'z', ""},
		{"malformed capture request", TmuxCaptureRequest, "{not json"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			wt, _, _ := newFailingWebTTY(t, &tmux.Layout{})
			if err := wt.handleTmuxMessage(tc.msgType, []byte(tc.payload)); err != nil {
				t.Fatalf("returned %v — that error closes the websocket, SIGHUPs the "+
					"pane's tmux client and shows the user [lost tty]", err)
			}
		})
	}
}

// modeUpdate returns the inCopyMode of the last TmuxModeUpdate frame written.
func modeUpdate(t *testing.T, m *recordMaster) bool {
	t.Helper()
	for i := len(m.frames) - 1; i >= 0; i-- {
		if m.frames[i][0] == TmuxModeUpdate {
			var st tmux.ModeState
			if err := json.Unmarshal(m.frames[i][1:], &st); err != nil {
				t.Fatalf("unmarshal mode update: %v", err)
			}
			return st.InCopyMode
		}
	}
	t.Fatal("no TmuxModeUpdate frame was sent")
	return false
}

func TestCopyModeReplyReportsTmuxNotTheRequest(t *testing.T) {
	// tmux says the pane IS in a mode. The client asked to leave and the command
	// failed, so the honest answer is "still in copy mode" — echoing the request
	// would leave the client believing a lie, which is exactly the desync that
	// makes it send the next impossible command.
	wt, m, ctrl := newFailingWebTTY(t, &tmux.Layout{ActivePaneInMode: true})
	if err := wt.handleTmuxMessage(TmuxCopyMode, []byte("0")); err != nil {
		t.Fatalf("handleTmuxMessage: %v", err)
	}
	if ctrl.refreshed == 0 {
		t.Error("the reply was not re-read from tmux")
	}
	if got := modeUpdate(t, m); !got {
		t.Error("reported not-in-copy-mode though tmux says the pane is in a mode")
	}

	// And the converse: the pane left copy mode on its own (a `q`, a mouse copy),
	// the client hadn't noticed and asked to ENTER — the reply corrects it.
	wt2, m2, _ := newFailingWebTTY(t, &tmux.Layout{ActivePaneInMode: false})
	if err := wt2.handleTmuxMessage(TmuxCopyMode, []byte("1")); err != nil {
		t.Fatalf("handleTmuxMessage: %v", err)
	}
	if got := modeUpdate(t, m2); got {
		t.Error("reported in-copy-mode though the command failed and tmux says otherwise")
	}
}
