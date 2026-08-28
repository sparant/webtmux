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
	got := buildSessions(rows, "web-abc123", nil, nil) // a split viewing services

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
	got := buildSessions(rows, "services", nil, nil)
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
	got := buildSessions(rows, "services", empty, nil)
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

// --- per-session new-window menu ---------------------------------------------

func TestParseSessionCmds(t *testing.T) {
	// Three fields per line: id | menu JSON | legacy single command. The menu is
	// JSON precisely so a command containing the field separator survives.
	// Built through the encoder, not by hand: the encoding is what makes a command
	// containing the field separator survive this line at all.
	menu, err := encodeNewCmds([]NewCmd{{Label: "tail", Cmd: "tail -F log | grep -i error"}})
	if err != nil {
		t.Fatalf("encodeNewCmds: %v", err)
	}
	out := "$0|" + menu + "|\n" +
		"$1||legacy.sh\n" + // no menu: the legacy option is adopted
		"$2||\n" // neither
	menus := parseSessionCmds(out)
	if len(menus["$0"]) != 1 || menus["$0"][0].Cmd != "tail -F log | grep -i error" {
		t.Errorf("menu with a separator in it was mangled: %+v", menus["$0"])
	}
	if menus["$0"][0].Label != "tail" {
		t.Errorf("label lost: %+v", menus["$0"])
	}
	if len(menus["$1"]) != 1 || menus["$1"][0].Cmd != "legacy.sh" {
		t.Errorf("legacy single command not adopted: %+v", menus["$1"])
	}
	if _, ok := menus["$2"]; ok {
		t.Errorf("a session with neither should be absent, not empty: %v", menus)
	}
}

func TestParseSessionCmdsDropsJunk(t *testing.T) {
	// A tmux too old to expand #{@user} options echoes the format back; adopting it
	// would later TYPE it into a shell. A line with too few fields belongs to no
	// session (an option value containing a newline arrives as extra lines).
	menus := parseSessionCmds("$0||#{@wt_newcmd}\n$1|[{\"cmd\":\"real.sh\"}]|\nstray tail\n")
	if _, ok := menus["$0"]; ok {
		t.Errorf("unexpanded format was adopted as a command: %+v", menus["$0"])
	}
	if len(menus["$1"]) != 1 || menus["$1"][0].Cmd != "real.sh" {
		t.Errorf("good row lost: %+v", menus["$1"])
	}
	if len(menus) != 1 {
		t.Errorf("want exactly the one good row, got %v", menus)
	}
}

func TestBuildSessionsCarriesTheMenu(t *testing.T) {
	rows := parseSessionRows(sessionsFixture)
	got := buildSessions(rows, "services", nil, map[string][]NewCmd{
		"$0": {{Label: "claude", Cmd: "launch_new.sh"}},
	})
	for _, s := range got {
		if s.Name == "services" && (len(s.NewCmds) != 1 || s.NewCmds[0].Label != "claude") {
			t.Errorf("services lost its menu: %+v", s)
		}
		if s.Name == "other" && len(s.NewCmds) != 0 {
			t.Errorf("a session with no menu got one: %+v", s)
		}
	}
}

func TestNextSessionName(t *testing.T) {
	cases := []struct {
		base  string
		taken []string
		want  string
	}{
		{"editors", nil, "editors (1)"},
		{"editors", []string{"editors (1)"}, "editors (2)"},
		{"editors", []string{"editors (1)", "editors (2)"}, "editors (3)"},
		// Deriving from an already-derived session must not nest the suffix.
		{"editors (1)", []string{"editors (1)"}, "editors (2)"},
		// A gap is filled, not skipped past.
		{"editors", []string{"editors (2)"}, "editors (1)"},
		// Parenthesised text that is not an index is part of the name.
		{"editors (old)", nil, "editors (old) (1)"},
		{"", nil, ""},
	}
	for _, c := range cases {
		taken := make(map[string]bool)
		for _, n := range c.taken {
			taken[n] = true
		}
		if got := nextSessionName(c.base, taken); got != c.want {
			t.Errorf("nextSessionName(%q, %v) = %q, want %q", c.base, c.taken, got, c.want)
		}
	}
}

func TestStripSessionIndex(t *testing.T) {
	cases := map[string]string{
		"editors (1)":   "editors",
		"editors (12)":  "editors",
		"editors":       "editors",
		"editors (a)":   "editors (a)",
		"editors ()":    "editors ()",
		"(1)":           "(1)",
		"editors (1) x": "editors (1) x",
	}
	for in, want := range cases {
		if got := stripSessionIndex(in); got != want {
			t.Errorf("stripSessionIndex(%q) = %q, want %q", in, got, want)
		}
	}
}
