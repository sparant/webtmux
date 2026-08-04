package webtty

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

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
//
// It also COUNTS the operations that would have mutated something. That is what
// the write-authority tests (authority_test.go) read: "did anything reach tmux?"
// is the whole question there, and it has to be asked of the mutating surface
// only — RefreshLayout/GetLayout run on every path, including the view-only ones.
type failCtrl struct {
	layout    *tmux.Layout
	refreshed int
	calls     int      // mutating operations attempted
	seen      []string // …and their names, for a readable failure
	repainted int      // RefreshClient calls (view-only, counted separately)
}

var errNope = errors.New("tmux command failed: exit status 1")

// note records one attempted mutation and returns the canned failure.
func (c *failCtrl) note(what string) error {
	c.calls++
	c.seen = append(c.seen, what)
	return errNope
}

func (c *failCtrl) GetLayout() *tmux.Layout   { return c.layout }
func (c *failCtrl) RefreshLayout() error      { c.refreshed++; return errNope }
func (c *failCtrl) Events() <-chan tmux.Event { return nil }

// RefreshClient repaints THIS pane's own screen; it is view-only (see
// authority.go), so it is counted apart from the mutations.
func (c *failCtrl) RefreshClient() error { c.repainted++; return errNope }

func (c *failCtrl) SelectPane(string) error              { return c.note("select-pane") }
func (c *failCtrl) SelectWindow(string) error            { return c.note("select-window") }
func (c *failCtrl) SwitchSession(string) error           { return c.note("switch-client") }
func (c *failCtrl) RenameWindow(string, string) error    { return c.note("rename-window") }
func (c *failCtrl) MoveWindow(string, int, string) error { return c.note("move-window") }
func (c *failCtrl) NewSession() error                    { return c.note("new-session") }
func (c *failCtrl) RenameSession(string, string) error   { return c.note("rename-session") }
func (c *failCtrl) KillWindow(string) error              { return c.note("kill-window") }
func (c *failCtrl) KillSession(string) error             { return c.note("kill-session") }
func (c *failCtrl) LinkWindow(string, string) error      { return c.note("link-window") }
func (c *failCtrl) UnlinkWindow(string, string) error    { return c.note("unlink-window") }
func (c *failCtrl) SplitPane(bool) error                 { return c.note("split-window") }
func (c *failCtrl) ClosePane(string) error               { return c.note("kill-pane") }
func (c *failCtrl) SetGlobalOption(string, string) error { return c.note("set-option") }
func (c *failCtrl) EnterCopyMode() error                 { return c.note("copy-mode") }
func (c *failCtrl) ExitCopyMode() error                  { return c.note("copy-mode -q") }
func (c *failCtrl) ScrollUp(int) error                   { return c.note("scroll-up") }
func (c *failCtrl) ScrollDown(int) error                 { return c.note("scroll-down") }
func (c *failCtrl) NewWindow(string) error               { return c.note("new-window") }

// The scrollback-buffer trio. All three mutate — a resize rebuilds panes, a clear
// throws history away, and the default-setter rewrites a server-global option —
// so all three go through note() and are counted by the write-authority tests.
func (c *failCtrl) SetDefaultHistoryLimit(string, int) error {
	return c.note("set-option history-limit")
}
func (c *failCtrl) ClearWindowHistory(string) error { return c.note("clear-history") }
func (c *failCtrl) ResizeWindowHistory(string, int, bool) (tmux.HistoryResize, error) {
	return tmux.HistoryResize{}, c.note("resize-history")
}

// countingCapture is a CaptureProvider that records every call and can be made to
// block inside one, so a test can observe a SECOND request arriving while the
// first is still in flight (see capture_cap_test.go).
type countingCapture struct {
	mu      sync.Mutex
	cond    *sync.Cond
	calls   []captureCall
	block   chan struct{} // when non-nil, CaptureWindows waits on it
	paneDir string
	err     error

	// The scrollback half: what CaptureScrollback returns, whether it fails, and
	// the window ids it was asked for (so a test can assert which buffer a save
	// actually read rather than inferring it from the bytes written).
	scrollback     string
	scrollbackErr  error
	scrollbackHold chan struct{} // when non-nil, CaptureScrollback waits on it
	scrollbackFor  []string

	// The scrollback-ACCOUNTING half (how big / how full), as distinct from the
	// scrollback CONTENTS above.
	history    *tmux.HistoryReport
	historyErr error
	historyFor []string
}

type captureCall struct {
	ids   []string
	force bool
}

func (c *countingCapture) CaptureWindows(ids []string, force bool) ([]tmux.CaptureEntry, error) {
	c.mu.Lock()
	if c.cond == nil {
		c.cond = sync.NewCond(&c.mu)
	}
	c.calls = append(c.calls, captureCall{ids: append([]string(nil), ids...), force: force})
	c.cond.Broadcast()
	block, err := c.block, c.err
	c.mu.Unlock()
	if block != nil {
		<-block
	}
	if err != nil {
		return nil, err
	}
	return []tmux.CaptureEntry{{WindowID: "@0", Cols: 80, Rows: 24, ANSI: []byte("hi")}}, nil
}

func (c *countingCapture) PaneCurrentPath(string) (string, error) { return c.paneDir, nil }

// HistoryReport is the read behind the scrollback dropdown. `history` is what it
// answers with; a nil one still yields a usable (empty) report, so a test that
// isn't about scrollback doesn't have to populate it.
func (c *countingCapture) HistoryReport(windowID string) (tmux.HistoryReport, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.historyFor = append(c.historyFor, windowID)
	if c.historyErr != nil {
		return tmux.HistoryReport{}, c.historyErr
	}
	if c.history == nil {
		return tmux.HistoryReport{WindowID: windowID}, nil
	}
	rep := *c.history
	rep.WindowID = windowID
	return rep, nil
}

func (c *countingCapture) CaptureScrollback(windowID string) (string, error) {
	c.mu.Lock()
	if c.cond == nil {
		c.cond = sync.NewCond(&c.mu)
	}
	c.scrollbackFor = append(c.scrollbackFor, windowID)
	c.cond.Broadcast()
	hold, text, err := c.scrollbackHold, c.scrollback, c.scrollbackErr
	c.mu.Unlock()
	if hold != nil {
		<-hold
	}
	if err != nil {
		return "", err
	}
	return text, nil
}

// scrollbackCalls is the window ids CaptureScrollback has been asked for.
func (c *countingCapture) scrollbackCalls() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]string(nil), c.scrollbackFor...)
}

// waitScrollback blocks until n scrollback reads have STARTED — the way a test
// synchronizes with a read that is deliberately parked inside the provider.
func (c *countingCapture) waitScrollback(t *testing.T, n int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		if len(c.scrollbackCalls()) >= n {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("only %d scrollback reads after 5s, wanted %d", len(c.scrollbackCalls()), n)
		}
		time.Sleep(2 * time.Millisecond)
	}
}

func (c *countingCapture) snapshot() []captureCall {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]captureCall(nil), c.calls...)
}

// wait blocks until at least n calls have been recorded (or the test times out),
// which is how an assertion synchronizes with the capture goroutine.
func (c *countingCapture) wait(t *testing.T, n int) []captureCall {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		if got := c.snapshot(); len(got) >= n {
			return got
		}
		if time.Now().After(deadline) {
			t.Fatalf("only %d capture calls after 5s, wanted %d", len(c.snapshot()), n)
		}
		time.Sleep(2 * time.Millisecond)
	}
}

// recordMaster is a PTY master that accepts and keeps every frame. Guarded,
// because capture replies are written from their own goroutine while a test is
// reading — the race detector is the point of the mutex, not contention.
type recordMaster struct {
	mu     sync.Mutex
	frames [][]byte
}

func (m *recordMaster) Read(p []byte) (int, error) { select {} } // never called (no Run)
func (m *recordMaster) Write(p []byte) (int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.frames = append(m.frames, append([]byte(nil), p...))
	return len(p), nil
}

// sent returns a copy of everything written so far.
func (m *recordMaster) sent() [][]byte {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([][]byte(nil), m.frames...)
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
		{"rename session", TmuxRenameSession, "old\x00new"},
		{"rename session with no separator", TmuxRenameSession, "old new"},
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
	frames := m.sent()
	for i := len(frames) - 1; i >= 0; i-- {
		if frames[i][0] == TmuxModeUpdate {
			var st tmux.ModeState
			if err := json.Unmarshal(frames[i][1:], &st); err != nil {
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

// A REFUSAL is the one command failure the browser hears about. tmux saying no is
// a race the next layout push repairs; a refusal is the controller declining to
// guess which object a command would hit, so nothing will change and the layout
// push looks identical to the one before it. Silence there is indistinguishable
// from a broken button.
func TestARefusalIsReportedToTheClient(t *testing.T) {
	wt, m, _ := newFailingWebTTY(t, &tmux.Layout{})
	wt.permitWrite = true
	wt.SetTmuxController(&refuseCtrl{failCtrl: failCtrl{layout: &tmux.Layout{}}})

	if err := wt.handleTmuxMessage(TmuxSelectWindow, []byte("@3")); err != nil {
		t.Fatalf("a refusal must not tear the connection down: %v", err)
	}
	var got string
	for _, f := range m.sent() {
		if f[0] == TmuxError {
			got = string(f[1:])
		}
	}
	if got == "" {
		t.Fatal("the refusal was swallowed; the user sees a button that does nothing")
	}
	if strings.Contains(got, "refused:") {
		t.Errorf("the sentinel's prefix leaked into the user-facing message: %q", got)
	}
	if !strings.Contains(got, "@3") {
		t.Errorf("the message should name what could not be identified: %q", got)
	}
}

// …and an ORDINARY tmux failure still is not: those happen routinely (a window
// closed between the click and the command) and the layout push already corrects
// the UI. A banner per race would be noise.
func TestAnOrdinaryFailureIsNotReportedToTheClient(t *testing.T) {
	wt, m, _ := newFailingWebTTY(t, &tmux.Layout{})
	wt.permitWrite = true
	if err := wt.handleTmuxMessage(TmuxKillWindow, []byte("@3")); err != nil {
		t.Fatalf("handleTmuxMessage: %v", err)
	}
	for _, f := range m.sent() {
		if f[0] == TmuxError {
			t.Fatalf("an ordinary tmux failure raised a banner: %q", f[1:])
		}
	}
}

// refuseCtrl refuses instead of failing — the "can't identify which object this
// would hit" case (see pkg/tmux.ErrRefused).
type refuseCtrl struct{ failCtrl }

func (c *refuseCtrl) SelectWindow(id string) error {
	return fmt.Errorf("%w: %s is not in this pane's window list", tmux.ErrRefused, id)
}
