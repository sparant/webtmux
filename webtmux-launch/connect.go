package main

// The connection priority order, in one place so it can be read as a list.
//
//  1. A webtmux is already running on the target — connect to it. Exactly one:
//     take it, no questions.
//  2. Several are running — ASK which, rather than guessing. Guessing wrong does
//     not produce an error, it produces someone else's terminal.
//  3. None running — look for an existing tmux session and attach webtmux to
//     that. No sessions at all: create one.
//  4. Only now does a binary matter. Reuse one already on the target if its
//     version matches; otherwise obtain one — configured directory, then beside
//     the launcher, then the GitHub release.
//
// Steps 1-3 are about what to CONNECT to; step 4 is about what to run. Keeping
// them in that order is what makes the common case (a box already running
// webtmux) cost one probe and one tunnel, with no binary resolution at all.

import (
	"fmt"
	"strings"
	"time"
)

// pickInstance implements steps 1 and 2.
func pickInstance(insts []instance, wantPort int, c *chooser) (*instance, error) {
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

	labels := make([]string, len(insts))
	for i, in := range insts {
		l := fmt.Sprintf("port %d (pid %d", in.Port, in.PID)
		if in.Session != "" {
			l += fmt.Sprintf(", session %q", in.Session)
		}
		if in.UptimeSec > 0 {
			l += ", up " + humanAge(time.Duration(in.UptimeSec)*time.Second)
		}
		if in.Containerized {
			l += ", in a container"
		}
		labels[i] = l + ")"
	}
	idx, err := c.choose(fmt.Sprintf("%d webtmux instances are running on this machine", len(insts)),
		labels, "pick one non-interactively with --remote-port <port>, or --fresh to start another")
	if err != nil {
		return nil, err
	}
	return &insts[idx], nil
}

// pickSession implements step 3: attach to what is already there, and only
// create when there is nothing to attach to.
//
// With several sessions and no --session it makes the choice `tmux attach`
// makes with no target — prefer a session nobody is attached to, then the most
// recently active — rather than asking. That is the answer a tmux user already
// expects from "attach", and a wrong pick costs nothing: webtmux's sidebar
// lists and switches every session, and --session decides it up front. (It
// used to prompt, which interrupted every launch on a box with several
// sessions to ask a question tmux answers on its own.)
//
// Returns the session name, whether it already exists — the caller reports
// "attaching to" versus "creating", and the distinction is worth showing
// because creating one on a box you thought had sessions means something is
// wrong — and, when it chose among several, why.
func pickSession(want string, p *probe) (name string, existed bool, why string) {
	if want != "" {
		return want, contains(p.Sessions, want), ""
	}
	switch len(p.Sessions) {
	case 0:
		return "main", false, ""
	case 1:
		return p.Sessions[0], true, ""
	}
	best := ""
	for _, s := range p.Sessions {
		if best == "" || sessionBetter(p, s, best) {
			best = s
		}
	}
	why = fmt.Sprintf("the most recently used of %d sessions, as `tmux attach` would pick; --session <name> for another", len(p.Sessions))
	if p.SessionAttached[best] {
		why = fmt.Sprintf("the most recently used of %d sessions (all attached elsewhere), as `tmux attach` would pick; --session <name> for another", len(p.Sessions))
	}
	return best, true, why
}

// sessionBetter is tmux's own ordering for an untargeted attach-session
// (cmd_find_best_session with CMD_FIND_PREFER_UNATTACHED): an unattached session
// beats an attached one, then later activity wins. Ties keep list order.
func sessionBetter(p *probe, a, b string) bool {
	if p.SessionAttached[a] != p.SessionAttached[b] {
		return !p.SessionAttached[a]
	}
	return p.SessionActivity[a] > p.SessionActivity[b]
}

// webtmuxVersionMatches decides whether a webtmux already on the target is the
// one this launcher would install.
//
// `webtmux --version` prints something like "webtmux version v0.1.0", so compare
// the version token rather than the whole line. Two deliberate non-matches:
// "latest" is unpinned and could be anything, and a "dev" build carries no
// identity at all — in both cases the honest answer is "I cannot tell", and the
// safe action is to install the one we do know.
func webtmuxVersionMatches(reported, want string) bool {
	if reported == "" || want == "" || want == "latest" {
		return false
	}
	tok := versionToken(reported)
	if tok == "" || tok == "dev" {
		return false
	}
	return tok == strings.TrimSpace(want)
}

// versionToken pulls the vX.Y.Z (or bare word) out of a --version line.
func versionToken(line string) string {
	fields := strings.Fields(strings.TrimSpace(line))
	for i := len(fields) - 1; i >= 0; i-- {
		f := strings.TrimSpace(fields[i])
		if f == "" {
			continue
		}
		if strings.HasPrefix(f, "v") || f == "dev" {
			return f
		}
	}
	if len(fields) > 0 {
		return fields[len(fields)-1]
	}
	return ""
}
