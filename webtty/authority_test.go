package webtty

import (
	"encoding/json"
	"testing"

	"webtmux/pkg/tmux"
)

// The write-authority matrix, and the two properties it has to keep:
//
//  1. EXHAUSTIVENESS. Every message type the protocol accepts is classified.
//     A new one added to isTmuxMessage without a decision about its authority
//     fails here rather than defaulting into whichever behavior the compiler
//     happened to give it.
//  2. ENFORCEMENT AT THE GATE. The classification is applied in
//     handleMasterReadEvent, before dispatch — not inside individual handlers —
//     so a handler cannot be reached at all without the authority for it.

// TestEveryMessageTypeIsClassified sweeps the WHOLE byte space and demands a
// verdict for every value the protocol accepts. isTmuxMessage is the registry of
// tmux message types (handleTmuxMessage is dispatched through it), so anything it
// admits must also have an authority; the base protocol's four input types are
// listed explicitly.
func TestEveryMessageTypeIsClassified(t *testing.T) {
	base := []byte{Input, Ping, ResizeTerminal, SetEncoding}
	for _, b := range base {
		if authorityOf(b) == authUnclassified {
			t.Errorf("base message %q has no authority classification", b)
		}
	}
	for i := 0; i < 256; i++ {
		b := byte(i)
		if !isTmuxMessage(b) {
			continue
		}
		if authorityOf(b) == authUnclassified {
			t.Errorf("tmux message %q is accepted by isTmuxMessage but has no authority "+
				"classification — add it to authorityOf (view-only or requires -w)", b)
		}
	}
}

// The matrix itself, stated once, in the vocabulary of the design decision:
// read-only means WATCH.
func TestReadOnlyAllowsExactlyTheViewingMessages(t *testing.T) {
	view := []struct {
		name string
		msg  byte
	}{
		{"ping", Ping},
		{"resize", ResizeTerminal},
		{"set encoding", SetEncoding},
		{"capture request", TmuxCaptureRequest},
		{"save-info probe", TmuxSaveInfoRequest},
		{"refresh (repaint our own pane)", TmuxRefresh},
	}
	for _, tc := range view {
		if requiresWrite(tc.msg) {
			t.Errorf("%s (%q) must work on a read-only server", tc.name, tc.msg)
		}
	}

	write := []struct {
		name string
		msg  byte
	}{
		{"input", Input},
		{"select pane", TmuxSelectPane},
		// Not a nicety: a select-window moves the window every OTHER client
		// attached to that session is looking at.
		{"select window", TmuxSelectWindow},
		{"split pane", TmuxSplitPane},
		{"close pane", TmuxClosePane},
		{"copy mode", TmuxCopyMode},
		{"raw tmux command", TmuxSendCommand},
		{"scroll up", TmuxScrollUp},
		{"scroll down", TmuxScrollDown},
		{"new window", TmuxNewWindow},
		{"switch session", TmuxSwitchSession},
		{"rename window", TmuxRenameWindow},
		{"move window", TmuxMoveWindow},
		{"new session", TmuxNewSession},
		{"rename session", TmuxRenameSession},
		{"kill window", TmuxKillWindow},
		{"kill session", TmuxKillSession},
		{"link window", TmuxLinkWindow},
		{"unlink window", TmuxUnlinkWindow},
		{"save pane to a file on the server", TmuxSavePaneFile},
		{"rewrite the shared @wt_state", TmuxSetState},
	}
	for _, tc := range write {
		if !requiresWrite(tc.msg) {
			t.Errorf("%s (%q) mutates shared state and must require -w", tc.name, tc.msg)
		}
	}
}

// A type nobody has ruled on fails CLOSED. The gate asks requiresWrite, so an
// unclassified byte must be refused rather than waved through — the failure mode
// of a missed classification should be a control that does nothing, not a
// control that does everything.
func TestUnclassifiedMessagesFailClosed(t *testing.T) {
	if !requiresWrite('~') { // not a protocol message at all
		t.Error("an unclassified message type must be treated as a write")
	}
}

// Enforcement: drive handleMasterReadEvent (the real entry point) on a read-only
// WebTTY with the whole mutating surface and prove nothing reached tmux, then do
// the same with -w and prove it all did.
func TestGateBlocksMutationsWithoutPermitWrite(t *testing.T) {
	frames := [][]byte{
		{TmuxSelectPane, '%', '1'},
		{TmuxSelectWindow, '@', '3'},
		{TmuxSplitPane, 'h'},
		{TmuxClosePane, '%', '1'},
		{TmuxCopyMode, '1'},
		{TmuxScrollUp, '3'},
		{TmuxScrollDown, '3'},
		{TmuxNewWindow},
		{TmuxSwitchSession, 'x'},
		[]byte(string(rune(TmuxRenameWindow)) + "@3 build"),
		[]byte(string(rune(TmuxMoveWindow)) + "@3 2"),
		{TmuxNewSession},
		[]byte(string(rune(TmuxRenameSession)) + "old\x00new"),
		{TmuxKillWindow, '@', '3'},
		[]byte(string(rune(TmuxKillSession)) + "scratch"),
		[]byte(string(rune(TmuxLinkWindow)) + "@3 other"),
		{TmuxUnlinkWindow, '@', '3'},
		[]byte(string(rune(TmuxSetState)) + `{"v":1}`),
	}

	t.Run("read-only", func(t *testing.T) {
		wt, _, ctrl := newFailingWebTTY(t, &tmux.Layout{})
		for _, f := range frames {
			if err := wt.handleMasterReadEvent(f); err != nil {
				t.Fatalf("blocked message %q returned %v — that tears the connection down "+
					"and SIGHUPs the pane; blocked must mean dropped", f[0], err)
			}
		}
		if ctrl.calls != 0 {
			t.Errorf("a read-only server ran %d tmux commands: %v", ctrl.calls, ctrl.seen)
		}
	})

	t.Run("with -w", func(t *testing.T) {
		wt, _, ctrl := newFailingWebTTY(t, &tmux.Layout{})
		wt.permitWrite = true
		for _, f := range frames {
			if err := wt.handleMasterReadEvent(f); err != nil {
				t.Fatalf("message %q returned %v", f[0], err)
			}
		}
		if ctrl.calls != len(frames) {
			t.Errorf("with -w, %d of %d messages reached tmux: %v", ctrl.calls, len(frames), ctrl.seen)
		}
	})
}

// The view-only half of the same proof: a read-only client can still watch.
// Capture and save-info go through the capture provider, not the controller, so
// they are asserted against a fake provider; refresh-client is a controller call.
func TestGateLetsAReadOnlyClientWatch(t *testing.T) {
	wt, m, ctrl := newFailingWebTTY(t, &tmux.Layout{})
	cp := &countingCapture{}
	wt.SetCaptureProvider(cp)

	// (ResizeTerminal is classified view-only above but not driven here: it reaches
	// through to the pty slave, which this fixture does not have.)
	for _, f := range [][]byte{
		{Ping},
		[]byte("4base64"),
		[]byte(string(rune(TmuxCaptureRequest)) + `{"windows":"all"}`),
		[]byte(string(rune(TmuxSaveInfoRequest)) + `{"windowId":"@0"}`),
		{TmuxRefresh},
	} {
		if err := wt.handleMasterReadEvent(f); err != nil {
			t.Fatalf("view-only message %q was refused: %v", f[0], err)
		}
	}
	if ctrl.repainted == 0 {
		t.Error("refresh-client never reached the controller on a read-only server")
	}
	if ctrl.calls != 0 {
		t.Errorf("a view-only exchange mutated something: %v", ctrl.seen)
	}
	if len(m.sent()) == 0 {
		t.Error("nothing was sent back to a watching client")
	}
	cp.wait(t, 1) // the capture request ran
}

// The browser cannot grey out controls it does not know are forbidden, so the
// authority is part of the handshake — sent even when the operator configured no
// preferences at all (previously the frame was skipped entirely).
func TestInitMessageCarriesTheWriteAuthority(t *testing.T) {
	for _, tc := range []struct {
		name string
		opts []Option
		want bool
	}{
		{"read-only", nil, false},
		{"with -w", []Option{WithPermitWrite()}, true},
		{"merged with operator preferences", []Option{
			WithPermitWrite(), WithMasterPreferences(map[string]any{"fontSize": 14}),
		}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m := &recordMaster{}
			wt, err := New(m, nil, tc.opts...)
			if err != nil {
				t.Fatal(err)
			}
			if err := wt.sendInitializeMessage(); err != nil {
				t.Fatal(err)
			}
			var got *bool
			for _, f := range m.sent() {
				if f[0] != SetPreferences {
					continue
				}
				var prefs struct {
					PermitWrite *bool `json:"permitWrite"`
				}
				if err := json.Unmarshal(f[1:], &prefs); err != nil {
					t.Fatalf("preferences frame is not valid JSON: %s (%v)", f[1:], err)
				}
				if prefs.PermitWrite != nil {
					got = prefs.PermitWrite
				}
			}
			if got == nil {
				t.Fatalf("no preferences frame carried permitWrite: %q", m.sent())
			}
			if *got != tc.want {
				t.Errorf("permitWrite = %v, want %v", *got, tc.want)
			}
		})
	}
}

// The operator's own preferences must survive the merge — the flag rides along
// with them, it does not replace them.
func TestInitMessageKeepsConfiguredPreferences(t *testing.T) {
	m := &recordMaster{}
	wt, err := New(m, nil, WithMasterPreferences(map[string]any{"fontSize": 14}))
	if err != nil {
		t.Fatal(err)
	}
	if err := wt.sendInitializeMessage(); err != nil {
		t.Fatal(err)
	}
	var prefs struct {
		FontSize    int  `json:"fontSize"`
		PermitWrite bool `json:"permitWrite"`
	}
	for _, f := range m.sent() {
		if f[0] == SetPreferences {
			if err := json.Unmarshal(f[1:], &prefs); err != nil {
				t.Fatal(err)
			}
		}
	}
	if prefs.FontSize != 14 {
		t.Errorf("the configured fontSize was lost in the merge: %+v", prefs)
	}
	if prefs.PermitWrite {
		t.Errorf("permitWrite should be false without -w: %+v", prefs)
	}
}
