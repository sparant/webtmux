package server

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// wsEcho stands up a real websocket server that hands one Read on a wsWrapper
// back to the test, so the limits can be exercised through gorilla rather than
// around it (the wrapper embeds *websocket.Conn — there is nothing to fake).
func wsRead(t *testing.T, limit int64, bufSize int, send []byte) (int, []byte, error) {
	t.Helper()
	type result struct {
		n   int
		buf []byte
		err error
	}
	done := make(chan result, 1)
	upgrader := websocket.Upgrader{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			done <- result{err: err}
			return
		}
		defer conn.Close()
		wrapped := newWSWrapper(conn, limit)
		buf := make([]byte, bufSize)
		n, err := wrapped.Read(buf)
		done <- result{n: n, buf: buf[:n], err: err}
	}))
	defer srv.Close()

	c, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer c.Close()
	// A write error is not a test failure here: when the frame is over the
	// transport limit the server tears the connection down while the bytes are
	// still going out, so the sender legitimately sees "connection reset". The
	// server-side result below is the assertion.
	_ = c.WriteMessage(websocket.TextMessage, send)

	select {
	case res := <-done:
		return res.n, res.buf, res.err
	case <-time.After(10 * time.Second):
		t.Fatal("server never returned from Read")
		return 0, nil, nil
	}
}

func TestWSWrapperReadsAMessageThatFits(t *testing.T) {
	msg := bytes.Repeat([]byte("x"), 900)
	n, got, err := wsRead(t, 1024, 1024, msg)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if n != len(msg) || !bytes.Equal(got, msg) {
		t.Errorf("read %d bytes, want %d", n, len(msg))
	}
}

// The transport ceiling. Before this the whole message was buffered by io.ReadAll
// and only THEN measured, so an unauthenticated client could make the server hold
// an arbitrary number of bytes just by announcing a large text frame. gorilla
// defaults to no limit at all, so this is the only thing standing between a
// websocket and the heap.
func TestWSWrapperRefusesAnOversizeFrameAtTheTransport(t *testing.T) {
	_, _, err := wsRead(t, 1024, 1024, bytes.Repeat([]byte("x"), 64*1024))
	if err == nil {
		t.Fatal("an oversize frame must fail the read")
	}
	if !strings.Contains(err.Error(), "read limit exceeded") {
		t.Errorf("error %q does not look like gorilla's read limit", err)
	}
}

// The caller's buffer is the other ceiling, and it is smaller here than the
// transport's. The message is read (bounded to one byte past the buffer) and
// refused with an honest error rather than silently truncated.
func TestWSWrapperRefusesAMessageLargerThanTheCallerBuffer(t *testing.T) {
	n, _, err := wsRead(t, 64*1024, 1024, bytes.Repeat([]byte("x"), 4096))
	if err == nil {
		t.Fatal("a message larger than the caller's buffer must fail the read")
	}
	if n != 0 {
		t.Errorf("a refused read must report 0 bytes, got %d", n)
	}
	if !strings.Contains(err.Error(), "exceeded buffer size (1024)") {
		t.Errorf("unhelpful error: %v", err)
	}
}

// One byte over is over: the boundary is where a truncating implementation would
// look correct.
func TestWSWrapperBoundary(t *testing.T) {
	if _, _, err := wsRead(t, 4096, 1024, bytes.Repeat([]byte("x"), 1024)); err != nil {
		t.Errorf("a message exactly the size of the buffer must be accepted: %v", err)
	}
	if _, _, err := wsRead(t, 4096, 1024, bytes.Repeat([]byte("x"), 1025)); err == nil {
		t.Error("one byte over the buffer must be refused")
	}
}
