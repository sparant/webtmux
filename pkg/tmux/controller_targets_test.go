package tmux

import (
	"strings"
	"testing"
)

// tmux resolves a `-t` session name by PREFIX. Measured on tmux 3.2a with a live
// server, `switch-client -c <tty> -t dev-` moves the client to "dev-2" and exits
// 0 — and the same resolution sits under kill-session, rename-session,
// unlink-window and swap-window, where the consequence is not a surprising view
// but a destroyed or mangled session the user never named.
//
// These tests assert the literal argv, because that is the only place the
// difference is visible: every one of these commands succeeds either way.
//
// The exact-match syntax is not uniform, and the three shapes below were measured
// rather than assumed (see exactSession / exactPaneOf):
//   - session targets take `=name`
//   - target-PANE commands take `=name:` (a bare `=name` is "can't find pane",
//     and display-message silently expands to "" with status 0)
//   - set-option -t takes neither, so its caller targets #{session_id}

// twoSessionServer: "dev" ($0) and "dev-2" ($1) — the pair that makes a prefix
// match reachable — plus a window in each.
func twoSessionServer() *fakeServer {
	return &fakeServer{
		sessions: []map[string]string{
			{"session_id": "$0", "session_name": "dev", "session_windows": "2",
				"session_attached": "1", "session_grouped": "0", "session_group": ""},
			{"session_id": "$1", "session_name": "dev-2", "session_windows": "1",
				"session_attached": "0", "session_grouped": "0", "session_group": ""},
		},
		windows: []map[string]string{
			{"window_id": "@0", "window_index": "0", "window_active": "1",
				"window_name": "shell", "@wt_working": "1",
				"session_id": "$0", "session_name": "dev"},
			{"window_id": "@1", "window_index": "1", "window_active": "0",
				"window_name": "build", "@wt_working": "",
				"session_id": "$0", "session_name": "dev"},
			{"window_id": "@2", "window_index": "0", "window_active": "1",
				"window_name": "other", "@wt_working": "",
				"session_id": "$1", "session_name": "dev-2"},
		},
		panes: []map[string]string{
			{"pane_id": "%0", "pane_index": "0", "pane_active": "1", "pane_in_mode": "0",
				"pane_width": "80", "pane_height": "24", "pane_top": "0", "pane_left": "0",
				"pane_current_command": "bash", "pane_title": "shell",
				"window_id": "@0", "session_id": "$0", "session_name": "dev"},
			{"pane_id": "%1", "pane_index": "0", "pane_active": "1", "pane_in_mode": "0",
				"pane_width": "80", "pane_height": "24", "pane_top": "0", "pane_left": "0",
				"pane_current_command": "bash", "pane_title": "build",
				"window_id": "@1", "session_id": "$0", "session_name": "dev"},
			{"pane_id": "%2", "pane_index": "0", "pane_active": "1", "pane_in_mode": "0",
				"pane_width": "80", "pane_height": "24", "pane_top": "0", "pane_left": "0",
				"pane_current_command": "bash", "pane_title": "other",
				"window_id": "@2", "session_id": "$1", "session_name": "dev-2"},
		},
		clients: []map[string]string{
			{"client_pid": "4242", "client_tty": "/dev/pts/1", "client_session": "dev"},
		},
	}
}

// lastCall returns the last recorded argv for a subcommand.
func lastCall(t *testing.T, f *fakeServer, name string) []string {
	t.Helper()
	calls := f.argv(name)
	if len(calls) == 0 {
		t.Fatalf("%s was never called; calls: %v", name, f.calls)
	}
	return calls[len(calls)-1]
}

func wantArgv(t *testing.T, got []string, want ...string) {
	t.Helper()
	if strings.Join(got, "\x00") != strings.Join(want, "\x00") {
		t.Errorf("argv = %q\n    want %q", got, want)
	}
}

func TestDestructiveOpsTargetExactly(t *testing.T) {
	cases := []struct {
		name string
		act  func(*Controller) error
		cmd  string
		want []string
	}{
		{"kill-session",
			func(c *Controller) error { return c.KillSession("dev") },
			"kill-session", []string{"kill-session", "-t", "=dev"}},

		// `--` so a new name beginning with '-' is a name, not a flag.
		{"rename-session",
			func(c *Controller) error { return c.RenameSession("dev", "-fresh | name") },
			"rename-session", []string{"rename-session", "-t", "=dev", "--", "-fresh | name"}},

		{"rename-window",
			func(c *Controller) error { return c.RenameWindow("@0", "-fresh") },
			"rename-window", []string{"rename-window", "-t", "@0", "--", "-fresh"}},

		// Linking into the NEXT free index of the target session.
		{"link-window",
			func(c *Controller) error { return c.LinkWindow("@0", "dev-2") },
			"link-window", []string{"link-window", "-s", "@0", "-t", "=dev-2:1"}},

		{"unlink-window",
			func(c *Controller) error { return c.UnlinkWindow("@1", "dev") },
			"unlink-window", []string{"unlink-window", "-t", "=dev:1"}},

		{"swap-window (a reorder)",
			func(c *Controller) error { return c.MoveWindow("@0", 1, "dev") },
			"swap-window", []string{"swap-window", "-s", "=dev:0", "-t", "=dev:1"}},

		{"new-window",
			func(c *Controller) error { return c.NewWindow("dev") },
			"new-window", []string{"new-window", "-t", "=dev"}},

		{"select-window",
			func(c *Controller) error { return c.SelectWindow("@1") },
			"select-window", []string{"select-window", "-t", "=dev:1"}},

		// The no-tty legacy path; the tty path is covered by switchOurClient below.
		{"switch-client",
			func(c *Controller) error { return c.SwitchSession("dev-2") },
			"switch-client", []string{"switch-client", "-t", "=dev-2"}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := twoSessionServer()
			c := newControllerWithRunner("dev", false, "", f.run)
			if err := c.RefreshLayout(); err != nil { // warm the cache the id->index lookups use
				t.Fatalf("RefreshLayout: %v", err)
			}
			if err := tc.act(c); err != nil {
				t.Fatalf("%s: %v", tc.name, err)
			}
			wantArgv(t, lastCall(t, f, tc.cmd), tc.want...)
		})
	}
}

func TestSwitchOurClientTargetsExactly(t *testing.T) {
	f := twoSessionServer()
	c := newControllerWithRunner("dev", false, "", f.run)
	c.SetClient("/dev/pts/1", 4242)
	if err := c.switchOurClient("dev-2"); err != nil {
		t.Fatalf("switchOurClient: %v", err)
	}
	wantArgv(t, lastCall(t, f, "switch-client"),
		"switch-client", "-c", "/dev/pts/1", "-t", "=dev-2")
}

// The target-PANE commands: `=name:`, not `=name`. A bare `=name` makes tmux
// answer "can't find pane" — so getting this wrong breaks the feature outright
// rather than silently mis-targeting, which is why it is pinned here.
func TestPaneScopedCommandsUseTheColonForm(t *testing.T) {
	cases := []struct {
		name string
		act  func(*Controller) error
		cmd  string
		want []string
	}{
		{"split-window",
			func(c *Controller) error { return c.SplitPane(true) },
			"split-window", []string{"split-window", "-t", "=dev:", "-h"}},
		{"copy-mode",
			func(c *Controller) error { return c.EnterCopyMode() },
			"copy-mode", []string{"copy-mode", "-t", "=dev:"}},
		{"copy-mode -q",
			func(c *Controller) error { return c.ExitCopyMode() },
			"copy-mode", []string{"copy-mode", "-q", "-t", "=dev:"}},
		{"send-keys",
			func(c *Controller) error { return c.ScrollUp(3) },
			"send-keys", []string{"send-keys", "-t", "=dev:", "-N", "3", "-X", "scroll-up"}},
		{"if-shell",
			func(c *Controller) error { return c.ScrollDown(3) },
			"if-shell", []string{"if-shell", "-F", "-t", "=dev:", "#{pane_in_mode}", "send-keys -N 3 -X scroll-down"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := twoSessionServer()
			c := newControllerWithRunner("dev", false, "", f.run)
			if err := tc.act(c); err != nil {
				t.Fatalf("%s: %v", tc.name, err)
			}
			wantArgv(t, lastCall(t, f, tc.cmd), tc.want...)
		})
	}
}

func TestRefreshLayoutReadsExactly(t *testing.T) {
	f := twoSessionServer()
	c := newControllerWithRunner("dev", false, "", f.run)
	if err := c.RefreshLayout(); err != nil {
		t.Fatalf("RefreshLayout: %v", err)
	}
	// display-message is a target-PANE command: with `=dev` tmux expands the whole
	// format to "" and exits 0, so the layout would report a nameless session.
	// Selected by its format rather than by position, because RefreshLayout may run
	// other display-message calls (e.g. a targetless server-wide query) around it.
	var ident []string
	for _, call := range f.argv("display-message") {
		if flagValue(call, "-p") == sessionIdentFormat {
			ident = call
		}
	}
	if ident == nil {
		t.Fatalf("the session identity read never happened: %v", f.argv("display-message"))
	}
	wantArgv(t, ident, "display-message", "-t", "=dev:", "-p", sessionIdentFormat)
	// The per-session window listing is a session target.
	for _, call := range f.argv("list-windows") {
		if hasFlag(call, "-a") {
			continue
		}
		wantArgv(t, call, "list-windows", "-t", "=dev", "-F", windowsFormat)
	}
}

// regroupOnto's set-option is the one session-targeting command tmux gives no
// exact syntax at all ("no such session: =name" for both forms), so the fresh
// session is named by the #{session_id} that -P -F just handed back.
func TestRegroupOntoTargetsTheNewSessionByID(t *testing.T) {
	f := twoSessionServer()
	c := newControllerWithRunner("web-abc", true, "dev", f.run)
	c.SetClient("/dev/pts/1", 4242)
	if err := c.regroupOnto("dev"); err != nil {
		t.Fatalf("regroupOnto: %v", err)
	}
	create := lastCall(t, f, "new-session")
	if create[2] != "-t" || create[3] != "=dev" {
		t.Errorf("regroup grouped onto %q; want =dev (argv %q)", create[3], create)
	}
	if !hasFlag(create, "-P") || flagValue(create, "-F") != "#{session_id}" {
		t.Errorf("regroup must ask for the new session id: %q", create)
	}
	wantArgv(t, lastCall(t, f, "set-option"),
		"set-option", "-t", "$77", "destroy-unattached", "on")
}

// A session name the user began with '-' cannot be escaped for `new-session -s`:
// the name is an OPTION ARGUMENT, and tmux consumes a `--` as the name itself and
// then parses the real one as flags ("unknown option -- w"). Refuse with a
// message that says so instead of emitting a command whose failure blames
// something else.
func TestStartRefusesALeadingDashSessionName(t *testing.T) {
	f := &fakeServer{fail: map[string]error{"has-session": errRegroupInFlight}}
	c := newControllerWithRunner("-weird", false, "", f.run)
	err := c.Start()
	if err == nil {
		t.Fatal("Start must refuse a leading-'-' session name")
	}
	if !strings.Contains(err.Error(), "leading '-'") {
		t.Errorf("unhelpful error: %v", err)
	}
	if f.count("new-session") != 0 {
		t.Errorf("no session should have been created: %v", f.calls)
	}
}

// A sweep, so a command added later can't quietly reintroduce a prefix target:
// after driving the whole mutating surface, no recorded `-t` may name a session
// in bare form. Legitimate shapes are the exact prefixes (`=`), tmux's own object
// ids (@window, %pane, $session) and the client tty.
func TestNoCommandTargetsASessionByBareName(t *testing.T) {
	f := twoSessionServer()
	c := newControllerWithRunner("dev", false, "", f.run)
	c.SetClient("/dev/pts/1", 4242)

	c.RefreshLayout()
	c.SelectWindow("@1")
	c.SelectPane("%0")
	c.RenameWindow("@0", "x")
	c.MoveWindow("@0", 1, "dev")
	c.NewWindow("dev")
	c.KillWindow("@1")
	c.LinkWindow("@0", "dev-2")
	c.UnlinkWindow("@1", "dev")
	c.RenameSession("dev", "dev3")
	c.KillSession("dev-2")
	c.SplitPane(false)
	c.ClosePane("%0")
	c.EnterCopyMode()
	c.ExitCopyMode()
	c.ScrollUp(2)
	c.ScrollDown(2)
	c.RefreshClient()
	c.regroupOnto("dev")

	for _, call := range f.calls {
		v := flagValue(call, "-t")
		if v == "" {
			continue
		}
		switch {
		case strings.HasPrefix(v, "="), strings.HasPrefix(v, "@"),
			strings.HasPrefix(v, "%"), strings.HasPrefix(v, "$"),
			strings.HasPrefix(v, "/dev/"):
		default:
			t.Errorf("bare target %q in %q", v, call)
		}
		if s := flagValue(call, "-s"); s != "" && call[0] == "swap-window" && !strings.HasPrefix(s, "=") {
			t.Errorf("bare source target %q in %q", s, call)
		}
	}
}
