package tmux

import (
	"strings"
	"testing"
)

// A session's new-window MENU (@wt_newcmds) is the one tmux option in this
// package whose contents end up being TYPED INTO A SHELL, so these tests are
// about three things: that the right entry reaches the right window, that reads
// and writes address an exactly-identified session, and that the encoding
// survives tmux.
//
// The exact-identification half is not cosmetic. `set-option -t` and
// `show-options -t` accept neither `=name` nor `=name:` (see exactSession), and a
// bare name resolves by PREFIX — so a read for "dev" on a server that also has
// "dev-2" can answer about the wrong session, and a write can arm the wrong one.

// menuJSON is what encodeNewCmds would store, for seeding the fake option store.
func menuJSON(t *testing.T, cmds ...NewCmd) string {
	t.Helper()
	out, err := encodeNewCmds(cmds)
	if err != nil {
		t.Fatalf("encodeNewCmds: %v", err)
	}
	return out
}

func TestNewCmdDisplay(t *testing.T) {
	cases := []struct {
		cmd  NewCmd
		want string
	}{
		// An explicit label always wins — the derivation is a heuristic.
		{NewCmd{Label: "claude", Cmd: "anything at all"}, "claude"},
		// Empty command is a legitimate entry: a plain shell.
		{NewCmd{}, "shell"},
		// The LAST path-shaped token, because the first is so often a wrapper: every
		// daemon entry would otherwise be captioned "run-in-daemon".
		{NewCmd{Cmd: "/p/scripts/run-in-daemon.sh -w /workspace scripts/claude-docker/launch_new.sh"}, "launch_new"},
		{NewCmd{Cmd: "scripts/enter_secure_container.sh"}, "enter_secure_container"},
		{NewCmd{Cmd: "cd /home/me/Projects"}, "Projects"},
		{NewCmd{Cmd: "bash"}, "bash"},
		// Flags are skipped rather than captioning the button "-la".
		{NewCmd{Cmd: "ls -la"}, "ls"},
		// A redirect target is where output goes, not what runs. (The browser
		// driver caught this one captioning itself "menu-entry0".)
		{NewCmd{Cmd: "printf ran > /tmp/menu-entry0"}, "printf"},
		{NewCmd{Cmd: "make 2> /tmp/err"}, "make"},
		// Nor is the right-hand side of a pipe.
		{NewCmd{Cmd: `tail -F "$LOG" | grep -i error`}, "tail"},
		{NewCmd{Cmd: "a.sh && b.sh"}, "a"},
	}
	for _, c := range cases {
		if got := c.cmd.Display(); got != c.want {
			t.Errorf("Display() of %+v = %q, want %q", c.cmd, got, c.want)
		}
	}
}

// The whole reason the menu is JSON with \u0024 for '$': tmux 3.4 rewrites a
// stored '$' to '\$', and '\$' inside a JSON string is not a legal escape — so one
// dollar in one command would make the entire menu unparseable and every button on
// the session disappear.
func TestEncodeNewCmdsHidesDollarsFromTmux(t *testing.T) {
	enc, err := encodeNewCmds([]NewCmd{{Label: "pane", Cmd: `WT_WINDOW="$TMUX_PANE" run $HOME/x`}})
	if err != nil {
		t.Fatalf("encodeNewCmds: %v", err)
	}
	if strings.Contains(enc, "$") {
		t.Errorf("encoded menu still contains a raw '$', which tmux will escape: %s", enc)
	}
	if !strings.Contains(enc, `\u0024`) {
		t.Errorf("expected the dollars as \\u0024 escapes: %s", enc)
	}
	back := decodeNewCmds(enc)
	if len(back) != 1 || back[0].Cmd != `WT_WINDOW="$TMUX_PANE" run $HOME/x` {
		t.Errorf("round trip lost the dollars: %+v", back)
	}
}

// The menu shares a -F line with another field and is split off from the left, so
// a pipeline in a command must not be able to take the split with it. JSON is
// self-delimiting but NOT separator-free — assuming otherwise mangled every
// command containing a '|' the first time this was written.
func TestEncodeNewCmdsHidesTheFieldSeparator(t *testing.T) {
	enc, err := encodeNewCmds([]NewCmd{{Cmd: "tail -F log | grep -i error"}})
	if err != nil {
		t.Fatalf("encodeNewCmds: %v", err)
	}
	if strings.Contains(enc, sessionsSep) {
		t.Errorf("encoded menu still contains the field separator %q: %s", sessionsSep, enc)
	}
	back := decodeNewCmds(enc)
	if len(back) != 1 || back[0].Cmd != "tail -F log | grep -i error" {
		t.Errorf("round trip lost the pipeline: %+v", back)
	}
}

func TestDecodeNewCmdsRejectsJunk(t *testing.T) {
	for _, raw := range []string{
		"",
		"   ",
		"not json",
		"launch_new.sh",    // the legacy single-command form
		"#{@wt_newcmds}",   // a tmux too old to expand the format
		`{"cmd":"x"}`,      // an object, not an array
		`[{"cmd":"a\$b"}]`, // what tmux 3.4 would make of an unencoded '$'
	} {
		if got := decodeNewCmds(raw); got != nil {
			t.Errorf("decodeNewCmds(%q) = %+v, want nil", raw, got)
		}
	}
}

func TestNewWindowRunsTheChosenMenuEntry(t *testing.T) {
	f := twoSessionServer()
	f.options = map[string]string{"$0/" + newCmdsOption: menuJSON(t,
		NewCmd{Label: "shell"},
		NewCmd{Label: "secure", Cmd: "enter_secure_container.sh"},
		NewCmd{Label: "claude", Cmd: "launch_new.sh"},
	)}
	c := newControllerWithRunner("dev", false, "", f.run)
	if err := c.RefreshLayout(); err != nil {
		t.Fatalf("RefreshLayout: %v", err)
	}

	// Entry 0 is a plain shell: nothing typed.
	if err := c.NewWindow("dev", 0); err != nil {
		t.Fatalf("NewWindow: %v", err)
	}
	if calls := f.argv("send-keys"); len(calls) != 0 {
		t.Errorf("the shell entry typed something: %v", calls)
	}

	// Entry 2 is the third button.
	if err := c.NewWindow("dev", 2); err != nil {
		t.Fatalf("NewWindow: %v", err)
	}
	keys := lastCall(t, f, "send-keys")
	if keys[len(keys)-2] != "launch_new.sh" {
		t.Errorf("ran %q, want the third entry", keys[len(keys)-2])
	}
	// Aimed at the window new-window reported, not at the session — a session
	// target would land in whichever window happened to be current.
	if got := flagValue(keys, "-t"); !strings.HasPrefix(got, "@") {
		t.Errorf("send-keys targeted %q, want a window id", got)
	}
}

// The index comes from a button drawn from a layout that may be a refresh old, so
// a stale index must degrade to a plain shell rather than to another entry.
func TestNewWindowIgnoresAnOutOfRangeMenuIndex(t *testing.T) {
	f := twoSessionServer()
	f.options = map[string]string{"$0/" + newCmdsOption: menuJSON(t, NewCmd{Cmd: "only.sh"})}
	c := newControllerWithRunner("dev", false, "", f.run)
	if err := c.RefreshLayout(); err != nil {
		t.Fatalf("RefreshLayout: %v", err)
	}
	for _, idx := range []int{1, 7, -1} {
		f.calls = nil
		if err := c.NewWindow("dev", idx); err != nil {
			t.Fatalf("NewWindow(%d): %v", idx, err)
		}
		if calls := f.argv("send-keys"); len(calls) != 0 {
			t.Errorf("index %d typed something: %v", idx, calls)
		}
	}
}

func TestNewWindowUsesTheTargetSessionsMenu(t *testing.T) {
	f := twoSessionServer()
	f.options = map[string]string{
		"$0/" + newCmdsOption: menuJSON(t, NewCmd{Cmd: "wrong-session.sh"}),
		"$1/" + newCmdsOption: menuJSON(t, NewCmd{Cmd: "right-session.sh"}),
	}
	c := newControllerWithRunner("dev", false, "", f.run) // attached to dev ($0)
	if err := c.RefreshLayout(); err != nil {
		t.Fatalf("RefreshLayout: %v", err)
	}
	if err := c.NewWindow("dev-2", 0); err != nil { // creating in dev-2 ($1)
		t.Fatalf("NewWindow: %v", err)
	}
	keys := lastCall(t, f, "send-keys")
	if keys[len(keys)-2] != "right-session.sh" {
		t.Errorf("ran %q — the attached session's entry, not the target's", keys[len(keys)-2])
	}
}

func TestSetSessionNewCmdsTargetsTheSessionID(t *testing.T) {
	f := twoSessionServer()
	c := newControllerWithRunner("dev", false, "", f.run)
	if err := c.SetSessionNewCmds("dev", []NewCmd{{Label: "claude", Cmd: "launch_new.sh"}}); err != nil {
		t.Fatalf("SetSessionNewCmds: %v", err)
	}
	// $0 — not "dev", which would prefix-match "dev-2" and arm the wrong session.
	var wrote []string
	for _, call := range f.argv("set-option") {
		if call[len(call)-2] == newCmdsOption || call[len(call)-1] == newCmdsOption {
			wrote = call
		}
	}
	if wrote == nil {
		t.Fatalf("@wt_newcmds was never written; calls: %v", f.calls)
	}
	if got := flagValue(wrote, "-t"); got != "$0" {
		t.Errorf("write targeted %q, want the session id $0", got)
	}
	if menu := decodeNewCmds(f.options["$0/"+newCmdsOption]); len(menu) != 1 || menu[0].Cmd != "launch_new.sh" {
		t.Errorf("stored menu is %+v", menu)
	}
	// Writing a menu retires the legacy single-command option, so the two can
	// never disagree about what the "+" does.
	if _, still := f.options["$0/"+newCmdOption]; still {
		t.Errorf("the legacy @wt_newcmd survived a menu write")
	}
}

func TestSetSessionNewCmdsEmptyUnsets(t *testing.T) {
	f := twoSessionServer()
	f.options = map[string]string{"$0/" + newCmdsOption: menuJSON(t, NewCmd{Cmd: "old.sh"})}
	c := newControllerWithRunner("dev", false, "", f.run)
	if err := c.SetSessionNewCmds("dev", nil); err != nil {
		t.Fatalf("SetSessionNewCmds: %v", err)
	}
	if _, still := f.options["$0/"+newCmdsOption]; still {
		t.Errorf("option survived the clear: %v", f.options)
	}
}

func TestSetSessionNewCmdsRefusesUnknownSession(t *testing.T) {
	f := twoSessionServer()
	c := newControllerWithRunner("dev", false, "", f.run)
	err := c.SetSessionNewCmds("no-such-session", []NewCmd{{Cmd: "x.sh"}})
	if err == nil {
		t.Fatalf("want a refusal for a session that does not exist")
	}
	if !strings.Contains(err.Error(), "no session named") {
		t.Errorf("unexpected error text: %v", err)
	}
	if calls := f.argv("set-option"); len(calls) != 0 {
		t.Errorf("wrote an option anyway: %v", calls)
	}
}

// A command line containing the '|' that separates the layout's -F fields must
// survive the round trip. It does here because the menu half of that line is
// JSON, which cannot contain a bare separator.
func TestMenuWithSeparatorSurvivesTheLayout(t *testing.T) {
	const piped = "tail -F log | grep -i error"
	f := twoSessionServer()
	menu := menuJSON(t, NewCmd{Cmd: piped})
	f.options = map[string]string{"$0/" + newCmdsOption: menu}
	f.sessions[0][newCmdsOption] = menu
	c := newControllerWithRunner("dev", false, "", f.run)
	if err := c.RefreshLayout(); err != nil {
		t.Fatalf("RefreshLayout: %v", err)
	}
	for _, s := range c.GetLayout().Sessions {
		if s.Name == "dev" {
			if len(s.NewCmds) != 1 || s.NewCmds[0].Cmd != piped {
				t.Errorf("Session.NewCmds = %+v, want the piped command intact", s.NewCmds)
			}
		}
	}
}

// A session configured before the menu existed carries the old single-command
// option. It must keep working until something rewrites it: those sessions are
// live, and the value was set by a stack.sh run that may not have happened again.
func TestLegacySingleCommandStillReadsAsAOneEntryMenu(t *testing.T) {
	f := twoSessionServer()
	f.options = map[string]string{"$0/" + newCmdOption: "legacy.sh"}
	f.sessions[0][newCmdOption] = "legacy.sh"
	c := newControllerWithRunner("dev", false, "", f.run)
	if err := c.RefreshLayout(); err != nil {
		t.Fatalf("RefreshLayout: %v", err)
	}
	for _, s := range c.GetLayout().Sessions {
		if s.Name == "dev" && (len(s.NewCmds) != 1 || s.NewCmds[0].Cmd != "legacy.sh") {
			t.Errorf("legacy command did not surface as a menu: %+v", s.NewCmds)
		}
	}
	// ...and it is what a "+" runs.
	if err := c.NewWindow("dev", 0); err != nil {
		t.Fatalf("NewWindow: %v", err)
	}
	keys := lastCall(t, f, "send-keys")
	if keys[len(keys)-2] != "legacy.sh" {
		t.Errorf("ran %q, want the legacy command", keys[len(keys)-2])
	}
}

// The menu half of the layout line wins over the legacy half when both are set —
// otherwise a session that has been migrated would keep answering with the value
// the migration replaced.
func TestMenuWinsOverLegacyInTheLayout(t *testing.T) {
	f := twoSessionServer()
	f.sessions[0][newCmdsOption] = menuJSON(t, NewCmd{Cmd: "new.sh"})
	f.sessions[0][newCmdOption] = "old.sh"
	c := newControllerWithRunner("dev", false, "", f.run)
	if err := c.RefreshLayout(); err != nil {
		t.Fatalf("RefreshLayout: %v", err)
	}
	for _, s := range c.GetLayout().Sessions {
		if s.Name == "dev" && (len(s.NewCmds) != 1 || s.NewCmds[0].Cmd != "new.sh") {
			t.Errorf("legacy value won over the menu: %+v", s.NewCmds)
		}
	}
}

func TestNewSessionInheritsTheWholeMenu(t *testing.T) {
	f := twoSessionServer()
	f.options = map[string]string{"$0/" + newCmdsOption: menuJSON(t,
		NewCmd{Label: "shell"},
		NewCmd{Label: "claude", Cmd: "launch_new.sh"},
	)}
	c := newControllerWithRunner("dev", false, "", f.run)
	c.SetClient("/dev/pts/1", 4242) // SwitchSession needs a client identity
	if err := c.RefreshLayout(); err != nil {
		t.Fatalf("RefreshLayout: %v", err)
	}
	if err := c.NewSession(); err != nil {
		t.Fatalf("NewSession: %v", err)
	}
	if got := flagValue(lastCall(t, f, "new-session"), "-s"); got != "dev (1)" {
		t.Errorf("new session named %q, want %q", got, "dev (1)")
	}
	menu := decodeNewCmds(f.options["$77/"+newCmdsOption])
	if len(menu) != 2 || menu[1].Label != "claude" {
		t.Errorf("new session did not inherit the whole menu: %+v", menu)
	}
	// Its first window runs the menu's FIRST entry, which here is a plain shell.
	if calls := f.argv("send-keys"); len(calls) != 0 {
		t.Errorf("a plain-shell first entry typed something: %v", calls)
	}
}
