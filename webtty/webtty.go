package webtty

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"sync"
)

// WebTTY bridges a PTY slave and its PTY master.
// To support text-based streams and side channel commands such as
// terminal resizing, WebTTY uses an original protocol.
type WebTTY struct {
	// PTY Master, which probably a connection to browser
	masterConn Master
	// PTY Slave
	slave Slave

	windowTitle []byte
	permitWrite bool
	columns     int
	rows        int
	reconnect   int // in seconds
	masterPrefs []byte
	decoder     Decoder

	bufferSize int
	writeMutex sync.Mutex

	// blockedMu guards blockedLogged: the set of message types this connection
	// has already refused for want of `-w`. A read-only browser re-sends the same
	// blocked message on every poll/gesture, so logging each one would bury the
	// log; one line per type per connection says everything the operator needs.
	blockedMu     sync.Mutex
	blockedLogged map[byte]bool

	// Tmux controller for tmux-specific operations
	tmuxCtrl TmuxController

	// captureProvider is the SERVER-GLOBAL window-capture store, shared by pointer
	// across every connection (set alongside tmuxCtrl). Kept off the per-connection
	// TmuxController so "one capture per window across all connections" is intrinsic.
	captureProvider CaptureProvider
}

// DefaultBufferSize bounds a SINGLE client->server message (wsWrapper.Read
// errors, tearing down the connection, if a message exceeds it) and the
// server->client output chunk size. The old 1024 default meant any paste over
// ~760 raw bytes (base64 inflates 4/3) dropped the WebSocket and lost the input.
// The client now chunks input well under this, so this is headroom + fewer output
// frames.
//
// Exported because the SERVER has to arm the same ceiling on the websocket itself
// (SetReadLimit), one layer below this one, and the two must not drift: a
// transport limit under the buffer size would tear down connections carrying
// messages webtty is perfectly willing to accept.
const DefaultBufferSize = 128 * 1024

// New creates a new instance of WebTTY.
// masterConn is a connection to the PTY master,
// typically it's a websocket connection to a client.
// slave is a PTY slave such as a local command with a PTY.
func New(masterConn Master, slave Slave, options ...Option) (*WebTTY, error) {
	wt := &WebTTY{
		masterConn: masterConn,
		slave:      slave,

		permitWrite: false,
		columns:     0,
		rows:        0,

		bufferSize: DefaultBufferSize,
		decoder:    &NullCodec{},
	}

	for _, option := range options {
		option(wt)
	}

	return wt, nil
}

// Run starts the main process of the WebTTY.
// This method blocks until the context is canceled.
// Note that the master and slave are left intact even
// after the context is canceled. Closing them is caller's
// responsibility.
// If the connection to one end gets closed, returns ErrSlaveClosed or ErrMasterClosed.
func (wt *WebTTY) Run(ctx context.Context) error {
	err := wt.sendInitializeMessage()
	if err != nil {
		return fmt.Errorf("failed to send initializing message: %w", err)
	}

	errs := make(chan error, 2)

	go func() {
		errs <- func() error {
			buffer := make([]byte, wt.bufferSize)
			for {
				//base64 length
				effectiveBufferSize := wt.bufferSize - 1
				//max raw data length
				maxChunkSize := int(effectiveBufferSize/4) * 3

				n, err := wt.slave.Read(buffer[:maxChunkSize])
				if err != nil {
					return ErrSlaveClosed
				}

				err = wt.handleSlaveReadEvent(buffer[:n])
				if err != nil {
					return err
				}
			}
		}()
	}()

	go func() {
		errs <- func() error {
			buffer := make([]byte, wt.bufferSize)
			for {
				n, err := wt.masterConn.Read(buffer)
				if err != nil {
					return ErrMasterClosed
				}

				err = wt.handleMasterReadEvent(buffer[:n])
				if err != nil {
					return err
				}
			}
		}()
	}()

	select {
	case <-ctx.Done():
		err = ctx.Err()
	case err = <-errs:
	}

	return err
}

func (wt *WebTTY) sendInitializeMessage() error {
	err := wt.masterWrite(append([]byte{SetWindowTitle}, wt.windowTitle...))
	if err != nil {
		return fmt.Errorf("failed to send window title: %w", err)
	}

	bufSizeMsg, _ := json.Marshal(wt.bufferSize)
	err = wt.masterWrite(append([]byte{SetBufferSize}, bufSizeMsg...))
	if err != nil {
		return fmt.Errorf("failed to send buffer size: %w", err)
	}

	if wt.reconnect > 0 {
		reconnect, _ := json.Marshal(wt.reconnect)
		err := wt.masterWrite(append([]byte{SetReconnect}, reconnect...))
		if err != nil {
			return fmt.Errorf("failed to set reconnect: %w", err)
		}
	}

	// Preferences are ALWAYS sent now, even when the operator configured none:
	// they carry `permitWrite`, and the browser has to learn this connection's
	// authority to grey out the controls it may not use. A read-only viewer that
	// is not told is a viewer clicking things that silently do nothing.
	for _, prefs := range wt.preferencesFrames() {
		if err := wt.masterWrite(append([]byte{SetPreferences}, prefs...)); err != nil {
			return fmt.Errorf("failed to set preferences: %w", err)
		}
	}

	// Send initial tmux layout if available
	if wt.tmuxCtrl != nil {
		wt.tmuxCtrl.RefreshLayout()
		if err := wt.SendTmuxLayout(); err != nil {
			// Non-fatal: log and continue
		}
	}

	return nil
}

// preferencesFrames are the SetPreferences payloads to send at init: whatever the
// operator configured (WithMasterPreferences), plus this connection's
// `permitWrite`.
//
// Normally that is ONE frame — the flag merged into the configured object — so
// the browser applies the whole preference set at once. If the configured value
// is not a JSON object (nothing in this repo sets one, but the option takes
// `any`) it is passed through verbatim and the authority flag rides in a second
// frame: a strange preferences value must never cost the browser the one field
// it needs to know what it may do.
func (wt *WebTTY) preferencesFrames() [][]byte {
	permit, _ := json.Marshal(wt.permitWrite)
	own := []byte(`{"permitWrite":` + string(permit) + `}`)

	if len(wt.masterPrefs) == 0 {
		return [][]byte{own}
	}
	merged := map[string]json.RawMessage{}
	if err := json.Unmarshal(wt.masterPrefs, &merged); err != nil {
		return [][]byte{wt.masterPrefs, own}
	}
	merged["permitWrite"] = permit
	data, err := json.Marshal(merged)
	if err != nil {
		return [][]byte{wt.masterPrefs, own}
	}
	return [][]byte{data}
}

func (wt *WebTTY) handleSlaveReadEvent(data []byte) error {
	safeMessage := base64.StdEncoding.EncodeToString(data)
	err := wt.masterWrite(append([]byte{Output}, []byte(safeMessage)...))
	if err != nil {
		return fmt.Errorf("failed to send message to master: %w", err)
	}

	return nil
}

func (wt *WebTTY) masterWrite(data []byte) error {
	wt.writeMutex.Lock()
	defer wt.writeMutex.Unlock()

	_, err := wt.masterConn.Write(data)
	if err != nil {
		return fmt.Errorf("failed to write to master: %w", err)
	}

	return nil
}

func (wt *WebTTY) handleMasterReadEvent(data []byte) error {
	if len(data) == 0 {
		return errors.New("unexpected zero length read from master")
	}

	// The write-authority gate. Enforced HERE, once, before any handler runs, so
	// that no future message type can reach tmux or the filesystem by being added
	// to handleTmuxMessage and nowhere else. See authority.go for the matrix.
	//
	// Blocked messages are dropped, not fatal: returning an error from here unwinds
	// Run -> processWSConn, whose `defer slave.Close()` SIGHUPs the pane's tmux
	// client ([lost tty]). A read-only browser whose optimistic UI sends one
	// forbidden click must not lose its terminal over it — it is told the mode at
	// init and greys those controls out anyway.
	if !wt.permitWrite && requiresWrite(data[0]) {
		wt.logBlocked(data[0])
		return nil
	}

	switch data[0] {
	case Input:
		if len(data) <= 1 {
			return nil
		}

		var decodedBuffer = make([]byte, len(data))
		n, err := wt.decoder.Decode(decodedBuffer, data[1:])
		if err != nil {
			return fmt.Errorf("failed to decode received data: %w", err)
		}

		_, err = wt.slave.Write(decodedBuffer[:n])
		if err != nil {
			return fmt.Errorf("failed to write received data to slave: %w", err)
		}

	case Ping:
		err := wt.masterWrite([]byte{Pong})
		if err != nil {
			return fmt.Errorf("failed to return Pong message to master: %w", err)
		}

	case SetEncoding:
		switch string(data[1:]) {
		case "base64":
			wt.decoder = base64.StdEncoding
		case "null":
			wt.decoder = NullCodec{}
		}

	case ResizeTerminal:
		if wt.columns != 0 && wt.rows != 0 {
			break
		}

		if len(data) <= 1 {
			return errors.New("received malformed remote command for terminal resize: empty payload")
		}

		var args argResizeTerminal
		err := json.Unmarshal(data[1:], &args)
		if err != nil {
			return fmt.Errorf("received malformed data for terminal resize: %w", err)
		}
		rows := wt.rows
		if rows == 0 {
			rows = int(args.Rows)
		}

		columns := wt.columns
		if columns == 0 {
			columns = int(args.Columns)
		}

		wt.slave.ResizeTerminal(columns, rows)

	default:
		// Check if it's a tmux message
		if isTmuxMessage(data[0]) {
			return wt.handleTmuxMessage(data[0], data[1:])
		}
		return fmt.Errorf("unknown message type `%c`", data[0])
	}

	return nil
}

// logBlocked reports the first refusal of each message type on this connection.
//
// Input is deliberately silent: it arrives once per keystroke, so a read-only
// viewer resting a finger on a key would write the log a line at a time, and
// "clients cannot type" is what the flag has always meant — it needs no notice.
// Everything else is a control the browser offered and the server refused, which
// is worth exactly one line saying which flag turns it on.
func (wt *WebTTY) logBlocked(msgType byte) {
	if msgType == Input {
		return
	}
	wt.blockedMu.Lock()
	defer wt.blockedMu.Unlock()
	if wt.blockedLogged == nil {
		wt.blockedLogged = map[byte]bool{}
	}
	if wt.blockedLogged[msgType] {
		return
	}
	wt.blockedLogged[msgType] = true
	log.Printf("read-only server: refusing %q messages from this client (start webtmux with -w to permit writes)", msgType)
}

type argResizeTerminal struct {
	Columns float64
	Rows    float64
}
