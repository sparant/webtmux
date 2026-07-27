package main

// The probe: ONE round trip that answers everything the cold start needs.
//
// Everything here is cached for the process lifetime. A reconnect re-runs none
// of it — the whole point of the disposable-webtmux design is that a dropped
// connection costs one ssh handshake, not a re-probe (risk 13).

import (
	"context"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// probe is the parsed result of one probeScript run.
type probe struct {
	OS        string // uname -s
	Arch      string // uname -m
	Platform  string // release asset platform, e.g. linux-amd64
	Home      string
	User      string
	TmuxPath  string
	TmuxVer   string
	DistroID  string // /etc/os-release ID, for the install hint
	Sessions  []string
	CacheDirs []string // ~/.cache/webtmux entries, newest first
	Linger    string   // loginctl Linger
	KillUser  string   // logind.conf KillUserProcesses line, if set
	SelfPIDNS string
	Instances []instance
}

// probeScript is deliberately POSIX sh and tolerant of a missing /proc, missing
// pgrep, missing loginctl and missing tmux. Every line it emits is prefixed so
// a login banner, a motd, or a chatty rc file cannot confuse the parser.
const probeScript = `
p() { printf 'WTL_%s=%s\n' "$1" "$2"; }
p OS "$(uname -s)"
p ARCH "$(uname -m)"
p HOME "$HOME"
p USER "$(id -un 2>/dev/null)"
p TMUX "$(command -v tmux 2>/dev/null || true)"
p TMUXVER "$(tmux -V 2>/dev/null || true)"
p DISTRO "$(. /etc/os-release 2>/dev/null; echo "${ID:-}")"
for f in $(ls -t "$HOME/.cache/webtmux" 2>/dev/null); do p CACHE "$f"; done
tmux list-sessions -F '#{session_name}' 2>/dev/null | while read -r s; do p SESSION "$s"; done
p LINGER "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || true)"
p KILLUSER "$(grep -hs '^[[:space:]]*KillUserProcesses' /etc/systemd/logind.conf /etc/systemd/logind.conf.d/*.conf 2>/dev/null | tail -1)"
p SELFPIDNS "$(readlink /proc/self/ns/pid 2>/dev/null || true)"
if command -v pgrep >/dev/null 2>&1; then
  pids=$(pgrep -x webtmux -u "$(id -u)" 2>/dev/null || true)
else
  pids=$(ps -eo pid=,comm= 2>/dev/null | awk '$2=="webtmux"{print $1}')
fi
for pid in $pids; do
  [ -r "/proc/$pid/cmdline" ] || continue
  p PID "$pid"
  p CMDLINE "$pid $(tr '\0' ' ' < /proc/$pid/cmdline 2>/dev/null)"
  p ENVIRON "$pid $(tr '\0' '\n' < /proc/$pid/environ 2>/dev/null | grep -E '^(GOTTY_CREDENTIAL|WEBTMUX_SESSION|WEBTMUX_SOCKET)=' | tr '\n' ' ')"
  p EXESHA "$pid $(sha256sum /proc/$pid/exe 2>/dev/null | cut -d' ' -f1)"
  p PIDNS "$pid $(readlink /proc/$pid/ns/pid 2>/dev/null || true)"
  p ETIME "$pid $(ps -o etimes= -p $pid 2>/dev/null | tr -d ' ')"
  p CGROUP "$pid $(head -1 /proc/$pid/cgroup 2>/dev/null)"
done
`

// runProbe executes the probe and parses it.
func runProbe(ctx context.Context, r *sshRunner, archOverride string) (*probe, error) {
	out, errOut, err := r.Run(ctx, probeScript)
	if err != nil {
		return nil, fmt.Errorf("probe failed: %v\n%s", err, strings.TrimSpace(errOut))
	}
	p := parseProbe(out)
	if archOverride != "" {
		p.Arch = archOverride
	}
	if p.OS == "" || p.Arch == "" {
		return nil, fmt.Errorf("probe returned no platform information\n%s", strings.TrimSpace(out))
	}
	plat, err := platformFor(p.OS, p.Arch)
	if err != nil {
		return nil, err
	}
	p.Platform = plat
	if p.TmuxPath == "" {
		return nil, fmt.Errorf("no tmux on the target\n(install it: %s)", tmuxInstallHint(p.DistroID))
	}
	if p.Home == "" {
		return nil, fmt.Errorf("probe could not determine $HOME on the target")
	}
	return p, nil
}

func parseProbe(out string) *probe {
	p := &probe{}
	byPID := map[int]*instance{}
	inst := func(pid int) *instance {
		if i, ok := byPID[pid]; ok {
			return i
		}
		i := &instance{PID: pid}
		byPID[pid] = i
		return i
	}
	// splitPID pulls the leading "<pid> " off a per-process value.
	splitPID := func(v string) (int, string) {
		head, rest, _ := strings.Cut(v, " ")
		n, err := strconv.Atoi(head)
		if err != nil {
			return 0, ""
		}
		return n, rest
	}

	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimRight(line, "\r")
		if !strings.HasPrefix(line, "WTL_") {
			continue
		}
		key, val, ok := strings.Cut(strings.TrimPrefix(line, "WTL_"), "=")
		if !ok {
			continue
		}
		switch key {
		case "OS":
			p.OS = val
		case "ARCH":
			p.Arch = val
		case "HOME":
			p.Home = val
		case "USER":
			p.User = val
		case "TMUX":
			p.TmuxPath = val
		case "TMUXVER":
			p.TmuxVer = val
		case "DISTRO":
			p.DistroID = val
		case "CACHE":
			if val != "" {
				p.CacheDirs = append(p.CacheDirs, val)
			}
		case "SESSION":
			if val != "" {
				p.Sessions = append(p.Sessions, val)
			}
		case "LINGER":
			p.Linger = val
		case "KILLUSER":
			p.KillUser = strings.TrimSpace(val)
		case "SELFPIDNS":
			p.SelfPIDNS = val
		case "PID":
			if n, err := strconv.Atoi(val); err == nil {
				inst(n)
			}
		case "CMDLINE":
			if pid, rest := splitPID(val); pid != 0 {
				inst(pid).Cmdline = strings.Fields(rest)
			}
		case "ENVIRON":
			if pid, rest := splitPID(val); pid != 0 {
				inst(pid).Env = parseEnvList(rest)
			}
		case "EXESHA":
			if pid, rest := splitPID(val); pid != 0 {
				inst(pid).ExeSHA = strings.TrimSpace(rest)
			}
		case "PIDNS":
			if pid, rest := splitPID(val); pid != 0 {
				inst(pid).PIDNS = strings.TrimSpace(rest)
			}
		case "ETIME":
			if pid, rest := splitPID(val); pid != 0 {
				inst(pid).UptimeSec, _ = strconv.Atoi(strings.TrimSpace(rest))
			}
		case "CGROUP":
			if pid, rest := splitPID(val); pid != 0 {
				inst(pid).Cgroup = strings.TrimSpace(rest)
			}
		}
	}

	pids := make([]int, 0, len(byPID))
	for pid := range byPID {
		pids = append(pids, pid)
	}
	sort.Ints(pids)
	for _, pid := range pids {
		i := byPID[pid]
		i.parse(p.SelfPIDNS)
		p.Instances = append(p.Instances, *i)
	}
	return p
}

func parseEnvList(s string) map[string]string {
	out := map[string]string{}
	for _, kv := range strings.Fields(s) {
		if k, v, ok := strings.Cut(kv, "="); ok {
			out[k] = v
		}
	}
	return out
}

// hasCached answers "is the content-addressed binary already there?" from the
// directory listing the probe already returned — which is why the existence
// check costs no extra round trip even though the sha is not known until after
// the probe.
func (p *probe) hasCached(name string) bool {
	for _, e := range p.CacheDirs {
		if e == name {
			return true
		}
	}
	return false
}

func tmuxInstallHint(distro string) string {
	switch distro {
	case "debian", "ubuntu", "raspbian", "linuxmint", "pop":
		return "sudo apt install tmux"
	case "fedora", "rhel", "centos", "rocky", "almalinux":
		return "sudo dnf install tmux"
	case "arch", "manjaro":
		return "sudo pacman -S tmux"
	case "alpine":
		return "sudo apk add tmux"
	case "opensuse", "opensuse-leap", "opensuse-tumbleweed", "sles":
		return "sudo zypper install tmux"
	case "":
		return "your package manager's tmux package"
	default:
		return "your package manager's tmux package (" + distro + ")"
	}
}

// durability reports whether the target will reap the tmux server at logout.
// It NEVER changes what the launcher does — it only changes what is reported.
// Advisory, never blocking (see risk 10).
func (p *probe) durabilityWarning() string {
	if !strings.Contains(strings.ToLower(p.KillUser), "yes") {
		return ""
	}
	if strings.EqualFold(p.Linger, "yes") {
		return "" // linger is enabled; the reaper does not apply
	}
	return strings.Join([]string{
		"note: this box sets systemd-logind KillUserProcesses=yes and lingering is off,",
		"      so tmux sessions are reaped when you log out. Options, least imposing first:",
		"        1. run a webtmux yourself persistently (systemd --user unit, or nohup) —",
		"           the next launch adopts it automatically, and no privileged config is needed",
		"        2. sudo loginctl enable-linger " + p.User,
		"        3. accept it — for a laptop-driven workflow this may be perfectly fine",
	}, "\n")
}
