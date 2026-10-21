package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
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

func TestChromeCommandsPicksChromeWhenInstalled(t *testing.T) {
	const u = "http://127.0.0.1:8090/"
	missing := func(string) (string, error) { return "", errors.New("not found") }
	stable := func(name string) (string, error) {
		if name == "google-chrome-stable" {
			return "/usr/bin/google-chrome-stable", nil
		}
		return "", errors.New("not found")
	}
	if got := chromeCommands("linux", u, missing, fileExists); len(got) != 0 {
		t.Fatalf("no Chrome on PATH should fall back to the default browser, got %q", got)
	}
	got := chromeCommands("linux", u, stable, fileExists)
	if len(got) != 1 || got[0][0] != "/usr/bin/google-chrome-stable" || got[0][1] != u {
		t.Fatalf("linux = %q", got)
	}
	got = chromeCommands("darwin", u, missing, fileExists)
	if len(got) != 1 || strings.Join(got[0], " ") != "open -a Google Chrome "+u {
		t.Fatalf("darwin = %q", got)
	}
	t.Setenv("ProgramFiles", `C:\PF`)
	t.Setenv("ProgramFiles(x86)", "")
	t.Setenv("LocalAppData", `C:\LAD`)
	onlyUser := func(p string) bool { return p == `C:\LAD\Google\Chrome\Application\chrome.exe` }
	got = chromeCommands("windows", u, missing, onlyUser)
	if len(got) != 1 || got[0][0] != `C:\LAD\Google\Chrome\Application\chrome.exe` {
		t.Fatalf("windows = %q", got)
	}
}

// syncBuf is an io.Writer the supervisor's goroutines can share with a test.
type syncBuf struct {
	mu sync.Mutex
	b  strings.Builder
}

func (w *syncBuf) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.b.Write(p)
}

func (w *syncBuf) String() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.b.String()
}

// A Wi-Fi join reports its addresses one at a time, each one a network change.
// A tunnel still coming up when the next one lands has not failed — it has not
// answered YET — and must not be killed for it: that restarted the tunnel once
// per address and left the browser flickering red and blue. Once the tunnel HAS
// answered, a network change it cannot survive still bounces it at once.
func TestNetworkChangeSparesATunnelStillComingUp(t *testing.T) {
	var serving atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !serving.Load() {
			w.WriteHeader(http.StatusServiceUnavailable)
		}
	}))
	defer srv.Close()

	var starts atomic.Int32
	netCh := make(chan struct{})
	out := &syncBuf{}
	s := &supervisor{
		ssh:       newLocalRunner(false),
		url:       srv.URL,
		out:       out,
		noBrowser: true,
		netReady:  netCh,
		remoteCmd: func() string { starts.Add(1); return "exec sleep 30" },
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() { _ = s.run(ctx); close(done) }()
	defer func() { cancel(); <-done }()

	waitFor := func(what string, ok func() bool) {
		t.Helper()
		for deadline := time.Now().Add(10 * time.Second); !ok(); {
			if time.Now().After(deadline) {
				t.Fatalf("timed out waiting for %s; console:\n%s", what, out.String())
			}
			time.Sleep(20 * time.Millisecond)
		}
	}
	waitFor("the first attempt", func() bool { return starts.Load() == 1 })

	// Three address changes while the tunnel cannot answer yet.
	for i := 0; i < 3; i++ {
		netCh <- struct{}{}
		time.Sleep(200 * time.Millisecond)
	}
	time.Sleep(300 * time.Millisecond)
	if n := starts.Load(); n != 1 {
		t.Fatalf("network changes during setup restarted the tunnel: %d starts; console:\n%s", n, out.String())
	}

	serving.Store(true)
	waitFor("ready", func() bool { return strings.Contains(out.String(), "ready: ") })

	// Up, and then the network changes under it and it stops answering.
	serving.Store(false)
	netCh <- struct{}{}
	waitFor("the bounce", func() bool { return starts.Load() == 2 })
	if !strings.Contains(out.String(), "network changed and the tunnel stopped answering") {
		t.Errorf("an answered tunnel that stops answering must be bounced and say so:\n%s", out.String())
	}
}
