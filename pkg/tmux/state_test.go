package tmux

import (
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
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

// TestServerIdentity pins the sanitizer behind Layout.ServerStart. Its whole job is
// to be TOTAL and to fail CLOSED: a client keys its offline @wt_state cache by this
// string, so a wrong-but-plausible value is worse than none — every tmux server too
// old to expand the format would share one identity and go on poisoning each other's
// cached revs, which is the bug the field exists to remove.
func TestServerIdentity(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want string
	}{
		{"a modern tmux prints seconds", "1753900000\n", "1753900000"},
		{"surrounding whitespace is trimmed", "  1753900000  ", "1753900000"},
		{"nothing at all means no identity", "", ""},
		{"whitespace only means no identity", " \n\t ", ""},
		{"an unexpanded format is refused, not shared", "#{start_time}", ""},
		{"a partially expanded format is refused too", "1753900000#{", ""},
		{"a formatted date stays usable as a key", "Wed Jul 30 10:00:00 2026",
			"Wed-Jul-30-10-00-00-2026"},
		{"an over-long value is capped", strings.Repeat("9", 64), strings.Repeat("9", 32)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := serverIdentity(tc.raw); got != tc.want {
				t.Errorf("serverIdentity(%q) = %q, want %q", tc.raw, got, tc.want)
			}
		})
	}
}

// TestServerStartInLayout runs the field end to end against a real tmux server: it
// must be non-empty, stable across refreshes (the value is cached precisely because
// it cannot change), and different for a DIFFERENT server — which is the entire
// point, since two servers sharing an identity would share a client-side cache.
func TestServerStartInLayout(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not installed")
	}
	start := func(t *testing.T) *Controller {
		socket := filepath.Join(t.TempDir(), "wt.sock")
		c, err := NewController("wtst", socket, false, "")
		if err != nil {
			t.Fatalf("NewController: %v", err)
		}
		if _, err := c.runTmux("new-session", "-d", "-s", "wtst"); err != nil {
			t.Fatalf("new-session: %v", err)
		}
		t.Cleanup(func() { c.runTmux("kill-server") })
		return c
	}

	a := start(t)
	if err := a.RefreshLayout(); err != nil {
		t.Fatalf("RefreshLayout: %v", err)
	}
	first := a.GetLayout().ServerStart
	if first == "" {
		t.Fatal("ServerStart is empty against a live tmux server")
	}
	if err := a.RefreshLayout(); err != nil {
		t.Fatalf("RefreshLayout(2): %v", err)
	}
	if second := a.GetLayout().ServerStart; second != first {
		t.Errorf("ServerStart changed between refreshes: %q -> %q", first, second)
	}

	// A second server on its own socket. Same host, same second possibly — but the
	// client must be able to tell them apart, so this is the assertion that matters.
	// tmux reports start_time in whole seconds, so give it one to differ by.
	time.Sleep(1100 * time.Millisecond)
	b := start(t)
	if err := b.RefreshLayout(); err != nil {
		t.Fatalf("RefreshLayout(b): %v", err)
	}
	if other := b.GetLayout().ServerStart; other == first {
		t.Errorf("two distinct tmux servers share an identity (%q)", other)
	}
}
