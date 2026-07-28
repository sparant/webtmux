package main

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeAsset(t *testing.T, dir, name, content string) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte(content), 0o755); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte(content))
	return hex.EncodeToString(sum[:])
}

func TestDirSourceDigestAndOpen(t *testing.T) {
	dir := t.TempDir()
	want := writeAsset(t, dir, "webtmux-linux-amd64", "fake binary")

	s, err := newDirSource(dir, "--webtmux-source")
	if err != nil {
		t.Fatal(err)
	}
	got, err := s.Digest("linux-amd64")
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("digest = %s, want %s", got, want)
	}
	rc, err := s.Open("linux-amd64")
	if err != nil {
		t.Fatal(err)
	}
	defer rc.Close()
	b, _ := io.ReadAll(rc)
	if string(b) != "fake binary" {
		t.Fatalf("Open returned %q", b)
	}
	if _, ok := s.BuiltAt("linux-amd64"); !ok {
		t.Fatal("BuiltAt should report an mtime for a local source")
	}
}

// A SHA256SUMS file sitting in the build directory must be IGNORED: hashing the
// bytes we are about to send cannot go stale, and trusting a sums file would
// reintroduce exactly the staleness the direct hash avoids.
func TestDirSourceIgnoresStaleSHA256SUMS(t *testing.T) {
	dir := t.TempDir()
	want := writeAsset(t, dir, "webtmux-linux-amd64", "new bytes")
	if err := os.WriteFile(filepath.Join(dir, "SHA256SUMS"),
		[]byte(strings.Repeat("a", 64)+"  webtmux-linux-amd64\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	s, _ := newDirSource(dir, "--webtmux-source")
	got, err := s.Digest("linux-amd64")
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("digest came from SHA256SUMS, not the file: %s", got)
	}
}

func TestDirSourceMissingPlatformNamesWhatItHas(t *testing.T) {
	dir := t.TempDir()
	writeAsset(t, dir, "webtmux-linux-amd64", "x")
	writeAsset(t, dir, "webtmux-darwin-arm64", "y")
	writeAsset(t, dir, "webtmux-launch-darwin-arm64", "launcher, not a candidate")

	s, _ := newDirSource(dir, "--webtmux-source")
	_, err := s.Digest("linux-arm64")
	if err == nil {
		t.Fatal("expected an error for a missing platform")
	}
	msg := err.Error()
	for _, want := range []string{"webtmux-linux-arm64", dir, "webtmux-linux-amd64", "webtmux-darwin-arm64", "make cross-compile"} {
		if !strings.Contains(msg, want) {
			t.Errorf("error does not mention %q:\n%s", want, msg)
		}
	}
	if strings.Contains(msg, "webtmux-launch-darwin-arm64") {
		t.Errorf("launcher binaries listed as webtmux assets:\n%s", msg)
	}
}

// A typo'd source that "works" by quietly downloading instead is the nastiest
// bug in this design: it looks like success while testing nothing you intended.
func TestBadSourceIsHardErrorNotFallback(t *testing.T) {
	o := &options{}
	getenv := func(k string) string {
		if k == sourceEnv {
			return "/definitely/not/here"
		}
		return ""
	}
	src, _, err := resolveSource(o, getenv, t.TempDir())
	if err == nil {
		t.Fatalf("expected a hard error, got source %T", src)
	}
	if !strings.Contains(err.Error(), "/definitely/not/here") {
		t.Errorf("error does not quote the configured value: %v", err)
	}
	if !strings.Contains(err.Error(), "unset it") {
		t.Errorf("error does not say how to get back to the release path: %v", err)
	}
}

func TestSourcePrecedence(t *testing.T) {
	dirA, dirB := t.TempDir(), t.TempDir()
	file := filepath.Join(t.TempDir(), "hand-built")
	writeAsset(t, filepath.Dir(file), filepath.Base(file), "z")

	env := func(k string) string {
		if k == sourceEnv {
			return dirB
		}
		return ""
	}
	// --webtmux-binary beats everything.
	src, why, err := resolveSource(&options{webtmuxBinary: file, webtmuxSource: dirA}, env, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if src.Kind() != "file" || !strings.Contains(why, "--webtmux-binary") {
		t.Fatalf("flag did not win: %s / %s", src.Kind(), why)
	}
	// --webtmux-source beats the env.
	src, _, err = resolveSource(&options{webtmuxSource: dirA}, env, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if src.Location("linux-amd64") != filepath.Join(dirA, "webtmux-linux-amd64") {
		t.Fatalf("--webtmux-source lost to the env: %s", src.Location("linux-amd64"))
	}
	// The env beats main.DefaultSource.
	defer func(old string) { DefaultSource = old }(DefaultSource)
	DefaultSource = t.TempDir()
	src, _, err = resolveSource(&options{}, env, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if src.Location("linux-amd64") != filepath.Join(dirB, "webtmux-linux-amd64") {
		t.Fatalf("env lost to DefaultSource: %s", src.Location("linux-amd64"))
	}
	// main.DefaultSource beats the release.
	src, _, err = resolveSource(&options{}, func(string) string { return "" }, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if src.Kind() != "local" {
		t.Fatalf("DefaultSource lost to the release path: %s", src.Kind())
	}
}

// With nothing configured, the launcher must still ATTEMPT the release URL —
// the deferred fetch path must not rot into unreachable code.
func TestNothingConfiguredMeansRelease(t *testing.T) {
	defer func(o, n, s string) { RepoOwner, RepoName, DefaultSource = o, n, s }(RepoOwner, RepoName, DefaultSource)
	RepoOwner, RepoName, DefaultSource = "someone", "webtmux", ""

	src, why, err := resolveSource(&options{webtmuxVersion: "v0.1.0"}, func(string) string { return "" }, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if src.Kind() != "release" || !strings.Contains(why, "release") {
		t.Fatalf("kind = %s, why = %s", src.Kind(), why)
	}
	want := "https://github.com/someone/webtmux/releases/download/v0.1.0/webtmux-linux-amd64"
	if got := src.Location("linux-amd64"); got != want {
		t.Fatalf("Location = %s, want %s", got, want)
	}
}

func TestReleaseLatestUsesRedirectURL(t *testing.T) {
	r := newReleaseSource("o", "webtmux", "latest", t.TempDir())
	want := "https://github.com/o/webtmux/releases/latest/download/webtmux-darwin-arm64"
	if got := r.Location("darwin-arm64"); got != want {
		t.Fatalf("Location = %s, want %s", got, want)
	}
}

func TestParseSums(t *testing.T) {
	in := "  " + strings.Repeat("a", 64) + "  webtmux-linux-amd64\n" +
		strings.Repeat("b", 64) + " *dist/webtmux-darwin-arm64\n" +
		"garbage\n"
	got := parseSums(in)
	if got["webtmux-linux-amd64"] != strings.Repeat("a", 64) {
		t.Errorf("linux entry: %v", got)
	}
	if got["webtmux-darwin-arm64"] != strings.Repeat("b", 64) {
		t.Errorf("basename not used for a dist/ path: %v", got)
	}
	if len(got) != 2 {
		t.Errorf("garbage line parsed: %v", got)
	}
}

// The release backend differs from the tested local path ONLY in Digest/Open.
// This exercises that pair against a stand-in server so the deferred fetch-path
// tests (3.15e) are a thin last mile rather than a leap of faith.
func TestReleaseDigestAndOpenAgainstStubServer(t *testing.T) {
	body := "release bytes"
	sum := sha256.Sum256([]byte(body))
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "SHA256SUMS"):
			io.WriteString(w, hex.EncodeToString(sum[:])+"  webtmux-linux-amd64\n")
		case strings.HasSuffix(r.URL.Path, "webtmux-linux-amd64"):
			io.WriteString(w, body)
		default:
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()

	cache := t.TempDir()
	r := &releaseSource{owner: "o", repo: "webtmux", version: "v1", cacheDir: filepath.Join(cache, "v1"), client: srv.Client()}
	// Point the URL builder at the stub by overriding the host through a tiny
	// shim: releaseSource builds github.com URLs, so exercise get() directly via
	// a source whose owner/repo produce the stub's paths.
	r.urlBase = srv.URL

	got, err := r.Digest("linux-amd64")
	if err != nil {
		t.Fatal(err)
	}
	if got != hex.EncodeToString(sum[:]) {
		t.Fatalf("digest = %s", got)
	}
	rc, err := r.Open("linux-amd64")
	if err != nil {
		t.Fatal(err)
	}
	defer rc.Close()
	b, _ := io.ReadAll(rc)
	if string(b) != body {
		t.Fatalf("Open = %q", b)
	}
	// Second Open must come from the Mac-side cache, so a second target on the
	// same platform needs no second download.
	srv.Close()
	rc2, err := r.Open("linux-amd64")
	if err != nil {
		t.Fatalf("warm cache did not serve offline: %v", err)
	}
	rc2.Close()
}

func TestSourceLineNamesWhatGotDeployed(t *testing.T) {
	dir := t.TempDir()
	digest := writeAsset(t, dir, "webtmux-linux-amd64", "bytes")
	s, _ := newDirSource(dir, "--webtmux-source")
	line := sourceLine(s, "linux-amd64", digest)
	if !strings.HasPrefix(line, "source: local ") {
		t.Errorf("line = %q", line)
	}
	for _, want := range []string{dir, short12(digest), "built "} {
		if !strings.Contains(line, want) {
			t.Errorf("line %q lacks %q", line, want)
		}
	}
}
