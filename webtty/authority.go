package webtty

// Write authority: which client->server messages a server started WITHOUT `-w`
// is allowed to act on.
//
// `-w` (permit-write) used to mean exactly one thing: keystrokes may reach the
// pty. Everything else a browser can ask for arrived later — select/kill/rename
// a window, switch or kill a SESSION, rewrite the shared @wt_state blob, and
// write a file on the machine tmux runs on — and none of it was ever put behind
// the flag. So a "read-only" server handed any authenticated client the whole
// tmux server plus a filesystem write primitive; the only thing they could not
// do was type.
//
// The rule here is that read-only means WATCH. Not "watch, but you may still
// move the shared console to another window" — a select-window is visible to
// every other client attached to that session, so it is a write. What survives
// is the set of messages that change nothing anyone else can observe: asking for
// capture buffers, asking where a save WOULD land, repainting your own pane,
// ping, and the two frames that describe this browser's own terminal (resize and
// encoding).
//
// The classification is a function rather than a check scattered through
// handleTmuxMessage so that (a) it is enforced ONCE, before dispatch, and (b) a
// message type added later without a decision about its authority fails a test
// instead of silently defaulting to "allowed" (see authority_test.go).

// msgAuthority is what one message type is allowed to do.
type msgAuthority int

const (
	// authUnclassified is the zero value: a message type nobody has decided
	// about. Treated as a write at the gate (fail closed) and failed by the
	// exhaustiveness test.
	authUnclassified msgAuthority = iota
	// authView changes nothing another client can observe.
	authView
	// authWrite mutates the tmux server, the pty, or the filesystem.
	authWrite
)

// authorityOf classifies one client->server message type.
//
// Both message-type spaces are covered: the base protocol ('1'..'4') and the
// tmux extension ('5'..'R'). They are disjoint by construction, so one switch
// can speak for both.
func authorityOf(msgType byte) msgAuthority {
	switch msgType {

	// ---- view-only ------------------------------------------------------------
	case Ping:
		return authView
	case ResizeTerminal, SetEncoding:
		// Facts about THIS browser's terminal. A resize reaches the pty, but the
		// pty is this connection's own; nothing shared moves.
		return authView
	case TmuxCaptureRequest:
		// Reads window contents. It forks `capture-pane`, which is a read.
		return authView
	case TmuxSaveInfoRequest:
		// "Where would a save land?" — deliberately writes nothing (the writability
		// probe creates and removes its own temp file, which is not user-visible
		// state).
		return authView
	case TmuxScrollbackRequest:
		// Reads one window's history buffer. `capture-pane -S -` is the same read
		// as any other capture — bigger, but it moves nothing. Read-only servers
		// keep it deliberately: "Download to browser" is the save path that asks
		// nothing of the filesystem, and it is the only one they have.
		return authView
	case TmuxRefresh:
		// `refresh-client` on this pane's OWN client: it repaints a screen that the
		// hover preview scribbled on. No tmux state changes.
		return authView

	// ---- requires -w ----------------------------------------------------------
	case Input:
		// The original meaning of the flag, kept here so the matrix is complete and
		// the table test speaks about it too.
		return authWrite
	case TmuxSelectPane, TmuxSelectWindow, TmuxSplitPane, TmuxClosePane:
		return authWrite
	case TmuxCopyMode, TmuxScrollUp, TmuxScrollDown:
		// Copy mode and scrolling drive tmux MODES on a shared pane: another client
		// attached to the same session watches the scrollback move.
		return authWrite
	case TmuxNewWindow, TmuxRenameWindow, TmuxMoveWindow, TmuxKillWindow,
		TmuxLinkWindow, TmuxUnlinkWindow:
		return authWrite
	case TmuxNewSession, TmuxSwitchSession, TmuxRenameSession, TmuxKillSession:
		return authWrite
	case TmuxSendCommand:
		// Never implemented (handleTmuxMessage has no case for it), but it is in
		// isTmuxMessage and its NAME is "run an arbitrary tmux command" — the last
		// thing that should default open if someone wires it up.
		return authWrite
	case TmuxSavePaneFile:
		// Writes a file on the machine tmux runs on.
		return authWrite
	case TmuxSetState:
		// Rewrites @wt_state, which every other client adopts.
		return authWrite
	}
	return authUnclassified
}

// requiresWrite is the gate's question: may a read-only connection act on this?
// Unclassified fails closed — a message type nobody has ruled on is refused
// rather than waved through.
func requiresWrite(msgType byte) bool {
	return authorityOf(msgType) != authView
}
