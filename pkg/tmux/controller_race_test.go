package tmux

import (
	"sync"
	"testing"
	"time"
)

// A controller's identity fields are written from TWO goroutines for the whole
// life of a connection: the 500ms layout poller (server.handleTmuxEvents ->
// RefreshLayout -> session/discoverClient/selfHeal/regroupOnto) and the
// connection's message reader (SetClient at startup, SwitchSession on every
// sidebar click). `go test -race` only reports a race it actually WITNESSES, so
// before this test the whole package passed -race purely because no test ever
// crossed goroutines on a Controller — the detector had nothing to see.
//
// This test makes the two goroutines collide on purpose.
func TestControllerIdentityIsRaceFree(t *testing.T) {
	f := oneSessionServer()
	// A split pane: follow + a groupBase, which is the configuration that reaches
	// every identity writer (discoverClient, selfHeal, regroupOnto, SwitchSession).
	c := newControllerWithRunner("web-abc", true, "services", f.run)
	c.SetClient("/dev/pts/1", 4242)

	stop := make(chan struct{})
	var wg sync.WaitGroup

	// The poller.
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
				c.RefreshLayout()
				c.GetLayout()
			}
		}
	}()

	// The connection's message goroutine: session switches and a re-issued client
	// identity, exactly as handlers.go/webtty drive them.
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < 200; i++ {
			c.SwitchSession("editors")
			c.SetClient("/dev/pts/1", 4242)
			c.SwitchSession("services")
		}
		close(stop)
	}()

	// A third reader, standing in for the command handlers that ask where the pane
	// is while both of the above are running (SelectWindow, NewWindow, SplitPane…).
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
				c.session()
				c.logicalSession()
			}
		}
	}()

	wg.Wait()
}

// regroupOnto is a multi-step tmux MUTATION (new-session, switch-client,
// set-option) that only publishes its result — the new baseSession/groupBase —
// once all three have landed. Two of them at once therefore create two grouped
// sessions, switch the client twice, and leave the identity naming whichever
// finished last while the client sits on the other. Both callers are real and
// concurrent: the poll tick's selfHeal and the user's SwitchSession.
func TestRegroupOntoIsSingleFlight(t *testing.T) {
	f := oneSessionServer()
	entered := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	f.hook = func(args []string) {
		if args[0] == "new-session" {
			once.Do(func() { close(entered) })
			<-release
		}
	}

	c := newControllerWithRunner("web-abc", true, "services", f.run)
	c.SetClient("/dev/pts/1", 4242)

	first := make(chan error, 1)
	go func() { first <- c.regroupOnto("editors") }()

	<-entered // the first regroup is mid-flight, between new-session and switch-client

	if err := c.regroupOnto("mywork"); err != errRegroupInFlight {
		t.Fatalf("second regroup returned %v; want errRegroupInFlight", err)
	}

	close(release)
	if err := <-first; err != nil {
		t.Fatalf("first regroup: %v", err)
	}
	if n := f.count("new-session"); n != 1 {
		t.Errorf("new-session ran %d times; a refused regroup must not create a session", n)
	}

	// Once the first one has finished the latch is clear again.
	if err := c.regroupOnto("mywork"); err != nil {
		t.Fatalf("regroup after the first completed: %v", err)
	}
	if got := c.ident().groupBase; got != "mywork" {
		t.Errorf("groupBase = %q; want mywork", got)
	}
}

// selfHeal runs on every poll tick, so a user switching sessions while a heal is
// under way must not produce a second grouped session. Same latch, driven through
// the two PUBLIC entry points rather than regroupOnto directly.
func TestSelfHealAndSwitchSessionDoNotBothRegroup(t *testing.T) {
	f := oneSessionServer()
	// The pane's client sits on a session shared with another client, which is what
	// makes selfHeal decide to re-group.
	f.clients = append(f.clients,
		map[string]string{"client_pid": "99", "client_tty": "/dev/pts/2", "client_session": "services"})

	entered := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	f.hook = func(args []string) {
		if args[0] == "new-session" {
			once.Do(func() { close(entered) })
			<-release
		}
	}

	c := newControllerWithRunner("web-abc", true, "services", f.run)
	c.SetClient("/dev/pts/1", 4242)

	go c.selfHeal("services")
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("selfHeal never reached new-session")
	}

	if err := c.SwitchSession("editors"); err != errRegroupInFlight {
		t.Fatalf("SwitchSession during a heal returned %v; want errRegroupInFlight", err)
	}
	close(release)

	// Give the heal a moment to retire the latch before asserting the count.
	deadline := time.Now().Add(5 * time.Second)
	for c.ident().regrouping && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if n := f.count("new-session"); n != 1 {
		t.Errorf("new-session ran %d times; want exactly the heal's own", n)
	}
}
