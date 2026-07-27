package server

import (
	"bytes"
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// body of a size that clears gzipMinSize, and compresses well enough that a
// failure to compress is unmistakable in the recorded length.
func largeBody() []byte {
	return bytes.Repeat([]byte("webtmux "), 400) // 3200 bytes
}

func serve(t *testing.T, acceptEncoding string, h http.HandlerFunc) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/js/webtmux.js", nil)
	if acceptEncoding != "" {
		req.Header.Set("Accept-Encoding", acceptEncoding)
	}
	rec := httptest.NewRecorder()
	gzipHandler(h).ServeHTTP(rec, req)
	return rec
}

func TestGzipCompressesLargeBodyForWillingClient(t *testing.T) {
	want := largeBody()
	rec := serve(t, "gzip", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/javascript")
		w.Write(want)
	})

	if got := rec.Header().Get("Content-Encoding"); got != "gzip" {
		t.Fatalf("Content-Encoding = %q, want gzip", got)
	}
	if got := rec.Header().Get("Content-Type"); got != "application/javascript" {
		t.Errorf("Content-Type = %q, want the handler's own value", got)
	}
	if !strings.Contains(rec.Header().Get("Vary"), "Accept-Encoding") {
		t.Errorf("Vary = %q, want it to include Accept-Encoding", rec.Header().Get("Vary"))
	}
	if rec.Body.Len() >= len(want) {
		t.Errorf("compressed body is %d bytes, not smaller than the %d-byte original", rec.Body.Len(), len(want))
	}

	zr, err := gzip.NewReader(rec.Body)
	if err != nil {
		t.Fatalf("body is not valid gzip: %v", err)
	}
	got, err := io.ReadAll(zr)
	if err != nil {
		t.Fatalf("reading gzip body: %v", err)
	}
	if !bytes.Equal(got, want) {
		t.Errorf("decompressed body does not round-trip")
	}
}

func TestGzipPassesThroughWhenClientDoesNotAskForIt(t *testing.T) {
	want := largeBody()
	for _, accept := range []string{"", "deflate, br", "gzip;q=0"} {
		rec := serve(t, accept, func(w http.ResponseWriter, r *http.Request) {
			w.Write(want)
		})
		if got := rec.Header().Get("Content-Encoding"); got != "" {
			t.Errorf("Accept-Encoding %q: Content-Encoding = %q, want none", accept, got)
		}
		if !bytes.Equal(rec.Body.Bytes(), want) {
			t.Errorf("Accept-Encoding %q: body was altered", accept)
		}
	}
}

// A tiny body gets bigger when gzipped, so it must be sent as-is even though the
// client would accept compression.
func TestGzipLeavesSmallBodyUncompressed(t *testing.T) {
	want := []byte("ok")
	rec := serve(t, "gzip", func(w http.ResponseWriter, r *http.Request) {
		w.Write(want)
	})
	if got := rec.Header().Get("Content-Encoding"); got != "" {
		t.Errorf("Content-Encoding = %q, want none for a %d-byte body", got, len(want))
	}
	if !bytes.Equal(rec.Body.Bytes(), want) {
		t.Errorf("body = %q, want %q", rec.Body.Bytes(), want)
	}
}

func TestGzipPreservesStatusAndDropsStaleContentLength(t *testing.T) {
	rec := serve(t, "gzip", func(w http.ResponseWriter, r *http.Request) {
		body := largeBody()
		w.Header().Set("Content-Length", "3200")
		w.WriteHeader(http.StatusNotFound)
		w.Write(body)
	})
	if rec.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404", rec.Code)
	}
	if got := rec.Header().Get("Content-Length"); got != "" {
		t.Errorf("Content-Length = %q, want it removed once the body is compressed", got)
	}
}

// A handler that writes no body at all must still produce its status line.
func TestGzipEmptyBodyStillWritesStatus(t *testing.T) {
	rec := serve(t, "gzip", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	if rec.Code != http.StatusNoContent {
		t.Errorf("status = %d, want 204", rec.Code)
	}
	if rec.Body.Len() != 0 {
		t.Errorf("body = %q, want empty", rec.Body.Bytes())
	}
	if got := rec.Header().Get("Content-Encoding"); got != "" {
		t.Errorf("Content-Encoding = %q, want none on a bodiless response", got)
	}
}

// Without an explicit Content-Type the sniff must run on the plain bytes; if it
// ran on the compressed stream every asset would come back as x-gzip.
func TestGzipSniffsContentTypeFromUncompressedBody(t *testing.T) {
	rec := serve(t, "gzip", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("<!DOCTYPE html>" + strings.Repeat("<p>hello</p>", 300)))
	})
	if got := rec.Header().Get("Content-Type"); !strings.HasPrefix(got, "text/html") {
		t.Errorf("Content-Type = %q, want text/html sniffed from the plain body", got)
	}
}

// An already-encoded response must not be wrapped a second time.
func TestGzipSkipsAlreadyEncodedResponse(t *testing.T) {
	rec := serve(t, "gzip", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Encoding", "br")
		w.Write(largeBody())
	})
	if got := rec.Header().Get("Content-Encoding"); got != "br" {
		t.Errorf("Content-Encoding = %q, want the handler's own br", got)
	}
}

func TestAcceptsGzip(t *testing.T) {
	cases := map[string]bool{
		"":                           false,
		"gzip":                       true,
		"GZIP":                       true,
		" gzip ":                     true,
		"deflate, gzip":              true,
		"gzip;q=1.0, identity;q=0.5": true,
		"gzip;q=0":                   false,
		"gzip;q=0.0":                 false,
		"gzip;q=0.001":               true,
		"deflate":                    false,
		"identity":                   false,
		"*":                          true,
	}
	for header, want := range cases {
		if got := acceptsGzip(header); got != want {
			t.Errorf("acceptsGzip(%q) = %v, want %v", header, got, want)
		}
	}
}
