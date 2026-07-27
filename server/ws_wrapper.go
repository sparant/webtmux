package server

import (
	"fmt"
	"io"

	"github.com/gorilla/websocket"
)

type wsWrapper struct {
	*websocket.Conn
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

		b, err := io.ReadAll(reader)
		if len(b) > len(p) {
			// err is usually nil here, so this must build a fresh error rather
			// than wrap: the caller would otherwise see a (0, nil) read and fail
			// with a misleading "unexpected zero length read" instead of the
			// real reason.
			return 0, fmt.Errorf("client message (%d bytes) exceeded buffer size (%d)", len(b), len(p))
		}
		n = copy(p, b)
		return n, err
	}
}
