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
	c, _ := testChooser("", true)

	name, existed, err := pickSession("", &probe{}, c)
	if err != nil || name != "main" || existed {
		t.Errorf("no sessions should create main: %q existed=%v err=%v", name, existed, err)
	}

	one := &probe{Sessions: []string{"services"}}
	name, existed, err = pickSession("", one, c)
	if err != nil || name != "services" || !existed {
		t.Errorf("a single session should be used: %q existed=%v err=%v", name, existed, err)
	}

	// An explicit --session wins even when it does not exist yet.
	name, existed, err = pickSession("brand-new", one, c)
	if err != nil || name != "brand-new" || existed {
		t.Errorf("--session ignored: %q existed=%v err=%v", name, existed, err)
	}
}

func TestSeveralSessionsAsk(t *testing.T) {
	p := &probe{
		Sessions:      []string{"services", "scratch"},
		SessionLabels: map[string]string{"services": "services (4 windows) — attached", "scratch": "scratch (1 window)"},
	}
	c, out := testChooser("1\n", true)
	name, existed, err := pickSession("", p, c)
	if err != nil || name != "services" || !existed {
		t.Fatalf("got %q existed=%v err=%v", name, existed, err)
	}
	if !strings.Contains(out.String(), "4 windows") || !strings.Contains(out.String(), "attached") {
		t.Errorf("the menu should carry enough to choose by:\n%s", out.String())
	}
	c, _ = testChooser("", false)
	if _, _, err := pickSession("", p, c); err == nil || !strings.Contains(err.Error(), "--session") {
		t.Errorf("no-tty error should name --session: %v", err)
	}
}

func TestSessionLineParsing(t *testing.T) {
	name, label, ok := parseSessionLine("4 1 services")
	if !ok || name != "services" || !strings.Contains(label, "4 windows") || !strings.Contains(label, "attached") {
		t.Errorf("name=%q label=%q ok=%v", name, label, ok)
	}
	// A name with spaces survives, because it is the LAST field.
	name, _, _ = parseSessionLine("2 0 my project")
	if name != "my project" {
		t.Errorf("name with spaces mangled: %q", name)
	}
	// Singular reads correctly.
	if _, label, _ = parseSessionLine("1 0 solo"); strings.Contains(label, "1 windows") {
		t.Errorf("label should say 1 window: %q", label)
	}
	if _, _, ok := parseSessionLine(""); ok {
		t.Error("empty line should not produce a session")
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
