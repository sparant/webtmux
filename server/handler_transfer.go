package server

// The HTTP half of file transfer: the two endpoints behind the ⤓ dropdown's
// upload and download sections. See webtty/transfer.go for what a path means and
// why the bytes do not travel over ssh.
//
// These are HTTP rather than websocket frames, which is a departure from every
// other thing the dropdown does, and the reason is size. The existing pane-buffer
// download rides the websocket as base64 inside a JSON message: the whole object
// exists in memory twice on the server, once more in the browser, and inflated by
// a third on the way. That is a defensible price for a scrollback and an absurd
// one for the 400 MB tarball someone wants off a build machine. HTTP streams,
// costs one buffer at a time in either direction, gives the browser its own
// download UI with a progress bar and a Cancel button, and lets an upload report
// progress that a websocket send could not.
//
// Both endpoints are registered on siteMux (server.go), so they sit behind the
// same Basic auth as every other route. That is the whole authentication story,
// deliberately: a second credential for file transfer would be a second thing to
// get wrong, and there is no threat model in which someone who can open the
// terminal should be stopped here.

import (
	"archive/zip"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"webtmux/webtty"
)

// transferProbe is the JSON answer to "could I download this, and what would I
// get?" — see handleTransferDownload for why a probe exists at all.
type transferProbe struct {
	OK bool `json:"ok"`
	// Name is the filename the browser will receive, zip suffix included.
	Name string `json:"name"`
	// Bytes is the source's size for a file, and the sum of its regular files for
	// a folder — an estimate in the folder case, since the zip is compressed.
	Bytes int64 `json:"bytes"`
	// Files is 0 for a single file, else how many are inside the folder.
	Files int    `json:"files"`
	IsDir bool   `json:"isDir"`
	Error string `json:"error"`
	// Skipped names what a folder download will leave out (symlinks, unreadable
	// corners). Reported BEFORE the download rather than after, because an
	// archive that is quietly missing things is the failure nobody checks for.
	Skipped []string `json:"skipped,omitempty"`
}

// uploadOutcome is the JSON answer to an upload.
type uploadOutcome struct {
	OK      bool   `json:"ok"`
	Dir     string `json:"dir"`
	Files   int    `json:"files"`
	Bytes   int64  `json:"bytes"`
	Error   string `json:"error"`
	Skipped int    `json:"skipped"`
	// Failures names the individual files that did not make it, so a folder
	// upload that mostly worked reports WHICH parts didn't instead of collapsing
	// to a single red banner about the whole thing.
	Failures []uploadFailure `json:"failures,omitempty"`
}

type uploadFailure struct {
	Name  string `json:"name"`
	Error string `json:"error"`
}

// maxUploadFailures caps how many individual failures ride back in one reply.
// A folder upload into a directory that turns out to be full would otherwise
// produce one line per file, and the thousandth is not telling anyone anything
// the first ten didn't.
const maxUploadFailures = 10

// transferEnv builds the path-resolution environment for one request, from the
// window the browser is looking at and the save directory in force.
//
// The windowId matters more than it looks: it is what makes the pane's own
// working directory a legal transfer root. Without it every path would resolve
// against the fallback directory, and "download the file I am looking at in this
// pane" — the entire point — would be refused as outside the allowlist while the
// user stares at it in `ls`.
func (server *Server) transferEnv(r *http.Request) webtty.SaveEnv {
	paneDir := ""
	if win := r.URL.Query().Get("win"); win != "" && server.captureStore != nil {
		paneDir, _ = server.captureStore.PaneCurrentPath(win)
	}
	return webtty.TransferEnv(paneDir, r.URL.Query().Get("dir"))
}

// transferAllowed gates both endpoints on -w, and returns the sentence to show
// when it doesn't.
//
// Reading a file is not a write, so gating the DOWNLOAD on the write flag needs
// saying out loud. `-w` is what separates "watch these terminals" from "act on
// this machine", and an arbitrary-file read is squarely the second: a read-only
// viewer is trusted to see what is on the screens, not to walk the disk behind
// them. The pane-buffer download stays available to them precisely because it
// only hands back what they can already see (see webtty/authority.go), and that
// distinction is the whole rule.
func (server *Server) transferAllowed() (bool, string) {
	if !server.options.PermitWrite {
		return false, "This webtmux is read-only (started without -w), so it will not transfer files. " +
			"Downloading the pane's buffer above still works — it only hands back what is already on your screen."
	}
	if server.captureStore == nil {
		return false, "File transfer is unavailable — this webtmux is not attached to a tmux session."
	}
	return true, ""
}

func writeTransferJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("transfer: failed to write reply: %v", err)
	}
}

// ---- download: the machine tmux runs on -> this browser --------------------------

// handleTransferDownload sends one file, or a folder as a zip.
//
// It answers two different requests on one route, distinguished by ?probe=1:
//
//	probe=1  resolve the path and describe what a download WOULD produce (JSON)
//	         — no bytes, no Content-Disposition.
//	default  the download itself.
//
// The split exists because of where errors have to appear. A real download is
// started by pointing the browser at this URL, which is what gets a native
// progress bar, a Cancel button, and a stream straight to disk instead of the
// whole file buffered in a JS blob first. But a failed navigation renders
// wherever the browser feels like rendering it, and the one place this feature's
// errors are useful is the dropdown the user is still looking at — the same
// dropdown holding the path they mistyped. So the browser asks first, shows any
// refusal in place, and only navigates once the answer is yes.
//
// The two paths run the SAME resolution, so a probe that says yes and a download
// that then refuses means the filesystem changed underneath them — which is
// worth being possible, and is not worth pretending isn't.
func (server *Server) handleTransferDownload(w http.ResponseWriter, r *http.Request) {
	probe := r.URL.Query().Get("probe") == "1"
	fail := func(status int, msg string) {
		if probe {
			writeTransferJSON(w, http.StatusOK, transferProbe{Error: msg})
			return
		}
		http.Error(w, msg, status)
	}

	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		fail(http.StatusMethodNotAllowed, "download expects GET")
		return
	}
	if ok, why := server.transferAllowed(); !ok {
		fail(http.StatusForbidden, why)
		return
	}

	env := server.transferEnv(r)
	resolved, isDir, err := webtty.ResolveTransferSource(env, r.URL.Query().Get("path"))
	if err != nil {
		fail(http.StatusBadRequest, err.Error())
		return
	}

	if isDir {
		server.downloadFolder(w, r, resolved, probe, fail)
		return
	}
	server.downloadFile(w, r, resolved, probe, fail)
}

func (server *Server) downloadFile(w http.ResponseWriter, r *http.Request, resolved string, probe bool, fail func(int, string)) {
	f, err := os.Open(resolved)
	if err != nil {
		fail(http.StatusBadRequest, fmt.Sprintf("could not open %s: %v", resolved, err))
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		fail(http.StatusBadRequest, fmt.Sprintf("could not read %s: %v", resolved, err))
		return
	}
	name := filepath.Base(resolved)
	if probe {
		writeTransferJSON(w, http.StatusOK, transferProbe{OK: true, Name: name, Bytes: st.Size()})
		return
	}
	w.Header().Set("Content-Disposition", contentDisposition(name))
	// Deliberately generic. Serving a .html from someone's home directory as
	// text/html would let it run as a same-origin page on the webtmux that served
	// it, which is a cross-site-scripting hole dressed as a convenience; a
	// download does not need the type to be right, only the bytes.
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	// ServeContent handles Range and If-Modified-Since, which is what lets a
	// browser resume a large transfer that dropped — the case this feature exists
	// for over a connection that is often an ssh tunnel.
	http.ServeContent(w, r, name, st.ModTime(), f)
	log.Printf("transfer: sent %s (%d bytes)", resolved, st.Size())
}

func (server *Server) downloadFolder(w http.ResponseWriter, r *http.Request, resolved string, probe bool, fail func(int, string)) {
	entries, skipped, err := webtty.WalkTransferDir(resolved)
	if err != nil {
		fail(http.StatusBadRequest, err.Error())
		return
	}
	name := filepath.Base(resolved) + ".zip"
	if probe {
		var total int64
		for _, e := range entries {
			total += e.Info.Size()
		}
		writeTransferJSON(w, http.StatusOK, transferProbe{
			OK: true, Name: name, Bytes: total, Files: len(entries), IsDir: true, Skipped: skipped,
		})
		return
	}
	if r.Method == http.MethodHead {
		w.Header().Set("Content-Disposition", contentDisposition(name))
		w.Header().Set("Content-Type", "application/zip")
		return
	}

	w.Header().Set("Content-Disposition", contentDisposition(name))
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("X-Content-Type-Options", "nosniff")

	// No Content-Length: the zip is built as it is sent, so its size is not known
	// until it is finished. Buffering the whole archive to learn the number would
	// trade the one property that makes a large folder possible for a progress
	// bar, which is the wrong way round.
	zw := zip.NewWriter(w)
	var written int64
	for _, e := range entries {
		if err := writeZipEntry(zw, e); err != nil {
			// The status line and much of the body are long gone, so this cannot
			// become an error response. Stop, close the archive so what did get
			// written is a VALID zip rather than a truncated one, and log the
			// reason where an operator can find it.
			log.Printf("transfer: zip of %s stopped at %s: %v", resolved, e.Name, err)
			break
		}
		written += e.Info.Size()
	}
	if err := zw.Close(); err != nil {
		log.Printf("transfer: failed to finish zip of %s: %v", resolved, err)
		return
	}
	log.Printf("transfer: sent %s as zip (%d files, %d bytes uncompressed, %d skipped)",
		resolved, len(entries), written, len(skipped))
}

// writeZipEntry copies one file into the archive, preserving its modification
// time and permission bits so an unpacked tree still says when things changed
// and which of them were executable.
func writeZipEntry(zw *zip.Writer, e webtty.TransferEntry) error {
	hdr, err := zip.FileInfoHeader(e.Info)
	if err != nil {
		return err
	}
	hdr.Name = e.Name
	hdr.Method = zip.Deflate
	hdr.Modified = transferModTime(e.Info.ModTime())
	dst, err := zw.CreateHeader(hdr)
	if err != nil {
		return err
	}
	src, err := os.Open(e.Path)
	if err != nil {
		return err
	}
	defer src.Close()
	_, err = io.Copy(dst, src)
	return err
}

// contentDisposition builds the attachment header for a filename that may
// contain anything a filesystem allows.
//
// Both forms are emitted. The plain `filename=` is ASCII-sanitized for old
// clients, and RFC 5987's `filename*=UTF-8''…` carries the real name for
// everything current — without it a file called "résumé.pdf" arrives as
// "r_sum_.pdf". Quotes and backslashes are stripped rather than escaped: a
// filename containing one is vanishingly rare and not worth the risk of getting
// the escaping subtly wrong in a header that controls where a file is written.
func contentDisposition(name string) string {
	ascii := strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f || r > 0x7e || r == '"' || r == '\\' {
			return '_'
		}
		return r
	}, name)
	if ascii == "" {
		ascii = "download"
	}
	return fmt.Sprintf("attachment; filename=%q; filename*=UTF-8''%s", ascii, urlEscapeFilename(name))
}

// urlEscapeFilename percent-encodes for RFC 5987, which is stricter than
// url.QueryEscape: a space must be %20 and not '+', and the attr-char set
// excludes several punctuation marks QueryEscape leaves alone.
func urlEscapeFilename(s string) string {
	const keep = "!#$&+-.^_`|~"
	var b strings.Builder
	for _, c := range []byte(s) {
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9',
			strings.IndexByte(keep, c) >= 0:
			b.WriteByte(c)
		default:
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

// ---- upload: this browser -> the machine tmux runs on ----------------------------

// handleTransferUpload writes an uploaded file, or a whole folder, into a
// directory on the machine tmux runs on.
//
// The body is read with r.MultipartReader() rather than ParseMultipartForm,
// which is the difference between a feature and a memory bomb: ParseMultipartForm
// buffers parts in RAM up to its limit and spills the rest to temp files on the
// SAME disk the upload is heading for, so a folder upload would be written twice
// and could fill the destination before reaching it. Streaming each part straight
// to its final path costs one copy buffer regardless of how much is coming.
//
// Every part is attempted even after one fails. A folder upload is one gesture
// but many files, and stopping at the first unwritable one would leave the
// destination in a state the user has no way to reason about — half a tree, and
// no list of which half.
func (server *Server) handleTransferUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeTransferJSON(w, http.StatusMethodNotAllowed, uploadOutcome{Error: "upload expects POST"})
		return
	}
	if ok, why := server.transferAllowed(); !ok {
		writeTransferJSON(w, http.StatusForbidden, uploadOutcome{Error: why})
		return
	}

	env := server.transferEnv(r)
	destDir, err := webtty.ResolveTransferDest(env, r.URL.Query().Get("dest"))
	if err != nil {
		writeTransferJSON(w, http.StatusBadRequest, uploadOutcome{Error: err.Error()})
		return
	}
	overwrite := r.URL.Query().Get("overwrite") == "1"

	mr, err := r.MultipartReader()
	if err != nil {
		writeTransferJSON(w, http.StatusBadRequest, uploadOutcome{
			Dir: destDir, Error: "that upload was not a file upload webtmux could read",
		})
		return
	}

	out := uploadOutcome{Dir: destDir}
	for {
		part, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			// The connection died mid-body. Whatever landed already is real and is
			// reported; the error says the rest did not.
			out.Error = fmt.Sprintf("the upload ended early (%v) — %d file(s) had already been written", err, out.Files)
			writeTransferJSON(w, http.StatusOK, out)
			return
		}
		// The relative path a folder upload carries is sent in its own field
		// because a part's filename= is just the basename in some browsers, which
		// would flatten a tree into one directory without saying so.
		rel := part.FileName()
		if p := part.FormName(); strings.HasPrefix(p, "path:") {
			rel = strings.TrimPrefix(p, "path:")
		}
		if rel == "" {
			part.Close()
			continue
		}
		n, err := server.storeUploadPart(env, destDir, rel, overwrite, part)
		part.Close()
		if err != nil {
			out.Skipped++
			if len(out.Failures) < maxUploadFailures {
				out.Failures = append(out.Failures, uploadFailure{Name: rel, Error: err.Error()})
			}
			continue
		}
		out.Files++
		out.Bytes += n
	}

	out.OK = out.Skipped == 0
	if out.Skipped > 0 && out.Error == "" {
		out.Error = fmt.Sprintf("%d of %d file(s) could not be written", out.Skipped, out.Skipped+out.Files)
	}
	log.Printf("transfer: received %d file(s), %d bytes into %s (%d refused)",
		out.Files, out.Bytes, destDir, out.Skipped)
	writeTransferJSON(w, http.StatusOK, out)
}

// storeUploadPart writes one part to disk and returns how many bytes landed.
//
// The write goes to a temp file in the destination directory and is RENAMED into
// place, so a transfer that dies halfway leaves no half-file wearing the name of
// a real one. Same directory, never /tmp: a rename across filesystems is a copy,
// which would undo the atomicity and pay for the bytes twice.
func (server *Server) storeUploadPart(env webtty.SaveEnv, destDir, rel string, overwrite bool, src io.Reader) (int64, error) {
	target, err := webtty.ResolveUploadTarget(env, destDir, rel)
	if err != nil {
		return 0, err
	}
	if !overwrite {
		if _, err := os.Lstat(target); err == nil {
			return 0, fmt.Errorf("%s already exists — tick \"replace files that already exist\" to overwrite it",
				filepath.Base(target))
		}
	}
	tmp, err := os.CreateTemp(filepath.Dir(target), ".webtmux-upload-*")
	if err != nil {
		return 0, fmt.Errorf("could not write into %s: %v", filepath.Dir(target), err)
	}
	tmpName := tmp.Name()
	n, copyErr := io.Copy(tmp, src)
	closeErr := tmp.Close()
	if copyErr != nil {
		os.Remove(tmpName)
		return 0, fmt.Errorf("upload failed after %d bytes: %v", n, copyErr)
	}
	if closeErr != nil {
		os.Remove(tmpName)
		return 0, fmt.Errorf("could not finish writing: %v", closeErr)
	}
	// CreateTemp makes the file 0600, which is not what a transferred file should
	// wear — the user expects what their umask would have given them.
	if err := os.Chmod(tmpName, 0o644); err != nil {
		log.Printf("transfer: could not set permissions on %s: %v", tmpName, err)
	}
	if err := os.Rename(tmpName, target); err != nil {
		os.Remove(tmpName)
		return 0, fmt.Errorf("could not put the file in place: %v", err)
	}
	return n, nil
}

// transferModTime keeps the zip's timestamps sane when a filesystem reports a
// zero time (some network mounts do), which zip encodes as 1979 and unzip then
// reports as a corrupt entry on some tools.
func transferModTime(t time.Time) time.Time {
	if t.IsZero() {
		return time.Now()
	}
	return t
}
