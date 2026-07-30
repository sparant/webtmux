package tmux

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

// fakeTmux records calls and returns canned output for list-windows /
// list-sessions / capture-pane.
//
// listOut holds rows stated with the session NAME, because that is what the test
// is about; the fake substitutes the session ID on the way out, exactly as tmux
// would, and answers the `list-sessions` the store now runs to translate them
// back. Keeping the fixture in names is what lets a test put a '|' in one.
type fakeTmux struct {
	listOut     [][]string
	captureOut  string
	listCalls   int
	captureArgs [][]string
}

// sessionIDs assigns "$0", "$1", … to the distinct session names in listOut, in
// first-appearance order. Deterministic, so list-windows and list-sessions agree.
func (f *fakeTmux) sessionIDs() (map[string]string, []string) {
	ids := map[string]string{}
	var order []string
	for _, r := range f.listOut {
		if _, ok := ids[r[1]]; !ok {
			ids[r[1]] = fmt.Sprintf("$%d", len(order))
			order = append(order, r[1])
		}
	}
	return ids, order
}

func (f *fakeTmux) run(args ...string) (string, error) {
	switch args[0] {
	case "list-windows":
		f.listCalls++
		ids, _ := f.sessionIDs()
		var lines []string
		for _, r := range f.listOut {
			row := append([]string(nil), r...)
			row[1] = ids[r[1]]
			lines = append(lines, strings.Join(row, enumSep))
		}
		return strings.Join(lines, "\n"), nil
	case "list-sessions":
		ids, order := f.sessionIDs()
		format := flagValue(args, "-F")
		var lines []string
		for _, name := range order {
			lines = append(lines, renderFormat(format, map[string]string{
				"session_id": ids[name], "session_name": name, "session_windows": "1",
				"session_attached": "1", "session_grouped": "0", "session_group": "",
			}))
		}
		return strings.Join(lines, "\n"), nil
	case "capture-pane":
		f.captureArgs = append(f.captureArgs, args)
		return f.captureOut, nil
	}
	return "", nil
}

// buildList collects list-windows rows. Each row: windowID, session NAME, index,
// paneID, cols, rows, window name.
func buildList(rows ...[]string) [][]string {
	return rows
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

func TestEnumerateWindowsSurvivesSeparatorsInBothNames(t *testing.T) {
	// The row carries the session as #{session_id}, so BOTH user-typed strings on
	// the line can contain the separator. With session_name in the line, "ops |
	// staging" shifted index/pane_id/cols/rows by one field each: the tile lost its
	// geometry and capture-pane was aimed at "0" instead of "%10".
	f := &fakeTmux{listOut: buildList(
		[]string{"@5", "ops | staging", "2", "%10", "80", "24", "a, b | c"},
	)}
	s := newCaptureStoreWithRunner(f.run, time.Now)

	wins, err := s.EnumerateWindows()
	if err != nil {
		t.Fatal(err)
	}
	if len(wins) != 1 {
		t.Fatalf("expected 1 placement, got %+v", wins)
	}
	w := wins[0]
	if w.SessionName != "ops | staging" || w.Name != "a, b | c" ||
		w.Index != 2 || w.PaneID != "%10" || w.Cols != 80 || w.Rows != 24 {
		t.Errorf("separators corrupted the placement: %+v", w)
	}
}

func TestEnumerateWindowsDropsUnnameableSessions(t *testing.T) {
	// A session that `list-sessions` doesn't know about (created a moment later)
	// cannot be labelled or switched to, so its placement is left out rather than
	// tiled under a raw "$7".
	f := &fakeTmux{listOut: buildList(
		[]string{"@5", "services", "0", "%10", "80", "24", "build"},
	)}
	f2 := &fakeTmux{listOut: f.listOut}
	s := newCaptureStoreWithRunner(func(args ...string) (string, error) {
		if args[0] == "list-sessions" {
			return "", nil // the listing raced us
		}
		return f2.run(args...)
	}, time.Now)

	wins, err := s.EnumerateWindows()
	if err != nil {
		t.Fatal(err)
	}
	if len(wins) != 0 {
		t.Errorf("want no placements when no session can be named, got %+v", wins)
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
