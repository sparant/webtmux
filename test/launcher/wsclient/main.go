// Command wsclient is a headless stand-in for a browser region, used by the
// launcher's end-to-end suite.
//
// Split-view is the regression the launcher's attach script exists to prevent,
// and it fails QUIETLY — regions mirror each other instead of erroring — so it
// has to be exercised for real. Opening two of these with different -session
// values is exactly what a browser does when you add a region: the server turns
// the name into a Webtmux-Session header, localcommand turns that into
// HTTP_WEBTMUX_SESSION, and the attach script joins a grouped session.
package main

import (
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/gorilla/websocket"
)

func main() {
	url := flag.String("url", "", "ws://host:port/<secret>/ws")
	session := flag.String("session", "", "region session name (empty = primary/shared)")
	token := flag.String("token", "", "AuthToken (webtmux's credential; empty with --no-auth)")
	input := flag.String("input", "", "keystrokes to send once connected")
	dwell := flag.Duration("dwell", 3*time.Second, "how long to stay connected")
	flag.Parse()

	if *url == "" {
		fmt.Fprintln(os.Stderr, "wsclient: -url is required")
		os.Exit(2)
	}
	dialer := websocket.Dialer{Subprotocols: []string{"webtty"}, HandshakeTimeout: 10 * time.Second}
	conn, _, err := dialer.Dial(*url, nil)
	if err != nil {
		fmt.Fprintf(os.Stderr, "wsclient: dial: %v\n", err)
		os.Exit(1)
	}
	defer conn.Close()

	init, _ := json.Marshal(struct {
		AuthToken string `json:"AuthToken"`
		Session   string `json:"Session,omitempty"`
	}{AuthToken: *token, Session: *session})
	if err := conn.WriteMessage(websocket.TextMessage, init); err != nil {
		fmt.Fprintf(os.Stderr, "wsclient: init: %v\n", err)
		os.Exit(1)
	}

	// '3' is ResizeTerminal — without a size the pty stays at 0x0 and tmux
	// refuses the attach.
	size, _ := json.Marshal(struct{ Columns, Rows int }{100, 30})
	_ = conn.WriteMessage(websocket.TextMessage, append([]byte{'3'}, size...))

	if *input != "" {
		time.Sleep(500 * time.Millisecond)
		// '1' is Input.
		_ = conn.WriteMessage(websocket.TextMessage, append([]byte{'1'}, []byte(*input)...))
	}

	deadline := time.Now().Add(*dwell)
	_ = conn.SetReadDeadline(deadline)
	for time.Now().Before(deadline) {
		_, msg, err := conn.ReadMessage()
		if err != nil {
			break
		}
		// Output is always base64-encoded on the wire; input is raw unless a
		// SetEncoding message asked otherwise, which we never send.
		if len(msg) > 1 && msg[0] == '1' {
			if b, err := base64.StdEncoding.DecodeString(string(msg[1:])); err == nil {
				os.Stdout.Write(b)
			}
		}
	}
}
