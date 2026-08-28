package tmux

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The per-session new-window command, against a REAL tmux.
//
// The fake-runner tests next door prove the argv. They cannot prove the claims
// this feature actually rests on, because a fake that agrees with them proves
// only that we wrote it to agree:
//
//	`#{@wt_newcmd}` expands a USER option inside a list-sessions format (tmux
//	    learned this in 3.2; before that it echoes the format back verbatim);
//	`set-option -t $N` / `show-options -t $N -qv` address a session by id, which
//	    is the only exact form those two commands accept;
//	send-keys into a just-created window reaches its shell at all — nothing waits
//	    for that shell to be ready, the pty is expected to buffer the keys;
//	and $TMUX_PANE in the sent text expands to the NEW window's own pane, which is
//	    what makes the wrapped stack.conf command drive the right stoplight rather
//	    than the one belonging to whoever clicked "+".
//
// Skipped, not failed, where tmux is absent — same rule as the live scrollback
// test this borrows its harness from.

// waitForFile polls for a file the pane's shell is expected to create. The
// command is TYPED into a shell in another process, so every assertion here is
// about state tmux and that shell settle into.
func waitForFile(t *testing.T, path string) string {
	t.Helper()
	for i := 0; i < 100; i++ {
		if b, err := os.ReadFile(path); err == nil {
			return strings.TrimSpace(string(b))
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("%s never appeared — the session's command did not run in the new window", path)
	return ""
}

func TestLiveNewCmdRoundTripsThroughTmux(t *testing.T) {
	run, _ := liveTmux(t)
	c := newControllerWithRunner("live", false, "", run)

	// Both hazards in one value: a '|' the layout's -F parsing must survive, and a
	// '$' that tmux 3.4 escapes in a stored option (see encodeNewCmds).
	const cmd = `tail -F "$LOG" | grep -i error`
	if err := c.SetSessionNewCmds("live", []NewCmd{{Label: "tail", Cmd: cmd}}); err != nil {
		t.Fatalf("SetSessionNewCmds against real tmux: %v", err)
	}

	// Read back the way the UI does: through the layout, i.e. through
	// `list-sessions -F '#{session_id}|#{@wt_newcmd}'`. This is the assertion that
	// fails on a tmux too old to expand a user option in a format.
	if err := c.RefreshLayout(); err != nil {
		t.Fatalf("RefreshLayout: %v", err)
	}
	var got []NewCmd
	for _, s := range c.GetLayout().Sessions {
		if s.Name == "live" {
			got = s.NewCmds
		}
	}
	if len(got) != 1 || got[0].Cmd != cmd || got[0].Label != "tail" {
		t.Fatalf("Session.NewCmds = %+v, want one entry %q (does this tmux expand "+
			"#{@user} options, and did the '$' survive?)", got, cmd)
	}

	// And clearing really unsets it, rather than storing an empty string.
	if err := c.SetSessionNewCmds("live", nil); err != nil {
		t.Fatalf("clear: %v", err)
	}
	if v := c.sessionNewCmds("live"); v != nil {
		t.Errorf("after clearing, sessionNewCmds = %+v", v)
	}
}

func TestLiveNewWindowRunsTheCommandInTheNewWindow(t *testing.T) {
	run, _ := liveTmux(t)
	c := newControllerWithRunner("live", false, "", run)

	dir := t.TempDir()
	marker := filepath.Join(dir, "pane")
	// Writes the RUNNING pane's own id. Two things at once: that the command runs
	// at all, and that $TMUX_PANE resolves to the new window's pane — the property
	// scripts/stack.sh depends on when it stores WT_WINDOW="$TMUX_PANE" unexpanded.
	if err := c.SetSessionNewCmds("live", []NewCmd{
		{Label: "shell"}, // entry 0: a plain shell, so entry 1 proves the INDEX works
		{Cmd: "printf '%s' \"$TMUX_PANE\" > " + marker},
	}); err != nil {
		t.Fatalf("SetSessionNewCmds: %v", err)
	}

	before, err := run("list-panes", "-a", "-F", "#{pane_id}")
	if err != nil {
		t.Fatalf("list-panes: %v", err)
	}
	if err := c.NewWindow("live", 1); err != nil {
		t.Fatalf("NewWindow: %v", err)
	}

	ranIn := waitForFile(t, marker)
	if ranIn == "" || !strings.HasPrefix(ranIn, "%") {
		t.Fatalf("marker holds %q, want a tmux pane id", ranIn)
	}
	// The pane it ran in must be one that did not exist before the new window.
	if strings.Contains(before, ranIn) {
		t.Errorf("the command ran in pre-existing pane %s — $TMUX_PANE resolved to the "+
			"wrong pane, so a stoplight would paint the wrong window", ranIn)
	}
}

func TestLiveNewWindowWithoutACommandJustGetsAShell(t *testing.T) {
	run, _ := liveTmux(t)
	c := newControllerWithRunner("live", false, "", run)
	if err := c.NewWindow("live", 0); err != nil {
		t.Fatalf("NewWindow: %v", err)
	}
	out, err := run("list-windows", "-t", "=live", "-F", "#{window_id}")
	if err != nil {
		t.Fatalf("list-windows: %v", err)
	}
	if n := len(strings.Fields(out)); n != 2 {
		t.Errorf("want the original window plus the new one, got %d: %q", n, out)
	}
}

func TestLiveNewSessionInheritsAndRuns(t *testing.T) {
	run, _ := liveTmux(t)
	c := newControllerWithRunner("live", false, "", run)

	dir := t.TempDir()
	marker := filepath.Join(dir, "inherited")
	if err := c.SetSessionNewCmds("live", []NewCmd{{Cmd: "printf ran > " + marker}}); err != nil {
		t.Fatalf("SetSessionNewCmds: %v", err)
	}

	// The switch at the end of NewSession needs an attached client to move, and
	// this server has none (new-session -d). The refusal is expected and is not
	// what this test is about: everything asserted below happened before it.
	_ = c.NewSession()

	out, err := run("list-sessions", "-F", "#{session_name}")
	if err != nil {
		t.Fatalf("list-sessions: %v", err)
	}
	if !strings.Contains(out, "live (1)") {
		t.Fatalf("no derived session; sessions are %q, want one named %q", out, "live (1)")
	}

	// The menu was copied onto the new session...
	derived := c.sessionNewCmds("live (1)")
	if len(derived) != 1 || derived[0].Cmd != "printf ran > "+marker {
		t.Errorf("derived session's menu = %+v, want it inherited", derived)
	}
	// ...and ran in its first window.
	waitForFile(t, marker)

	// A second "+" from the same place must not collide with the first.
	_ = c.NewSession()
	out, _ = run("list-sessions", "-F", "#{session_name}")
	if !strings.Contains(out, "live (2)") {
		t.Errorf("second derived session missing; sessions are %q", out)
	}
}
