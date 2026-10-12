package webtty

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The filesystem root is never on the save allowlist by accident: a pane sitting
// at /, a home of /, or a server started from / (a systemd service's default
// WorkingDirectory) would otherwise allow a write anywhere. It is still allowed
// when somebody NAMES it. See isFilesystemRoot.

// chdir for the length of a test (os.Chdir is process-wide, so tests using it
// must not run in parallel — none in this package do).
func chdir(t *testing.T, dir string) {
	t.Helper()
	old, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(dir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(old) })
}

// Outside a container, with a real home and nothing configured.
func hostEnv(t *testing.T, home string) {
	t.Helper()
	t.Setenv("WEBTMUX_PATH_MAP", "")
	t.Setenv("WEBTMUX_SAVE_DIR", "")
	t.Setenv("WEBTMUX_IN_CONTAINER", "0")
	t.Setenv("WEBTMUX_HOME", home)
}

func TestIsFilesystemRoot(t *testing.T) {
	for dir, want := range map[string]bool{"/": true, "/.": true, "//": true, "/tmp": false, "": false} {
		if got := isFilesystemRoot(dir); got != want {
			t.Errorf("isFilesystemRoot(%q) = %v, want %v", dir, got, want)
		}
	}
}

func TestAPaneAtTheRootDoesNotAllowEverything(t *testing.T) {
	home := t.TempDir()
	hostEnv(t, home)
	outside := t.TempDir()

	env := describeSaveEnv("/", "")
	if env.BaseDir != home {
		t.Errorf("a pane at / should save plain names in the home directory, got BaseDir=%q", env.BaseDir)
	}
	for _, r := range saveRoots(env) {
		if isFilesystemRoot(r) {
			t.Fatalf("/ is on the allowlist only because the pane sits there: %v", saveRoots(env))
		}
	}
	if _, err := resolveSavePath(env, filepath.Join(outside, "stolen.txt")); err == nil {
		t.Error("a pane at / let a save land outside every allowed directory")
	}
	if got, err := resolveSavePath(env, "fine.txt"); err != nil || got != filepath.Join(home, "fine.txt") {
		t.Errorf("a plain name should still save, in the home directory: %q, %v", got, err)
	}
}

func TestAServerStartedFromTheRootDoesNotAllowEverything(t *testing.T) {
	pane := t.TempDir()
	hostEnv(t, t.TempDir())
	chdir(t, "/")

	env := describeSaveEnv(pane, "")
	for _, r := range saveRoots(env) {
		if isFilesystemRoot(r) {
			t.Fatalf("/ is on the allowlist only because webtmux was started there: %v", saveRoots(env))
		}
	}
	if _, err := resolveSavePath(env, filepath.Join(t.TempDir(), "stolen.txt")); err == nil {
		t.Error("a server started from / let a save land anywhere")
	}
	if _, err := resolveSavePath(env, filepath.Join(pane, "fine.txt")); err != nil {
		t.Errorf("the pane's own directory must still work: %v", err)
	}
}

func TestAHomeOfRootDoesNotAllowEverything(t *testing.T) {
	pane := t.TempDir()
	hostEnv(t, "/")

	env := describeSaveEnv(pane, "")
	if _, err := resolveSavePath(env, filepath.Join(t.TempDir(), "stolen.txt")); err == nil {
		t.Error("a home of / let a save land anywhere")
	}
}

func TestTheRootIsAllowedWhenNamed(t *testing.T) {
	anywhere := filepath.Join(t.TempDir(), "out.txt")

	hostEnv(t, t.TempDir())
	t.Setenv("WEBTMUX_SAVE_DIR", "/")
	if _, err := resolveSavePath(describeSaveEnv(t.TempDir(), ""), anywhere); err != nil {
		t.Errorf("WEBTMUX_SAVE_DIR=/ is an explicit choice and must be honored: %v", err)
	}

	hostEnv(t, t.TempDir())
	if _, err := resolveSavePath(describeSaveEnv(t.TempDir(), "/"), anywhere); err != nil {
		t.Errorf("/ chosen in the dropdown is an explicit choice and must be honored: %v", err)
	}
}

func TestEveryDefaultBeingTheRootAsksForADirectory(t *testing.T) {
	hostEnv(t, "/")
	chdir(t, "/")

	env := describeSaveEnv("/", "")
	if !env.Blocked {
		t.Fatalf("with every default at /, there is no default to save in: %+v", env)
	}
	_, err := resolveSavePath(env, "out.txt")
	if err == nil || !strings.Contains(err.Error(), "only used when you name it") {
		t.Errorf("the refusal should say / must be named, not talk about containers: %v", err)
	}
}
