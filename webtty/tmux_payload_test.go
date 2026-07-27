package webtty

import "testing"

// The move/unlink payloads grew an optional trailing SESSION field when the sidebar
// gained its flat all-windows tree: a row you drag (or click the × on) there can
// belong to a session this connection's pane is not attached to, which the server
// cannot infer from the connection. These tests pin the wire format, because the
// failure mode of getting it wrong is silent — the field is dropped and the command
// quietly acts on the pane's own session, i.e. reorders the wrong window list.
//
// recCtrl records the parsed arguments; everything else it needs comes from
// failCtrl (see tmux_nonfatal_test.go).
type recCtrl struct {
	failCtrl
	moveID     string
	movePos    int
	moveSess   string
	unlinkID   string
	unlinkSess string
	calls      int
}

func (c *recCtrl) MoveWindow(id string, pos int, session string) error {
	c.moveID, c.movePos, c.moveSess = id, pos, session
	c.calls++
	return nil
}

func (c *recCtrl) UnlinkWindow(id string, session string) error {
	c.unlinkID, c.unlinkSess = id, session
	c.calls++
	return nil
}

func newRecordingWebTTY(t *testing.T) (*WebTTY, *recCtrl) {
	t.Helper()
	wt, err := New(&recordMaster{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	ctrl := &recCtrl{}
	wt.SetTmuxController(ctrl)
	return wt, ctrl
}

func TestMoveWindowPayloadCarriesTheSession(t *testing.T) {
	cases := []struct {
		payload string
		id      string
		pos     int
		session string
	}{
		// The single-session view sends two fields: no session => the pane's own.
		{"@3 2", "@3", 2, ""},
		// The tree view names the list it reordered.
		{"@3 2 editors", "@3", 2, "editors"},
		// A session name with spaces stays whole (only the first two fields are ours).
		{"@3 0 my session", "@3", 0, "my session"},
	}
	for _, tc := range cases {
		wt, ctrl := newRecordingWebTTY(t)
		if err := wt.handleTmuxMessage(TmuxMoveWindow, []byte(tc.payload)); err != nil {
			t.Fatalf("%q: %v", tc.payload, err)
		}
		if ctrl.moveID != tc.id || ctrl.movePos != tc.pos || ctrl.moveSess != tc.session {
			t.Errorf("%q parsed as (%q, %d, %q); want (%q, %d, %q)",
				tc.payload, ctrl.moveID, ctrl.movePos, ctrl.moveSess, tc.id, tc.pos, tc.session)
		}
	}
}

func TestMoveWindowPayloadRejectsANonNumericPosition(t *testing.T) {
	// "@3 editors" would be a tree-view move with the position left out. Acting on it
	// (as position 0) would silently jump the window to the top of the list, so it is
	// dropped instead.
	wt, ctrl := newRecordingWebTTY(t)
	if err := wt.handleTmuxMessage(TmuxMoveWindow, []byte("@3 editors")); err != nil {
		t.Fatal(err)
	}
	if ctrl.calls != 0 {
		t.Errorf("malformed move was executed: (%q, %d, %q)", ctrl.moveID, ctrl.movePos, ctrl.moveSess)
	}
}

func TestUnlinkWindowPayloadCarriesTheSession(t *testing.T) {
	cases := []struct {
		payload string
		id      string
		session string
	}{
		{"@3", "@3", ""},                      // this pane's own session
		{"@3 editors", "@3", "editors"},       // the tree view's row said which
		{"@3 my session", "@3", "my session"}, // …spaces and all
	}
	for _, tc := range cases {
		wt, ctrl := newRecordingWebTTY(t)
		if err := wt.handleTmuxMessage(TmuxUnlinkWindow, []byte(tc.payload)); err != nil {
			t.Fatalf("%q: %v", tc.payload, err)
		}
		if ctrl.unlinkID != tc.id || ctrl.unlinkSess != tc.session {
			t.Errorf("%q parsed as (%q, %q); want (%q, %q)",
				tc.payload, ctrl.unlinkID, ctrl.unlinkSess, tc.id, tc.session)
		}
	}
}
