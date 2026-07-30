package tmux

import "testing"

// End to end through RefreshLayout, with the separator characters in every
// user-controlled string at once: the session name, the window name and the pane
// title. This is the Phase 4 smoke case ("a, b | c") expressed as a unit test, and
// it is the assertion that matters most — the per-field parse tests can all pass
// while RefreshLayout still asks tmux for the wrong format.
func TestRefreshLayoutSurvivesSeparatorsInEveryName(t *testing.T) {
	f := oneSessionServer()
	f.sessions[0]["session_name"] = "ops | staging"
	f.windows[0]["window_name"] = "a, b | c"
	f.windows[0]["session_name"] = "ops | staging"
	f.windows[1]["window_name"] = "build"
	f.windows[1]["session_name"] = "ops | staging"
	for _, p := range f.panes {
		p["session_name"] = "ops | staging"
	}
	f.panes[0]["pane_title"] = "user@host: ~/w | 2 jobs"
	f.clients[0]["client_session"] = "ops | staging"

	c := newControllerWithRunner("ops | staging", false, "", f.run)
	if err := c.RefreshLayout(); err != nil {
		t.Fatalf("RefreshLayout: %v", err)
	}
	l := c.GetLayout()

	if l.SessionName != "ops | staging" || l.SessionID != "$0" {
		t.Errorf("session ident = %q / %q", l.SessionID, l.SessionName)
	}
	if l.SessionBase != "ops | staging" {
		t.Errorf("SessionBase = %q", l.SessionBase)
	}
	if len(l.Sessions) != 1 || l.Sessions[0].Name != "ops | staging" || !l.Sessions[0].Active {
		t.Errorf("sessions = %+v", l.Sessions)
	}
	if len(l.Windows) != 2 {
		t.Fatalf("windows = %+v", l.Windows)
	}
	w := l.Windows[0]
	if w.ID != "@0" || w.Name != "a, b | c" || w.Index != 0 || !w.Active || w.Working != "1" {
		t.Errorf("window row corrupted: %+v", w)
	}
	if l.ActiveWinID != "@0" {
		t.Errorf("ActiveWinID = %q, want @0", l.ActiveWinID)
	}
	if len(w.Panes) != 1 || w.Panes[0].Width != 80 || w.Panes[0].Height != 24 ||
		w.Panes[0].Title != "user@host: ~/w | 2 jobs" || w.Panes[0].Command != "bash" {
		t.Errorf("pane row corrupted: %+v", w.Panes)
	}
	if l.ActivePaneID != "%0" {
		t.Errorf("ActivePaneID = %q, want %%0", l.ActivePaneID)
	}
	// The server-wide directory must name the session (it is what a click on the
	// attention arrow switches to) and carry the window name whole.
	if len(l.AllWindows) != 2 {
		t.Fatalf("AllWindows = %+v", l.AllWindows)
	}
	if l.AllWindows[0].Session != "ops | staging" || l.AllWindows[0].Name != "a, b | c" {
		t.Errorf("directory entry corrupted: %+v", l.AllWindows[0])
	}
	if l.AllWorking["@0"] != "1" || l.AllWorking["@1"] != "" {
		t.Errorf("AllWorking = %+v", l.AllWorking)
	}
	// The pane running a shell alongside a pane running `go` means the session is
	// not empty — the value the sidebar's kill confirmation turns on.
	if l.Sessions[0].Empty {
		t.Error("a session with a program running must not read as empty")
	}
}
