package server

import (
	"fmt"
	"io"

	"github.com/gorilla/websocket"
)

// wsWrapper adapts a gorilla websocket to the io.ReadWriter webtty drives.
//
// The size ceiling is enforced TWICE, on purpose:
//
//   - newWSWrapper arms conn.SetReadLimit, so the gorilla reader itself refuses
//     an oversize frame and the bytes never accumulate anywhere. Without it a
//     client could announce a 2 GB text message and this server would buffer all
//     of it — the check below only ran AFTER io.ReadAll had already held the
//     whole thing in memory, which is a one-message OOM from an unprivileged
//     client.
//   - the io.LimitReader in Read bounds this copy to len(p)+1 bytes, which is
//     exactly enough to know the message did not fit without holding it. That
//     check stays even with the transport limit armed: the caller's buffer is the
//     real constraint, and it is the caller who must get the honest error.
type wsWrapper struct {
	*websocket.Conn
}

// newWSWrapper arms the transport-level read limit and returns the adapter.
// gorilla's default is unlimited.
func newWSWrapper(conn *websocket.Conn, limit int64) *wsWrapper {
	conn.SetReadLimit(limit)
	return &wsWrapper{Conn: conn}
}

func (wsw *wsWrapper) Write(p []byte) (n int, err error) {
	writer, err := wsw.Conn.NextWriter(websocket.TextMessage)
	if err != nil {
		return 0, err
	}
	defer writer.Close()
	return writer.Write(p)
}

func (wsw *wsWrapper) Read(p []byte) (n int, err error) {
	for {
		msgType, reader, err := wsw.Conn.NextReader()
		if err != nil {
			return 0, err
		}

		if msgType != websocket.TextMessage {
			continue
		}

		// One byte past the caller's buffer is all we need to detect an overflow,
		// and it is all we are willing to hold.
		b, err := io.ReadAll(io.LimitReader(reader, int64(len(p))+1))
		if len(b) > len(p) {
			// err is usually nil here, so this must build a fresh error rather
			// than wrap: the caller would otherwise see a (0, nil) read and fail
			// with a misleading "unexpected zero length read" instead of the
			// real reason. The message's true size is deliberately not reported —
			// it was never read.
			return 0, fmt.Errorf("client message exceeded buffer size (%d)", len(p))
		}
		n = copy(p, b)
		return n, err
	}
}
