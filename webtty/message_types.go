package webtty

// Protocols defines the name of this protocol,
// which is supposed to be used to the subprotocol of Websockt streams.
var Protocols = []string{"webtty"}

const (
	// Unknown message type, maybe sent by a bug
	UnknownInput = '0'
	// User input typically from a keyboard
	Input = '1'
	// Ping to the server
	Ping = '2'
	// Notify that the browser size has been changed
	ResizeTerminal = '3'
	// Change encoding
	SetEncoding = '4'
)

const (
	// Unknown message type, maybe set by a bug
	UnknownOutput = '0'
	// Normal output to the terminal
	Output = '1'
	// Pong to the browser
	Pong = '2'
	// Set window title of the terminal
	SetWindowTitle = '3'
	// Set terminal preference
	SetPreferences = '4'
	// Make terminal to reconnect
	SetReconnect = '5'
	// Set the input buffer size
	SetBufferSize = '6'

	// Tmux layout update (JSON payload)
	TmuxLayoutUpdate = '7'
	// Tmux pane-specific output
	TmuxPaneOutput = '8'
	// Tmux mode update (copy mode state)
	TmuxModeUpdate = '9'
	// Tmux window capture data (JSON payload; see TmuxCaptureRequest). Reuses the
	// 'A' output slot formerly reserved for the never-emitted TmuxSessionInfo.
	TmuxCaptureData = 'A'
	// Tmux error
	TmuxError = 'B'
	// Result of a TmuxSavePaneFile request (JSON payload: {"ok":bool,"path":"…",
	// "error":"…","env":{…}}). Lets the browser report where the file landed, or
	// why not — the env is the SaveEnv the write was resolved against.
	TmuxSaveResult = 'C'
	// Answer to a TmuxSaveInfoRequest: the SaveEnv for one window (JSON) — which
	// directory a relative save resolves against, whether the pane's own directory
	// is visible to webtmux at all, and whether webtmux is containerized. Shown in
	// the save dropdown BEFORE a save, so a surprising destination is never a
	// surprise. See webtty/savepath.go.
	TmuxSaveInfo = 'D'
)

// Tmux input message types (client -> server)
const (
	// Select a pane by ID
	TmuxSelectPane = '5'
	// Select a window by ID
	TmuxSelectWindow = '6'
	// Split current pane (payload: "h" or "v")
	TmuxSplitPane = '7'
	// Close a pane by ID
	TmuxClosePane = '8'
	// Enter/exit copy mode (payload: "1" or "0")
	TmuxCopyMode = '9'
	// Raw tmux command
	TmuxSendCommand = 'A'
	// Scroll in copy mode (payload: lines as string)
	TmuxScrollUp   = 'B'
	TmuxScrollDown = 'C'
	// Create new window
	TmuxNewWindow = 'D'
	// Switch session by name
	TmuxSwitchSession = 'E'
	// Rename a window (payload: "<windowID> <new name>")
	TmuxRenameWindow = 'F'
	// Request capture buffers (payload JSON: {"windows":["@3",...]|"all","force":bool})
	TmuxCaptureRequest = 'G'
	// Reorder a window to a new ordinal position (payload: "<windowID> <targetPos>",
	// targetPos 0-based in index order). Drag-and-drop from the sidebar.
	TmuxMoveWindow = 'H'
	// Create a fresh session and switch this pane's view to it (no payload).
	TmuxNewSession = 'I'
	// Rename a session (payload: "<oldName> <new name>"). Double-click a session
	// tab in the sidebar.
	TmuxRenameSession = 'J'
	// Kill a window by id (payload: "<windowID>"). Sidebar hover × on a window.
	TmuxKillWindow = 'K'
	// Kill a session by name (payload: "<sessionName>"). Sidebar hover × on a session.
	TmuxKillSession = 'L'
	// Link a window into another session (payload: "<windowID> <targetSession>").
	// Drag a window tab onto a session tab in the sidebar. The window keeps running
	// and now appears in both sessions.
	TmuxLinkWindow = 'M'
	// Unlink a window from THIS pane's session (payload: "<windowID>"). Sidebar
	// hover × on a window that is linked into other sessions too — removes it here
	// but leaves it running in the others (contrast TmuxKillWindow, the last-link
	// case which ends its processes).
	TmuxUnlinkWindow = 'N'
	// Save a window's pane buffer to a file on the machine tmux runs on (payload
	// JSON: {"windowId":"@N","path":"~/out.txt"}). The server captures the pane
	// fresh, writes clean text, and replies with a TmuxSaveResult. Relative paths
	// resolve against the pane's own working directory.
	TmuxSavePaneFile = 'O'
	// Persist the shared UI visual-state blob into the tmux SERVER-global option
	// @wt_state (payload: the raw JSON blob). It round-trips back to every client on
	// the next TmuxLayoutUpdate (Layout.State), so the visual state is shared across
	// clients and survives reconnect / webtmux restart. See StateStore on the client.
	TmuxSetState = 'P'
	// Force tmux to fully redraw THIS pane's client (no payload). The browser paints
	// hover previews by blitting another window's cached capture straight into a
	// region's xterm; ending the hover has to put the region's REAL screen back, and
	// only tmux knows it. `refresh-client` repaints it authoritatively. See
	// hover-preview.js on the client.
	TmuxRefresh = 'Q'
	// Ask where a save for this window would land (payload JSON: {"windowId":"@N"}).
	// Read-only — writes nothing; the reply is a TmuxSaveInfo.
	TmuxSaveInfoRequest = 'R'
)
