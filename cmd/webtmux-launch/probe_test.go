package main

import (
	"strings"
	"testing"
)

const sampleProbe = `Welcome to Ubuntu! motd noise here
WTL_OS=Linux
WTL_ARCH=x86_64
WTL_HOME=/home/dev
WTL_USER=dev
WTL_TMUX=/usr/bin/tmux
WTL_TMUXVER=tmux 3.4
WTL_DISTRO=debian
WTL_CACHE=webtmux-abc123def456
WTL_CACHE=attach-0011223344.sh
WTL_SESSION=main
WTL_SESSION=scratch
WTL_LINGER=no
WTL_KILLUSER=KillUserProcesses=yes
WTL_SELFPIDNS=pid:[4026531836]
WTL_PID=4242
WTL_CMDLINE=4242 /home/dev/.cache/webtmux/webtmux-abc123def456 -w -a 127.0.0.1 -p 8099 --path /sekrit/ --no-auth /home/dev/.cache/webtmux/attach.sh
WTL_ENVIRON=4242 WEBTMUX_SESSION=main
WTL_EXESHA=4242 ` + "aa" + `
WTL_PIDNS=4242 pid:[4026531836]
WTL_ETIME=4242 7200
`

func TestParseProbe(t *testing.T) {
	p := parseProbe(sampleProbe)
	if p.OS != "Linux" || p.Arch != "x86_64" || p.Home != "/home/dev" {
		t.Fatalf("basics wrong: %+v", p)
	}
	if p.TmuxPath != "/usr/bin/tmux" || p.DistroID != "debian" {
		t.Fatalf("tmux/distro wrong: %+v", p)
	}
	if len(p.Sessions) != 2 || p.Sessions[0] != "main" {
		t.Fatalf("sessions: %v", p.Sessions)
	}
	if !p.hasCached("webtmux-abc123def456") || p.hasCached("webtmux-nope") {
		t.Fatalf("cache listing: %v", p.CacheDirs)
	}
	if len(p.Instances) != 1 {
		t.Fatalf("instances: %+v", p.Instances)
	}
	i := p.Instances[0]
	if i.PID != 4242 || i.Port != 8099 || i.Address != "127.0.0.1" || i.Path != "/sekrit/" {
		t.Fatalf("instance parse: %+v", i)
	}
	if !i.NoAuth || i.Session != "main" || i.UptimeSec != 7200 {
		t.Fatalf("instance parse 2: %+v", i)
	}
	if i.Containerized {
		t.Fatalf("same pid namespace must not read as containerized")
	}
}

func TestProbeDurabilityWarningIsAdvisory(t *testing.T) {
	p := parseProbe(sampleProbe)
	w := p.durabilityWarning()
	if w == "" {
		t.Fatal("KillUserProcesses=yes with no linger should warn")
	}
	// Least-imposing option first: never lead with enable-linger.
	if strings.Index(w, "run a webtmux yourself") > strings.Index(w, "enable-linger") {
		t.Errorf("options are in the wrong order:\n%s", w)
	}

	p.Linger = "yes"
	if p.durabilityWarning() != "" {
		t.Error("lingering enabled should silence the warning")
	}
	p.Linger = "no"
	p.KillUser = ""
	if p.durabilityWarning() != "" {
		t.Error("no KillUserProcesses setting should silence the warning")
	}
}

func TestPlatformMapping(t *testing.T) {
	cases := map[[2]string]string{
		{"Linux", "x86_64"}:  "linux-amd64",
		{"Linux", "aarch64"}: "linux-arm64",
		{"Linux", "armv7l"}:  "linux-arm",
		{"Darwin", "arm64"}:  "darwin-arm64",
		{"Darwin", "x86_64"}: "darwin-amd64",
		{"FreeBSD", "amd64"}: "freebsd-amd64",
	}
	for in, want := range cases {
		got, err := platformFor(in[0], in[1])
		if err != nil {
			t.Errorf("%v: %v", in, err)
			continue
		}
		if got != want {
			t.Errorf("%v = %s, want %s", in, got, want)
		}
	}
	// An unknown arch must name the assets that DO exist — a wrong mapping
	// otherwise surfaces as an opaque 404 at download time.
	if _, err := platformFor("Linux", "sparc64"); err == nil {
		t.Error("expected an error for sparc64")
	} else if !strings.Contains(err.Error(), "linux-amd64") {
		t.Errorf("error does not list published platforms: %v", err)
	}
	// A platform we do not publish for is refused up front, not at 404 time.
	if _, err := platformFor("Linux", "i686"); err == nil {
		t.Error("expected an error for linux-386, which no release publishes")
	}
}

func TestTmuxInstallHint(t *testing.T) {
	if got := tmuxInstallHint("fedora"); !strings.Contains(got, "dnf") {
		t.Errorf("fedora hint: %s", got)
	}
	if got := tmuxInstallHint("weirdos"); !strings.Contains(got, "weirdos") {
		t.Errorf("unknown distro hint should still name it: %s", got)
	}
}

func TestContainerizedInstanceSoftensReporting(t *testing.T) {
	out := strings.ReplaceAll(sampleProbe, "WTL_PIDNS=4242 pid:[4026531836]", "WTL_PIDNS=4242 pid:[4026532999]")
	out = strings.ReplaceAll(out, "-a 127.0.0.1", "-a 0.0.0.0")
	out += "WTL_CGROUP=4242 0::/docker/9f8e7d6c5b4a3210deadbeef\n"
	p := parseProbe(out)
	i := p.Instances[0]
	if !i.Containerized {
		t.Fatal("a different pid namespace must read as containerized")
	}
	if i.Container != "9f8e7d6c5b4a" {
		t.Errorf("container id = %q", i.Container)
	}
	report := strings.Join(i.report("differs"), "\n")
	if strings.Contains(report, "WARNING: bound to") {
		t.Errorf("container-relative bind must not raise the exposure warning:\n%s", report)
	}
	if !strings.Contains(report, "container-relative") {
		t.Errorf("report should explain the softening:\n%s", report)
	}
}
