package main

// Which webtmux build is which.
//
// Three builds can be in play on any launch: the one running on the target, the
// one this launcher was released with (the tag it installs by default), and the
// newest release on GitHub. They are compared by TAG wherever both sides have
// one, and otherwise by COMMIT — the id the UI's build chip shows — because a
// container's own build reports "local", and a dev build copied over reports
// whatever `git describe` said.
//
// The rules, all advisory — none of them ever stops a connection:
//
//   - running build = launcher's build: nothing to say.
//   - running build differs: connect to it as is, and say which build the
//     launcher wanted and which one (built when) is running.
//   - nothing running: install the launcher's own tag (resolveBinary already
//     does; --webtmux-version overrides it).
//   - a newer release exists: say so and recommend updating (update.go).

import (
	"fmt"
	"regexp"
	"strings"
	"time"
)

// buildID is what is known about one webtmux build. Any field may be empty.
type buildID struct {
	Version string    // "v0.3.0", "local", "v0.3.0-16-gc4a9ae0", "dev"
	Commit  string    // short commit hash
	Built   time.Time // the commit's time, as stamped into the build
}

// tagPattern is a release tag: vX.Y.Z, optionally with a pre-release suffix
// such as -rc1. `git describe` output past a tag ("v0.3.0-16-gc4a9ae0") is NOT
// a tag — the suffix starts with a digit, which is what this excludes.
var tagPattern = regexp.MustCompile(`^v\d+\.\d+\.\d+(-[A-Za-z][0-9A-Za-z.]*)?$`)

// describeCommit pulls the commit out of `git describe` output.
var describeCommit = regexp.MustCompile(`-g([0-9a-f]{7,40})(-dirty)?$`)

func isTag(v string) bool { return tagPattern.MatchString(v) }

// parseBuildID reads `webtmux --version` output, with its lines joined by
// spaces:
//
//	webtmux version v0.4.0 commit 1a2b3c4 built 2026-10-21_08:44:00
//
// Builds before v0.4.0 print only the first line.
func parseBuildID(s string) buildID {
	var b buildID
	f := strings.Fields(s)
	for i := 0; i+1 < len(f); i++ {
		switch f[i] {
		case "version":
			b.Version = f[i+1]
		case "commit":
			b.Commit = f[i+1]
		case "built":
			b.Built = parseBuildTime(f[i+1])
		}
	}
	switch b.Commit {
	case "dev", "unknown":
		b.Commit = ""
	}
	if b.Commit == "" {
		if m := describeCommit.FindStringSubmatch(b.Version); m != nil {
			b.Commit = m[1]
		}
	}
	return b
}

// parseBuildTime reads the Makefile's BUILD_TIME stamp (UTC).
func parseBuildTime(s string) time.Time {
	for _, layout := range []string{"2006-01-02_15:04:05", time.RFC3339, "2006-01-02"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t
		}
	}
	return time.Time{}
}

func (b buildID) known() bool { return b.Version != "" || b.Commit != "" }

// sameBuild reports whether two builds are the same source. Commits decide
// when both have one — a tag can be moved, and "local" says nothing — and tags
// decide otherwise. Anything unknown is not the same: "cannot tell" must not
// read as a match.
func sameBuild(a, b buildID) bool {
	if a.Commit != "" && b.Commit != "" {
		n := min(len(a.Commit), len(b.Commit))
		return a.Commit[:n] == b.Commit[:n]
	}
	return isTag(a.Version) && a.Version == b.Version
}

// name is how a build is referred to: its tag where it has one, else its
// commit, which is what the UI's build chip shows. withCommit adds the commit
// to a tag, for when two builds share a tag but not a commit.
func (b buildID) name(withCommit bool) string {
	switch {
	case isTag(b.Version) && withCommit && b.Commit != "":
		return b.Version + " (" + b.Commit + ")"
	case isTag(b.Version):
		return b.Version
	case b.Commit != "":
		return "build " + b.Commit
	case b.Version != "":
		return fmt.Sprintf("a %q build with no commit stamp", b.Version)
	default:
		return "a build whose version could not be read"
	}
}

// day formats a date the way every version line here shows one.
func day(t time.Time) string { return t.UTC().Format("2006-01-02") }

// wantedBuild is the build this launcher installs when nothing is running: its
// own release tag, and — for the tag it was released with — that tag's commit.
// ok is false for "latest", which names no build until GitHub is asked.
func wantedBuild(version string) (buildID, bool) {
	if version == "" || version == "latest" {
		return buildID{}, false
	}
	b := buildID{Version: version}
	if version == DefaultWebtmuxVersion {
		b.Commit = DefaultWebtmuxCommit
	}
	return b, true
}

// runningLine describes the build an instance is running, always with a date:
// the build's own stamp, else the release's publication date, else the
// file's modification time — each labelled for what it is.
func runningLine(b buildID, withCommit bool, released, fileTime time.Time) string {
	s := b.name(withCommit)
	switch {
	case !b.Built.IsZero():
		return s + ", built " + day(b.Built)
	case !released.IsZero():
		return s + ", released " + day(released)
	case !fileTime.IsZero():
		return s + ", file dated " + day(fileTime)
	}
	return s + ", date unknown"
}

// versionMismatchNote is printed when the running webtmux is not the build this
// launcher wanted. The connection goes ahead regardless: the running webtmux is
// someone's deliberate setup, and the tmux state behind it is the same either
// way.
func versionMismatchNote(wanted, running string, inst *instance, where string) []string {
	lines := []string{fmt.Sprintf("note: this launcher wanted %s, but %s is running on %s", wanted, running, where)}
	// Nothing here assumes how the container got its build: it may be built
	// locally or pulled, so the note names the image, not a rebuild.
	if inst.Containerized {
		lines = append(lines, "      connecting to it as is — it runs inside a container, so it changes when that container's image does")
	} else {
		lines = append(lines, "      connecting to it as is")
	}
	return append(lines, "      (--fresh starts the launcher's own build alongside it instead)")
}
