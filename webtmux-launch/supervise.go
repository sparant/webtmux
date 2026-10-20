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
	"os"
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
	// defaultBrowser skips the Chrome preference and opens the system default.
	defaultBrowser bool
	// onPortCollision lets the caller reallocate a remote port when webtmux
	// could not bind. Returns the new port, or 0 to give up on reallocation.
	onPortCollision func() int
	// urlFor recomputes url after a collision moved the port. Only local mode
	// needs it: there the browser's port is the one that moved.
	urlFor func() string

	// opened is touched by one goroutine per connection attempt, so it is
	// atomic: only the first success may open a browser tab.
	opened atomic.Bool

	// Health check through the forward, after the attempt has answered once.
	// Zero values mean the defaults below; tests shorten them.
	healthEvery time.Duration
	healthFails int
}

// backoff bounds: start at 1s so a transient blip recovers almost instantly,
// cap at 30s, and reset after any connection that survived longer than
// resetAfter — a link that stayed up for a minute is not flapping.
const (
	backoffMin = 1 * time.Second
	backoffMax = 30 * time.Second
	resetAfter = 60 * time.Second

	// A tunnel that answered and then fails this many checks in a row is
	// bounced. ~15s, in step with the ssh keepalive: whichever notices first
	// wins, and this one also catches what keepalives cannot — a connection the
	// server still answers while the forward behind it is wedged.
	defaultHealthEvery = 5 * time.Second
	defaultHealthFails = 3

	// probeHeader marks the launcher's own health checks; webtmux's request
	// log skips requests carrying it (server/middleware.go).
	probeHeader = "X-Webtmux-Probe"
)

// run is the supervisor loop. It returns when ctx is cancelled (Ctrl-C).
func (s *supervisor) run(ctx context.Context) error {
	delay := backoffMin
	attempt := 0

	// The remote wrapper waits for stdin EOF to learn that we are gone (see
	// tieToConnection). Hand ssh the read end of a pipe we hold open and never
	// write to: it stays open exactly as long as this process lives, signal or
	// no signal, and closes even on SIGKILL. Passing the terminal instead would
	// let a stray keystroke reach it, and /dev/null would read EOF immediately
	// and kill webtmux the moment it started.
	//
	// One pipe for the whole supervisor, not one per attempt: os/exec passes an
	// *os.File straight through without closing it, so reusing it costs nothing
	// and avoids leaking a descriptor pair per reconnect.
	var livePipe *os.File
	if s.remoteCmd != nil {
		pr, pw, err := os.Pipe()
		if err != nil {
			return fmt.Errorf("creating the liveness pipe: %v", err)
		}
		livePipe = pr
		defer pr.Close()
		defer pw.Close() // held open until run returns — that IS the liveness signal
	}
	for {
		started := time.Now()
		remote := ""
		if s.remoteCmd != nil {
			remote = s.remoteCmd()
		}
		cmd := s.ssh.TunnelCommand(ctx, s.local, s.remote, remote)
		if livePipe != nil {
			cmd.Stdin = livePipe
		}
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
		// It then keeps checking for as long as this attempt lives, and kills
		// the ssh if the forward stops answering: after a network switch ssh can
		// sit on a dead connection until its keepalives give up, and a
		// supervisor that only waits on the process waits that long too.
		attemptCtx, endAttempt := context.WithCancel(ctx)
		bounced := make(chan struct{}, 1)
		go s.watch(attemptCtx, attempt > 0, func() {
			bounced <- struct{}{}
			_ = cmd.Process.Kill()
		})

		err := cmd.Wait()
		endAttempt()
		if ctx.Err() != nil {
			return nil // Ctrl-C: the child is already going away with the context
		}
		alive := time.Since(started)

		if s.onPortCollision != nil && isPortCollision(errTail.String()) && alive < 10*time.Second {
			if p := s.onPortCollision(); p > 0 {
				if s.ssh.local {
					fmt.Fprintf(s.out, "port %d was taken; retrying on %d\n", s.remote, p)
					s.local = p
					if s.urlFor != nil {
						s.url = s.urlFor()
						fmt.Fprintf(s.out, "url: %s\n", s.url)
					}
				} else {
					fmt.Fprintf(s.out, "remote port %d was taken; retrying on %d\n", s.remote, p)
				}
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
		select {
		case <-bounced:
			if s.ssh.local {
				fmt.Fprintf(s.out, "\rwebtmux stopped answering; restarting\n")
			} else {
				fmt.Fprintf(s.out, "\rtunnel stopped answering; reconnecting\n")
			}
		default:
			if err != nil && attempt == 1 {
				fmt.Fprintf(s.out, "\rconnection ended: %v\n", err)
			}
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
		if delay < backoffMax {
			delay *= 2
			if delay > backoffMax {
				delay = backoffMax
			}
		}
	}
}

// watch polls the forwarded port until webtmux answers — opening the browser
// on the first success ever — and then keeps polling for the life of this
// attempt, calling dead once the forward has failed healthFails checks in a
// row. Failures before the first answer never count: a slow start is the
// readiness timeout's business, not a reason to kill a connection mid-setup.
func (s *supervisor) watch(ctx context.Context, reconnect bool, dead func()) {
	client := &http.Client{Timeout: 3 * time.Second}
	if !s.awaitAnswer(ctx, client) {
		if ctx.Err() == nil && !s.opened.Load() {
			fmt.Fprintf(s.out, "warning: %s did not answer within 30s\n", s.url)
		}
		return
	}
	if s.opened.CompareAndSwap(false, true) {
		fmt.Fprintf(s.out, "ready: %s\n", s.url)
		if !s.noBrowser {
			if err := openBrowser(s.url, s.defaultBrowser); err != nil {
				fmt.Fprintf(s.out, "(could not open a browser: %v)\n", err)
			}
		}
	} else if reconnect {
		fmt.Fprintf(s.out, "\rreconnected: %s        \n", s.url)
	}
	every, limit := s.healthEvery, s.healthFails
	if every == 0 {
		every = defaultHealthEvery
	}
	if limit == 0 {
		limit = defaultHealthFails
	}
	if watchHealth(ctx, client, s.url, every, limit) {
		dead()
	}
}

// awaitAnswer polls until the URL answers or 30s pass.
func (s *supervisor) awaitAnswer(ctx context.Context, client *http.Client) bool {
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return false
		case <-time.After(150 * time.Millisecond):
		}
		if answers(client, s.url) {
			return true
		}
	}
	return false
}

// watchHealth returns true once url has failed limit consecutive checks, or
// false when ctx ends first.
func watchHealth(ctx context.Context, client *http.Client, url string, every time.Duration, limit int) bool {
	fails := 0
	for {
		select {
		case <-ctx.Done():
			return false
		case <-time.After(every):
		}
		if answers(client, url) {
			fails = 0
			continue
		}
		if ctx.Err() != nil {
			return false // the attempt ended under the request; not a verdict
		}
		if fails++; fails >= limit {
			return true
		}
	}
}

// answers reports whether webtmux is reachable through the forward. 401 counts:
// it is up and asking for basic auth — an adopted instance whose credentials
// we could not recover.
//
// The request carries probeHeader, which webtmux leaves out of its request log:
// a check every 5s would otherwise be most of that log.
func answers(client *http.Client, url string) bool {
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return false
	}
	req.Header.Set(probeHeader, "health")
	resp, err := client.Do(req)
	if err != nil {
		return false
	}
	resp.Body.Close()
	return resp.StatusCode == http.StatusOK || resp.StatusCode == http.StatusUnauthorized
}

// openBrowser opens url in Google Chrome when it is installed, and in the
// system default browser otherwise, or always when defaultBrowser is set.
func openBrowser(url string, defaultBrowser bool) error {
	if !defaultBrowser {
		for _, argv := range chromeCommands(runtime.GOOS, url, exec.LookPath, fileExists) {
			if argv[0] == "open" {
				// `open -a` fails fast when the app is missing, so Run it and
				// fall through rather than guessing where the app lives.
				if exec.Command(argv[0], argv[1:]...).Run() == nil {
					return nil
				}
				continue
			}
			if exec.Command(argv[0], argv[1:]...).Start() == nil {
				return nil
			}
		}
	}
	switch runtime.GOOS {
	case "darwin":
		return exec.Command("open", url).Start()
	case "windows":
		return exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
	default:
		return exec.Command("xdg-open", url).Start()
	}
}

// chromeCommands lists the ways to open url in Chrome on goos, most likely
// first; empty means Chrome is not installed. lookPath and exists are
// injected so tests need no Chrome.
func chromeCommands(goos, url string, lookPath func(string) (string, error), exists func(string) bool) [][]string {
	var out [][]string
	switch goos {
	case "darwin":
		out = append(out, []string{"open", "-a", "Google Chrome", url})
	case "windows":
		for _, env := range []string{"ProgramFiles", "ProgramFiles(x86)", "LocalAppData"} {
			if dir := os.Getenv(env); dir != "" {
				if exe := dir + `\Google\Chrome\Application\chrome.exe`; exists(exe) {
					out = append(out, []string{exe, url})
				}
			}
		}
	default:
		for _, name := range []string{"google-chrome", "google-chrome-stable"} {
			if path, err := lookPath(name); err == nil {
				out = append(out, []string{path, url})
				break
			}
		}
	}
	return out
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
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
