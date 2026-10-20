package main

import (
	"context"
	"os/user"
	"strings"
	"testing"
)

// This machine, spelled any of the ways a user would, runs without SSH. Every
// form that might mean something else to ssh stays an SSH target.
func TestIsLocalTarget(t *testing.T) {
	me, err := user.Current()
	if err != nil {
		t.Skip("no current user")
	}
	local := []string{"", "localhost", "LOCALHOST", "127.0.0.1", "127.0.1.1", "::1", "[::1]",
		me.Username + "@localhost", "ssh://localhost", "ssh://127.0.0.1:22", "ssh://[::1]",
		"ssh://" + me.Username + "@localhost"}
	for _, tgt := range local {
		if !isLocalTarget(tgt) {
			t.Errorf("%q should be local", tgt)
		}
	}
	remote := []string{"linuxbox", "203.0.113.10", "you@203.0.113.10",
		"ssh://localhost:2222", "ssh://127.0.0.1:38242", "not-" + me.Username + "@localhost",
		"ssh://not-" + me.Username + "@127.0.0.1"}
	for _, tgt := range remote {
		if isLocalTarget(tgt) {
			t.Errorf("%q should go over SSH", tgt)
		}
	}
}

func TestParseArgsWithoutTarget(t *testing.T) {
	o, err := parseArgs([]string{"--no-browser"})
	if err != nil || o.target != "" || len(o.tmuxArgs) != 0 {
		t.Fatalf("no target should mean this machine: %+v %v", o, err)
	}
	o, err = parseArgs([]string{"--", "htop"})
	if err != nil || o.target != "" || strings.Join(o.tmuxArgs, " ") != "htop" {
		t.Fatalf("`-- cmd` with no target: %+v %v", o, err)
	}
	o, err = parseArgs([]string{"box", "--", "htop"})
	if err != nil || o.target != "box" || strings.Join(o.tmuxArgs, " ") != "htop" {
		t.Fatalf("target then args: %+v %v", o, err)
	}
	if _, err := parseArgs([]string{"--ssh"}); err == nil {
		t.Fatal("--ssh with no target must be refused")
	}
}

// The local runner runs commands with sh, starts them in $HOME and strips the
// TMUX the launcher may have inherited (the attach script would refuse to nest).
func TestLocalRunnerRunsWithoutSSH(t *testing.T) {
	t.Setenv("TMUX", "/tmp/tmux-1/default,1,0")
	r := newLocalRunner(false)
	out, _, err := r.Run(context.Background(), `printf '%s|%s' "${TMUX-unset}" "$(pwd)"`)
	if err != nil {
		t.Fatal(err)
	}
	if out != "unset|"+homeDir() {
		t.Errorf("got %q", out)
	}
	if _, err := r.RunWithStdin(context.Background(), `read x; [ "$x" = hi ]`, strings.NewReader("hi\n")); err != nil {
		t.Errorf("stdin not delivered: %v", err)
	}
	cmd := r.TunnelCommand(context.Background(), 1, 2, "true")
	if strings.Contains(strings.Join(cmd.Args, " "), "ssh") || strings.Contains(strings.Join(cmd.Args, " "), "-L") {
		t.Errorf("local tunnel command must not ssh or forward: %v", cmd.Args)
	}
}

func TestDirectLineSaysThereIsNoTunnel(t *testing.T) {
	l := directLine(4242, "restarts")
	for _, want := range []string{"tunnel: none", "127.0.0.1:4242 on this machine", "every 5s", "restarts"} {
		if !strings.Contains(l, want) {
			t.Errorf("direct line lacks %q: %s", want, l)
		}
	}
}
