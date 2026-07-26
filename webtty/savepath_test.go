package webtty

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The invariant worth testing here is not "filepath.Join works" — it's that a
// save NEVER silently targets a directory that doesn't exist on the machine
// doing the write, and that when the two filesystems disagree the user is told
// which one is missing what.

func TestPathMapRewritesOnBoundaries(t *testing.T) {
	maps := parsePathMap("/home/nathan/Projects=/workspace, /var/log=/logs")

	got, ok := applyPathMap(maps, "/home/nathan/Projects/webtmux/out.txt")
	if !ok || got != "/workspace/webtmux/out.txt" {
		t.Fatalf("prefix rewrite = %q (%v), want /workspace/webtmux/out.txt", got, ok)
	}
	// The prefix itself maps.
	if got, ok := applyPathMap(maps, "/home/nathan/Projects"); !ok || got != "/workspace" {
		t.Fatalf("bare prefix = %q (%v), want /workspace", got, ok)
	}
	// A path that merely STARTS WITH the same characters must not match — the
	// whole point of a prefix map is that it follows directory boundaries.
	if got, ok := applyPathMap(maps, "/home/nathan/Projects-old/x"); ok {
		t.Fatalf("boundary violation: /home/nathan/Projects-old/x mapped to %q", got)
	}
	// Unmapped paths pass through untouched.
	if got, ok := applyPathMap(maps, "/etc/hosts"); ok || got != "/etc/hosts" {
		t.Fatalf("unmapped = %q (%v), want /etc/hosts (false)", got, ok)
	}
}

func TestPathMapPrefersTheLongestMatch(t *testing.T) {
	maps := parsePathMap("/home=/h,/home/nathan/Projects=/workspace")
	got, _ := applyPathMap(maps, "/home/nathan/Projects/a.txt")
	if got != "/workspace/a.txt" {
		t.Fatalf("longest-match = %q, want /workspace/a.txt", got)
	}
}

func TestPathMapIgnoresMalformedEntries(t *testing.T) {
	// A typo'd mapping must degrade to "no mapping" rather than break saving.
	maps := parsePathMap("garbage,=/nowhere,/from=,/a=/b")
	if len(maps) != 1 || maps[0].from != "/a" || maps[0].to != "/b" {
		t.Fatalf("parsePathMap kept %+v, want only {/a /b}", maps)
	}
}

func TestRelativeSaveUsesTheBaseDir(t *testing.T) {
	dir := t.TempDir()
	env := SaveEnv{BaseDir: dir, PaneVisible: true, Home: dir}

	got, err := resolveSavePath(env, "out.txt")
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if got != filepath.Join(dir, "out.txt") {
		t.Fatalf("resolved = %q, want %q", got, filepath.Join(dir, "out.txt"))
	}
}

func TestTildeExpandsToTheConfiguredHome(t *testing.T) {
	home := t.TempDir()
	env := SaveEnv{BaseDir: t.TempDir(), Home: home}

	got, err := resolveSavePath(env, "~/notes.txt")
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if got != filepath.Join(home, "notes.txt") {
		t.Fatalf("resolved = %q, want %q", got, filepath.Join(home, "notes.txt"))
	}
}

// The bug this whole file exists for: tmux reports a host directory, webtmux is
// in a container and can't see it, and the user gets a bare open(2) error about
// a path that plainly exists in their own shell.
func TestMissingDirectoryIsExplainedNotJustReported(t *testing.T) {
	env := SaveEnv{
		PaneDir:   "/home/nathan/Projects",
		BaseDir:   t.TempDir(),
		Container: true,
	}
	_, err := resolveSavePath(env, "/home/nathan/Projects/services-13.txt")
	if err == nil {
		t.Fatal("expected an error for a directory that does not exist here")
	}
	msg := err.Error()
	for _, want := range []string{"/home/nathan/Projects", "container", env.BaseDir, "Download to browser"} {
		if !strings.Contains(msg, want) {
			t.Errorf("error message is missing %q:\n  %s", want, msg)
		}
	}
}

func TestTypedHostPathIsMappedRatherThanFailing(t *testing.T) {
	server := t.TempDir()
	t.Setenv("WEBTMUX_PATH_MAP", "/home/nathan/Projects="+server)

	env := SaveEnv{BaseDir: server, Home: server}
	got, err := resolveSavePath(env, "/home/nathan/Projects/out.txt")
	if err != nil {
		t.Fatalf("a mapped host path should resolve, got: %v", err)
	}
	if got != filepath.Join(server, "out.txt") {
		t.Fatalf("resolved = %q, want %q", got, filepath.Join(server, "out.txt"))
	}
}

func TestSaveToADirectoryIsRefusedWithAUsefulMessage(t *testing.T) {
	dir := t.TempDir()
	if _, err := resolveSavePath(SaveEnv{BaseDir: dir, Home: dir}, "."); err == nil {
		t.Fatal("saving onto a directory should fail")
	} else if !strings.Contains(err.Error(), "file name") {
		t.Fatalf("unhelpful message: %v", err)
	}
}

func TestEmptyPathIsRejected(t *testing.T) {
	if _, err := resolveSavePath(SaveEnv{BaseDir: t.TempDir()}, "   "); err == nil {
		t.Fatal("empty path should fail")
	}
}

func TestDescribeSaveEnvUsesThePaneDirWhenItIsVisible(t *testing.T) {
	pane := t.TempDir()
	t.Setenv("WEBTMUX_PATH_MAP", "")
	t.Setenv("WEBTMUX_SAVE_DIR", t.TempDir())

	env := describeSaveEnv(pane)
	if !env.PaneVisible || env.BaseDir != pane {
		t.Fatalf("visible pane dir should be the base: %+v", env)
	}
	if env.Mapped {
		t.Fatalf("no mapping was configured, but env reports one: %+v", env)
	}
	if !env.Writable {
		t.Fatalf("a temp dir should be writable: %+v", env)
	}
}

func TestDescribeSaveEnvFallsBackWhenThePaneDirIsInvisible(t *testing.T) {
	save := filepath.Join(t.TempDir(), "saves")
	t.Setenv("WEBTMUX_PATH_MAP", "")
	t.Setenv("WEBTMUX_SAVE_DIR", save)

	env := describeSaveEnv("/definitely/not/here")
	if env.PaneVisible {
		t.Fatal("a nonexistent pane dir must not be reported as visible")
	}
	if env.BaseDir != save {
		t.Fatalf("BaseDir = %q, want the configured save dir %q", env.BaseDir, save)
	}
	// WEBTMUX_SAVE_DIR is an instruction, so it is created rather than ignored.
	if st, err := os.Stat(save); err != nil || !st.IsDir() {
		t.Fatalf("WEBTMUX_SAVE_DIR was not created: %v", err)
	}
}

func TestDescribeSaveEnvReportsAMappedPaneDir(t *testing.T) {
	server := t.TempDir()
	t.Setenv("WEBTMUX_PATH_MAP", "/home/nathan/Projects="+server)

	env := describeSaveEnv("/home/nathan/Projects")
	if !env.PaneVisible || !env.Mapped || env.BaseDir != server {
		t.Fatalf("mapping should make the pane dir visible: %+v", env)
	}
}

func TestContainerDetectionCanBeForced(t *testing.T) {
	t.Setenv("WEBTMUX_IN_CONTAINER", "1")
	if !detectContainer() {
		t.Fatal("WEBTMUX_IN_CONTAINER=1 should force true")
	}
	t.Setenv("WEBTMUX_IN_CONTAINER", "0")
	if detectContainer() {
		t.Fatal("WEBTMUX_IN_CONTAINER=0 should force false")
	}
}
