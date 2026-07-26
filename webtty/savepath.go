package webtty

// Where "save this pane's buffer on the machine tmux runs on" actually lands.
//
// The complication is that webtmux and tmux need not share a filesystem. The
// deployment this was written against runs webtmux in a container whose ONLY
// host mount is the tmux control socket, so tmux truthfully reports a pane
// directory like /home/nathan/Projects that simply does not exist for the
// process doing the write. Resolving a relative path against it produced
//
//     open /home/nathan/Projects/services-13-webtmux.txt: no such file or directory
//
// — an error about a path the user never typed, naming a directory they can see
// in their own shell. The path wasn't wrong; the two sides were looking at
// different filesystems and nothing said so.
//
// So this file makes the two filesystems explicit. Every save is described by a
// SaveEnv (below) that the browser can ASK FOR BEFORE SAVING, so the dropdown
// can say where a relative path will land — and say why, when that isn't the
// pane's own directory. Two optional env vars let an operator make the two sides
// agree rather than merely explain the disagreement:
//
//	WEBTMUX_PATH_MAP  host=server[,host2=server2]  prefix rewrites applied to the
//	                  pane directory AND to any absolute path you type, so
//	                  /home/nathan/Projects can resolve to /host-home/Projects.
//	WEBTMUX_SAVE_DIR  where relative saves land when the pane's directory isn't
//	                  visible here. Created if missing. Defaults to $HOME, then
//	                  the process's own working directory.
//	WEBTMUX_HOME      what `~` expands to (the container's own $HOME is rarely
//	                  the home the user means).
//
// WEBTMUX_SAVE_DIR carries more weight than "a default directory": it is the only
// way webtmux can know that a directory is SHARED. A container's own filesystem
// is always there and always writable, so without that declaration a save would
// succeed into storage that dies with the container. So when webtmux is
// containerized and nothing is declared, saving is refused (SaveEnv.Blocked) and
// the UI points at "Download to browser", which needs no mount at all.
//
// That is the DEFAULT state of the webtmux container in this repo's deployment:
// it mounts only the tmux control socket, on purpose — no host filesystem is
// exposed to it. Enabling server-side saves means mounting ONE DEDICATED
// directory at the same path on both sides and naming it in WEBTMUX_SAVE_DIR.

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// SaveEnv describes, for one window, where a save would land — the answer the
// save dropdown shows before you press Save, and the context an error is
// phrased against. Marshalled to the browser as a TmuxSaveInfo payload.
type SaveEnv struct {
	// PaneDir is the pane's working directory exactly as tmux reports it (a path
	// on the machine tmux runs on, which may not exist here).
	PaneDir string `json:"paneDir"`
	// BaseDir is the directory a RELATIVE path will actually resolve against.
	BaseDir string `json:"baseDir"`
	// PaneVisible is true when PaneDir (after mapping) exists on this filesystem,
	// i.e. when BaseDir is the pane's own directory and everything is boring.
	PaneVisible bool `json:"paneVisible"`
	// Mapped is true when WEBTMUX_PATH_MAP rewrote PaneDir to reach BaseDir.
	Mapped bool `json:"mapped"`
	// Container is true when webtmux appears to be running inside a container —
	// the usual reason PaneVisible is false, and worth saying out loud because it
	// explains an otherwise baffling "no such directory".
	Container bool `json:"container"`
	// Home is what `~` expands to here.
	Home string `json:"home"`
	// Writable is false when BaseDir can't be written by this process; the UI
	// warns before the user types a name and presses Save.
	Writable bool `json:"writable"`
	// Blocked is true when there is nowhere honest to write at all: webtmux is
	// containerized, the pane's directory isn't reachable, and neither the
	// operator (WEBTMUX_SAVE_DIR) nor the user (Chosen) has named a shared
	// directory. Saving is refused in that state — see fallbackSaveDir for why
	// refusing beats writing into the image's own filesystem.
	Blocked bool `json:"blocked"`
	// Chosen is the directory the USER named in the save dropdown, echoed back
	// when it checks out. webtmux cannot tell a bind mount from an image
	// directory, but the person who ran the container can — so when there is no
	// operator declaration, the UI asks, and this is the answer in force.
	Chosen string `json:"chosen"`
	// ChosenError explains why a directory the user named was rejected (missing,
	// not a directory, not writable). The UI keeps asking rather than silently
	// falling back to somewhere they didn't pick.
	ChosenError string `json:"chosenError"`
}

// ---- environment probes -------------------------------------------------------

var (
	probeOnce sync.Once
	probeVal  bool
)

// inContainer reports whether webtmux is running inside a container.
//
// WEBTMUX_IN_CONTAINER=1/0 forces the answer for deployments the probes miss (or
// wrongly flag), and is re-read every call so it stays a live switch; only the
// filesystem PROBE is memoized (it cannot change during a process's life, and it
// is asked on every save).
//
// This no longer only picks wording: with no shared directory, containerization
// is what makes a save refuse rather than write into storage that disappears —
// see fallbackSaveDir.
func inContainer() bool {
	switch strings.TrimSpace(os.Getenv("WEBTMUX_IN_CONTAINER")) {
	case "1", "true", "yes":
		return true
	case "0", "false", "no":
		return false
	}
	probeOnce.Do(func() { probeVal = probeContainer() })
	return probeVal
}

// probeContainer is the heuristic half of inContainer, without the override.
func probeContainer() bool {
	// Docker writes /.dockerenv; podman/CRI-O write /run/.containerenv.
	for _, marker := range []string{"/.dockerenv", "/run/.containerenv"} {
		if _, err := os.Stat(marker); err == nil {
			return true
		}
	}
	// Fall back to pid 1's cgroup, which names the runtime under most engines.
	if data, err := os.ReadFile("/proc/1/cgroup"); err == nil {
		s := string(data)
		for _, needle := range []string{"docker", "containerd", "libpod", "kubepods", "lxc"} {
			if strings.Contains(s, needle) {
				return true
			}
		}
	}
	return false
}

// pathMapping is one host-prefix -> server-prefix rewrite from WEBTMUX_PATH_MAP.
type pathMapping struct{ from, to string }

// parsePathMap reads "from=to,from2=to2". Entries missing a '=' , or with an
// empty side, are skipped rather than failing the save: a typo'd mapping should
// degrade to "no mapping" (which still saves, with an explanation) instead of
// breaking a feature the user is in the middle of using.
func parsePathMap(spec string) []pathMapping {
	var out []pathMapping
	for _, part := range strings.Split(spec, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		i := strings.Index(part, "=")
		if i <= 0 {
			continue
		}
		from := strings.TrimRight(strings.TrimSpace(part[:i]), "/")
		to := strings.TrimRight(strings.TrimSpace(part[i+1:]), "/")
		if from == "" || to == "" {
			continue
		}
		out = append(out, pathMapping{from: from, to: to})
	}
	return out
}

// configuredPathMap is the process's WEBTMUX_PATH_MAP, parsed. Read at each use
// rather than cached so a test (and an operator restarting with a corrected
// value) sees what the environment currently says.
func configuredPathMap() []pathMapping {
	return parsePathMap(os.Getenv("WEBTMUX_PATH_MAP"))
}

// applyPathMap rewrites p under the longest matching prefix. Matching is on path
// BOUNDARIES: /home/nathan must not match /home/nathanx.
func applyPathMap(maps []pathMapping, p string) (string, bool) {
	best := -1
	for i, m := range maps {
		if p != m.from && !strings.HasPrefix(p, m.from+"/") {
			continue
		}
		if best < 0 || len(m.from) > len(maps[best].from) {
			best = i
		}
	}
	if best < 0 {
		return p, false
	}
	m := maps[best]
	return filepath.Clean(m.to + p[len(m.from):]), true
}

func dirExists(p string) bool {
	if p == "" {
		return false
	}
	st, err := os.Stat(p)
	return err == nil && st.IsDir()
}

// dirWritable reports whether this process can create a file in dir. Probes by
// actually creating and removing one — permission bits alone lie about
// read-only mounts, which is exactly the container case this file exists for.
func dirWritable(dir string) bool {
	if !dirExists(dir) {
		return false
	}
	f, err := os.CreateTemp(dir, ".webtmux-write-probe-*")
	if err != nil {
		return false
	}
	name := f.Name()
	f.Close()
	os.Remove(name)
	return true
}

// serverHome is what `~` expands to, or "" when `~` has no honest meaning here.
//
// WEBTMUX_HOME wins. Inside a container with nothing declared it is "": the
// image's own home (/root, or a service account) is a real, writable directory
// that is NOT the home of the person typing `~/out.txt`, so expanding to it
// would quietly write the file into storage that vanishes. Same rule as
// fallbackSaveDir — refuse rather than resolve to the wrong machine's home.
func serverHome() string {
	if h := strings.TrimSpace(os.Getenv("WEBTMUX_HOME")); h != "" {
		return filepath.Clean(h)
	}
	if inContainer() {
		return ""
	}
	if h, err := os.UserHomeDir(); err == nil {
		return h
	}
	return ""
}

// configuredSaveDir is WEBTMUX_SAVE_DIR, created if missing — naming it is an
// instruction, not a question. "" when unset or unusable.
//
// Setting it is also a DECLARATION, and the only one webtmux gets: a container
// cannot tell a bind-mounted directory from one that exists solely inside the
// image. WEBTMUX_SAVE_DIR is the operator saying "this directory is shared and a
// file written here is a file you can reach". See fallbackSaveDir.
func configuredSaveDir() string {
	d := strings.TrimSpace(os.Getenv("WEBTMUX_SAVE_DIR"))
	if d == "" {
		return ""
	}
	d = filepath.Clean(d)
	if !dirExists(d) {
		_ = os.MkdirAll(d, 0o755)
	}
	if dirExists(d) {
		return d
	}
	return ""
}

// checkChosenDir validates a directory the USER named in the save dropdown. It
// must already exist — the point of the question is "which mounted directory is
// this?", and a path webtmux would have to CREATE is, by definition, not one that
// was mounted. Returns (cleanPath, "") or ("", reason).
func checkChosenDir(dir string) (string, string) {
	dir = strings.TrimSpace(dir)
	if dir == "" {
		return "", ""
	}
	if !filepath.IsAbs(dir) {
		return "", fmt.Sprintf("%s is not an absolute path — give the directory as webtmux sees it, e.g. /workspace", dir)
	}
	dir = filepath.Clean(dir)
	if !dirExists(dir) {
		return "", fmt.Sprintf("there is no directory %s inside the container webtmux runs in", dir)
	}
	if !dirWritable(dir) {
		return "", fmt.Sprintf("%s exists but webtmux cannot write to it (it runs as uid %d)", dir, os.Getuid())
	}
	return dir, ""
}

// fallbackSaveDir is where relative saves land when the pane's own directory
// isn't visible here: the user's chosen directory, else WEBTMUX_SAVE_DIR, else
// $HOME, else the process's cwd.
//
// The USER's choice outranks WEBTMUX_SAVE_DIR because it is the more specific,
// more recent statement of intent — the operator's variable is a default for the
// deployment, not a veto on where this person wants this file.
//
// Returns "" INSIDE A CONTAINER when nobody has named a directory — the case
// where there is no honest answer. The image's own home and cwd are always
// present and always writable, so falling back to them would report a cheerful
// "Saved: /home/webtmux/out.txt" for a file nobody can open and that dies with
// the container. A refusal that names the escape hatch beats a success that lies.
func fallbackSaveDir(chosen string) string {
	if chosen != "" {
		return chosen
	}
	if d := configuredSaveDir(); d != "" {
		return d
	}
	if inContainer() {
		return ""
	}
	if h := serverHome(); dirExists(h) {
		return h
	}
	if cwd, err := os.Getwd(); err == nil {
		return cwd
	}
	return "/"
}

// ---- the resolver -------------------------------------------------------------

// describeSaveEnv answers "if I saved to this window right now, where would it
// go?" — for the pre-save hint AND for the save itself, so the hint can never
// describe a different rule than the one that runs. `chosen` is the directory the
// user picked in the dropdown (persisted client-side and sent with every
// request); "" when they haven't been asked yet or have nothing to say.
func describeSaveEnv(paneDir, chosen string) SaveEnv {
	maps := configuredPathMap()
	env := SaveEnv{
		PaneDir:   paneDir,
		Container: inContainer(),
		Home:      serverHome(),
	}
	// Validate the user's directory first, so a stale one (a mount that went away
	// between sessions) is REPORTED rather than silently ignored — the dropdown
	// re-asks with the reason instead of quietly saving somewhere else.
	ok, why := checkChosenDir(chosen)
	env.Chosen, env.ChosenError = ok, why

	mapped, didMap := applyPathMap(maps, paneDir)
	if dirExists(mapped) {
		env.BaseDir = mapped
		env.PaneVisible = true
		env.Mapped = didMap
	} else {
		env.BaseDir = fallbackSaveDir(ok)
	}
	// No BaseDir at all: containerized with nothing shared to write into. The UI
	// turns this into "tell me which mounted directory to use", with the browser
	// download as the answer that needs no directory at all.
	env.Blocked = env.BaseDir == ""
	env.Writable = !env.Blocked && dirWritable(env.BaseDir)
	return env
}

// resolveSavePath turns a user-typed path into an absolute one on THIS machine.
// `~`/`~/…` expand to the server's home; a relative path resolves against
// env.BaseDir; an absolute path is honored as typed — but every result goes
// through the same prefix mapping, so typing the host path you can see in your
// own shell lands in its mapped equivalent here rather than failing.
//
// The parent directory is checked up front so the failure is described in the
// vocabulary of the two filesystems ("that directory doesn't exist HERE, and
// here's why") rather than as a raw open(2) error about a path the user may
// never have typed.
func resolveSavePath(env SaveEnv, path string) (string, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return "", fmt.Errorf("enter a file name")
	}
	// Nowhere shared to write: a bare name (or ~) has no honest destination, so
	// refuse instead of inventing one inside the image. An ABSOLUTE path is still
	// allowed through — someone who mounted a directory and typed its path knows
	// something webtmux can't infer, and the dir-exists check below still guards it.
	if env.Blocked && !filepath.IsAbs(path) && !strings.HasPrefix(path, "~") {
		return "", fmt.Errorf("%s", blockedMessage())
	}
	if path == "~" || strings.HasPrefix(path, "~/") {
		// Blocked first: "there is nowhere to save at all" outranks "~ is the wrong
		// home", because it is the bigger fact and the one with the fix in it.
		if env.Blocked {
			return "", fmt.Errorf("%s", blockedMessage())
		}
		if env.Home == "" {
			// `~` on which machine? Not this one's — see serverHome.
			return "", fmt.Errorf("~ has no meaning here: webtmux's own home is inside its container, "+
				"not the home you see in your shell. Use a plain file name%s, an absolute path, or set WEBTMUX_HOME",
				baseDirSuffix(env))
		}
		if path == "~" {
			path = env.Home
		} else {
			path = filepath.Join(env.Home, path[2:])
		}
	}
	if !filepath.IsAbs(path) {
		path = filepath.Join(env.BaseDir, path)
	}
	resolved, _ := applyPathMap(configuredPathMap(), filepath.Clean(path))
	if strings.HasSuffix(resolved, string(filepath.Separator)) || dirExists(resolved) {
		return "", fmt.Errorf("%s is a directory — add a file name", resolved)
	}
	dir := filepath.Dir(resolved)
	if !dirExists(dir) {
		return "", fmt.Errorf("%s", missingDirMessage(env, dir))
	}
	return resolved, nil
}

// blockedMessage is what a save gets when webtmux has no directory it shares
// with the machine tmux runs on. It has to do two jobs at once: tell the user the
// thing that always works (the browser download needs no mount at all), and tell
// whoever deploys webtmux the one switch that turns this on — because the reader
// of the message is often both people.
func blockedMessage() string {
	return "webtmux does not know a directory it shares with the machine tmux runs on, so a file saved " +
		`here could land inside the container and vanish with it. Name a mounted directory in the ` +
		`save dropdown (webtmux checks it), use "Download to browser", or set WEBTMUX_SAVE_DIR.`
}

// baseDirSuffix is " (saves in <dir>)" when there is one, else "" — so a message
// can offer the working alternative without claiming one that doesn't exist.
func baseDirSuffix(env SaveEnv) string {
	if env.BaseDir == "" {
		return ""
	}
	return fmt.Sprintf(" (saves in %s)", env.BaseDir)
}

// missingDirMessage explains a missing target directory in terms of WHICH
// machine is missing it, and what to do about it. The container case gets named
// explicitly: without that sentence the message is indistinguishable from a
// typo, and the user has a shell open in a directory that plainly exists.
func missingDirMessage(env SaveEnv, dir string) string {
	msg := fmt.Sprintf("there is no directory %s on the machine webtmux runs on", dir)
	if env.Container {
		msg += " — webtmux is running in a container, so it does not see your host's filesystem"
	}
	if env.BaseDir != "" {
		msg += fmt.Sprintf(". A plain file name saves in %s", env.BaseDir)
	}
	msg += `; "Download to browser" always works.`
	return msg
}

// writeErrorMessage turns a failed write into something actionable. os.WriteFile
// reports permission problems as "permission denied" with no hint that webtmux
// is a different user than the shell you're looking at, which is the usual cause
// under a container that pins its uid.
func writeErrorMessage(resolved string, err error) string {
	if os.IsPermission(err) {
		return fmt.Sprintf("no permission to write %s — webtmux runs as uid %d on that machine", resolved, os.Getuid())
	}
	return fmt.Sprintf("could not write %s: %v", resolved, err)
}
