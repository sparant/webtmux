package server

type InitMessage struct {
	Arguments string `json:"Arguments,omitempty"`
	AuthToken string `json:"AuthToken,omitempty"`
	// Session is the caller-chosen tmux session name for this connection. The
	// split-view frontend generates one grouped-session name per extra region
	// (e.g. "web-a1b2c3") and sends it here at connect time; the server threads
	// it into BOTH the pty env (so attach-web.sh joins that grouped session) and
	// this connection's per-connection tmux layout controller. Empty => the
	// default shared base session (single-view / primary region, unchanged).
	Session string `json:"Session,omitempty"`
}
