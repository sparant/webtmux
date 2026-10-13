package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// A forward that answered and then stops answering is declared dead after
// exactly `limit` consecutive failures — and a single blip in between resets
// the count rather than adding to it.
func TestWatchHealthDeclaresDeadAfterConsecutiveFailures(t *testing.T) {
	var up atomic.Bool
	up.Store(true)
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if !up.Load() {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	client := &http.Client{Timeout: time.Second}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	done := make(chan bool, 1)
	go func() { done <- watchHealth(ctx, client, srv.URL, 20*time.Millisecond, 3) }()
	time.Sleep(100 * time.Millisecond)
	up.Store(false)
	select {
	case dead := <-done:
		if !dead {
			t.Fatal("watchHealth returned without declaring the forward dead")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("a forward answering 502 was never declared dead")
	}
}

func TestWatchHealthToleratesAnIsolatedFailure(t *testing.T) {
	var n atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// fail every other request: never 3 in a row
		if n.Add(1)%2 == 0 {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 400*time.Millisecond)
	defer cancel()
	if watchHealth(ctx, &http.Client{Timeout: time.Second}, srv.URL, 20*time.Millisecond, 3) {
		t.Fatal("alternating failures must not add up to a dead verdict")
	}
}

// 401 is a live webtmux asking for basic auth, not a failure.
func TestAnswersCountsUnauthorizedAsUp(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()
	if !answers(&http.Client{Timeout: time.Second}, srv.URL) {
		t.Fatal("401 must count as up")
	}
	srv.Close()
	if answers(&http.Client{Timeout: time.Second}, srv.URL) {
		t.Fatal("a closed port must not count as up")
	}
}

// The tunnel must be its own connection: no mux, whatever ~/.ssh/config says,
// with the fast keepalives. ssh takes the FIRST value for an option, so the
// setup mux options must not appear at all.
func TestTunnelCommandUsesItsOwnConnection(t *testing.T) {
	r := &sshRunner{target: "box", controlPath: "/tmp/cm-test"}
	for _, remote := range []string{"", "webtmux …"} {
		args := strings.Join(r.TunnelCommand(context.Background(), 1111, 2222, remote).Args, " ")
		for _, want := range []string{"ControlPath=none", "ControlMaster=no", "ServerAliveInterval=5", "ServerAliveCountMax=3", "ExitOnForwardFailure=yes"} {
			if !strings.Contains(args, want) {
				t.Errorf("tunnel (remote=%q) lacks %s: %s", remote, want, args)
			}
		}
		for _, bad := range []string{"ControlMaster=auto", "ControlPersist", "/tmp/cm-test"} {
			if strings.Contains(args, bad) {
				t.Errorf("tunnel (remote=%q) rides the setup mux (%s): %s", remote, bad, args)
			}
		}
	}
	if !strings.Contains(strings.Join(r.TunnelCommand(context.Background(), 1, 2, "").Args, " "), " -N box") {
		t.Error("adopt mode's tunnel must be a bare -N forward")
	}
}
