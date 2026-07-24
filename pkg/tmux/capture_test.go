package tmux

import (
	"strings"
	"testing"
	"time"
)

// fakeTmux records calls and returns canned output for list-windows / capture-pane.
type fakeTmux struct {
	listOut     string
	captureOut  string
	listCalls   int
	captureArgs [][]string
}

func (f *fakeTmux) run(args ...string) (string, error) {
	switch args[0] {
	case "list-windows":
		f.listCalls++
		return f.listOut, nil
	case "capture-pane":
		f.captureArgs = append(f.captureArgs, args)
		return f.captureOut, nil
	}
	return "", nil
}

// buildList renders list-windows rows in the enumSep-delimited format the store
// parses. Each row: windowID, session, index, paneID, cols, rows, name.
func buildList(rows ...[]string) string {
	var lines []string
	for _, r := range rows {
		lines = append(lines, strings.Join(r, enumSep))
	}
	return strings.Join(lines, "\n")
}

func TestEnumerateWindowsDedupsByWindowID(t *testing.T) {
	// @0 and @1 each appear under three grouped sessions (services/web-a/web-b).
	f := &fakeTmux{listOut: buildList(
		[]string{"@0", "services", "0", "%0", "80", "24", "zsh"},
		[]string{"@1", "services", "1", "%3", "80", "24", "editor"},
		[]string{"@0", "web-a", "0", "%0", "80", "24", "zsh"},
		[]string{"@1", "web-a", "1", "%3", "80", "24", "editor"},
		[]string{"@0", "web-b", "0", "%0", "80", "24", "zsh"},
		[]string{"@1", "web-b", "1", "%3", "80", "24", "editor"},
	)}
	s := newCaptureStoreWithRunner(f.run, time.Now)

	wins, err := s.EnumerateWindows()
	if err != nil {
		t.Fatal(err)
	}
	if len(wins) != 2 {
		t.Fatalf("expected 2 deduped windows, got %d: %+v", len(wins), wins)
	}
	// First occurrence wins for the label session.
	if wins[0].WindowID != "@0" || wins[0].SessionName != "services" || wins[0].PaneID != "%0" {
		t.Errorf("unexpected first window: %+v", wins[0])
	}
	if wins[1].WindowID != "@1" || wins[1].Name != "editor" || wins[1].Cols != 80 {
		t.Errorf("unexpected second window: %+v", wins[1])
	}
}

func TestCaptureWindowsOnePerWindowID(t *testing.T) {
	f := &fakeTmux{
		listOut: buildList(
			[]string{"@0", "services", "0", "%0", "80", "24", "zsh"},
			[]string{"@0", "web-a", "0", "%0", "80", "24", "zsh"},
			[]string{"@1", "web-a", "1", "%3", "80", "24", "editor"},
		),
		captureOut: "line1\nline2\n",
	}
	s := newCaptureStoreWithRunner(f.run, time.Now)

	entries, err := s.CaptureWindows(nil, false) // nil == all
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 {
		t.Fatalf("expected one capture per window_id (2), got %d", len(entries))
	}
	if len(f.captureArgs) != 2 {
		t.Fatalf("expected 2 capture-pane forks, got %d", len(f.captureArgs))
	}
	// \n joined as \r\n, trailing newline trimmed.
	if string(entries[0].ANSI) != "line1\r\nline2" {
		t.Errorf("unexpected ANSI: %q", entries[0].ANSI)
	}
	// Wire form base64-encodes the data and carries dims.
	w := entries[1].Wire()
	if w.WindowID != "@1" || w.Cols != 80 || w.Data == "" {
		t.Errorf("unexpected wire: %+v", w)
	}
}

func TestEnumerateWindowsPlacesLinkedWindowPerSession(t *testing.T) {
	// @5 is LINKED into two real sessions (services idx 2, mywork idx 0) and also
	// visible through an ephemeral web-abc split shadow. Expect two placements (one
	// per real session, each with its own index) and NO web-* placement.
	f := &fakeTmux{listOut: buildList(
		[]string{"@5", "services", "2", "%10", "80", "24", "build"},
		[]string{"@5", "mywork", "0", "%10", "80", "24", "build"},
		[]string{"@5", "web-abc", "2", "%10", "80", "24", "build"},
	)}
	s := newCaptureStoreWithRunner(f.run, time.Now)

	wins, err := s.EnumerateWindows()
	if err != nil {
		t.Fatal(err)
	}
	if len(wins) != 2 {
		t.Fatalf("expected 2 placements for a window linked into 2 sessions, got %d: %+v", len(wins), wins)
	}
	if wins[0].SessionName != "services" || wins[0].Index != 2 {
		t.Errorf("unexpected first placement: %+v", wins[0])
	}
	if wins[1].SessionName != "mywork" || wins[1].Index != 0 {
		t.Errorf("unexpected second placement: %+v", wins[1])
	}
	for _, w := range wins {
		if strings.HasPrefix(w.SessionName, "web-") {
			t.Errorf("web-* shadow leaked as a placement: %+v", w)
		}
	}
}

func TestEnumerateWindowsKeepsWebOnlyWindow(t *testing.T) {
	// @9 exists ONLY under a web-* shadow (no real session). It must not vanish —
	// keep exactly one collapsed placement.
	f := &fakeTmux{listOut: buildList(
		[]string{"@9", "web-x", "0", "%20", "80", "24", "ghost"},
		[]string{"@9", "web-y", "0", "%20", "80", "24", "ghost"},
	)}
	s := newCaptureStoreWithRunner(f.run, time.Now)

	wins, err := s.EnumerateWindows()
	if err != nil {
		t.Fatal(err)
	}
	if len(wins) != 1 || wins[0].WindowID != "@9" {
		t.Fatalf("expected 1 fallback placement for a web-only window, got %+v", wins)
	}
}

func TestCaptureWindowsSharesScreenAcrossPlacements(t *testing.T) {
	// A window linked into two real sessions => two capture entries (one per
	// session, own index) but the SCREEN is captured only ONCE (shared panes).
	f := &fakeTmux{
		listOut: buildList(
			[]string{"@5", "services", "2", "%10", "80", "24", "build"},
			[]string{"@5", "mywork", "0", "%10", "80", "24", "build"},
		),
		captureOut: "hi\n",
	}
	s := newCaptureStoreWithRunner(f.run, time.Now)

	entries, err := s.CaptureWindows(nil, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 {
		t.Fatalf("expected 2 placement entries, got %d", len(entries))
	}
	if len(f.captureArgs) != 1 {
		t.Fatalf("expected the shared screen to be captured once, got %d forks", len(f.captureArgs))
	}
	if entries[0].SessionName != "services" || entries[0].Index != 2 ||
		entries[1].SessionName != "mywork" || entries[1].Index != 0 {
		t.Errorf("placements lost their session/index: %+v", entries)
	}
	// Both placements carry the SAME screen bytes.
	if string(entries[0].ANSI) != "hi" || string(entries[1].ANSI) != "hi" {
		t.Errorf("placements should share the screen: %q / %q", entries[0].ANSI, entries[1].ANSI)
	}
}

func TestCaptureCoalescesWithinTTL(t *testing.T) {
	f := &fakeTmux{
		listOut:    buildList([]string{"@0", "services", "0", "%0", "80", "24", "zsh"}),
		captureOut: "hello\n",
	}
	base := time.Unix(1_700_000_000, 0)
	clock := base
	s := newCaptureStoreWithRunner(f.run, func() time.Time { return clock })

	if _, err := s.CaptureWindows([]string{"@0"}, false); err != nil {
		t.Fatal(err)
	}
	// Second call 100ms later (< TTL) must reuse the cache: no new capture fork.
	clock = base.Add(100 * time.Millisecond)
	if _, err := s.CaptureWindows([]string{"@0"}, false); err != nil {
		t.Fatal(err)
	}
	if len(f.captureArgs) != 1 {
		t.Fatalf("expected coalescing (1 fork), got %d", len(f.captureArgs))
	}

	// Past the TTL it re-captures.
	clock = base.Add(CaptureFreshnessTTL + time.Millisecond)
	if _, err := s.CaptureWindows([]string{"@0"}, false); err != nil {
		t.Fatal(err)
	}
	if len(f.captureArgs) != 2 {
		t.Fatalf("expected re-capture past TTL (2 forks), got %d", len(f.captureArgs))
	}

	// force=true bypasses coalescing even within the TTL.
	clock = base.Add(CaptureFreshnessTTL + 2*time.Millisecond)
	if _, err := s.CaptureWindows([]string{"@0"}, true); err != nil {
		t.Fatal(err)
	}
	if len(f.captureArgs) != 3 {
		t.Fatalf("expected force bypass (3 forks), got %d", len(f.captureArgs))
	}
}
