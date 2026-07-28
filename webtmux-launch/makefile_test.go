package main

import (
	"os"
	"strings"
	"testing"
)

// readTarget returns the recipe lines of one make target.
func readTarget(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile("Makefile")
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	in := false
	for _, line := range strings.Split(string(b), "\n") {
		if strings.HasPrefix(line, name+":") {
			in = true
			continue
		}
		if in {
			if line == "" || (!strings.HasPrefix(line, "\t") && !strings.HasPrefix(line, " ")) {
				break
			}
			out = append(out, line)
		}
	}
	if len(out) == 0 {
		t.Fatalf("no recipe found for target %q", name)
	}
	return strings.Join(out, "\n")
}

// A dev default leaking into a release build would send every user's launcher
// looking for a path on the builder's machine — a failure that only shows up on
// someone else's computer, which is exactly why it is asserted rather than
// eyeballed.
func TestReleaseBuildHasNoDefaultSource(t *testing.T) {
	if strings.Contains(readTarget(t, "release"), "main.DefaultSource") {
		t.Error("make release must leave main.DefaultSource empty")
	}
	if !strings.Contains(readTarget(t, "dev"), "main.DefaultSource") {
		t.Error("make dev must bake in a local source — that is its whole point")
	}
}

// The launcher builds from its own source alone: no payload, no cross-compiled
// webtmux as a prerequisite. That is what makes a webtmux fix reach every
// launcher already in the field with no launcher release at all.
func TestLauncherBuildHasNoWebtmuxPrerequisite(t *testing.T) {
	b, err := os.ReadFile("Makefile")
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range strings.Split(string(b), "\n") {
		if strings.HasPrefix(line, "release:") || strings.HasPrefix(line, "dev:") {
			if deps := strings.TrimSpace(strings.SplitN(line, ":", 2)[1]); deps != "" {
				t.Errorf("%s should have no prerequisites, has %q", line, deps)
			}
		}
	}
	// The embedded-payload design is gone; its .dockerignore line must go too.
	di, err := os.ReadFile("../.dockerignore")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(di), "payload") {
		t.Error(".dockerignore still excludes the retired embedded payload")
	}
}
