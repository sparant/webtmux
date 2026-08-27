package tmux

import (
	"strings"
	"testing"
)

// A session's new-window command (@wt_newcmd) is the one tmux option in this
// package that ends up being TYPED INTO A SHELL, so the tests below are about two
// things: that it reaches the right window, and that it is read and written
// against an exactly-identified session.
//
// The exact-identification half is not cosmetic. `set-option -t` and
// `show-options -t` accept neither `=name` nor `=name:` (see exactSession), and a
// bare name resolves by PREFIX — so a read for "dev" on a server that also has
// "dev-2" can answer about the wrong session, and a write can arm the wrong one.
// Every option call here must therefore target a "$N" session id, which is what
// these assertions pin.

func TestNewWindowRunsTheSessionCommand(t *testing.T) {
	f := twoSessionServer()
	f.options = map[string]string{"$0/" + newCmdOption: "launch_new.sh"}
	c := newControllerWithRunner("dev", false, "", f.run)
	if err := c.RefreshLayout(); err != nil {
		t.Fatalf("RefreshLayout: %v", err)
	}
	if err := c.NewWindow("dev"); err != nil {
		t.Fatalf("NewWindow: %v", err)
	}

	// The command is sent to the id new-window reported (@501 from the fake's
	// counter), not to the session — a session target would land in whichever
	// window happened to be current.
	keys := lastCall(t, f, "send-keys")
	wantArgv(t, keys, "send-keys", "-t", "@501", "--", "launch_new.sh", "Enter")

	// And it was read from the session by ID, not by name.
	var read []string
	for _, call := range f.argv("show-options") {
		if call[len(call)-1] == newCmdOption {
			read = call
		}
	}
	if read == nil {
		t.Fatalf("@wt_newcmd was never read; calls: %v", f.calls)
	}
	if got := flagValue(read, "-t"); got != "$0" {
		t.Errorf("read targeted %q, want the session id $0 (a name resolves by prefix)", got)
	}
}

func TestNewWindowWithoutACommandSendsNothing(t *testing.T) {
	f := twoSessionServer()
	c := newControllerWithRunner("dev", false, "", f.run)
	if err := c.RefreshLayout(); err != nil {
		t.Fatalf("RefreshLayout: %v", err)
	}
	if err := c.NewWindow("dev"); err != nil {
		t.Fatalf("NewWindow: %v", err)
	}
	if calls := f.argv("send-keys"); len(calls) != 0 {
		t.Errorf("a session with no command typed something into the window: %v", calls)
	}
}

// The command belongs to the session the window is created IN, which in the
// sidebar's tree view is not the session the pane is attached to.
func TestNewWindowUsesTheTargetSessionsCommand(t *testing.T) {
	f := twoSessionServer()
	f.options = map[string]string{
		"$0/" + newCmdOption: "wrong-session.sh",
		"$1/" + newCmdOption: "right-session.sh",
	}
	c := newControllerWithRunner("dev", false, "", f.run) // attached to dev ($0)
	if err := c.RefreshLayout(); err != nil {
		t.Fatalf("RefreshLayout: %v", err)
	}
	if err := c.NewWindow("dev-2"); err != nil { // but creating in dev-2 ($1)
		t.Fatalf("NewWindow: %v", err)
	}
	keys := lastCall(t, f, "send-keys")
	if keys[len(keys)-2] != "right-session.sh" {
		t.Errorf("ran %q — the attached session's command, not the target's", keys[len(keys)-2])
	}
}

func TestSetSessionNewCmdTargetsTheSessionID(t *testing.T) {
	f := twoSessionServer()
	c := newControllerWithRunner("dev", false, "", f.run)
	if err := c.SetSessionNewCmd("dev", "  launch_new.sh  "); err != nil {
		t.Fatalf("SetSessionNewCmd: %v", err)
	}
	// $0 — not "dev", which would prefix-match "dev-2" and arm the wrong session.
	wantArgv(t, lastCall(t, f, "set-option"),
		"set-option", "-t", "$0", newCmdOption, "launch_new.sh")
	if got := f.options["$0/"+newCmdOption]; got != "launch_new.sh" {
		t.Errorf("stored %q, want the trimmed command", got)
	}
}

func TestSetSessionNewCmdEmptyUnsets(t *testing.T) {
	f := twoSessionServer()
	f.options = map[string]string{"$0/" + newCmdOption: "old.sh"}
	c := newControllerWithRunner("dev", false, "", f.run)
	if err := c.SetSessionNewCmd("dev", "   "); err != nil {
		t.Fatalf("SetSessionNewCmd: %v", err)
	}
	// -u, so the option is ABSENT rather than present-and-empty: that is what
	// "this session has no command" looks like to anything reading tmux directly.
	wantArgv(t, lastCall(t, f, "set-option"), "set-option", "-t", "$0", "-u", newCmdOption)
	if _, still := f.options["$0/"+newCmdOption]; still {
		t.Errorf("option survived the clear: %v", f.options)
	}
}

func TestSetSessionNewCmdRefusesUnknownSession(t *testing.T) {
	f := twoSessionServer()
	c := newControllerWithRunner("dev", false, "", f.run)
	err := c.SetSessionNewCmd("no-such-session", "x.sh")
	if err == nil {
		t.Fatalf("want a refusal for a session that does not exist")
	}
	// A refusal, not a generic failure: the client shows it as a reason.
	if !strings.Contains(err.Error(), "no session named") {
		t.Errorf("unexpected error text: %v", err)
	}
	if calls := f.argv("set-option"); len(calls) != 0 {
		t.Errorf("wrote an option anyway: %v", calls)
	}
}

// A command line containing the '|' that separates the layout's -F fields must
// survive the round trip — which is why the commands are read in their own
// list-sessions pass (see sessionCmdsFormat).
func TestNewCmdWithSeparatorSurvivesTheLayout(t *testing.T) {
	const piped = "tail -F log | grep -i error"
	f := twoSessionServer()
	f.options = map[string]string{"$0/" + newCmdOption: piped}
	// The fake renders whatever format is asked for, so #{@wt_newcmd} must resolve
	// from the session row the same way tmux resolves it.
	f.sessions[0]["@wt_newcmd"] = piped
	c := newControllerWithRunner("dev", false, "", f.run)
	if err := c.RefreshLayout(); err != nil {
		t.Fatalf("RefreshLayout: %v", err)
	}
	got := ""
	for _, s := range c.GetLayout().Sessions {
		if s.Name == "dev" {
			got = s.NewCmd
		}
	}
	if got != piped {
		t.Errorf("Session.NewCmd = %q, want %q", got, piped)
	}
}

func TestNewSessionInheritsNameAndCommand(t *testing.T) {
	f := twoSessionServer()
	f.options = map[string]string{"$0/" + newCmdOption: "launch_new.sh"}
	c := newControllerWithRunner("dev", false, "", f.run)
	c.SetClient("/dev/pts/1", 4242) // SwitchSession needs a client identity
	if err := c.RefreshLayout(); err != nil {
		t.Fatalf("RefreshLayout: %v", err)
	}
	if err := c.NewSession(); err != nil {
		t.Fatalf("NewSession: %v", err)
	}

	// Named after the session it was made from. "dev (1)" and not "dev-2", which
	// exists — the derived name skips what is taken.
	ns := lastCall(t, f, "new-session")
	if got := flagValue(ns, "-s"); got != "dev (1)" {
		t.Errorf("new session named %q, want %q", got, "dev (1)")
	}

	// The command is inherited onto the new session (by id — it is the only exact
	// target set-option accepts) AND run in its first window.
	if got := f.options["$77/"+newCmdOption]; got != "launch_new.sh" {
		t.Errorf("new session did not inherit the command: %v", f.options)
	}
	keys := lastCall(t, f, "send-keys")
	wantArgv(t, keys, "send-keys", "-t", "@770", "--", "launch_new.sh", "Enter")
}

func TestNewSessionWithoutACommandInheritsOnlyTheName(t *testing.T) {
	f := twoSessionServer()
	c := newControllerWithRunner("dev", false, "", f.run)
	c.SetClient("/dev/pts/1", 4242)
	if err := c.RefreshLayout(); err != nil {
		t.Fatalf("RefreshLayout: %v", err)
	}
	if err := c.NewSession(); err != nil {
		t.Fatalf("NewSession: %v", err)
	}
	if got := flagValue(lastCall(t, f, "new-session"), "-s"); got != "dev (1)" {
		t.Errorf("new session named %q, want %q", got, "dev (1)")
	}
	if calls := f.argv("send-keys"); len(calls) != 0 {
		t.Errorf("typed something into a session that inherited no command: %v", calls)
	}
}
