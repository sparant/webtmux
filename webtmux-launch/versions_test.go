package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestParseBuildID(t *testing.T) {
	cases := []struct {
		in   string
		want buildID
	}{
		// v0.4.0 on: three lines, joined by the probe.
		{"webtmux version v0.4.0 commit 1a2b3c4 built 2026-10-21_08:44:00 ",
			buildID{"v0.4.0", "1a2b3c4", time.Date(2026, 10, 21, 8, 44, 0, 0, time.UTC)}},
		// A container's build: no tag, but the commit the build chip shows.
		{"webtmux version local commit c4a9ae0 built 2026-10-21_07:00:00",
			buildID{"local", "c4a9ae0", time.Date(2026, 10, 21, 7, 0, 0, 0, time.UTC)}},
		// Before v0.4.0: the version line only.
		{"webtmux version v0.2.0", buildID{Version: "v0.2.0"}},
		// git describe past a tag carries its commit.
		{"webtmux version v0.3.0-16-gc4a9ae0", buildID{Version: "v0.3.0-16-gc4a9ae0", Commit: "c4a9ae0"}},
		{"webtmux version v0.3.0-16-gc4a9ae0-dirty commit dev", buildID{Version: "v0.3.0-16-gc4a9ae0-dirty", Commit: "c4a9ae0"}},
		{"", buildID{}},
	}
	for _, c := range cases {
		if got := parseBuildID(c.in); got != c.want {
			t.Errorf("parseBuildID(%q) = %+v, want %+v", c.in, got, c.want)
		}
	}
}

func TestSameBuild(t *testing.T) {
	release := buildID{Version: "v0.3.0", Commit: "e0e21e3"}
	cases := []struct {
		name string
		got  buildID
		same bool
	}{
		{"the release itself", buildID{Version: "v0.3.0", Commit: "e0e21e3"}, true},
		{"an older binary of the tag, no commit stamp", buildID{Version: "v0.3.0"}, true},
		{"a container's local build of the release commit", buildID{Version: "local", Commit: "e0e21e3"}, true},
		{"a longer hash of the same commit", buildID{Version: "local", Commit: "e0e21e3a9"}, true},
		{"the tag, moved since this build", buildID{Version: "v0.3.0", Commit: "0b8b668"}, false},
		{"an older release", buildID{Version: "v0.2.0"}, false},
		{"a later dev build", buildID{Version: "v0.3.0-16-gc4a9ae0", Commit: "c4a9ae0"}, false},
		{"unreadable", buildID{}, false},
	}
	for _, c := range cases {
		if got := sameBuild(release, c.got); got != c.same {
			t.Errorf("%s: sameBuild = %v, want %v", c.name, got, c.same)
		}
	}
	// A launcher that knows only its tag (no commit baked in) still matches by
	// tag, and never by an unknown.
	if !sameBuild(buildID{Version: "v0.3.0"}, buildID{Version: "v0.3.0", Commit: "e0e21e3"}) {
		t.Error("tag alone should match the same tag")
	}
	if sameBuild(buildID{Version: "local"}, buildID{Version: "local"}) {
		t.Error(`two "local" builds with no commit are not known to be the same`)
	}
}

// The running build is always named with a date, and the date says where it
// came from.
func TestRunningLineAlwaysHasADate(t *testing.T) {
	built := time.Date(2026, 10, 21, 8, 0, 0, 0, time.UTC)
	released := time.Date(2026, 9, 30, 12, 0, 0, 0, time.UTC)
	file := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	cases := []struct {
		b                  buildID
		withCommit         bool
		released, fileTime time.Time
		want               string
	}{
		{buildID{"local", "c4a9ae0", built}, false, time.Time{}, file, "build c4a9ae0, built 2026-10-21"},
		{buildID{Version: "v0.2.0"}, false, released, file, "v0.2.0, released 2026-09-30"},
		{buildID{Version: "v0.2.0"}, false, time.Time{}, file, "v0.2.0, file dated 2026-10-01"},
		{buildID{"v0.3.0", "0b8b668", built}, true, time.Time{}, time.Time{}, "v0.3.0 (0b8b668), built 2026-10-21"},
		{buildID{Version: "local"}, false, time.Time{}, file, `a "local" build with no commit stamp, file dated 2026-10-01`},
		{buildID{}, false, time.Time{}, time.Time{}, "a build whose version could not be read, date unknown"},
	}
	for _, c := range cases {
		if got := runningLine(c.b, c.withCommit, c.released, c.fileTime); got != c.want {
			t.Errorf("runningLine(%+v) = %q, want %q", c.b, got, c.want)
		}
	}
}

func TestNewerTag(t *testing.T) {
	cases := []struct {
		a, b  string
		newer bool
	}{
		{"v0.4.0", "v0.3.0", true},
		{"v0.4.0", "v0.3.0", true},
		{"v0.10.0", "v0.9.0", true}, // numeric, not string, order
		{"v1.0.0", "v0.99.99", true},
		{"v0.3.0", "v0.3.0", false},
		{"v0.2.0", "v0.3.0", false},
		{"v0.4.0", "v0.4.0-rc1", true},
		{"v0.4.0-rc1", "v0.4.0", false},
		{"v0.4.0-rc2", "v0.4.0-rc1", true},
		{"v0.4.0", "v0.3.0-16-gc4a9ae0", false}, // a dev build has no release to be behind
		{"latest", "v0.3.0", false},
	}
	for _, c := range cases {
		if got := newerTag(c.a, c.b); got != c.newer {
			t.Errorf("newerTag(%s, %s) = %v, want %v", c.a, c.b, got, c.newer)
		}
	}
}

// withGlobals sets the build stamps a release launcher carries, for one test.
func withGlobals(t *testing.T, version, webtmuxVersion, webtmuxCommit string) {
	t.Helper()
	saved := []string{Version, RepoOwner, RepoName, DefaultWebtmuxVersion, DefaultWebtmuxCommit, DefaultSource}
	t.Cleanup(func() {
		Version, RepoOwner, RepoName, DefaultWebtmuxVersion, DefaultWebtmuxCommit, DefaultSource =
			saved[0], saved[1], saved[2], saved[3], saved[4], saved[5]
	})
	Version, RepoOwner, RepoName = version, "you", "webtmux"
	DefaultWebtmuxVersion, DefaultWebtmuxCommit, DefaultSource = webtmuxVersion, webtmuxCommit, ""
}

// fakeGitHub serves the two API calls the launcher makes and counts them.
func fakeGitHub(t *testing.T, latest string, published map[string]string) *atomic.Int32 {
	t.Helper()
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		tag := ""
		switch {
		case r.URL.Path == "/repos/you/webtmux/releases/latest":
			tag = latest
		case strings.HasPrefix(r.URL.Path, "/repos/you/webtmux/releases/tags/"):
			tag = strings.TrimPrefix(r.URL.Path, "/repos/you/webtmux/releases/tags/")
		}
		when, ok := published[tag]
		if !ok {
			http.NotFound(w, r)
			return
		}
		fmt.Fprintf(w, `{"tag_name":%q,"published_at":%q}`, tag, when)
	}))
	t.Cleanup(srv.Close)
	saved := githubAPI
	githubAPI = srv.URL
	t.Cleanup(func() { githubAPI = saved })
	return &calls
}

func TestUpdateCheckRecommendsANewerRelease(t *testing.T) {
	withGlobals(t, "v0.3.0", "v0.3.0", "e0e21e3")
	calls := fakeGitHub(t, "v0.4.0", map[string]string{"v0.4.0": "2026-11-02T10:00:00Z"})
	cache := t.TempDir()
	env := func(string) string { return "" }

	got := strings.Join(startUpdateCheck(&options{}, env, cache)(), "\n")
	if !strings.Contains(got, "update available: webtmux v0.4.0 (released 2026-11-02) — this launcher is v0.3.0") ||
		!strings.Contains(got, launcherAsset()) || !strings.Contains(got, "https://github.com/you/webtmux/releases/latest") {
		t.Fatalf("update notice:\n%s", got)
	}
	// Cached: a second launch asks GitHub nothing.
	startUpdateCheck(&options{}, env, cache)()
	if n := calls.Load(); n != 1 {
		t.Errorf("GitHub was asked %d times, want 1 (the answer is cached)", n)
	}

	// Up to date: nothing to say.
	Version = "v0.4.0"
	if got := startUpdateCheck(&options{}, env, cache)(); got != nil {
		t.Errorf("an up-to-date launcher said %q", got)
	}
}

func TestUpdateCheckIsSkippable(t *testing.T) {
	withGlobals(t, "v0.3.0", "v0.3.0", "e0e21e3")
	calls := fakeGitHub(t, "v0.4.0", map[string]string{"v0.4.0": "2026-11-02T10:00:00Z"})
	none := func(string) string { return "" }
	set := func(k string) string {
		if k == noUpdateCheckEnv {
			return "1"
		}
		return ""
	}
	startUpdateCheck(&options{noUpdateCheck: true}, none, t.TempDir())()
	startUpdateCheck(&options{}, set, t.TempDir())()
	// A dev launcher has no release to be behind.
	Version = "v0.3.0-16-gc4a9ae0"
	startUpdateCheck(&options{}, none, t.TempDir())()
	if n := calls.Load(); n != 0 {
		t.Errorf("GitHub was asked %d times by checks that should not run", n)
	}
}

// Offline, an earlier answer still stands; with none, the check is silent.
func TestUpdateCheckOfflineUsesStaleCache(t *testing.T) {
	withGlobals(t, "v0.3.0", "v0.3.0", "e0e21e3")
	saved := githubAPI
	githubAPI = "http://127.0.0.1:1" // nothing listens there
	t.Cleanup(func() { githubAPI = saved })
	cache := t.TempDir()
	env := func(string) string { return "" }
	if got := startUpdateCheck(&options{}, env, cache)(); got != nil {
		t.Errorf("offline with no cache said %q", got)
	}
	stale := `{"tag":"v0.4.0","published":"2026-11-02T10:00:00Z","checked":"2026-01-01T00:00:00Z"}`
	if err := os.WriteFile(filepath.Join(cache, "release-latest.json"), []byte(stale), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := startUpdateCheck(&options{}, env, cache)(); len(got) == 0 || !strings.Contains(got[0], "v0.4.0") {
		t.Errorf("offline with a stale cache said %q", got)
	}
}

// compareRunningBuild: silence when the running webtmux is the launcher's own
// build, a note naming both — the running one with a date — when it is not.
func TestCompareRunningBuild(t *testing.T) {
	withGlobals(t, "v0.3.0", "v0.3.0", "e0e21e3")
	fakeGitHub(t, "v0.3.0", map[string]string{"v0.2.0": "2026-09-30T12:00:00Z"})
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv(sourceEnv, "")
	// The release's sums, as cached by an earlier launch: no network needed.
	sums := filepath.Join(home, ".cache", "webtmux-launch", "v0.3.0")
	if err := os.MkdirAll(sums, 0o755); err != nil {
		t.Fatal(err)
	}
	digest := strings.Repeat("ab", 32)
	if err := os.WriteFile(filepath.Join(sums, "SHA256SUMS"), []byte(digest+"  webtmux-linux-amd64\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	p := &probe{Platform: "linux-amd64"}
	o := &options{webtmuxVersion: "v0.3.0", platformHint: "linux-amd64"}
	built := time.Date(2026, 10, 21, 7, 0, 0, 0, time.UTC)
	file := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)

	cases := []struct {
		name string
		inst instance
		want string // "" = no message at all
	}{
		{"the release binary itself", instance{ExeSHA: digest, Build: buildID{Version: "v0.3.0"}}, ""},
		{"the release, by version", instance{ExeSHA: "other", Build: buildID{Version: "v0.3.0", Commit: "e0e21e3"}}, ""},
		{"a container's build of the release commit", instance{Containerized: true, Build: buildID{"local", "e0e21e3", built}}, ""},
		{"a container's newer build", instance{Containerized: true, Build: buildID{"local", "c4a9ae0", built}},
			"wanted webtmux v0.3.0, but build c4a9ae0, built 2026-10-21 is running on box\n      connecting to it as is — it runs inside a container, so it changes when that container's image does\n      (--fresh starts the launcher's own build alongside it instead)"},
		{"an older release with no build stamp", instance{ExeMTime: file, Build: buildID{Version: "v0.2.0"}},
			"wanted webtmux v0.3.0, but v0.2.0, released 2026-09-30 is running on box\n      connecting to it as is\n      (--fresh starts the launcher's own build alongside it instead)"},
		{"the tag, moved since", instance{Build: buildID{"v0.3.0", "0b8b668", built}},
			"wanted webtmux v0.3.0 (e0e21e3), but v0.3.0 (0b8b668), built 2026-10-21 is running"},
		{"unreadable", instance{ExeMTime: file},
			"but a build whose version could not be read, file dated 2026-10-01 is running"},
	}
	for _, c := range cases {
		got := strings.Join(compareRunningBuild(o, p, &c.inst, "box"), "\n")
		switch {
		case c.want == "" && got != "":
			t.Errorf("%s: want no message, got:\n%s", c.name, got)
		case c.want != "" && !strings.Contains(got, c.want):
			t.Errorf("%s: want %q in:\n%s", c.name, c.want, got)
		}
	}

	// A local build directory is compared by sha alone, and named by path.
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "webtmux-linux-amd64"), []byte("local bytes"), 0o755); err != nil {
		t.Fatal(err)
	}
	local := &options{webtmuxSource: dir, platformHint: "linux-amd64"}
	got := strings.Join(compareRunningBuild(local, p, &instance{Build: buildID{Version: "v0.3.0"}}, "box"), "\n")
	if !strings.Contains(got, "wanted the webtmux at "+filepath.Join(dir, "webtmux-linux-amd64")+" (sha ") {
		t.Errorf("local source note:\n%s", got)
	}
	same, _ := sha256File(filepath.Join(dir, "webtmux-linux-amd64"))
	if got := compareRunningBuild(local, p, &instance{ExeSHA: same}, "box"); got != nil {
		t.Errorf("the deployed local build itself should say nothing, got %q", got)
	}
}
