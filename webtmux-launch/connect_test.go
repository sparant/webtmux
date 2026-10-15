package main

import (
	"bytes"
	"strings"
	"testing"
)

func testChooser(input string, interactive bool) (*chooser, *bytes.Buffer) {
	out := &bytes.Buffer{}
	return &chooser{in: strings.NewReader(input), out: out, interactive: interactive}, out
}

// Step 1: exactly one running webtmux is taken without a word.
func TestOneInstanceIsAdoptedSilently(t *testing.T) {
	c, out := testChooser("", true)
	got, err := pickInstance([]instance{{PID: 1, Port: 8080}}, 0, c)
	if err != nil || got == nil || got.Port != 8080 {
		t.Fatalf("got %+v, err %v", got, err)
	}
	if out.Len() != 0 {
		t.Errorf("asked a question it did not need to: %q", out.String())
	}
}

// Step 2: several running instances are a question, not a guess. Guessing wrong
// does not produce an error — it produces someone else's terminal.
func TestSeveralInstancesAsk(t *testing.T) {
	insts := []instance{
		{PID: 10, Port: 8080, Session: "services", UptimeSec: 7200},
		{PID: 20, Port: 8090, Session: "scratch"},
		{PID: 30, Port: 9000, Containerized: true},
	}
	c, out := testChooser("2\n", true)
	got, err := pickInstance(insts, 0, c)
	if err != nil {
		t.Fatal(err)
	}
	if got.Port != 8090 {
		t.Fatalf("picked port %d, wanted the second entry (8090)", got.Port)
	}
	menu := out.String()
	for _, want := range []string{"port 8080", "port 8090", "port 9000", "services", "up 2h", "in a container"} {
		if !strings.Contains(menu, want) {
			t.Errorf("menu lacks %q:\n%s", want, menu)
		}
	}
}

func TestInstanceChoiceRetriesThenGivesUp(t *testing.T) {
	insts := []instance{{PID: 1, Port: 1}, {PID: 2, Port: 2}}
	c, out := testChooser("banana\n9\n0\n", true)
	if _, err := pickInstance(insts, 0, c); err == nil {
		t.Fatal("expected failure after three bad answers")
	}
	if strings.Count(out.String(), "not a choice") != 3 {
		t.Errorf("should have re-prompted three times:\n%s", out.String())
	}
}

// With no terminal, asking is impossible and guessing is still wrong — so it
// fails, and names the flag that decides it. "Run it interactively" would be
// useless advice inside a script.
func TestNoTTYNamesTheFlag(t *testing.T) {
	insts := []instance{{PID: 1, Port: 8080}, {PID: 2, Port: 8090}}
	c, _ := testChooser("", false)
	_, err := pickInstance(insts, 0, c)
	if err == nil {
		t.Fatal("expected an error with no terminal")
	}
	for _, want := range []string{"--remote-port", "8080", "8090"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error lacks %q: %v", want, err)
		}
	}
}

func TestRemotePortSkipsTheQuestion(t *testing.T) {
	insts := []instance{{PID: 1, Port: 8080}, {PID: 2, Port: 8090}}
	c, out := testChooser("", false) // no tty: proves nothing was asked
	got, err := pickInstance(insts, 8090, c)
	if err != nil || got.PID != 2 {
		t.Fatalf("got %+v err %v", got, err)
	}
	if out.Len() != 0 {
		t.Errorf("asked anyway: %q", out.String())
	}
}

// Step 3: attach to what exists; create only when there is nothing to attach to.
func TestSessionSelection(t *testing.T) {
	name, existed, _ := pickSession("", &probe{})
	if name != "main" || existed {
		t.Errorf("no sessions should create main: %q existed=%v", name, existed)
	}

	one := &probe{Sessions: []string{"services"}}
	name, existed, why := pickSession("", one)
	if name != "services" || !existed || why != "" {
		t.Errorf("a single session should be used, silently: %q existed=%v why=%q", name, existed, why)
	}

	// An explicit --session wins even when it does not exist yet.
	name, existed, _ = pickSession("brand-new", one)
	if name != "brand-new" || existed {
		t.Errorf("--session ignored: %q existed=%v", name, existed)
	}
}

// Several sessions: the choice `tmux attach` makes — unattached first, then the
// most recent activity — never a prompt.
func TestSeveralSessionsPickLikeTmuxAttach(t *testing.T) {
	p := &probe{
		Sessions:        []string{"services", "claude-editors", "scratch"},
		SessionActivity: map[string]int64{"services": 300, "claude-editors": 200, "scratch": 100},
		SessionAttached: map[string]bool{"services": true},
	}
	name, existed, why := pickSession("", p)
	if name != "claude-editors" || !existed {
		t.Errorf("an unattached session beats a more recent attached one: got %q", name)
	}
	if !strings.Contains(why, "tmux attach") || !strings.Contains(why, "--session") {
		t.Errorf("the pick should say why and how to choose another: %q", why)
	}

	p.SessionAttached = map[string]bool{"services": true, "claude-editors": true, "scratch": true}
	if name, _, why := pickSession("", p); name != "services" || !strings.Contains(why, "all attached") {
		t.Errorf("all attached: the most recent wins and says so: %q (%q)", name, why)
	}

	p.SessionAttached = nil
	p.SessionActivity = map[string]int64{"services": 1, "claude-editors": 5, "scratch": 5}
	if name, _, _ := pickSession("", p); name != "claude-editors" {
		t.Errorf("a tie keeps list order: got %q", name)
	}
}

func TestSessionLineParsing(t *testing.T) {
	s, ok := parseSessionLine("4 1 1760000000 my services")
	if !ok || s.name != "my services" || s.activity != 1760000000 || !s.attached ||
		!strings.Contains(s.label, "4 windows") || !strings.Contains(s.label, "attached") {
		t.Errorf("%+v ok=%v", s, ok)
	}
	if s, ok := parseSessionLine("main"); !ok || s.name != "main" {
		t.Errorf("a bare name must still parse: %+v ok=%v", s, ok)
	}
}

// Step 4's reuse gate: an existing webtmux is only reused when we can be sure it
// is the build we expect.
func TestWebtmuxVersionMatching(t *testing.T) {
	cases := []struct {
		reported, want string
		match          bool
	}{
		{"webtmux version v0.1.0", "v0.1.0", true},
		{"v0.1.0", "v0.1.0", true},
		{"webtmux version v0.1.0", "v0.2.0", false},
		{"webtmux version dev", "v0.1.0", false},
		// "dev" on both sides is still not a match: a dev build carries no
		// identity, so "they agree" would be an illusion.
		{"webtmux version dev", "dev", false},
		// "latest" is unpinned — it could be anything, so it can never confirm.
		{"webtmux version v0.1.0", "latest", false},
		{"", "v0.1.0", false},
	}
	for _, c := range cases {
		if got := webtmuxVersionMatches(c.reported, c.want); got != c.match {
			t.Errorf("match(%q, %q) = %v, want %v", c.reported, c.want, got, c.match)
		}
	}
}
