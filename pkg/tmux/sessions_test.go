package tmux

import "testing"

// list-sessions fixture: base "services" grouped with two web shadows, one
// standalone "other" session, one grouped pair of real sessions.
const sessionsFixture = `$0|5|1|1|grp0|services
$3|5|1|1|grp0|web-abc123
$4|5|1|1|grp0|web-h99
$1|2|0|0||other
$5|3|1|1|grp1|dev
$6|3|1|1|grp1|dev-mirror
`

func TestParseSessionRows(t *testing.T) {
	rows := parseSessionRows(sessionsFixture)
	if len(rows) != 6 {
		t.Fatalf("want 6 rows, got %d", len(rows))
	}
	if rows[0].name != "services" || rows[0].windows != 5 || !rows[0].grouped || rows[0].group != "grp0" {
		t.Errorf("bad first row: %+v", rows[0])
	}
	if rows[3].name != "other" || rows[3].grouped || rows[3].attached {
		t.Errorf("bad standalone row: %+v", rows[3])
	}
}

func TestParseSessionRowsNameWithSeparator(t *testing.T) {
	rows := parseSessionRows("$9|1|1|0||odd|name\n")
	if len(rows) != 1 || rows[0].name != "odd|name" {
		t.Fatalf("name-with-separator not preserved: %+v", rows)
	}
}

func TestLogicalBase(t *testing.T) {
	rows := parseSessionRows(sessionsFixture)
	cases := []struct{ cur, want string }{
		{"web-abc123", "services"}, // shadow -> group base
		{"web-h99", "services"},    // self-heal shadow -> group base
		{"services", "services"},   // base of its own group
		{"other", "other"},         // ungrouped -> itself
		{"dev", "dev"},             // grouped real session -> first non-web member
		{"missing", "missing"},     // unknown session -> itself
	}
	for _, c := range cases {
		if got := logicalBase(rows, c.cur); got != c.want {
			t.Errorf("logicalBase(%q) = %q, want %q", c.cur, got, c.want)
		}
	}
}

func TestBuildSessionsHidesShadowsAndMarksGroupActive(t *testing.T) {
	rows := parseSessionRows(sessionsFixture)
	got := buildSessions(rows, "web-abc123", nil) // a split viewing services

	names := map[string]Session{}
	for _, s := range got {
		names[s.Name] = s
	}
	if _, ok := names["web-abc123"]; ok {
		t.Error("web shadow session leaked into the UI list")
	}
	if _, ok := names["web-h99"]; ok {
		t.Error("web-h shadow session leaked into the UI list")
	}
	if !names["services"].Active {
		t.Error("group base not marked active for a shadow-session pane")
	}
	if names["other"].Active || names["dev"].Active {
		t.Error("unrelated sessions marked active")
	}
}

func TestBuildSessionsPrimary(t *testing.T) {
	rows := parseSessionRows(sessionsFixture)
	got := buildSessions(rows, "services", nil)
	for _, s := range got {
		if s.Name == "services" && !s.Active {
			t.Error("primary's own session not active")
		}
		if s.Name == "other" && s.Active {
			t.Error("other session wrongly active")
		}
	}
}

func TestBuildSessionsMarksEmpty(t *testing.T) {
	rows := parseSessionRows(sessionsFixture)
	empty := map[string]bool{"other": true} // only "other" is an idle-shell session
	got := buildSessions(rows, "services", empty)
	for _, s := range got {
		want := s.Name == "other"
		if s.Empty != want {
			t.Errorf("session %q Empty = %v, want %v", s.Name, s.Empty, want)
		}
	}
}

func TestIsShellCommand(t *testing.T) {
	for _, cmd := range []string{"bash", "zsh", "-bash", "fish", "sh"} {
		if !isShellCommand(cmd) {
			t.Errorf("isShellCommand(%q) = false, want true", cmd)
		}
	}
	for _, cmd := range []string{"vim", "node", "ssh", "claude", ""} {
		if isShellCommand(cmd) {
			t.Errorf("isShellCommand(%q) = true, want false", cmd)
		}
	}
}
