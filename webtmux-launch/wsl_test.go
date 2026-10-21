package main

import (
	"context"
	"strings"
	"testing"
)

// `wsl` and `wsl:<distro>` are WSL targets on Windows only; anywhere else they
// are host names, and ssh must get them untouched.
func TestParseWSLTarget(t *testing.T) {
	for _, c := range []struct {
		target, distro string
		ok             bool
	}{
		{"wsl", "", true},
		{"WSL", "", true},
		{"wsl:Ubuntu-24.04", "Ubuntu-24.04", true},
		{"wslbox", "", false},
		{"you@wsl", "", false},
		{"", "", false},
	} {
		d, ok := parseWSLTarget("windows", c.target)
		if ok != c.ok || d != c.distro {
			t.Errorf("%q: got (%q, %v), want (%q, %v)", c.target, d, ok, c.distro, c.ok)
		}
	}
	if _, ok := parseWSLTarget("darwin", "wsl"); ok {
		t.Error(`"wsl" off Windows is an ssh target, not WSL`)
	}
}

// A WSL runner is a local runner (no tunnel, one port) whose commands go
// through wsl.exe, starting in the distro user's home, never through ssh.
func TestWSLRunnerCommand(t *testing.T) {
	r := newWSLRunner("Debian", false)
	if !r.local || r.where() != "WSL" || r.target != "wsl:Debian" {
		t.Fatalf("runner: %+v", r)
	}
	cmd := r.command(context.Background(), nil, "uname -s")
	got := strings.Join(cmd.Args[1:], " ")
	if got != "-d Debian --cd ~ -e /bin/sh -c uname -s" {
		t.Errorf("wsl argv: %q", got)
	}
	if !strings.Contains(strings.ToLower(cmd.Args[0]), "wsl") {
		t.Errorf("not run through wsl.exe: %v", cmd.Args)
	}
	if strings.Join(wslArgs("", "x"), " ") != "--cd ~ -e /bin/sh -c x" {
		t.Error("default distro must pass no -d")
	}
}

// Windows' OpenSSH has no multiplexing: a ControlMaster option there fails the
// connection, so a no-mux runner must not emit one — and must still keep alive.
func TestNoMuxOmitsControlMaster(t *testing.T) {
	r := newSSHRunner("box", false)
	r.noMux = true
	args := strings.Join(r.baseArgs(), " ")
	if strings.Contains(args, "ControlMaster") || strings.Contains(args, "ControlPath") {
		t.Errorf("no-mux args carry mux options: %s", args)
	}
	if !strings.Contains(args, "ServerAliveInterval=5") {
		t.Errorf("no-mux args lost the keepalives: %s", args)
	}
	r.noMux = false
	if !strings.Contains(strings.Join(r.baseArgs(), " "), "ControlMaster=auto") {
		t.Error("mux runner lost ControlMaster=auto")
	}
}

func TestInstallHints(t *testing.T) {
	if h := tmuxInstallHint("Darwin", ""); !strings.Contains(h, "brew install tmux") || !strings.Contains(h, "brew.sh") {
		t.Errorf("macOS tmux hint: %s", h)
	}
	if h := tmuxInstallHint("FreeBSD", ""); !strings.Contains(h, "pkg install tmux") {
		t.Errorf("FreeBSD tmux hint: %s", h)
	}
	if h := sshInstallHint("windows"); !strings.Contains(h, "OpenSSH.Client") || !strings.Contains(h, "Optional features") {
		t.Errorf("windows ssh hint: %s", h)
	}
	if e := nativeWindowsError().Error(); !strings.Contains(e, "wsl --install") || !strings.Contains(e, "webtmux-launch wsl") {
		t.Errorf("native windows error: %s", e)
	}
}

func TestWSLBrowserCommands(t *testing.T) {
	cmds := wslBrowserCommands("http://127.0.0.1:1/")
	last := cmds[len(cmds)-1]
	if strings.Join(last, " ") != "cmd.exe /c start  http://127.0.0.1:1/" {
		t.Errorf("start needs an empty title before the URL: %q", last)
	}
}
