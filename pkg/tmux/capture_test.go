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
// parses. Each row: windowID, session, index, name, paneID, cols, rows.
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
		[]string{"@0", "services", "0", "zsh", "%0", "80", "24"},
		[]string{"@1", "services", "1", "editor", "%3", "80", "24"},
		[]string{"@0", "web-a", "0", "zsh", "%0", "80", "24"},
		[]string{"@1", "web-a", "1", "editor", "%3", "80", "24"},
		[]string{"@0", "web-b", "0", "zsh", "%0", "80", "24"},
		[]string{"@1", "web-b", "1", "editor", "%3", "80", "24"},
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
			[]string{"@0", "services", "0", "zsh", "%0", "80", "24"},
			[]string{"@0", "web-a", "0", "zsh", "%0", "80", "24"},
			[]string{"@1", "web-a", "1", "editor", "%3", "80", "24"},
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

func TestCaptureCoalescesWithinTTL(t *testing.T) {
	f := &fakeTmux{
		listOut:    buildList([]string{"@0", "services", "0", "zsh", "%0", "80", "24"}),
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
