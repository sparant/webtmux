package server

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"webtmux/pkg/tmux"
)

// End-to-end tests for the two file-transfer routes.
//
// The unit tests in webtty/transfer_test.go pin what a path is allowed to mean.
// These pin the things only the HTTP layer can get wrong: that a folder comes
// back as a zip a real unzip can open, that a folder UPLOAD reconstructs its tree
// instead of flattening it, that an existing file is not silently replaced, and
// that a read-only server refuses the whole feature rather than quietly serving
// files to someone who is not even allowed to type.

// transferServer builds a Server wired for transfers, with `dir` as the one
// declared root (see webtty/savepath.go: WEBTMUX_SAVE_DIR is how an operator
// says "this directory is shared", and the container flag stops the process's
// own home and cwd from joining the allowlist behind the test's back).
func transferServer(t *testing.T, dir string, permitWrite bool) *Server {
	t.Helper()
	t.Setenv("WEBTMUX_IN_CONTAINER", "1")
	t.Setenv("WEBTMUX_SAVE_DIR", dir)
	t.Setenv("WEBTMUX_HOME", dir)
	t.Setenv("WEBTMUX_PATH_MAP", "")
	return &Server{
		options: &Options{PermitWrite: permitWrite},
		// Non-nil is all the gate asks. No window id is sent by these tests, so it
		// is never consulted for a pane directory.
		captureStore: tmux.NewCaptureStore(""),
	}
}

func mustWrite(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func downloadURL(dir, path string, probe bool) string {
	q := url.Values{"dir": {dir}, "path": {path}}
	if probe {
		q.Set("probe", "1")
	}
	return "/transfer/download?" + q.Encode()
}

// ---- download ---------------------------------------------------------------------

func TestTransferDownloadFile(t *testing.T) {
	dir := t.TempDir()
	srv := transferServer(t, dir, true)
	mustWrite(t, filepath.Join(dir, "build.log"), "line one\nline two\n")

	rec := httptest.NewRecorder()
	srv.handleTransferDownload(rec, httptest.NewRequest(http.MethodGet, downloadURL(dir, filepath.Join(dir, "build.log"), false), nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	if got := rec.Body.String(); got != "line one\nline two\n" {
		t.Errorf("body = %q", got)
	}
	// Without attachment the browser would render the file instead of saving it.
	if cd := rec.Header().Get("Content-Disposition"); !strings.Contains(cd, "attachment") ||
		!strings.Contains(cd, "build.log") {
		t.Errorf("Content-Disposition = %q", cd)
	}
	// A .html out of someone's home directory served as text/html would run as a
	// same-origin page on the webtmux that served it.
	if ct := rec.Header().Get("Content-Type"); ct != "application/octet-stream" {
		t.Errorf("Content-Type = %q, want application/octet-stream", ct)
	}
}

// The probe is what lets a refusal appear in the dropdown the user is still
// looking at, instead of as a navigation to an error page.
func TestTransferDownloadProbeReportsRefusalAsJSON(t *testing.T) {
	dir := t.TempDir()
	outside := t.TempDir()
	srv := transferServer(t, dir, true)
	mustWrite(t, filepath.Join(outside, "secret"), "shh")

	rec := httptest.NewRecorder()
	srv.handleTransferDownload(rec, httptest.NewRequest(http.MethodGet,
		downloadURL(dir, filepath.Join(outside, "secret"), true), nil))

	// 200 with ok:false, not an HTTP error: the browser is asking a question, and
	// "no, because…" is a successful answer to it.
	if rec.Code != http.StatusOK {
		t.Fatalf("probe status = %d", rec.Code)
	}
	var got transferProbe
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("probe reply is not JSON: %v (%s)", err, rec.Body.String())
	}
	if got.OK || got.Error == "" {
		t.Fatalf("probe = %+v, want a refusal with a reason", got)
	}
}

func TestTransferDownloadFolderIsAZip(t *testing.T) {
	dir := t.TempDir()
	srv := transferServer(t, dir, true)
	src := filepath.Join(dir, "project")
	mustWrite(t, filepath.Join(src, "a.txt"), "alpha")
	mustWrite(t, filepath.Join(src, "nested", "b.txt"), "bravo")

	rec := httptest.NewRecorder()
	srv.handleTransferDownload(rec, httptest.NewRequest(http.MethodGet, downloadURL(dir, src, false), nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	if cd := rec.Header().Get("Content-Disposition"); !strings.Contains(cd, "project.zip") {
		t.Errorf("Content-Disposition = %q, want project.zip", cd)
	}
	// The archive is built as it is sent, so the real question is whether what
	// came out the other end is a zip anything can open.
	body := rec.Body.Bytes()
	zr, err := zip.NewReader(bytes.NewReader(body), int64(len(body)))
	if err != nil {
		t.Fatalf("the streamed archive is not a readable zip: %v", err)
	}
	found := map[string]string{}
	for _, f := range zr.File {
		rc, err := f.Open()
		if err != nil {
			t.Fatalf("opening %s: %v", f.Name, err)
		}
		data, _ := io.ReadAll(rc)
		rc.Close()
		found[f.Name] = string(data)
	}
	// Names carry the folder, so unzipping makes ONE folder rather than dropping
	// a.txt and nested/ into whatever directory you happened to be in.
	if found["project/a.txt"] != "alpha" || found["project/nested/b.txt"] != "bravo" {
		t.Errorf("zip contents = %v", found)
	}
}

func TestTransferDownloadRefusedWhenReadOnly(t *testing.T) {
	dir := t.TempDir()
	srv := transferServer(t, dir, false) // started without -w
	mustWrite(t, filepath.Join(dir, "build.log"), "secrets")

	rec := httptest.NewRecorder()
	srv.handleTransferDownload(rec, httptest.NewRequest(http.MethodGet, downloadURL(dir, filepath.Join(dir, "build.log"), false), nil))

	// Reading a file is not a write, so this gate is a deliberate decision rather
	// than a consequence: -w is what separates "watch these terminals" from "act
	// on this machine", and walking the disk is squarely the second.
	if rec.Code != http.StatusForbidden {
		t.Fatalf("a read-only server served a file: status %d, body %q", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "secrets") {
		t.Fatal("the refusal leaked the file's contents")
	}
}

// ---- upload -----------------------------------------------------------------------

// uploadRequest builds the multipart body the browser sends: one part per file,
// each carrying its path relative to the chosen folder in the FIELD name, since a
// part's filename= is only the basename in some browsers.
func uploadRequest(t *testing.T, dir, dest string, overwrite bool, files map[string]string) *http.Request {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	for rel, content := range files {
		w, err := mw.CreateFormFile("path:"+rel, filepath.Base(rel))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := io.WriteString(w, content); err != nil {
			t.Fatal(err)
		}
	}
	if err := mw.Close(); err != nil {
		t.Fatal(err)
	}
	q := url.Values{"dir": {dir}, "dest": {dest}}
	if overwrite {
		q.Set("overwrite", "1")
	}
	req := httptest.NewRequest(http.MethodPost, "/transfer/upload?"+q.Encode(), &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	return req
}

func doUpload(t *testing.T, srv *Server, req *http.Request) uploadOutcome {
	t.Helper()
	rec := httptest.NewRecorder()
	srv.handleTransferUpload(rec, req)
	var out uploadOutcome
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("upload reply is not JSON: %v (%s)", err, rec.Body.String())
	}
	return out
}

func TestTransferUploadRebuildsAFolderTree(t *testing.T) {
	dir := t.TempDir()
	dest := filepath.Join(dir, "incoming")
	if err := os.MkdirAll(dest, 0o755); err != nil {
		t.Fatal(err)
	}
	srv := transferServer(t, dir, true)

	out := doUpload(t, srv, uploadRequest(t, dir, dest, false, map[string]string{
		"report.txt":      "top level",
		"src/lib/util.js": "nested",
	}))
	if !out.OK || out.Files != 2 {
		t.Fatalf("upload = %+v", out)
	}
	// Flattening would silently merge every src/index.js in a selection into one
	// file, which is the kind of loss nobody notices until much later.
	for rel, want := range map[string]string{
		"report.txt":      "top level",
		"src/lib/util.js": "nested",
	} {
		got, err := os.ReadFile(filepath.Join(dest, filepath.FromSlash(rel)))
		if err != nil {
			t.Errorf("%s: %v", rel, err)
			continue
		}
		if string(got) != want {
			t.Errorf("%s = %q, want %q", rel, got, want)
		}
	}
}

func TestTransferUploadRefusesToReplaceUnlessAsked(t *testing.T) {
	dir := t.TempDir()
	dest := filepath.Join(dir, "incoming")
	mustWrite(t, filepath.Join(dest, "report.txt"), "the original")
	srv := transferServer(t, dir, true)

	out := doUpload(t, srv, uploadRequest(t, dir, dest, false, map[string]string{"report.txt": "the replacement"}))
	if out.OK || out.Skipped != 1 {
		t.Fatalf("an existing file was replaced without being asked: %+v", out)
	}
	if len(out.Failures) != 1 || !strings.Contains(out.Failures[0].Error, "already exists") {
		t.Errorf("failures = %+v, want the collision named", out.Failures)
	}
	if got, _ := os.ReadFile(filepath.Join(dest, "report.txt")); string(got) != "the original" {
		t.Fatalf("the original was overwritten anyway: %q", got)
	}

	// …and does replace it when asked, in the same words the checkbox uses.
	out = doUpload(t, srv, uploadRequest(t, dir, dest, true, map[string]string{"report.txt": "the replacement"}))
	if !out.OK || out.Files != 1 {
		t.Fatalf("an explicit overwrite was refused: %+v", out)
	}
	if got, _ := os.ReadFile(filepath.Join(dest, "report.txt")); string(got) != "the replacement" {
		t.Errorf("after overwrite = %q", got)
	}
}

// One gesture, many files: a folder upload that stops at the first bad name
// leaves the destination in a state the user cannot reason about — half a tree,
// and no list of which half.
func TestTransferUploadKeepsGoingPastABadName(t *testing.T) {
	dir := t.TempDir()
	dest := filepath.Join(dir, "incoming")
	if err := os.MkdirAll(dest, 0o755); err != nil {
		t.Fatal(err)
	}
	srv := transferServer(t, dir, true)

	out := doUpload(t, srv, uploadRequest(t, dir, dest, false, map[string]string{
		"good-one.txt":     "kept",
		"../escape.txt":    "must not land",
		"also-good.txt":    "kept too",
		"a/../../away.txt": "must not land either",
	}))
	if out.Files != 2 || out.Skipped != 2 {
		t.Fatalf("outcome = %+v, want 2 written and 2 refused", out)
	}
	if out.OK {
		t.Error("an upload with refused files reported itself as wholly OK")
	}
	for _, escaped := range []string{
		filepath.Join(dir, "escape.txt"),
		filepath.Join(filepath.Dir(dir), "away.txt"),
	} {
		if _, err := os.Stat(escaped); err == nil {
			t.Errorf("a `..` in an uploaded name escaped the destination: %s", escaped)
		}
	}
}

func TestTransferUploadRefusedWhenReadOnly(t *testing.T) {
	dir := t.TempDir()
	dest := filepath.Join(dir, "incoming")
	if err := os.MkdirAll(dest, 0o755); err != nil {
		t.Fatal(err)
	}
	srv := transferServer(t, dir, false)

	rec := httptest.NewRecorder()
	srv.handleTransferUpload(rec, uploadRequest(t, dir, dest, false, map[string]string{"x.txt": "nope"}))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("a read-only server accepted an upload: %d", rec.Code)
	}
	if _, err := os.Stat(filepath.Join(dest, "x.txt")); err == nil {
		t.Fatal("the refused upload wrote a file anyway")
	}
}

// ---- the attachment header ---------------------------------------------------------

func TestContentDispositionCarriesNonASCIINames(t *testing.T) {
	got := contentDisposition("résumé final.pdf")
	// The ASCII form is what old clients read, and it must not contain a quote or
	// a backslash that would let a filename break out of the header.
	if !strings.Contains(got, `filename="r`) || strings.Contains(got, `\`) {
		t.Errorf("ascii fallback malformed: %q", got)
	}
	// RFC 5987 carries the real name; without it the file arrives as r_sum_.pdf.
	// A space must be %20 here, never '+'.
	if !strings.Contains(got, "filename*=UTF-8''r%C3%A9sum%C3%A9%20final.pdf") {
		t.Errorf("utf-8 form missing or wrongly escaped: %q", got)
	}
}
