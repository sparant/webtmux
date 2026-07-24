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

// CaptureEntry is a color-preserving snapshot of ONE window's active pane AS SEEN
// FROM one session (a "placement"). A window linked into several real sessions
// produces one entry per session — same screen, but each carrying that session's
// name and the window's index WITHIN it. Ephemeral web-* grouped shadows collapse
// onto their base, so a split's grouped sessions add no extra entries.
type CaptureEntry struct {
	WindowID    string
	SessionName string // the placement's session (a real session, not a web-* shadow)
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

// WindowInfo is one (session, window) placement from EnumerateWindows: everything
// needed to capture the window (active pane id + dims) plus this session's label
// metadata (session name + the window's index within that session).
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

	mu sync.Mutex
	// byWindow caches the latest SCREEN per window_id (the coalescing key). A window
	// has one screen regardless of how many sessions it's placed in, so the cache
	// stays keyed by window_id; the per-session placements are built on top of it in
	// CaptureWindows. The SessionName/Index on a cached entry are just whichever
	// placement captured it and are overridden per placement on the way out.
	byWindow map[string]CaptureEntry
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

// enumSep separates fields in the list-windows format. tmux SANITIZES all
// control bytes (tab, \x1f, \x01, …) to '_' in -F output, so a non-printable
// separator is impossible — we use '|' and put the only user-arbitrary field
// (window_name) LAST, parsed with SplitN, so a '|' typed into a window name
// can't break the split. session_name is program-generated here and never
// contains '|'; the remaining fields are @/%-ids and integers.
const enumSep = "|"
const enumFields = 7

// EnumerateWindows lists every window across every session on the server
// (`list-windows -a`) and returns one WindowInfo per (session, window) PLACEMENT:
// a window LINKED into services + mywork yields TWO entries (one per real session,
// each with its own window index), so Exposé can show — and navigate to — each.
//
// Ephemeral web-* grouped split shadows mirror their base session's window list, so
// they never add a placement (they'd just duplicate the base). The one exception is
// a window that appears ONLY under web-* sessions — vanishingly rare, since grouped
// sessions mirror a base that is itself always listed — where a single collapsed
// placement is kept so the window isn't lost.
//
// This is the "every window across all sessions, one tile per placement" source of
// truth for both Exposé and "all"-window capture requests.
func (s *CaptureStore) EnumerateWindows() ([]WindowInfo, error) {
	// Field order: id | session | index | pane_id | cols | rows | name(LAST).
	format := strings.Join([]string{
		"#{window_id}", "#{session_name}", "#{window_index}",
		"#{pane_id}", "#{pane_width}", "#{pane_height}", "#{window_name}",
	}, enumSep)

	out, err := s.run("list-windows", "-a", "-F", format)
	if err != nil {
		return nil, err
	}

	// Parse every row first, so we can decide the web-* fallback knowing whether a
	// window has ANY real-session placement (a real placement may be listed after a
	// window's web-* line).
	type row struct {
		info  WindowInfo
		isWeb bool
	}
	var rows []row
	hasReal := make(map[string]bool) // window_id -> has a non-web placement somewhere
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if line == "" {
			continue
		}
		f := strings.SplitN(line, enumSep, enumFields)
		if len(f) < enumFields {
			continue
		}
		idx, _ := strconv.Atoi(f[2])
		cols, _ := strconv.Atoi(f[4])
		rowsN, _ := strconv.Atoi(f[5])
		info := WindowInfo{
			WindowID:    f[0],
			SessionName: f[1],
			Index:       idx,
			Name:        f[6],
			PaneID:      f[3],
			Cols:        cols,
			Rows:        rowsN,
		}
		isWeb := strings.HasPrefix(f[1], "web-")
		if !isWeb {
			hasReal[f[0]] = true
		}
		rows = append(rows, row{info: info, isWeb: isWeb})
	}

	var wins []WindowInfo
	seen := make(map[string]bool)    // "session\x00window_id" -> real placement emitted
	webFallback := make(map[string]bool) // window_id -> web-only fallback emitted
	for _, r := range rows {
		if r.isWeb {
			// A shadow placement only survives if the window has no real session
			// anywhere (else the real placement(s) cover it); keep just one.
			if hasReal[r.info.WindowID] || webFallback[r.info.WindowID] {
				continue
			}
			webFallback[r.info.WindowID] = true
			wins = append(wins, r.info)
			continue
		}
		key := r.info.SessionName + "\x00" + r.info.WindowID
		if seen[key] {
			continue
		}
		seen[key] = true
		wins = append(wins, r.info)
	}
	return wins, nil
}

// CaptureWindows refreshes and returns capture entries for the requested windows,
// ONE per (session, window) placement (a linked window yields an entry per session).
// windowIDs==nil (or empty) means "all placements". `force` bypasses the freshness
// coalescing. Read-only: it only runs list-windows + capture-pane and never touches
// the active pane, so it is safe against any window at any time.
//
// A window's SCREEN is captured at most once per call even when it has several
// placements (they share the same panes); each placement then carries that shared
// screen with its OWN session name + window index.
func (s *CaptureStore) CaptureWindows(windowIDs []string, force bool) ([]CaptureEntry, error) {
	placements, err := s.EnumerateWindows()
	if err != nil {
		return nil, err
	}

	// Which window_ids are we returning? nil request => all placements.
	wantAll := len(windowIDs) == 0
	want := make(map[string]bool, len(windowIDs))
	for _, id := range windowIDs {
		want[id] = true
	}

	now := s.now()
	captured := make(map[string]CaptureEntry) // window_id -> screen captured this call
	var out []CaptureEntry
	for _, p := range placements {
		if !wantAll && !want[p.WindowID] {
			continue
		}

		// Resolve the window's screen once per call (then reuse it for every
		// placement of the same window).
		content, ok := captured[p.WindowID]
		if !ok {
			// Coalesce: reuse a still-fresh cached screen unless forced.
			if !force {
				s.mu.Lock()
				cached, hit := s.byWindow[p.WindowID]
				s.mu.Unlock()
				if hit && now.Sub(cached.CapturedAt) < CaptureFreshnessTTL {
					content = cached
					ok = true
				}
			}
			if !ok {
				entry, err := s.captureOne(p)
				if err != nil {
					// Skip an unreadable window (e.g. it vanished mid-enumeration)
					// but still serve the rest — a partial mosaic beats a failure.
					continue
				}
				s.mu.Lock()
				s.byWindow[p.WindowID] = entry
				s.mu.Unlock()
				content = entry
			}
			captured[p.WindowID] = content
		}

		// Emit THIS placement: the shared screen + this session's name/index.
		out = append(out, CaptureEntry{
			WindowID:    p.WindowID,
			SessionName: p.SessionName,
			Index:       p.Index,
			Name:        p.Name,
			Cols:        content.Cols,
			Rows:        content.Rows,
			CapturedAt:  content.CapturedAt,
			ANSI:        content.ANSI,
		})
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
