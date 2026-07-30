package webtty

import (
	"context"
	"testing"
	"time"
)

// The per-connection capture cap (see the fan-out comment in tmux.go).
//
// What is being bounded is not "requests" but FORKS: every CaptureWindows call
// runs `capture-pane` once per window, and the browser asks on a 500ms poll plus
// every hover, Exposé open and PiP tick. Nothing used to stop a client that asks
// faster than tmux answers from stacking those up, and `force:true` walked past
// the TTL coalescing that makes the polling affordable in the first place.

// requestCapture drives one TmuxCaptureRequest through the real handler.
func requestCapture(t *testing.T, wt *WebTTY, payload string) {
	t.Helper()
	if err := wt.handleTmuxMessage(TmuxCaptureRequest, []byte(payload)); err != nil {
		t.Fatalf("capture request: %v", err)
	}
}

func TestOnlyOneCaptureIsInFlightPerConnection(t *testing.T) {
	wt, _, _ := newFailingWebTTY(t, nil)
	release := make(chan struct{})
	cp := &countingCapture{block: release}
	wt.SetCaptureProvider(cp)

	// The first request blocks inside CaptureWindows, standing in for a slow (or
	// wedged) tmux.
	requestCapture(t, wt, `{"windows":"all"}`)
	cp.wait(t, 1)

	// Everything that arrives meanwhile coalesces onto it. The client re-asks on
	// its next tick; what must not happen is ten more forks.
	for i := 0; i < 10; i++ {
		requestCapture(t, wt, `{"windows":["@3"]}`)
	}
	if got := len(cp.snapshot()); got != 1 {
		t.Fatalf("%d concurrent captures reached tmux; want 1", got)
	}

	// Once it finishes, the next request runs normally.
	close(release)
	cp.block = nil
	deadline := time.Now().Add(2 * time.Second)
	for {
		requestCapture(t, wt, `{"windows":["@3"]}`)
		if len(cp.snapshot()) > 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the in-flight slot was never released")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// force:true is the TTL bypass. A hover that re-asks per mouse-move, or a client
// with a bug, must not turn it into an unthrottled fork loop.
func TestForceIsRateLimitedPerWindow(t *testing.T) {
	var l captureLimiter
	now := time.Now()

	if !l.allowForce([]string{"@3"}, now) {
		t.Fatal("the first force must go through")
	}
	if l.allowForce([]string{"@3"}, now.Add(100*time.Millisecond)) {
		t.Error("a second force 100ms later bypassed the limit")
	}
	// A DIFFERENT window is not throttled by the first one's timer.
	if !l.allowForce([]string{"@4"}, now.Add(100*time.Millisecond)) {
		t.Error("one hot window throttled another")
	}
	// Past the interval it is allowed again.
	if !l.allowForce([]string{"@3"}, now.Add(forceInterval+time.Millisecond)) {
		t.Error("the limit never expires")
	}
	// A set is granted only if EVERY member is outside its interval, so one hot
	// window cannot drag the rest past the cache.
	if l.allowForce([]string{"@3", "@9"}, now.Add(forceInterval+2*time.Millisecond)) {
		t.Error("a set containing a recently-forced window was still forced")
	}
	// The all-windows request is one key of its own.
	all := now.Add(10 * time.Second)
	if !l.allowForce(nil, all) {
		t.Fatal("the all-windows force must go through once")
	}
	if l.allowForce(nil, all.Add(time.Millisecond)) {
		t.Error("the all-windows force is not rate limited")
	}
}

// End to end through the handler: the second force inside the window reaches the
// store as a NON-forced request. It still runs — the client gets its (cached)
// buffers — it just doesn't re-fork tmux.
func TestASecondForceBecomesAnOrdinaryRequest(t *testing.T) {
	wt, _, _ := newFailingWebTTY(t, nil)
	cp := &countingCapture{}
	wt.SetCaptureProvider(cp)

	requestCapture(t, wt, `{"windows":["@3"],"force":true}`)
	cp.wait(t, 1)
	requestCapture(t, wt, `{"windows":["@3"],"force":true}`)
	calls := cp.wait(t, 2)

	if !calls[0].force {
		t.Error("the first force was downgraded")
	}
	if calls[1].force {
		t.Error("a force 0ms after the last one still bypassed the TTL cache")
	}
}

// A capture that finishes after the connection is gone must not go on to
// marshal a screenful of base64 per window for nobody.
func TestCaptureStopsWhenTheConnectionDoes(t *testing.T) {
	m := &recordMaster{}
	wt, err := New(m, nil)
	if err != nil {
		t.Fatal(err)
	}
	release := make(chan struct{})
	cp := &countingCapture{block: release}
	wt.SetCaptureProvider(cp)

	ctx, cancel := context.WithCancel(context.Background())
	wt.ctxMu.Lock()
	wt.runCtx = ctx
	wt.ctxMu.Unlock()

	requestCapture(t, wt, `{"windows":"all"}`)
	cp.wait(t, 1)
	cancel()       // the websocket went while tmux was forking
	close(release) // …and only then does the capture come back

	// Give the goroutine a moment to do the wrong thing if it is going to.
	time.Sleep(50 * time.Millisecond)
	for _, f := range m.sent() {
		if f[0] == TmuxCaptureData {
			t.Fatal("capture data was built and sent for a connection that had gone")
		}
	}
}
