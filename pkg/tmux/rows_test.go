package tmux

import (
	"strings"
	"testing"
)

// The per-session listings used to be comma-separated with the WINDOW NAME second
// of five and the pane's COMMAND and TITLE last of ten, split with strings.Split.
// A window called "build, test" therefore shifted window_index, window_active and
// @wt_working one field each — the sidebar highlighted the wrong current window,
// painted the wrong stoplight, and MoveWindow bubbled by the wrong index. These
// tests pin the shape that makes that impossible.

func TestParseWindowRows(t *testing.T) {
	out := strings.Join([]string{
		"@0|0|1|1|shell",
		"@1|3|0||build",
		"@7|9|0|2|", // an empty window name still yields a full row
	}, "\n")
	wins := parseWindowRows(out)
	if len(wins) != 3 {
		t.Fatalf("want 3 windows, got %d: %+v", len(wins), wins)
	}
	if wins[0].ID != "@0" || wins[0].Index != 0 || !wins[0].Active ||
		wins[0].Working != "1" || wins[0].Name != "shell" {
		t.Errorf("bad row: %+v", wins[0])
	}
	if wins[1].Index != 3 || wins[1].Active || wins[1].Working != "" || wins[1].Name != "build" {
		t.Errorf("bad row: %+v", wins[1])
	}
	if wins[2].Working != "2" || wins[2].Name != "" {
		t.Errorf("bad row: %+v", wins[2])
	}
}

func TestParseWindowRowsNameWithSeparators(t *testing.T) {
	// The Phase 4 smoke window: commas AND pipes, in the field that used to sit
	// second. Everything the layout is computed from must survive it.
	wins := parseWindowRows("@4|2|1|1|a, b | c\n")
	if len(wins) != 1 {
		t.Fatalf("want 1 window, got %+v", wins)
	}
	w := wins[0]
	if w.ID != "@4" || w.Index != 2 || !w.Active || w.Working != "1" || w.Name != "a, b | c" {
		t.Errorf("separators corrupted the row: %+v", w)
	}
}

func TestParseWindowRowsSkipsShortRows(t *testing.T) {
	// A truncated row is dropped rather than half-parsed: a window with index 0 it
	// never had is a select-window aimed at the wrong window.
	wins := parseWindowRows("@0|0|1\n@1|1|0||ok\n\n")
	if len(wins) != 1 || wins[0].ID != "@1" {
		t.Errorf("want only the well-formed row, got %+v", wins)
	}
	if got := parseWindowRows(""); len(got) != 0 {
		t.Errorf("empty listing must yield nothing, got %+v", got)
	}
}

func TestParsePaneRows(t *testing.T) {
	panes := parsePaneRows("%0|0|1|0|80|24|0|0|bash|~/src\n%1|1|0|1|80|12|24|0|nvim|main.go\n")
	if len(panes) != 2 {
		t.Fatalf("want 2 panes, got %+v", panes)
	}
	p := panes[0]
	if p.ID != "%0" || p.Index != 0 || !p.Active || p.InMode ||
		p.Width != 80 || p.Height != 24 || p.Top != 0 || p.Left != 0 ||
		p.Command != "bash" || p.Title != "~/src" {
		t.Errorf("bad pane: %+v", p)
	}
	if !panes[1].InMode || panes[1].Top != 24 || panes[1].Title != "main.go" {
		t.Errorf("bad pane: %+v", panes[1])
	}
}

func TestParsePaneRowsTitleWithSeparators(t *testing.T) {
	// pane_title is whatever the running program last wrote with an OSC escape —
	// a shell prompt title routinely carries '|'. It takes the LAST slot, so the
	// geometry the split layout is drawn from can't be shifted by it.
	panes := parsePaneRows("%2|0|1|0|100|30|0|0|zsh|user@host: ~/w | tmux | 3 jobs\n")
	if len(panes) != 1 {
		t.Fatalf("want 1 pane, got %+v", panes)
	}
	p := panes[0]
	if p.Width != 100 || p.Height != 30 || p.Command != "zsh" ||
		p.Title != "user@host: ~/w | tmux | 3 jobs" {
		t.Errorf("separators corrupted the pane: %+v", p)
	}
}

func TestParsePaneRowsSkipsShortRows(t *testing.T) {
	panes := parsePaneRows("%0|0|1|0|80|24\n%1|0|1|0|80|24|0|0|bash|t\n")
	if len(panes) != 1 || panes[0].ID != "%1" {
		t.Errorf("want only the well-formed row, got %+v", panes)
	}
}

func TestParseSessionIdent(t *testing.T) {
	// The old format was "#{session_id},#{session_name}" split on every ',' with
	// the name taken from field 1: a session called "a, b" reported itself as "a",
	// and every name comparison in the UI (SessionBase, the active tab) missed.
	id, name, ok := parseSessionIdent("$3|a, b | c\n")
	if !ok || id != "$3" || name != "a, b | c" {
		t.Errorf("parseSessionIdent = %q, %q, %v", id, name, ok)
	}
	if _, _, ok := parseSessionIdent("$3\n"); ok {
		t.Error("a row without a name must not parse")
	}
	if _, _, ok := parseSessionIdent(""); ok {
		t.Error("empty output must not parse")
	}
}

func TestParseSessionEmptiness(t *testing.T) {
	rows := []sessionRow{
		{id: "$0", name: "services"},
		{id: "$1", name: "ops | staging"},
		{id: "$2", name: "busy"},
		{id: "$9", name: "web-abc", grouped: true},
	}
	// services: one idle shell => empty. "ops | staging": one login shell => empty
	// (and its name must not be truncated at the '|', which used to make it a
	// different, always-empty session). busy: a shell AND a program => not empty.
	// The web-* shadow mirrors services' panes and must not be counted at all.
	out := strings.Join([]string{
		"$0|bash",
		"$1|-zsh",
		"$2|bash",
		"$2|nvim",
		"$9|bash",
		"$77|bash", // a session list-sessions doesn't know about
	}, "\n")
	empty := parseSessionEmptiness(out, rows)

	if !empty["services"] {
		t.Error("a lone idle shell must read as empty")
	}
	if !empty["ops | staging"] {
		t.Errorf("a session name containing the separator lost its panes: %+v", empty)
	}
	if empty["busy"] {
		t.Error("a session running a program is not empty")
	}
	if _, ok := empty["web-abc"]; ok {
		t.Errorf("a grouped shadow must not appear: %+v", empty)
	}
	if len(empty) != 3 {
		t.Errorf("unexpected sessions in the emptiness map: %+v", empty)
	}
}
