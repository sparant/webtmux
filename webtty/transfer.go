package webtty

// Moving whole FILES between the machine the browser runs on and the machine
// tmux runs on.
//
// The save dropdown next door writes one thing — a pane's buffer — to one place.
// This is the other half of the question people actually have while looking at
// that pane, and over an ssh connection it is the expensive half: the file you
// want is on the far end, and getting it to the laptop in front of you means
// finding a second terminal, remembering the host and the port and the jump box,
// and typing an scp line that has nothing to do with the session already on your
// screen. The session already knows the machine. It should be able to hand you
// the file.
//
// A transfer therefore has exactly TWO ends, and every sentence in the UI names
// both of them: THIS BROWSER, and THE MACHINE TMUX RUNS ON. webtmux itself is
// deliberately never named as an endpoint. It is in the middle of every byte, but
// a user who has to think about that has already been failed — "which of the
// three machines does this path mean?" is the question the whole feature exists
// to stop anyone asking.
//
// What is NOT here is scp. The bytes ride the same authenticated HTTP connection
// that served the page (see server/handler_transfer.go), because that connection
// is already tunnelled through whatever ssh forwarding got the browser here and
// needs no key material, no known_hosts, and no second credential inside
// webtmux. "SCP" is the SHAPE of the feature — a source, a destination, files or
// whole folders — not its transport. Saying scp in the UI would be a promise
// about ssh that this code does not keep.
//
// Paths on the far end resolve through EXACTLY the machinery a save uses
// (savepath.go): the same `~`, the same WEBTMUX_PATH_MAP prefix rewrite, the
// same containment allowlist, the same SaveEnv the dropdown already probes for
// and explains. That is not code thrift. A transfer that could read or write
// outside the directories a save is confined to would reduce the save path's
// containment to a formality — you would simply use the other button. Two doors
// into one filesystem must be the same door.

import (
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// TransferEnv answers "where do this window's transfer paths resolve?" — the
// exported name for the SaveEnv the save dropdown is already built from, so the
// HTTP handlers in package server can ask the same question the websocket
// handlers ask. `paneDir` is the pane's working directory as tmux reports it and
// `chosen` the directory the user named in the dropdown; both may be "".
func TransferEnv(paneDir, chosen string) SaveEnv {
	return describeSaveEnv(paneDir, chosen)
}

// TransferRoots lists the directories transfers are confined to, for a message
// that has to say what IS on offer. Same list a save is held to.
func TransferRoots(env SaveEnv) []string {
	return saveRoots(env)
}

// ---- reading: the download half ------------------------------------------------

// ResolveTransferSource turns a user-typed source path into something that can
// be read, and refuses it unless it exists and lies inside the allowlist.
//
// Three differences from resolveSavePath, all of them because this reads instead
// of writing:
//
//   - a directory is a legitimate answer, not an error (a folder downloads as a
//     zip), so `isDir` comes back rather than a refusal;
//   - the path must ALREADY EXIST — a save creates its target, a download cannot;
//   - containment is checked on the resolved path ITSELF, not on its parent. A
//     save's target may not exist yet, so only its parent can be resolved; here
//     the thing named is right there, and a symlink pointing out of the allowlist
//     must be caught by following it rather than by trusting the directory it sits
//     in.
func ResolveTransferSource(env SaveEnv, p string) (resolved string, isDir bool, err error) {
	if strings.TrimSpace(p) == "" {
		return "", false, fmt.Errorf("enter the path of a file or folder on the machine tmux runs on")
	}
	resolved, err = expandPath(env, p)
	if err != nil {
		return "", false, err
	}
	st, err := os.Stat(resolved)
	if err != nil {
		if os.IsNotExist(err) {
			return "", false, fmt.Errorf("%s", missingSourceMessage(env, resolved))
		}
		if os.IsPermission(err) {
			return "", false, fmt.Errorf("no permission to read %s — webtmux runs as uid %d on that machine",
				resolved, os.Getuid())
		}
		return "", false, fmt.Errorf("could not read %s: %v", resolved, err)
	}
	// Neither a device, socket, nor fifo. Reading a fifo blocks until something
	// on the far end writes, which from the browser looks exactly like a hung
	// download and is not something a user can diagnose or cancel.
	if !st.IsDir() && !st.Mode().IsRegular() {
		return "", false, fmt.Errorf("%s is not a regular file or folder (it is %s), so there is nothing to transfer",
			resolved, describeMode(st.Mode()))
	}
	roots := TransferRoots(env)
	if !containedExisting(resolved, roots) {
		return "", false, fmt.Errorf("%s", outsideReadMessage(resolved, roots))
	}
	return resolved, st.IsDir(), nil
}

// ---- writing: the upload half ----------------------------------------------------

// ResolveTransferDest turns a user-typed destination into a directory uploads may
// be written into. Unlike a save's target it must already exist: an upload names
// a place to PUT things, and a directory webtmux would have to invent is not one
// the user has looked at and decided on.
func ResolveTransferDest(env SaveEnv, dir string) (string, error) {
	if strings.TrimSpace(dir) == "" {
		return "", fmt.Errorf("enter the folder on the machine tmux runs on to upload into")
	}
	resolved, err := expandPath(env, dir)
	if err != nil {
		return "", err
	}
	if !dirExists(resolved) {
		if targetExists(resolved) {
			return "", fmt.Errorf("%s is a file, not a folder — uploads need a folder to land in", resolved)
		}
		return "", fmt.Errorf("%s", missingDirMessage(env, resolved))
	}
	roots := TransferRoots(env)
	if !containedExisting(resolved, roots) {
		return "", fmt.Errorf("%s", outsideMessage(resolved, roots))
	}
	if !dirWritable(resolved) {
		return "", fmt.Errorf("webtmux cannot write to %s — it runs as uid %d on that machine",
			resolved, os.Getuid())
	}
	return resolved, nil
}

// ResolveUploadTarget places ONE incoming file inside an already-resolved
// destination directory, creating the intermediate directories a folder upload
// implies, and hands back the absolute path to write.
//
// `rel` is client-supplied and is the only string in this file that a browser
// composes rather than a person types: for a folder upload it is the browser's
// webkitRelativePath ("src/lib/util.js"). It is therefore treated as hostile.
// uploadRelName strips it to a clean relative path with no `..` in it, which is
// most of the answer — but not all of it, because a SYMLINK already sitting in
// the destination ("incoming/logs" -> /etc) turns an innocent "logs/passwd" into
// an escape that no amount of string cleaning would catch. So the parent is
// containment-checked AFTER the directories exist, with symlinks resolved, which
// is the only moment the question can be answered truthfully.
func ResolveUploadTarget(env SaveEnv, destDir, rel string) (string, error) {
	clean, err := uploadRelName(rel)
	if err != nil {
		return "", err
	}
	target := filepath.Join(destDir, filepath.FromSlash(clean))
	parent := filepath.Dir(target)
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return "", fmt.Errorf("could not create %s: %v", parent, err)
	}
	roots := TransferRoots(env)
	if !contained(target, roots) {
		return "", fmt.Errorf("%s would land outside the folders webtmux may write to (%s)",
			target, strings.Join(roots, ", "))
	}
	// A pre-existing symlink AT the name is followed by the write, exactly as it
	// is for a save (see resolveSavePath), so it gets the same second check.
	if link, err := filepath.EvalSymlinks(target); err == nil && link != target {
		if !contained(link, roots) {
			return "", fmt.Errorf("%s is a symlink to %s, which is outside the folders webtmux may write to",
				target, link)
		}
	}
	return target, nil
}

// uploadRelName reduces a browser-supplied name to a relative path that cannot
// point anywhere but downward.
//
// Everything here is a refusal rather than a repair, with one exception: leading
// separators and `.` segments are simply dropped, because a browser produces
// them incidentally and dropping them changes nothing about where the file
// lands. A `..` is different — it is never incidental, and a caller that meant
// something by it should be told no rather than quietly given a different
// destination than the one it named.
func uploadRelName(rel string) (string, error) {
	// Windows browsers report separators as "/" in webkitRelativePath, but a
	// dragged file's name can still arrive with a backslash in it. Normalize
	// before splitting or a "..\.." sails through the `..` check below.
	s := strings.ReplaceAll(strings.TrimSpace(rel), `\`, "/")
	if s == "" {
		return "", fmt.Errorf("an uploaded file arrived with no name")
	}
	// A drive letter or UNC prefix is not a relative path by any reading.
	if strings.Contains(s, ":") {
		return "", fmt.Errorf("%q is not a plain relative name", rel)
	}
	var parts []string
	for _, seg := range strings.Split(s, "/") {
		switch seg {
		case "", ".":
			continue
		case "..":
			return "", fmt.Errorf("%q contains \"..\", which would put the file outside the folder you chose", rel)
		}
		parts = append(parts, seg)
	}
	if len(parts) == 0 {
		return "", fmt.Errorf("%q names no file", rel)
	}
	clean := path.Join(parts...)
	if clean == "" || clean == "." {
		return "", fmt.Errorf("%q names no file", rel)
	}
	return clean, nil
}

// ---- containment for things that already exist -----------------------------------

// containedExisting reports whether an EXISTING path — file or directory — lies
// inside one of the roots once its symlinks are resolved.
//
// The sibling `contained` in savepath.go answers the same question for a path
// that may not exist yet, and so can only resolve the PARENT. Here the thing is
// on disk, so the honest check is on the thing itself: a source file that is a
// symlink into /etc sits in a perfectly allowed directory, and only following it
// says so.
func containedExisting(p string, roots []string) bool {
	real, err := filepath.EvalSymlinks(p)
	if err != nil {
		return false
	}
	for _, r := range roots {
		if rr := realDir(r); rr != "" && underRoot(real, rr) {
			return true
		}
	}
	return false
}

// ---- walking a folder ------------------------------------------------------------

// TransferEntry is one file inside a folder being downloaded: where to read it
// from, and the name it should carry inside the archive.
type TransferEntry struct {
	// Path is absolute, on the machine tmux runs on.
	Path string
	// Name is the slash-separated path inside the archive, and always begins with
	// the source folder's own name — so unzipping produces ONE folder rather than
	// scattering its contents across whatever directory the user was in.
	Name string
	Info fs.FileInfo
}

// WalkTransferDir lists the regular files inside a folder, in the order they
// should be archived, and reports what it declined to include.
//
// Symlinks are SKIPPED rather than followed or stored. Following one would copy
// whatever it points at, which is how a download of an allowed folder quietly
// becomes a download of /etc; storing it as a link would put a path from the far
// machine into an archive that gets unpacked on this one. Neither is what
// "download this folder" means, and both are worse than a file being absent —
// so they are omitted and NAMED, because a silently incomplete archive is the
// one outcome nobody would check for.
//
// Unreadable subdirectories are likewise skipped and named rather than aborting
// the walk: a folder with one permission-denied corner should still produce the
// rest of itself.
func WalkTransferDir(root string) (entries []TransferEntry, skipped []string, err error) {
	base := filepath.Base(root)
	walkErr := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			skipped = append(skipped, fmt.Sprintf("%s (%v)", relForMessage(root, p), err))
			if d != nil && d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if p == root {
			return nil
		}
		rel, relErr := filepath.Rel(root, p)
		if relErr != nil {
			return nil
		}
		name := path.Join(base, filepath.ToSlash(rel))
		switch {
		case d.IsDir():
			return nil
		case d.Type()&fs.ModeSymlink != 0:
			skipped = append(skipped, rel+" (symlink)")
			return nil
		case !d.Type().IsRegular():
			skipped = append(skipped, rel+" (not a regular file)")
			return nil
		}
		info, infoErr := d.Info()
		if infoErr != nil {
			skipped = append(skipped, rel+" (vanished while reading)")
			return nil
		}
		entries = append(entries, TransferEntry{Path: p, Name: name, Info: info})
		return nil
	})
	if walkErr != nil {
		return entries, skipped, fmt.Errorf("could not read %s: %v", root, walkErr)
	}
	return entries, skipped, nil
}

// relForMessage names a path the way the user would recognize it — relative to
// the folder they asked for — falling back to the absolute path if that fails.
func relForMessage(root, p string) string {
	if rel, err := filepath.Rel(root, p); err == nil {
		return rel
	}
	return p
}

// ---- messages ---------------------------------------------------------------------

// describeMode names a non-regular file in words, because the reason a transfer
// refused it ("it is a named pipe") is the entire content of the message.
func describeMode(m os.FileMode) string {
	switch {
	case m&os.ModeSymlink != 0:
		return "a symlink"
	case m&os.ModeNamedPipe != 0:
		return "a named pipe"
	case m&os.ModeSocket != 0:
		return "a socket"
	case m&os.ModeDevice != 0:
		return "a device"
	}
	return "not a regular file"
}

// missingSourceMessage explains a source that isn't there in terms of WHICH
// machine is missing it. Same trap the save path documents: in the container
// deployment the user is looking at a shell sitting in a directory that plainly
// exists, and a bare "no such file" reads as a typo on their part.
func missingSourceMessage(env SaveEnv, resolved string) string {
	msg := fmt.Sprintf("there is no %s on the machine webtmux runs on", resolved)
	if env.Container {
		msg += " — webtmux is running in a container, so it does not see your host's filesystem"
	}
	if env.BaseDir != "" {
		msg += fmt.Sprintf(". A plain name is looked for in %s", env.BaseDir)
	}
	return msg
}

// outsideReadMessage is outsideMessage's counterpart for a download. Separate
// wording rather than a shared sentence about "writing", because a refusal that
// describes the wrong operation reads as a bug in webtmux rather than as a limit
// on what it was configured to reach.
func outsideReadMessage(resolved string, roots []string) string {
	if len(roots) == 0 {
		return blockedMessage()
	}
	return fmt.Sprintf("%s is outside the folders webtmux may read on that machine (%s). "+
		"Transfer something inside one of them, name a different folder in the save dropdown, "+
		"or set WEBTMUX_SAVE_DIR.", resolved, strings.Join(roots, ", "))
}
