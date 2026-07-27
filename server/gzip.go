package server

import (
	"compress/gzip"
	"net/http"
	"strconv"
	"strings"
)

// gzipMinSize is the smallest body worth compressing. Below roughly this size
// the gzip header and trailer cost more than the deflate stream saves, so a
// tiny response comes out *larger*. 1400 bytes is the value NYTimes/gziphandler
// used (one Ethernet MTU worth of payload), kept so behaviour is unchanged from
// the archived dependency this replaces.
const gzipMinSize = 1400

// gzipHandler compresses responses for clients that advertise gzip support.
//
// This replaces github.com/NYTimes/gziphandler, which was archived upstream.
// Compression is not optional dressing here: the UI ships ~292 KB of xterm.js
// that gzips to roughly 80 KB, and SSH does not compress a tunnelled connection
// unless -C is set — so dropping it instead of replacing it would have made the
// first page load several times heavier over exactly the transport the portable
// launcher uses.
//
// The websocket endpoint is registered on a separate mux and never passes
// through here, so this deliberately does not implement http.Hijacker.
func gzipHandler(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// The response differs by request header whether or not we end up
		// compressing this one, so caches must be told regardless.
		w.Header().Add("Vary", "Accept-Encoding")

		if !acceptsGzip(r.Header.Get("Accept-Encoding")) {
			next.ServeHTTP(w, r)
			return
		}

		gw := &gzipResponseWriter{ResponseWriter: w, status: http.StatusOK}
		defer gw.Close()
		next.ServeHTTP(gw, r)
	})
}

// acceptsGzip reports whether an Accept-Encoding value asks for gzip. It honours
// an explicit "gzip;q=0", which is the documented way for a client to refuse an
// encoding that a bare substring match would happily hand it anyway.
func acceptsGzip(header string) bool {
	for _, part := range strings.Split(header, ",") {
		fields := strings.Split(strings.TrimSpace(part), ";")
		name := strings.ToLower(strings.TrimSpace(fields[0]))
		if name != "gzip" && name != "*" {
			continue
		}
		for _, param := range fields[1:] {
			param = strings.ToLower(strings.TrimSpace(param))
			if strings.HasPrefix(param, "q=") && isZeroQuality(param[2:]) {
				return false
			}
		}
		return true
	}
	return false
}

// isZeroQuality reports whether a q-value means "do not send this" — q=0, q=0.0,
// q=0.000. Anything unparseable is treated as acceptable, matching the general
// HTTP rule that a malformed parameter should not silently disable a feature.
func isZeroQuality(q string) bool {
	v, err := strconv.ParseFloat(q, 64)
	return err == nil && v == 0
}

// gzipResponseWriter defers the compress/don't-compress decision until it has
// either gzipMinSize bytes of body or the handler is finished, because that
// choice depends on the body's size and on headers the handler may still be
// setting. Nothing is written to the underlying ResponseWriter until then.
type gzipResponseWriter struct {
	http.ResponseWriter

	status  int
	buf     []byte
	decided bool
	gz      *gzip.Writer
}

func (w *gzipResponseWriter) WriteHeader(status int) {
	if w.decided {
		return
	}
	w.status = status
}

func (w *gzipResponseWriter) Write(p []byte) (int, error) {
	if w.decided {
		if w.gz != nil {
			return w.gz.Write(p)
		}
		return w.ResponseWriter.Write(p)
	}

	w.buf = append(w.buf, p...)
	if len(w.buf) >= gzipMinSize {
		if err := w.decide(); err != nil {
			return 0, err
		}
	}
	return len(p), nil
}

// Flush is what makes a streaming handler work through this wrapper: it forces
// the pending decision (a handler that flushes wants bytes on the wire now, even
// if it has produced fewer than gzipMinSize of them) and then pushes the gzip
// writer's own buffer out before flushing the connection.
func (w *gzipResponseWriter) Flush() {
	if !w.decided {
		w.decide()
	}
	if w.gz != nil {
		w.gz.Flush()
	}
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// Close settles a response that never reached gzipMinSize and finishes the gzip
// stream. It is safe to call more than once.
func (w *gzipResponseWriter) Close() error {
	if !w.decided {
		if err := w.decide(); err != nil {
			return err
		}
	}
	if w.gz != nil {
		err := w.gz.Close()
		w.gz = nil
		return err
	}
	return nil
}

// decide commits to compressed or plain, writes the status line, and drains
// whatever body was buffered while the decision was pending.
func (w *gzipResponseWriter) decide() error {
	w.decided = true
	header := w.ResponseWriter.Header()

	if w.shouldCompress(header) {
		// Content-Type must be pinned from the *uncompressed* bytes. Left unset,
		// net/http would sniff the gzip magic number off the first write and
		// label every asset application/x-gzip, which browsers do not execute.
		if header.Get("Content-Type") == "" {
			header.Set("Content-Type", http.DetectContentType(w.buf))
		}
		header.Set("Content-Encoding", "gzip")
		// The handler's Content-Length described the plain body, and byte ranges
		// of a compressed body are meaningless.
		header.Del("Content-Length")
		header.Del("Accept-Ranges")

		w.ResponseWriter.WriteHeader(w.status)
		w.gz = gzip.NewWriter(w.ResponseWriter)
		if len(w.buf) > 0 {
			_, err := w.gz.Write(w.buf)
			w.buf = nil
			return err
		}
		w.buf = nil
		return nil
	}

	w.ResponseWriter.WriteHeader(w.status)
	if len(w.buf) > 0 {
		_, err := w.ResponseWriter.Write(w.buf)
		w.buf = nil
		return err
	}
	w.buf = nil
	return nil
}

func (w *gzipResponseWriter) shouldCompress(header http.Header) bool {
	// Already encoded by the handler — re-compressing would corrupt the
	// Content-Encoding it declared.
	if header.Get("Content-Encoding") != "" {
		return false
	}
	// 204 and 304 carry no body; 206 is a byte range of the *plain* resource,
	// and its Content-Range would no longer describe what we sent. 1xx never
	// reaches here as a final status.
	switch w.status {
	case http.StatusNoContent, http.StatusNotModified, http.StatusPartialContent:
		return false
	}
	return len(w.buf) >= gzipMinSize
}
