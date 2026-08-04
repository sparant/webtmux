package main

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// The build's reproducibility is a property of the Makefile and Dockerfile, and
// every part of it is one careless edit away from being lost silently: a binary
// built with a stray `date` looks exactly like a good one until someone tries to
// rebuild it a month later and cannot. `make verify-repro` proves the property
// end to end but needs docker and a few minutes; these tests are the cheap
// standing guard that runs with `make test`.

func read(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// The stamp must come from the commit, never from the clock. This is the bug
// that made every single build of one commit differ.
func TestBuildTimeComesFromTheCommit(t *testing.T) {
	mk := read(t, "Makefile")

	for _, line := range strings.Split(mk, "\n") {
		if !strings.HasPrefix(line, "BUILD_TIME") {
			continue
		}
		if !strings.Contains(line, "git log") {
			t.Errorf("BUILD_TIME must be derived from the commit, got: %s", line)
		}
		// A *call* to date(1), not the word: git's own --date=format-local is
		// how the commit's time is read and must not trip this.
		if regexp.MustCompile("\\$\\(shell\\s+date\\b|`date\\b").MatchString(line) {
			t.Errorf("BUILD_TIME must not call date(1) — that is the clock, got: %s", line)
		}
	}
	if !strings.Contains(mk, "SOURCE_DATE_EPOCH") {
		t.Error("Makefile should export SOURCE_DATE_EPOCH for downstream archivers")
	}
}

// -trimpath is what makes the binary independent of WHERE it was built, and
// -buildvcs=false is what makes a worktree build agree with a container build.
// Neither shows up in normal use; both show up as an unreproducible release.
func TestBuildFlagsPinTheEnvironmentOut(t *testing.T) {
	for _, f := range []struct{ path, sym string }{
		{"Makefile", "BUILD_OPTIONS"},
		{"webtmux-launch/Makefile", "BUILD_FLAGS"},
	} {
		src := read(t, f.path)
		var opts string
		for _, line := range strings.Split(src, "\n") {
			if strings.HasPrefix(line, f.sym) {
				opts = line
			}
		}
		if opts == "" {
			t.Fatalf("%s: no %s definition found", f.path, f.sym)
		}
		for _, flag := range []string{"-trimpath", "-buildvcs=false"} {
			if !strings.Contains(opts, flag) {
				t.Errorf("%s: %s is missing %s", f.path, f.sym, flag)
			}
		}
	}
}

// A compiler is a build input like any other. If the three places that name one
// disagree, the "pinned" toolchain is whichever file the build happened to read.
func TestPinnedGoVersionAgrees(t *testing.T) {
	pin := regexp.MustCompile(`(?m)^GO_VERSION\s*=\s*(\S+)`)
	arg := regexp.MustCompile(`(?m)^ARG GO_VERSION=(\S+)`)

	root := pin.FindStringSubmatch(read(t, "Makefile"))
	launcher := pin.FindStringSubmatch(read(t, "webtmux-launch/Makefile"))
	docker := arg.FindStringSubmatch(read(t, "Dockerfile"))
	if root == nil || launcher == nil || docker == nil {
		t.Fatalf("GO_VERSION pin missing: Makefile=%v launcher=%v Dockerfile=%v",
			root != nil, launcher != nil, docker != nil)
	}
	if root[1] != docker[1] || root[1] != launcher[1] {
		t.Errorf("pinned Go version disagrees: Makefile=%s Dockerfile=%s launcher=%s",
			root[1], docker[1], launcher[1])
	}
	// A floating tag (1.23, latest) would drift under the pin without any edit
	// here, which is the failure this whole mechanism exists to prevent.
	if strings.Count(root[1], ".") != 2 {
		t.Errorf("GO_VERSION=%s is not an exact patch version", root[1])
	}
}

// The release build must take its source from a commit, not from whatever the
// working tree happens to contain — a `git archive` context is what enforces it.
func TestReleaseBuildsFromACommit(t *testing.T) {
	mk := read(t, "Makefile")
	i := strings.Index(mk, "\nrelease-from-commit:")
	if i < 0 {
		t.Fatal("no release-from-commit target")
	}
	recipe := mk[i:]
	if j := strings.Index(recipe[1:], "\n\n"); j >= 0 {
		recipe = recipe[:j]
	}
	if !strings.Contains(recipe, "git archive") {
		t.Error("release-from-commit must build a git archive of REF, not the working tree")
	}
	for _, stamp := range []string{"$(REF_VERSION)", "$(REF_COMMIT)", "$(REF_TIME)"} {
		if !strings.Contains(recipe, stamp) {
			t.Errorf("release-from-commit must stamp %s (derived from REF, not HEAD)", stamp)
		}
	}
}
