package main

// Asking the user to choose, when the launcher genuinely cannot know.
//
// There are exactly two such moments: several webtmux instances are running, and
// several tmux sessions exist with no --session given. Both are cases where any
// automatic pick would be a guess that silently connects you to the wrong thing
// — the failure mode is not an error message, it is a terminal showing someone
// else's work.
//
// When there is no terminal to ask (a script, a cron job, a pipe), asking is
// impossible and guessing is still wrong, so the launcher fails and names the
// flag that would have decided it.

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
)

type chooser struct {
	in  io.Reader
	out io.Writer
	// interactive is false when stdin is not a terminal. Kept as a field so
	// tests can exercise both paths without a pty.
	interactive bool
}

func newChooser() *chooser {
	return &chooser{in: os.Stdin, out: os.Stderr, interactive: stdinIsTerminal()}
}

// stdinIsTerminal avoids a dependency on x/term for one bit of information.
//
// A pipe or a regular file is obviously not a terminal. The trap — found by the
// end-to-end suite — is that `< /dev/null` IS a character device, so the mode
// check alone calls it a terminal, the launcher prompts, and the read returns
// EOF instantly: a script gets "no choice made" instead of the message naming
// the flag it should have passed. Comparing against /dev/null itself covers the
// one realistic case the mode bit gets wrong.
func stdinIsTerminal() bool {
	fi, err := os.Stdin.Stat()
	if err != nil || fi.Mode()&os.ModeCharDevice == 0 {
		return false
	}
	if devNull, err := os.Stat(os.DevNull); err == nil && os.SameFile(fi, devNull) {
		return false
	}
	return true
}

// choose presents a numbered menu and returns the selected index.
//
// noTTYHint is what to tell someone who cannot be asked — it must name the flag
// that decides this, because "run it interactively" is useless advice inside a
// script.
func (c *chooser) choose(title string, labels []string, noTTYHint string) (int, error) {
	switch len(labels) {
	case 0:
		return -1, fmt.Errorf("nothing to choose from")
	case 1:
		return 0, nil
	}
	if !c.interactive {
		var b strings.Builder
		fmt.Fprintf(&b, "%s, and there is no terminal to ask:\n", title)
		for i, l := range labels {
			fmt.Fprintf(&b, "  %d. %s\n", i+1, l)
		}
		b.WriteString("(" + noTTYHint + ")")
		return -1, fmt.Errorf("%s", b.String())
	}

	fmt.Fprintf(c.out, "%s:\n", title)
	for i, l := range labels {
		fmt.Fprintf(c.out, "  %d. %s\n", i+1, l)
	}
	r := bufio.NewReader(c.in)
	// Three tries, then give up rather than looping forever against a stream
	// that keeps returning something unparseable.
	for attempt := 0; attempt < 3; attempt++ {
		fmt.Fprintf(c.out, "choose 1-%d: ", len(labels))
		line, err := r.ReadString('\n')
		if err != nil && strings.TrimSpace(line) == "" {
			return -1, fmt.Errorf("no choice made (%v)\n(%s)", err, noTTYHint)
		}
		n, convErr := strconv.Atoi(strings.TrimSpace(line))
		if convErr == nil && n >= 1 && n <= len(labels) {
			return n - 1, nil
		}
		fmt.Fprintf(c.out, "  not a choice between 1 and %d\n", len(labels))
	}
	return -1, fmt.Errorf("no valid choice after 3 attempts\n(%s)", noTTYHint)
}
