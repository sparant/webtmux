package tmux

import (
	"os/exec"
	"path/filepath"
	"testing"
)

// Live tmux tests for the copy-mode/scroll commands. They exist because the bug
// they cover is not visible in Go: `send-keys -X …` is exit 1 ("not in a mode")
// on a pane that isn't in a mode, and the browser cannot know that it is — its
// copy-mode flag is up to one 500ms poll old, and tmux leaves copy mode on its
// own (q, a `y` that copies-and-cancels, Enter, a mouse copy, the ssh console
// sharing the session). Every one of those failures used to end the websocket
// and SIGHUP the pane's tmux client: `[lost tty]`. So the property under test is
// simply that asking for the wrong thing is not an error.

func ctrlOnTmux(t *testing.T) *Controller {
	t.Helper()
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not installed; skipping live copy-mode tests")
	}
	sock := filepath.Join(t.TempDir(), "cm.sock")
	t.Cleanup(func() { exec.Command("tmux", "-S", sock, "kill-server").Run() })
	if err := exec.Command("tmux", "-S", sock, "new-session", "-d", "-s", "t", "-x", "80", "-y", "24").Run(); err != nil {
		t.Fatalf("new-session: %v", err)
	}
	c, err := NewController("t", sock, false, "")
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func inMode(t *testing.T, c *Controller) string {
	t.Helper()
	out, err := c.runTmux("display-message", "-p", "-t", "t", "#{pane_in_mode}")
	if err != nil {
		t.Fatalf("display-message: %v", err)
	}
	if len(out) > 0 && out[len(out)-1] == '\n' {
		out = out[:len(out)-1]
	}
	return out
}

func TestExitCopyModeIsIdempotent(t *testing.T) {
	c := ctrlOnTmux(t)

	// The case the browser hits constantly: leave a mode we are not in. This is
	// the exact request every paste makes, and the one `send-keys -X cancel`
	// rejected.
	if err := c.ExitCopyMode(); err != nil {
		t.Fatalf("exit from normal mode: %v", err)
	}
	if got := inMode(t, c); got != "0" {
		t.Fatalf("pane_in_mode = %q, want 0", got)
	}

	if err := c.EnterCopyMode(); err != nil {
		t.Fatalf("enter: %v", err)
	}
	if got := inMode(t, c); got != "1" {
		t.Fatalf("pane_in_mode after enter = %q, want 1", got)
	}
	if err := c.EnterCopyMode(); err != nil {
		t.Fatalf("enter while already in copy mode: %v", err)
	}

	if err := c.ExitCopyMode(); err != nil {
		t.Fatalf("exit: %v", err)
	}
	if got := inMode(t, c); got != "0" {
		t.Fatalf("pane_in_mode after exit = %q, want 0", got)
	}
	if err := c.ExitCopyMode(); err != nil {
		t.Fatalf("second exit: %v", err)
	}
}

func TestScrollFromNormalMode(t *testing.T) {
	c := ctrlOnTmux(t)

	// Wheel down at the live prompt: nothing below, so it must be a no-op —
	// neither an error nor, worse, a trip INTO the scrollback.
	if err := c.ScrollDown(3); err != nil {
		t.Fatalf("scroll down from normal mode: %v", err)
	}
	if got := inMode(t, c); got != "0" {
		t.Fatalf("scroll down entered a mode (pane_in_mode = %q)", got)
	}

	// Wheel up: scrolling into history IS entering copy mode, so it does that
	// itself rather than failing when the caller's flag was stale.
	for i := 0; i < 40; i++ {
		if _, err := c.runTmux("send-keys", "-t", "t", "echo scrollback", "Enter"); err != nil {
			t.Fatalf("seeding scrollback: %v", err)
		}
	}
	if err := c.ScrollUp(5); err != nil {
		t.Fatalf("scroll up from normal mode: %v", err)
	}
	if got := inMode(t, c); got != "1" {
		t.Fatalf("scroll up did not enter copy mode (pane_in_mode = %q)", got)
	}
	if err := c.ScrollDown(2); err != nil {
		t.Fatalf("scroll down while in copy mode: %v", err)
	}
}
