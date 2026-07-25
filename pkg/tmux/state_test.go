package tmux

import (
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// TestSetGlobalOptionRoundTrip verifies the @wt_state persistence path end to end:
// SetGlobalOption writes the shared UI-state blob into the tmux global option, and
// RefreshLayout reads it back into Layout.State. It also checks the two guards:
// a non-JSON value is dropped (omitted), and clearing round-trips to nil.
//
// It spins a throwaway tmux server on a temp socket, so it's skipped anywhere tmux
// isn't installed (e.g. the CI image without the tmux package).
func TestSetGlobalOptionRoundTrip(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not installed")
	}
	socket := filepath.Join(t.TempDir(), "wt.sock")
	c, err := NewController("wtst", socket, false, "")
	if err != nil {
		t.Fatalf("NewController: %v", err)
	}
	// A detached session gives the server (and one window) for RefreshLayout to read.
	if _, err := c.runTmux("new-session", "-d", "-s", "wtst"); err != nil {
		t.Fatalf("new-session: %v", err)
	}
	defer c.runTmux("kill-server")

	blob := `{"v":1,"rev":7,"sidebar":{"pinned":true}}`
	if err := c.SetGlobalOption("@wt_state", blob); err != nil {
		t.Fatalf("SetGlobalOption: %v", err)
	}

	// Direct read (the exact command RefreshLayout uses).
	if out, err := c.runTmux("show-options", "-gqv", "@wt_state"); err != nil {
		t.Fatalf("show-options: %v", err)
	} else if got := strings.TrimSpace(out); got != blob {
		t.Errorf("show-options round-trip: got %q want %q", got, blob)
	}

	// Full path: RefreshLayout must surface the blob as Layout.State.
	if err := c.RefreshLayout(); err != nil {
		t.Fatalf("RefreshLayout: %v", err)
	}
	if got := string(c.GetLayout().State); got != blob {
		t.Errorf("Layout.State round-trip: got %q want %q", got, blob)
	}

	// A non-JSON value must be IGNORED (omitted), never break the layout marshal.
	if err := c.SetGlobalOption("@wt_state", "not-json"); err != nil {
		t.Fatalf("SetGlobalOption(non-json): %v", err)
	}
	if err := c.RefreshLayout(); err != nil {
		t.Fatalf("RefreshLayout(non-json): %v", err)
	}
	if s := c.GetLayout().State; s != nil {
		t.Errorf("non-JSON @wt_state should be omitted, got %q", string(s))
	}
}
