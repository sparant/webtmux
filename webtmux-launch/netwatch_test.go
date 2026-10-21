package main

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type fakeNet struct {
	mu sync.Mutex
	fp string
}

func (f *fakeNet) set(fp string) { f.mu.Lock(); f.fp = fp; f.mu.Unlock() }
func (f *fakeNet) get() string   { f.mu.Lock(); defer f.mu.Unlock(); return f.fp }

func startWatcher(t *testing.T, n *fakeNet, reachable func(context.Context) bool) (chan struct{}, <-chan struct{}) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	raw, out := make(chan struct{}, 1), make(chan struct{}, 1)
	w := &netWatcher{reachable: reachable, fingerprint: n.get,
		settle: 20 * time.Millisecond, retryEvery: 20 * time.Millisecond, retryFor: 2 * time.Second}
	go w.run(ctx, raw, out)
	time.Sleep(10 * time.Millisecond) // let it take its baseline fingerprint
	return raw, out
}

func expect(t *testing.T, out <-chan struct{}, want bool, what string) {
	t.Helper()
	select {
	case <-out:
		if !want {
			t.Fatalf("%s: fired, but should not have", what)
		}
	case <-time.After(300 * time.Millisecond):
		if want {
			t.Fatalf("%s: never fired", what)
		}
	}
}

// Notifications whose addresses did not change (awdl0 churn, an RA refresh)
// are not a new network.
func TestNetWatcherIgnoresChurn(t *testing.T) {
	n := &fakeNet{fp: "en0=192.168.1.5/24"}
	raw, out := startWatcher(t, n, func(context.Context) bool { return true })
	for i := 0; i < 3; i++ {
		raw <- struct{}{}
	}
	expect(t, out, false, "churn")
}

// A new network fires only once the server is reachable on it.
func TestNetWatcherWaitsForReachability(t *testing.T) {
	n := &fakeNet{fp: "en0=192.168.1.5/24"}
	var tries atomic.Int32
	raw, out := startWatcher(t, n, func(context.Context) bool { return tries.Add(1) >= 4 })
	n.set("en0=10.0.0.7/24")
	raw <- struct{}{}
	expect(t, out, true, "new network")
	if got := tries.Load(); got < 4 {
		t.Fatalf("fired after %d reachability checks, before the server answered", got)
	}
}

// Going offline is not a trigger; the network after it is — even when it
// hands out the same address as before.
func TestNetWatcherOfflineThenBack(t *testing.T) {
	n := &fakeNet{fp: "en0=192.168.1.5/24"}
	raw, out := startWatcher(t, n, func(context.Context) bool { return true })
	n.set("")
	raw <- struct{}{}
	expect(t, out, false, "offline")
	n.set("en0=192.168.1.5/24")
	raw <- struct{}{}
	expect(t, out, true, "back on the same address")
}

func TestParseSSHConfigDump(t *testing.T) {
	host, port, proxied := parseSSHConfigDump([]byte("user nathan\nhostname 174.21.118.30\nport 38242\nproxyjump none\n"))
	if host != "174.21.118.30" || port != "38242" || proxied {
		t.Errorf("got %q %q %v", host, port, proxied)
	}
	if _, _, proxied := parseSSHConfigDump([]byte("hostname box\nproxyjump bastion\n")); !proxied {
		t.Error("a ProxyJump must count as proxied")
	}
	if _, _, proxied := parseSSHConfigDump([]byte("hostname box\nproxycommand nc %h %p\n")); !proxied {
		t.Error("a ProxyCommand must count as proxied")
	}
}
