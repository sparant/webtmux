package main

// Binary sources — where the launcher gets a webtmux for the target platform.
//
// The launcher needs exactly two things from wherever webtmux comes from, and
// neither is GitHub-specific: the sha256 of the asset for a platform WITHOUT
// transferring it, and the bytes once the digest has decided a transfer is
// needed. That split is the whole design — Digest answers "is a copy needed?"
// for a few hundred bytes, before the ~12 MB question is ever asked.
//
// Three backends satisfy it (release, local directory, single file). Everything
// downstream — content-addressed install paths, the adopt-mode build
// comparison, verify-before-transfer — is written against the interface and
// contains no "if localMode" branches. Any behaviour that exists in one mode and
// not another is a bug in the abstraction, not a feature.

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Source is the launcher's only view of where webtmux binaries come from.
type Source interface {
	// Kind is a short tag for the source line: "local", "file", "release".
	Kind() string
	// Location is the path or URL the bytes for this platform would come from.
	Location(platform string) string
	// Digest returns the sha256 of the asset for a platform without
	// transferring it.
	Digest(platform string) (string, error)
	// Open returns the bytes. Only called once Digest has decided a transfer
	// is needed.
	Open(platform string) (io.ReadCloser, error)
	// BuiltAt reports the asset's mtime, for the "built 6m ago" stamp. Local
	// sources only; ok is false when the notion does not apply.
	BuiltAt(platform string) (t time.Time, ok bool)
}

// assetName is the release asset filename for a platform — and, not by
// coincidence, exactly what `make cross-compile` writes into builds/. That
// identity is what makes a local build directory a drop-in release.
func assetName(platform string) string { return "webtmux-" + platform }

func sha256Reader(r io.Reader) (string, error) {
	h := sha256.New()
	if _, err := io.Copy(h, r); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func sha256File(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	return sha256Reader(f)
}

// short12 is the content-addressed install path's discriminator.
func short12(digest string) string {
	if len(digest) <= 12 {
		return digest
	}
	return digest[:12]
}

// ---------------------------------------------------------------------------
// local directory source — the development path
// ---------------------------------------------------------------------------

// dirSource reads `<dir>/webtmux-<platform>`. It deliberately does NOT read a
// SHA256SUMS file even if one is present (because `make checksums` ran):
// hashing the bytes we are about to send cannot go stale, and a sums file can.
type dirSource struct {
	dir string
	// origin records which knob selected this directory, so --verbose can say
	// why (a leftover export in a shell is otherwise invisible).
	origin string
}

func newDirSource(dir, origin string) (*dirSource, error) {
	abs, err := filepath.Abs(dir)
	if err != nil {
		abs = dir
	}
	st, err := os.Stat(abs)
	// Configured-but-invalid is a hard error, never a fallback to the release
	// path: a typo that "works" by quietly downloading instead is the nastiest
	// failure mode in this design, because it looks like success while testing
	// nothing you intended.
	if err != nil {
		return nil, fmt.Errorf("%s=%s: %v\n(unset it to fetch from the GitHub release instead)", origin, dir, err)
	}
	if !st.IsDir() {
		return nil, fmt.Errorf("%s=%s: not a directory\n(unset it to fetch from the GitHub release instead)", origin, dir)
	}
	return &dirSource{dir: abs, origin: origin}, nil
}

func (d *dirSource) Kind() string                    { return "local" }
func (d *dirSource) Location(platform string) string { return d.path(platform) }
func (d *dirSource) path(platform string) string {
	return filepath.Join(d.dir, assetName(platform))
}

func (d *dirSource) Digest(platform string) (string, error) {
	sum, err := sha256File(d.path(platform))
	if err != nil {
		if os.IsNotExist(err) {
			return "", d.missing(platform)
		}
		return "", err
	}
	return sum, nil
}

func (d *dirSource) Open(platform string) (io.ReadCloser, error) {
	f, err := os.Open(d.path(platform))
	if err != nil && os.IsNotExist(err) {
		return nil, d.missing(platform)
	}
	return f, err
}

func (d *dirSource) BuiltAt(platform string) (time.Time, bool) {
	st, err := os.Stat(d.path(platform))
	if err != nil {
		return time.Time{}, false
	}
	return st.ModTime(), true
}

// missing names the file it wanted and lists what the directory actually has —
// the failure mode here is always "you cross-compiled for one platform and the
// target is another", and the fix is a make target.
func (d *dirSource) missing(platform string) error {
	var have []string
	ents, _ := os.ReadDir(d.dir)
	for _, e := range ents {
		// builds/ also holds webtmux-launch-<os>-<arch>; listing those as
		// candidate webtmux assets would be actively misleading.
		if strings.HasPrefix(e.Name(), "webtmux-") && !strings.HasPrefix(e.Name(), "webtmux-launch") && !strings.HasSuffix(e.Name(), ".sh") {
			have = append(have, e.Name())
		}
	}
	sort.Strings(have)
	list := "nothing"
	if len(have) > 0 {
		list = strings.Join(have, ", ")
	}
	return fmt.Errorf("no %s in %s\n(have: %s — run `make cross-compile`)", assetName(platform), d.dir, list)
}

// ---------------------------------------------------------------------------
// single file source — the one-off escape hatch
// ---------------------------------------------------------------------------

// fileSource deploys one exact file, ignoring platform naming entirely. This is
// for "deploy *this* binary, right now" — typically the output of a plain
// `go build` for a single target, where inventing a webtmux-<platform> name
// would be pure ceremony.
type fileSource struct{ file string }

func newFileSource(path string) (*fileSource, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		abs = path
	}
	st, err := os.Stat(abs)
	if err != nil {
		return nil, fmt.Errorf("--webtmux-binary=%s: %v", path, err)
	}
	if st.IsDir() {
		return nil, fmt.Errorf("--webtmux-binary=%s: is a directory (use --webtmux-source for a build directory)", path)
	}
	return &fileSource{file: abs}, nil
}

func (f *fileSource) Kind() string                  { return "file" }
func (f *fileSource) Location(string) string        { return f.file }
func (f *fileSource) Digest(string) (string, error) { return sha256File(f.file) }
func (f *fileSource) Open(string) (io.ReadCloser, error) {
	return os.Open(f.file)
}
func (f *fileSource) BuiltAt(string) (time.Time, bool) {
	st, err := os.Stat(f.file)
	if err != nil {
		return time.Time{}, false
	}
	return st.ModTime(), true
}

// ---------------------------------------------------------------------------
// release source — the default
// ---------------------------------------------------------------------------

// releaseSource fetches from GitHub Releases. No API, no auth, no JSON: both
// URL forms are plain HTTPS GETs against a public repo, with `latest` handled
// by GitHub's own redirect.
type releaseSource struct {
	owner, repo, version string
	cacheDir             string // ~/.cache/webtmux-launch/<version>
	client               *http.Client
	sums                 map[string]string // parsed SHA256SUMS, cached in memory
	// urlBase is github.com unless a test points it elsewhere. The release
	// backend is the one path that cannot be run end to end until a release
	// exists, so it gets a seam rather than being left untested.
	urlBase string
}

func newReleaseSource(owner, repo, version, cacheRoot string) *releaseSource {
	return &releaseSource{
		owner:    owner,
		repo:     repo,
		version:  version,
		cacheDir: filepath.Join(cacheRoot, version),
		client:   &http.Client{Timeout: 5 * time.Minute},
	}
}

func (r *releaseSource) Kind() string { return "release" }

func (r *releaseSource) Location(platform string) string { return r.url(assetName(platform)) }

func (r *releaseSource) url(name string) string {
	base := r.urlBase
	if base == "" {
		base = "https://github.com"
	}
	if r.version == "latest" {
		return fmt.Sprintf("%s/%s/%s/releases/latest/download/%s", base, r.owner, r.repo, name)
	}
	return fmt.Sprintf("%s/%s/%s/releases/download/%s/%s", base, r.owner, r.repo, r.version, name)
}

func (r *releaseSource) BuiltAt(string) (time.Time, bool) { return time.Time{}, false }

// get performs one HTTPS GET, distinguishing "no network" from "404 — that
// version or asset does not exist". They need different fixes, and both name
// the URL attempted.
func (r *releaseSource) get(name string) (io.ReadCloser, error) {
	u := r.url(name)
	resp, err := r.client.Get(u)
	if err != nil {
		return nil, fmt.Errorf("cannot reach %s: %v\n(no network? a warm ~/.cache/webtmux-launch works offline)", u, err)
	}
	if resp.StatusCode == http.StatusNotFound {
		resp.Body.Close()
		return nil, fmt.Errorf("404 at %s\n(no such release asset — check --webtmux-version)", u)
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		return nil, fmt.Errorf("%s from %s", resp.Status, u)
	}
	return resp.Body, nil
}

// Digest reads the release's SHA256SUMS asset — a few hundred bytes, cached on
// the Mac — rather than the 12 MB binary.
func (r *releaseSource) Digest(platform string) (string, error) {
	if r.sums == nil {
		sums, err := r.loadSums()
		if err != nil {
			return "", err
		}
		r.sums = sums
	}
	sum, ok := r.sums[assetName(platform)]
	if !ok {
		var have []string
		for k := range r.sums {
			have = append(have, k)
		}
		sort.Strings(have)
		return "", fmt.Errorf("no %s in %s\n(the release publishes: %s)",
			assetName(platform), r.url("SHA256SUMS"), strings.Join(have, ", "))
	}
	return sum, nil
}

func (r *releaseSource) loadSums() (map[string]string, error) {
	cached := filepath.Join(r.cacheDir, "SHA256SUMS")
	// A pinned version's sums are immutable, so a cached copy is always valid.
	// "latest" is not pinned, so never trust a cached copy of it.
	if r.version != "latest" {
		if b, err := os.ReadFile(cached); err == nil {
			return parseSums(string(b)), nil
		}
	}
	rc, err := r.get("SHA256SUMS")
	if err != nil {
		return nil, err
	}
	defer rc.Close()
	b, err := io.ReadAll(io.LimitReader(rc, 1<<20))
	if err != nil {
		return nil, err
	}
	if r.version != "latest" {
		if err := os.MkdirAll(r.cacheDir, 0o755); err == nil {
			_ = os.WriteFile(cached, b, 0o644)
		}
	}
	return parseSums(string(b)), nil
}

// parseSums reads `sha256sum`-style output. Entries are keyed on the basename,
// so a sums file generated from inside a dist/ directory works unchanged.
func parseSums(s string) map[string]string {
	out := map[string]string{}
	for _, line := range strings.Split(s, "\n") {
		fields := strings.Fields(strings.TrimSpace(line))
		if len(fields) != 2 || len(fields[0]) != 64 {
			continue
		}
		out[filepath.Base(strings.TrimPrefix(fields[1], "*"))] = strings.ToLower(fields[0])
	}
	return out
}

// Open returns the asset, downloading it into the Mac-side cache first if
// needed. A second target on the same platform then needs no second download,
// and a warm cache works offline entirely.
func (r *releaseSource) Open(platform string) (io.ReadCloser, error) {
	name := assetName(platform)
	cached := filepath.Join(r.cacheDir, name)
	if f, err := os.Open(cached); err == nil {
		return f, nil
	}
	rc, err := r.get(name)
	if err != nil {
		return nil, err
	}
	defer rc.Close()
	if err := os.MkdirAll(r.cacheDir, 0o755); err != nil {
		return nil, err
	}
	tmp, err := os.CreateTemp(r.cacheDir, ".dl-*")
	if err != nil {
		return nil, err
	}
	defer os.Remove(tmp.Name())
	if _, err := io.Copy(tmp, rc); err != nil {
		tmp.Close()
		return nil, fmt.Errorf("download of %s failed: %v", r.url(name), err)
	}
	if err := tmp.Close(); err != nil {
		return nil, err
	}
	if err := os.Rename(tmp.Name(), cached); err != nil {
		return nil, err
	}
	return os.Open(cached)
}

// ---------------------------------------------------------------------------
// resolution
// ---------------------------------------------------------------------------

// sourceEnv is the ambient form of --webtmux-source, for a dev shell that wants
// it on every launch.
const sourceEnv = "WEBTMUX_LAUNCH_SOURCE"

// resolveSource picks the backend. Precedence, highest first:
//
//	--webtmux-binary > --webtmux-source > $WEBTMUX_LAUNCH_SOURCE
//	  > -X main.DefaultSource > GitHub release
//
// There is deliberately NO auto-detection of a nearby builds/ directory:
// silently preferring a local directory means an ordinary user with a checkout
// gets a stale hand-built binary instead of the release they asked for, and the
// failure is invisible. The source is always either explicitly configured or
// the release.
func resolveSource(o *options, getenv func(string) string, cacheRoot string) (Source, string, error) {
	switch {
	case o.webtmuxBinary != "":
		s, err := newFileSource(o.webtmuxBinary)
		return s, "--webtmux-binary", err
	case o.webtmuxSource != "":
		s, err := newDirSource(o.webtmuxSource, "--webtmux-source")
		return s, "--webtmux-source", err
	case getenv(sourceEnv) != "":
		s, err := newDirSource(getenv(sourceEnv), sourceEnv)
		return s, "$" + sourceEnv, err
	case DefaultSource != "":
		s, err := newDirSource(DefaultSource, "main.DefaultSource")
		return s, "main.DefaultSource (make launcher-dev)", err
	default:
		if RepoOwner == "" || RepoName == "" {
			return nil, "", errors.New("this launcher was built without a release repo baked in\n(configure a local build directory: --webtmux-source <dir> or $" + sourceEnv + ")")
		}
		return newReleaseSource(RepoOwner, RepoName, o.webtmuxVersion, cacheRoot), "GitHub release (default)", nil
	}
}

// sourceLine is the one line every run prints about where webtmux came from.
// Local mode trades the release's provenance for iteration speed, so a run must
// never leave you guessing what got deployed.
func sourceLine(s Source, platform, digest string) string {
	line := fmt.Sprintf("source: %s %s (sha %s", s.Kind(), s.Location(platform), short12(digest))
	if t, ok := s.BuiltAt(platform); ok {
		line += ", built " + humanAge(time.Since(t)) + " ago"
	}
	return line + ")"
}

func humanAge(d time.Duration) string {
	switch {
	case d < time.Minute:
		return fmt.Sprintf("%ds", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%dm", int(d.Minutes()))
	case d < 48*time.Hour:
		return fmt.Sprintf("%dh", int(d.Hours()))
	default:
		return fmt.Sprintf("%dd", int(d.Hours())/24)
	}
}
