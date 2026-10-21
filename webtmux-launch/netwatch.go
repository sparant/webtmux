package main

// Network-change awareness for the supervisor.
//
// Backoff alone is the wrong shape for a laptop. The link usually dies because
// the laptop changed networks (closed lid, new Wi-Fi, a tethered phone), and
// by the time the new network is up the backoff may be 16s or 30s into a
// sleep: the user is looking at a frozen terminal on a working network,
// waiting on a timer that knows nothing about either. So the supervisor also
// listens for the OS saying "the network changed", and once the SSH server is
// reachable again it reconnects at once.
//
// Sources, all feeding one signal:
//   - the OS's own notifications — a netlink socket on Linux, a routing
//     socket on macOS (netwatch_linux.go / netwatch_darwin.go); pure Go, no
//     cgo, so the launcher stays a static binary;
//   - a poll of the interface addresses every few seconds, as the backstop
//     for anything the OS source misses or for a platform without one.
//
// A notification only wakes the watcher; what counts as a change is the set
// of routable addresses (not loopback, not link-local) changing. The OS sources
// are noisy — macOS reports interface churn on awdl0 (AirDrop) and friends all
// day, Linux reports IPv6 router-advertisement refreshes — and none of that is
// a new network.
//
// "With internet access" is decided by reachability of the one thing that
// matters: a TCP connect to the SSH server itself, resolved with `ssh -G` so
// ~/.ssh/config aliases and ports are honoured. A new network that is not up
// yet (DHCP, a captive portal) is retried for a while rather than treated as
// a trigger, so a change does not spend an attempt on a network that cannot
// carry it.

import (
	"bufio"
	"bytes"
	"context"
	"net"
	"os/exec"
	"sort"
	"strings"
	"time"
)

const (
	// netSettle coalesces a burst of notifications — one Wi-Fi switch is a link
	// down, an address delete, a link up, an address add and route changes.
	netSettle = 750 * time.Millisecond
	// After a change, reachability is retried this often, for this long.
	netRetryEvery = time.Second
	netRetryFor   = 45 * time.Second
	// The address poll's interval: the backstop's worst-case latency.
	netPollEvery = 3 * time.Second
)

// watchNetwork returns a channel that receives each time the network changed
// and the SSH server is reachable afterwards. It never blocks its sources: an
// event that arrives while one is still unread is folded into it.
func watchNetwork(ctx context.Context, target string) <-chan struct{} {
	raw := make(chan struct{}, 1)
	notify := func() {
		select {
		case raw <- struct{}{}:
		default:
		}
	}
	// No OS source is not an error worth reporting: the poll still runs.
	go func() { _ = osNetEvents(ctx, notify) }()
	go pollAddrs(ctx, netPollEvery, notify)

	out := make(chan struct{}, 1)
	w := &netWatcher{reachable: sshReachability(target), fingerprint: addrFingerprint,
		settle: netSettle, retryEvery: netRetryEvery, retryFor: netRetryFor}
	go w.run(ctx, raw, out)
	return out
}

type netWatcher struct {
	reachable   func(context.Context) bool
	fingerprint func() string // the routable addresses, canonicalised
	settle      time.Duration
	retryEvery  time.Duration
	retryFor    time.Duration
}

func (w *netWatcher) run(ctx context.Context, raw <-chan struct{}, out chan<- struct{}) {
	last := w.fingerprint()
	for {
		select {
		case <-ctx.Done():
			return
		case <-raw:
		}
		// Settle: wait for the burst to go quiet.
		for quiet := false; !quiet; {
			select {
			case <-ctx.Done():
				return
			case <-raw:
			case <-time.After(w.settle):
				quiet = true
			}
		}
		fp := w.fingerprint()
		if fp == last {
			continue // churn, not a change
		}
		last = fp
		if fp == "" {
			continue // offline: the next address is the change worth acting on
		}
		// Then wait for the server to be reachable. A further change during the
		// wait restarts the clock: the network is still moving.
		deadline := time.Now().Add(w.retryFor)
		for time.Now().Before(deadline) {
			if w.reachable(ctx) {
				select {
				case out <- struct{}{}:
				default:
				}
				break
			}
			select {
			case <-ctx.Done():
				return
			case <-raw:
				if fp := w.fingerprint(); fp != last {
					last = fp
					deadline = time.Now().Add(w.retryFor)
				}
			case <-time.After(w.retryEvery):
			}
		}
	}
}

// sshReachability resolves the target the way ssh will (`ssh -G` applies
// ~/.ssh/config) and returns a TCP connect check against it. Through a jump
// host or a ProxyCommand the server itself is not what we would connect to,
// so there — and if ssh -G fails — it falls back to "is there a route out".
func sshReachability(target string) func(context.Context) bool {
	host, port, proxied := sshDestination(target)
	if host == "" || proxied {
		return routeOut
	}
	addr := net.JoinHostPort(host, port)
	return func(ctx context.Context) bool {
		d := net.Dialer{Timeout: 2 * time.Second}
		c, err := d.DialContext(ctx, "tcp", addr)
		if err != nil {
			return false
		}
		c.Close()
		return true
	}
}

func sshDestination(target string) (host, port string, proxied bool) {
	out, err := exec.Command("ssh", "-G", target).Output()
	if err != nil {
		return "", "", false
	}
	return parseSSHConfigDump(out)
}

// parseSSHConfigDump reads the `ssh -G` lines we need.
func parseSSHConfigDump(out []byte) (host, port string, proxied bool) {
	port = "22"
	sc := bufio.NewScanner(bytes.NewReader(out))
	for sc.Scan() {
		k, v, _ := strings.Cut(sc.Text(), " ")
		v = strings.TrimSpace(v)
		switch strings.ToLower(k) {
		case "hostname":
			host = v
		case "port":
			port = v
		case "proxyjump", "proxycommand":
			if v != "" && v != "none" {
				proxied = true
			}
		}
	}
	return host, port, proxied
}

// routeOut reports whether this machine has a route to the internet at all.
// A UDP "connect" sends nothing; it only asks the kernel to pick a route.
func routeOut(context.Context) bool {
	for _, a := range []string{"1.1.1.1:53", "[2606:4700:4700::1111]:53"} {
		if c, err := net.Dial("udp", a); err == nil {
			c.Close()
			return true
		}
	}
	return false
}

// pollAddrs notifies whenever the set of routable interface addresses
// changes.
func pollAddrs(ctx context.Context, every time.Duration, notify func()) {
	last := addrFingerprint()
	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(every):
		}
		if fp := addrFingerprint(); fp != last {
			last = fp
			notify()
		}
	}
}

// addrFingerprint canonicalises the routable addresses of the interfaces that
// are up and running. Running matters: Wi-Fi that drops and rejoins can keep
// its address throughout. Interfaces with only link-local addresses (awdl0,
// llw0, utun keepalives) are left out, so their churn changes nothing.
func addrFingerprint() string {
	ifs, err := net.Interfaces()
	if err != nil {
		return ""
	}
	var s []string
	for _, ifc := range ifs {
		if ifc.Flags&net.FlagUp == 0 || ifc.Flags&net.FlagRunning == 0 || ifc.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := ifc.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			if n, ok := a.(*net.IPNet); ok && !n.IP.IsLoopback() && !n.IP.IsLinkLocalUnicast() {
				s = append(s, ifc.Name+"="+n.String())
			}
		}
	}
	sort.Strings(s)
	return strings.Join(s, ",")
}
