package main

// Adopt an already-running webtmux.
//
// Never start a second webtmux when the box already has one. This is the common
// case, not the exception: webtmux is normally already running on these
// machines. Adopt mode skips deploy, session creation and launch entirely — the
// launcher's whole job becomes the tunnel plus the browser.

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

type instance struct {
	PID       int
	Cmdline   []string
	Env       map[string]string
	ExeSHA    string
	PIDNS     string
	Cgroup    string
	UptimeSec int

	// parsed out of Cmdline / Env
	Port          int
	Address       string
	Path          string // --path value, the secret path
	Credential    string
	NoAuth        bool
	Session       string
	Containerized bool
	Container     string // best-effort container id/name from the cgroup line
}

// parse pulls the interesting flags straight out of /proc/<pid>/cmdline. This
// beats ss/lsof: no extra dependency, and no privileges are needed to read your
// own processes.
func (i *instance) parse(selfPIDNS string) {
	get := func(idx int) string {
		if idx < len(i.Cmdline) {
			return i.Cmdline[idx]
		}
		return ""
	}
	for n, arg := range i.Cmdline {
		key, inline, hasInline := strings.Cut(arg, "=")
		val := func() string {
			if hasInline {
				return inline
			}
			return get(n + 1)
		}
		switch key {
		case "-p", "--port":
			i.Port, _ = strconv.Atoi(val())
		case "-a", "--address":
			i.Address = val()
		case "-m", "--path":
			i.Path = val()
		case "-c", "--credential":
			i.Credential = val()
		case "--no-auth":
			i.NoAuth = true
		}
	}
	// The environment is the other half: a user-set GOTTY_CREDENTIAL, and the
	// WEBTMUX_SESSION that a wrapper command hides from argv.
	if c := i.Env["GOTTY_CREDENTIAL"]; c != "" && i.Credential == "" {
		i.Credential = c
	}
	i.Session = i.Env["WEBTMUX_SESSION"]

	// The instance may be inside a container — and on a box running the
	// production deploy, it is. pgrep still finds it (same uid), but everything
	// read from /proc is then container-relative: -a 0.0.0.0 is the in-container
	// bind (published only to host loopback), -p matches the host port only by
	// coincidence of the port mapping, and /proc/<pid>/exe is the container's
	// binary, so the sha never matches.
	if selfPIDNS != "" && i.PIDNS != "" && i.PIDNS != selfPIDNS {
		i.Containerized = true
		i.Container = containerFromCgroup(i.Cgroup)
	}
}

// containerFromCgroup extracts a container id from a cgroup line such as
// 0::/docker/1a2b3c… or …/docker-1a2b3c….scope. Best effort; naming the
// container is a nicety in the report, never load-bearing.
func containerFromCgroup(line string) string {
	_, path, ok := strings.Cut(line, "::")
	if !ok {
		path = line
	}
	seg := path[strings.LastIndex(path, "/")+1:]
	seg = strings.TrimSuffix(seg, ".scope")
	seg = strings.TrimPrefix(seg, "docker-")
	seg = strings.TrimPrefix(seg, "cri-containerd-")
	if len(seg) >= 12 && !strings.ContainsAny(seg, ".:") {
		return seg[:12]
	}
	return ""
}

// secretPath is the --path value normalised to a leading and trailing slash,
// matching what webtmux serves.
func (i *instance) secretPath() string {
	p := strings.Trim(i.Path, "/")
	if p == "" {
		return "/"
	}
	return "/" + p + "/"
}

// credentialRecoverable reports whether we can tell the user the password.
// Recovery works in exactly two cases: -c user:pass on the command line, or a
// user-set GOTTY_CREDENTIAL. The default auto-generated password is created
// in-process and printed to stdout at startup — it is never in the environment
// and is NOT recoverable.
func (i *instance) needsCredential() bool { return !i.NoAuth }
func (i *instance) credentialRecoverable() bool {
	return i.Credential != ""
}

// report describes what is about to be adopted, plus any warnings.
func (i *instance) report(buildMatch string) []string {
	lines := []string{}
	desc := fmt.Sprintf("adopting webtmux pid %d on port %d", i.PID, i.Port)
	if i.Session != "" {
		desc += fmt.Sprintf(", session %q", i.Session)
	}
	if i.UptimeSec > 0 {
		desc += ", up " + humanAge(time.Duration(i.UptimeSec)*time.Second)
	}
	if i.Containerized {
		if i.Container != "" {
			desc += fmt.Sprintf(" (in container %s)", i.Container)
		} else {
			desc += " (in a container)"
		}
	}
	lines = append(lines, desc)
	if buildMatch != "" {
		lines = append(lines, "  build: "+buildMatch)
	}
	// A 0.0.0.0 bind means that instance is exposed on the box's network, not
	// just loopback — but only if the value means what it says. In a container
	// it is the in-container bind and says nothing about host exposure.
	if i.Address == "0.0.0.0" || i.Address == "::" {
		if i.Containerized {
			lines = append(lines, "  note: bind "+i.Address+" is container-relative; host exposure depends on the port mapping")
		} else {
			lines = append(lines, "  WARNING: bound to "+i.Address+" — reachable from the box's network, not just loopback")
		}
	}
	if i.NoAuth && strings.Trim(i.Path, "/") == "" {
		lines = append(lines, "  WARNING: --no-auth with no secret path — any local user on that box can reach this shell")
	}
	if i.needsCredential() {
		if i.credentialRecoverable() {
			lines = append(lines, "  auth: basic — "+i.Credential+" (paste it; browsers no longer accept user:pass@host URLs)")
		} else {
			lines = append(lines, "  auth: basic, password NOT recoverable (it was generated in-process and printed to that instance's stdout)")
			lines = append(lines, "        the browser will prompt; find the password in the terminal that started it, or use --fresh")
		}
	}
	return lines
}

// chooseInstance picks which running webtmux to adopt. More than one is not
// guessed at: they are listed and --remote-port is demanded.
func chooseInstance(insts []instance, wantPort int) (*instance, error) {
	if len(insts) == 0 {
		return nil, nil
	}
	if wantPort > 0 {
		for n := range insts {
			if insts[n].Port == wantPort {
				return &insts[n], nil
			}
		}
		return nil, fmt.Errorf("no running webtmux on port %d (found: %s)", wantPort, describeInstances(insts))
	}
	if len(insts) == 1 {
		return &insts[0], nil
	}
	return nil, fmt.Errorf("%d webtmux instances are running: %s\n(pick one with --remote-port <port>, or --fresh to start another)",
		len(insts), describeInstances(insts))
}

func describeInstances(insts []instance) string {
	var parts []string
	for _, i := range insts {
		parts = append(parts, fmt.Sprintf("pid %d port %d", i.PID, i.Port))
	}
	return strings.Join(parts, ", ")
}
