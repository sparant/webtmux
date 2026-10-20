package main

// Local mode: the target is this machine, so nothing goes over SSH.
//
// `webtmux-launch`, `webtmux-launch localhost` and `webtmux-launch 192.168.1.20`
// (one of this machine's own addresses) used to ssh back into the same box —
// which needs an sshd, a key for yourself, and a tunnel from a port to another
// port on the same loopback. None of that does anything here. Local mode keeps
// every step that does — the probe, the binary resolution and install, the
// detached base session, adoption, the supervisor — and changes only HOW a
// command reaches the shell: `sh -c` instead of `ssh <target>`.
//
// webtmux's lifetime is still tied to the launcher's, by the same mechanism:
// tieToConnection's wrapper watches its stdin, which is a pipe this process
// holds open, so the launcher exiting — even SIGKILLed — closes it and the
// wrapper kills webtmux. Over SSH that pipe rides the connection; here it is
// handed to the local shell directly.
//
// There is no tunnel. webtmux listens on 127.0.0.1:<local port> itself, so the
// "remote" port and the local port are one port.

import (
	"net"
	"net/url"
	"os"
	"os/user"
	"strings"
)

// isLocalTarget reports whether target names this machine as the user running
// the launcher, so that SSH would only loop back to where we already are.
//
// Deliberately conservative — anything that might mean something else to ssh
// stays an SSH target:
//   - a port other than 22 (ssh://localhost:2222 is typically a container's
//     sshd, i.e. a different machine that happens to be reached via loopback);
//   - a user other than the current one (that is a login as someone else);
//   - a bare name other than "localhost" (it may be a ~/.ssh/config alias
//     with its own HostName).
//
// --ssh forces SSH whatever this says.
func isLocalTarget(target string) bool {
	if target == "" {
		return true
	}
	host, usr, port := splitTarget(target)
	if port != "" && port != "22" {
		return false
	}
	if usr != "" {
		if me, err := user.Current(); err != nil || me.Username != usr {
			return false
		}
	}
	return isLocalHost(host)
}

// splitTarget pulls user, host and port out of the two forms ssh accepts:
// [user@]host and ssh://[user@]host[:port] (with [v6] brackets).
func splitTarget(target string) (host, usr, port string) {
	if strings.HasPrefix(target, "ssh://") {
		u, err := url.Parse(target)
		if err != nil {
			return target, "", ""
		}
		if u.User != nil {
			usr = u.User.Username()
		}
		return u.Hostname(), usr, u.Port()
	}
	if i := strings.LastIndex(target, "@"); i >= 0 {
		usr, target = target[:i], target[i+1:]
	}
	return strings.TrimSuffix(strings.TrimPrefix(target, "["), "]"), usr, ""
}

// isLocalHost: "localhost", any loopback address, or an address assigned to
// one of this machine's interfaces.
func isLocalHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return false
	}
	if ip.IsLoopback() {
		return true
	}
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return false
	}
	for _, a := range addrs {
		if n, ok := a.(*net.IPNet); ok && n.IP.Equal(ip) {
			return true
		}
	}
	return false
}

// localConfigKey names the per-target config local mode uses, whichever way
// this machine was spelled — no argument, localhost, 127.0.0.1 or a LAN
// address all keep one URL. It cannot collide with an SSH run's config for
// "localhost": that one stores a tunnel's two ports, this one stores the one
// port webtmux listens on.
const localConfigKey = "@local"

// localEnv is the environment for commands run locally. An ssh session starts
// from sshd's clean environment; a local one inherits the launcher's, and a
// launcher started from inside tmux carries TMUX — which would make the attach
// script's `tmux attach` refuse to nest. Everything else (PATH, TMUX_TMPDIR,
// LANG) is the user's own and wanted.
func localEnv() []string {
	var env []string
	for _, kv := range os.Environ() {
		if strings.HasPrefix(kv, "TMUX=") || strings.HasPrefix(kv, "TMUX_PANE=") {
			continue
		}
		env = append(env, kv)
	}
	return env
}
