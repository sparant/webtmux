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
	moveID        string
	movePos       int
	moveSess      string
	unlinkID      string
	unlinkSess    string
	newWindowSess string
	renameOld     string
	renameNew     string
	calls         int
}

func (c *recCtrl) RenameSession(oldName, newName string) error {
	c.renameOld, c.renameNew = oldName, newName
	c.calls++
	return nil
}

func (c *recCtrl) MoveWindow(id string, pos int, session string) error {
	c.moveID, c.movePos, c.moveSess = id, pos, session
	c.calls++
	return nil
}

func (c *recCtrl) NewWindow(session string) error {
	c.newWindowSess = session
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

func TestNewWindowPayloadCarriesTheSession(t *testing.T) {
	// Each session in the tree view has its own "+", so the target rides the payload;
	// the toolbar chord and the default view send nothing, meaning "this pane's".
	for _, tc := range []struct{ payload, session string }{
		{"", ""},
		{"editors", "editors"},
		{"  editors  ", "editors"},
	} {
		wt, ctrl := newRecordingWebTTY(t)
		if err := wt.handleTmuxMessage(TmuxNewWindow, []byte(tc.payload)); err != nil {
			t.Fatalf("%q: %v", tc.payload, err)
		}
		if ctrl.newWindowSess != tc.session || ctrl.calls != 1 {
			t.Errorf("%q created in %q (calls=%d); want %q", tc.payload, ctrl.newWindowSess, ctrl.calls, tc.session)
		}
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

// Rename-session is the only payload whose FIRST field is user-typed, so it is
// the only one the "machine field first, one user string last" rule can't save.
// It is NUL-delimited (tmux forbids NUL in a session name); the old form split on
// the first space, which turned a rename of "my project" into a rename aimed at
// "my" — and the server resolves a session target by PREFIX, so that hit whatever
// session started with it, with no error anywhere.
func TestRenameSessionPayloadIsNULDelimited(t *testing.T) {
	cases := []struct{ payload, old, fresh string }{
		{"old\x00new", "old", "new"},
		{"my project\x00my other project", "my project", "my other project"},
		{"a, b | c\x00-dashed | name", "a, b | c", "-dashed | name"},
		{"dev\x00", "dev", ""},
	}
	for _, tc := range cases {
		wt, ctrl := newRecordingWebTTY(t)
		if err := wt.handleTmuxMessage(TmuxRenameSession, []byte(tc.payload)); err != nil {
			t.Fatalf("%q: %v", tc.payload, err)
		}
		if ctrl.renameOld != tc.old || ctrl.renameNew != tc.fresh || ctrl.calls != 1 {
			t.Errorf("%q parsed as (%q, %q) calls=%d; want (%q, %q)",
				tc.payload, ctrl.renameOld, ctrl.renameNew, ctrl.calls, tc.old, tc.fresh)
		}
	}
}

func TestRenameSessionPayloadWithoutTheSeparatorIsDropped(t *testing.T) {
	// The old space form, or anything else unstructured. Guessing at it is what
	// produced the wrong-session rename, so it is dropped — the browser and the
	// server ship from the same bundle, so there is no old client to serve.
	for _, payload := range []string{"old new", "old", "", "   "} {
		wt, ctrl := newRecordingWebTTY(t)
		if err := wt.handleTmuxMessage(TmuxRenameSession, []byte(payload)); err != nil {
			t.Fatalf("%q: %v", payload, err)
		}
		if ctrl.calls != 0 {
			t.Errorf("%q was executed as (%q, %q)", payload, ctrl.renameOld, ctrl.renameNew)
		}
	}
}
