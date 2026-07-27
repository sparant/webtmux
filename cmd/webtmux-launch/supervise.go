package main

// Supervision, readiness and the browser.
//
// webtmux is disposable — the tmux server holds all the state and outlives it.
// So there is no remote daemon to supervise, no PID file, no orphan to reap.
// One SSH invocation carries both the forward and the remote process; the
// connection dying kills webtmux with it, and the restart re-attaches to tmux
// panes that never moved. Two hard problems ("keep the binary alive", "keep the
// tunnel alive") collapse into ONE supervised subprocess.

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os/exec"
	"runtime"
	"strings"
	"sync/atomic"
	"time"
)

type supervisor struct {
	ssh       *sshRunner
	local     int
	remote    int
	remoteCmd func() string // nil / returns "" for adopt mode's bare forward
	url       string
	out       io.Writer

	noBrowser bool
	// onPortCollision lets the caller reallocate a remote port when webtmux
	// could not bind. Returns the new port, or 0 to give up on reallocation.
	onPortCollision func() int

	// opened is touched by one goroutine per connection attempt, so it is
	// atomic: only the first success may open a browser tab.
	opened atomic.Bool
}

// backoff bounds: start at 1s so a transient blip recovers almost instantly,
// cap at 30s, and reset after any connection that survived longer than
// resetAfter — a link that stayed up for a minute is not flapping.
const (
	backoffMin = 1 * time.Second
	backoffMax = 30 * time.Second
	resetAfter = 60 * time.Second
)

// run is the supervisor loop. It returns when ctx is cancelled (Ctrl-C).
func (s *supervisor) run(ctx context.Context) error {
	delay := backoffMin
	attempt := 0
	for {
		started := time.Now()
		remote := ""
		if s.remoteCmd != nil {
			remote = s.remoteCmd()
		}
		cmd := s.ssh.TunnelCommand(ctx, s.local, s.remote, remote)
		// Surface ssh's own stderr rather than swallowing it — its messages are
		// better than anything we would invent — but keep a copy so a port
		// collision can be recognised.
		var errTail tailWriter
		cmd.Stderr = io.MultiWriter(s.out, &errTail)
		cmd.Stdout = s.out

		if err := cmd.Start(); err != nil {
			return fmt.Errorf("starting ssh: %v", err)
		}
		// The readiness poll runs against every attempt but opens the browser
		// only on the FIRST success — otherwise every network blip spawns a tab.
		go s.awaitReady(ctx)

		err := cmd.Wait()
		if ctx.Err() != nil {
			return nil // Ctrl-C: the child is already going away with the context
		}
		alive := time.Since(started)

		if s.onPortCollision != nil && isPortCollision(errTail.String()) && alive < 10*time.Second {
			if p := s.onPortCollision(); p > 0 {
				fmt.Fprintf(s.out, "remote port %d was taken; retrying on %d\n", s.remote, p)
				s.remote = p
				delay = backoffMin
				continue
			}
		}

		if alive > resetAfter {
			delay = backoffMin
			attempt = 0
		}
		attempt++
		if err != nil && attempt == 1 {
			fmt.Fprintf(s.out, "connection ended: %v\n", err)
		}
		// A single updating line, not a scrolling log: the user's browser is
		// already showing a frozen terminal, and the launcher's job is to say
		// whether it is working on it.
		fmt.Fprintf(s.out, "\rreconnecting… attempt %d, next in %ds        ", attempt, int(delay.Seconds()))
		select {
		case <-ctx.Done():
			fmt.Fprintln(s.out)
			return nil
		case <-time.After(delay):
		}
		fmt.Fprintf(s.out, "\r%s\r", strings.Repeat(" ", 48))
		// A dead master can leave a stale control socket behind; without
		// clearing it the reconnect hangs on a dead mux instead of establishing
		// a fresh connection.
		s.ssh.ClearStaleMaster(ctx)
		if delay < backoffMax {
			delay *= 2
			if delay > backoffMax {
				delay = backoffMax
			}
		}
	}
}

// awaitReady polls the forwarded port until webtmux answers, then opens the
// browser — once, ever.
func (s *supervisor) awaitReady(ctx context.Context) {
	deadline := time.Now().Add(30 * time.Second)
	client := &http.Client{Timeout: 2 * time.Second}
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return
		case <-time.After(150 * time.Millisecond):
		}
		resp, err := client.Get(s.url)
		if err != nil {
			continue
		}
		code := resp.StatusCode
		resp.Body.Close()
		// 401 means it is up and asking for basic auth — an adopted instance
		// whose credentials we could not recover. Still "ready".
		if code != http.StatusOK && code != http.StatusUnauthorized {
			continue
		}
		if !s.opened.CompareAndSwap(false, true) {
			return
		}
		fmt.Fprintf(s.out, "ready: %s\n", s.url)
		if !s.noBrowser {
			if err := openBrowser(s.url); err != nil {
				fmt.Fprintf(s.out, "(could not open a browser: %v)\n", err)
			}
		}
		return
	}
	if !s.opened.Load() {
		fmt.Fprintf(s.out, "warning: %s did not answer within 30s\n", s.url)
	}
}

func openBrowser(url string) error {
	switch runtime.GOOS {
	case "darwin":
		return exec.Command("open", url).Start()
	case "windows":
		return exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
	default:
		return exec.Command("xdg-open", url).Start()
	}
}

// isPortCollision recognises webtmux failing to bind the remote port. webtmux
// has no --port 0, so the port is chosen blind and a collision can only be
// detected here.
func isPortCollision(stderr string) bool {
	s := strings.ToLower(stderr)
	return strings.Contains(s, "address already in use") ||
		(strings.Contains(s, "bind") && strings.Contains(s, "in use"))
}

// tailWriter keeps the last few KB of a stream for post-mortem matching.
type tailWriter struct{ buf []byte }

func (t *tailWriter) Write(p []byte) (int, error) {
	t.buf = append(t.buf, p...)
	if len(t.buf) > 8192 {
		t.buf = t.buf[len(t.buf)-8192:]
	}
	return len(p), nil
}

func (t *tailWriter) String() string { return string(t.buf) }
