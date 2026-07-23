package tmux

import (
	"encoding/base64"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

// CaptureFreshnessTTL is the coalescing window: a capture whose CapturedAt is
// younger than this is reused instead of re-forking tmux. Multiple TerminalUnit
// connections / overlapping UI triggers (Exposé + sidebar poll) therefore do not
// stampede the socket. `force=true` bypasses it.
const CaptureFreshnessTTL = 500 * time.Millisecond

// CaptureEntry is a color-preserving snapshot of ONE window's active pane, keyed
// by tmux window_id (@N). Because grouped sessions (new-session -t base -s web-x)
// share the same window list, a window has exactly one entry regardless of how
// many sessions "contain" it — see CaptureStore's dedup rationale.
type CaptureEntry struct {
	WindowID    string
	SessionName string // first session that saw the window (label only)
	Index       int
	Name        string
	Cols        int
	Rows        int
	CapturedAt  time.Time
	ANSI        []byte // raw SGR-annotated screen, lines joined by \r\n
}

// CaptureWire is the JSON-marshalable shape sent to the client (ANSI as base64).
type CaptureWire struct {
	WindowID    string `json:"windowId"`
	SessionName string `json:"sessionName"`
	Index       int    `json:"index"`
	Name        string `json:"name"`
	Cols        int    `json:"cols"`
	Rows        int    `json:"rows"`
	CapturedAt  int64  `json:"capturedAt"` // unix seconds
	Data        string `json:"data"`       // base64 of ANSI
}

// Wire converts an entry to its client-facing form.
func (e CaptureEntry) Wire() CaptureWire {
	return CaptureWire{
		WindowID:    e.WindowID,
		SessionName: e.SessionName,
		Index:       e.Index,
		Name:        e.Name,
		Cols:        e.Cols,
		Rows:        e.Rows,
		CapturedAt:  e.CapturedAt.Unix(),
		Data:        base64.StdEncoding.EncodeToString(e.ANSI),
	}
}

// WindowInfo is one deduped window from EnumerateWindows: everything needed to
// capture it (active pane id + dims) plus label metadata.
type WindowInfo struct {
	WindowID    string
	SessionName string
	Index       int
	Name        string
	PaneID      string // active pane of the window (%N) — the capture target
	Cols        int
	Rows        int
}

// tmuxRunner runs a tmux subcommand and returns stdout. Injectable so tests can
// supply a fake tmux without forking.
type tmuxRunner func(args ...string) (string, error)

// CaptureStore is the SERVER-GLOBAL cache of per-window capture buffers. It is
// constructed once in server.Run with the tmux socket and shared (by pointer) by
// every connection's WebTTY — NOT per-connection and NOT on the per-connection
// TmuxController. Keeping it server-global is what makes "exactly one capture per
// window across all connections/grouped sessions" fall out for free: enumeration
// dedups by window_id, and capture is read-only (capture-pane never moves the
// active pane or disturbs any client), so it is always safe to run.
type CaptureStore struct {
	run tmuxRunner
	now func() time.Time

	mu       sync.Mutex
	byWindow map[string]CaptureEntry // window_id -> latest capture
}

// NewCaptureStore builds a store that talks to the given `tmux -S <socket>`
// (empty => tmux default socket), mirroring Controller.runTmux.
func NewCaptureStore(socket string) *CaptureStore {
	run := func(args ...string) (string, error) {
		if socket != "" {
			args = append([]string{"-S", socket}, args...)
		}
		out, err := exec.Command("tmux", args...).Output()
		if err != nil {
			return "", fmt.Errorf("tmux command failed: %w", err)
		}
		return string(out), nil
	}
	return newCaptureStoreWithRunner(run, time.Now)
}

// newCaptureStoreWithRunner is the test seam.
func newCaptureStoreWithRunner(run tmuxRunner, now func() time.Time) *CaptureStore {
	return &CaptureStore{
		run:      run,
		now:      now,
		byWindow: make(map[string]CaptureEntry),
	}
}

// enumSep separates fields in the list-windows format. Newline separates rows.
const enumSep = "\x1f" // ASCII unit separator: never appears in tmux names

// EnumerateWindows lists every window across every session on the server
// (`list-windows -a`) and dedups by window_id — first occurrence wins for the
// label/index/session, so a window shared by services + web-a + web-b yields a
// single WindowInfo. This is the "all windows across all sessions, one entry
// each" source of truth for both Exposé and "all"-window capture requests.
func (s *CaptureStore) EnumerateWindows() ([]WindowInfo, error) {
	format := strings.Join([]string{
		"#{window_id}", "#{session_name}", "#{window_index}",
		"#{window_name}", "#{pane_id}", "#{pane_width}", "#{pane_height}",
	}, enumSep)

	out, err := s.run("list-windows", "-a", "-F", format)
	if err != nil {
		return nil, err
	}

	var wins []WindowInfo
	seen := make(map[string]bool)
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if line == "" {
			continue
		}
		f := strings.Split(line, enumSep)
		if len(f) < 7 {
			continue
		}
		windowID := f[0]
		if seen[windowID] {
			continue // dedup: first grouped session wins
		}
		seen[windowID] = true

		idx, _ := strconv.Atoi(f[2])
		cols, _ := strconv.Atoi(f[5])
		rows, _ := strconv.Atoi(f[6])
		wins = append(wins, WindowInfo{
			WindowID:    windowID,
			SessionName: f[1],
			Index:       idx,
			Name:        f[3],
			PaneID:      f[4],
			Cols:        cols,
			Rows:        rows,
		})
	}
	return wins, nil
}

// CaptureWindows refreshes and returns capture entries for the requested windows.
// windowIDs==nil (or empty) means "all deduped windows". `force` bypasses the
// freshness coalescing. Read-only: it only runs list-windows + capture-pane and
// never touches the active pane, so it is safe against any window at any time.
func (s *CaptureStore) CaptureWindows(windowIDs []string, force bool) ([]CaptureEntry, error) {
	wins, err := s.EnumerateWindows()
	if err != nil {
		return nil, err
	}

	// Which window_ids are we returning? nil request => all enumerated windows.
	wantAll := len(windowIDs) == 0
	want := make(map[string]bool, len(windowIDs))
	for _, id := range windowIDs {
		want[id] = true
	}

	now := s.now()
	var out []CaptureEntry
	for _, w := range wins {
		if !wantAll && !want[w.WindowID] {
			continue
		}

		// Coalesce: reuse a still-fresh cached entry unless forced.
		if !force {
			s.mu.Lock()
			cached, ok := s.byWindow[w.WindowID]
			s.mu.Unlock()
			if ok && now.Sub(cached.CapturedAt) < CaptureFreshnessTTL {
				out = append(out, cached)
				continue
			}
		}

		entry, err := s.captureOne(w)
		if err != nil {
			// Skip an unreadable window (e.g. it vanished mid-enumeration) but
			// still serve the rest — a partial mosaic beats a failed request.
			continue
		}
		s.mu.Lock()
		s.byWindow[w.WindowID] = entry
		s.mu.Unlock()
		out = append(out, entry)
	}
	return out, nil
}

// captureOne snapshots a single window's active pane, colors preserved.
func (s *CaptureStore) captureOne(w WindowInfo) (CaptureEntry, error) {
	// Target the resolved active pane_id (%N) for determinism rather than the
	// window @id. -e emits SGR color escapes; -p prints to stdout. Read-only.
	target := w.PaneID
	if target == "" {
		target = w.WindowID
	}
	out, err := s.run("capture-pane", "-e", "-p", "-t", target)
	if err != nil {
		return CaptureEntry{}, err
	}
	// tmux prints one line per screen row separated by \n; xterm wants \r\n.
	ansi := strings.ReplaceAll(strings.TrimRight(out, "\n"), "\n", "\r\n")
	return CaptureEntry{
		WindowID:    w.WindowID,
		SessionName: w.SessionName,
		Index:       w.Index,
		Name:        w.Name,
		Cols:        w.Cols,
		Rows:        w.Rows,
		CapturedAt:  s.now(),
		ANSI:        []byte(ansi),
	}, nil
}
