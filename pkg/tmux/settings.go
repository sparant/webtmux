package tmux

import (
	"fmt"
	"strings"
)

// The tmux status line, as a thing webtmux OWNS while it is attached.
//
// tmux draws a status line across the bottom row of every client. In a terminal
// that is a feature; in the browser it is a duplicate. webtmux already draws the
// session, the window list, each window's stoplight and the copy-mode state in
// its own toolbar and sidebar, in a form you can click — so tmux's green bar is
// the same information again, in a row that cannot be interacted with, costing a
// line of terminal on every region of a split. Hence the default here: hidden on
// attach, one click from coming back.
//
// SCOPE, stated plainly because it is the surprising part. tmux has no per-CLIENT
// status option — `status` is a session option, and webtmux's primary region
// attaches to the SHARED base session (see attach-web.sh mode 2), the same one an
// ssh console is attached to. So `set-option -g status off` hides the bar in the
// terminal too, and there is no formulation of this feature that does not. That is
// why the decision is REMEMBERED rather than re-imposed: turn it back on once and
// webtmux stops hiding it for as long as this tmux server lives.
//
// WHERE THE DECISION LIVES. In the tmux server, as a user option, not in the
// browser: the thing being changed is server state that every client shares, so a
// preference stored per-browser-profile would have one client hiding a bar another
// client had deliberately turned on. @wt_status_show is the same kind of object as
// @wt_working and @wt_state — webtmux's own memory, kept where the thing it
// describes is kept, and gone when the server it describes is gone.

// statusShowOption records the user's DECISION: "1" = they want the bar, "0" =
// they want it hidden, unset = they have never said, which is what makes the
// hide-on-attach default a default rather than an override.
const statusShowOption = "@wt_status_show"

// statusSavedOption remembers what `status` was set to before webtmux hid it, so
// turning it back on restores THAT rather than a guess. It matters because
// `status` is not a boolean: since tmux 2.9 it takes 2..5 as well, for a status
// line of that many rows, and restoring a 3-row status line as plain "on" would
// silently throw two rows of someone's configuration away.
const statusSavedOption = "@wt_status_saved"

// statusOff is the one value of `status` that means "not drawn". Everything else
// — "on", "2".."5" — draws something.
const statusOff = "off"

// Settings is what the toolbar's link menu shows and changes. One struct for the
// whole tmux-settings section rather than one per option: the menu asks for all of
// it at once, and a reply that could answer about some settings and not others
// would need every consumer to handle a half-answer.
type Settings struct {
	// Status is tmux's `status` option verbatim ("on", "off", "2".."5"), so a
	// multi-row status line is reported as what it is.
	Status string `json:"status"`
	// On is the boolean the checkbox draws: Status != "off".
	On bool `json:"on"`
	// Chosen is true once the user has told webtmux which way they want it. While
	// it is false the menu can honestly say the bar is hidden BY WEBTMUX, which is
	// otherwise indistinguishable from a tmux.conf that turned it off.
	Chosen bool `json:"chosen"`
	// Error is why the answer is not trustworthy — an empty string means it is.
	Error string `json:"error,omitempty"`
}

// globalOption reads one server-global (session-table) option's value.
//
// `-q` is not optional here, and its absence is a silent failure rather than a
// noisy one: asking for an UNSET user option (@wt_status_show before anyone has
// decided — i.e. every first attach) makes tmux exit non-zero with "invalid
// option", so without -q the read errors, ApplyStatusDefault takes its
// swallow-and-return path, and the default never applies at all. -q turns "not
// set" into the empty string, which is the answer the caller is actually asking
// for. (The same flag is why the @wt_state read is `show-options -gqv`; the
// flags are spelled separately here so the argv reads as what it is.)
func globalOption(run tmuxRunner, name string) (string, error) {
	return optionValue(run, "show-options", "-g", "-q", "-v", name)
}

// statusIsOn reads `status` as the boolean the UI wants. Anything tmux reports
// that is not exactly "off" draws a bar, including the row counts.
func statusIsOn(v string) bool {
	v = strings.TrimSpace(v)
	return v != statusOff && v != ""
}

// ReadSettings answers "what do the tmux settings look like right now?" — a pure
// read (two `show-options` forks), so it is safe on a server started without -w.
func (c *Controller) ReadSettings() (Settings, error) {
	status, err := globalOption(c.run, "status")
	if err != nil {
		return Settings{}, fmt.Errorf("failed to read tmux status option: %w", err)
	}
	// A read failure on the DECISION is not a read failure on the setting: the
	// worst it costs is one sentence of explanation in the menu, so it is swallowed
	// rather than allowed to sink an otherwise good answer.
	chosen, _ := globalOption(c.run, statusShowOption)
	return Settings{
		Status: strings.TrimSpace(status),
		On:     statusIsOn(status),
		Chosen: chosen == "1" || chosen == "0",
	}, nil
}

// SetStatusBar turns the status line on or off and records that the user chose
// it, so the hide-on-attach default stops applying.
//
// Turning it OFF saves the value it had first; turning it ON restores that saved
// value. The pair is why a 2-row status line survives a round trip through this
// menu — see statusSavedOption.
func (c *Controller) SetStatusBar(on bool) (Settings, error) {
	want := statusOff
	if on {
		// Restore what it was before we hid it. Only a value that actually draws
		// something is honoured: a saved "off" (or an empty/garbage one) would make
		// "turn it on" a no-op, which is the one outcome a person clicking this can
		// read only as a broken control.
		saved, _ := globalOption(c.run, statusSavedOption)
		want = "on"
		if statusIsOn(saved) {
			want = strings.TrimSpace(saved)
		}
	} else {
		c.rememberStatus()
	}
	if _, err := c.runTmux("set-option", "-g", "status", want); err != nil {
		return Settings{}, fmt.Errorf("failed to set tmux status option: %w", err)
	}
	// The decision is recorded AFTER the change lands. Recording it first and then
	// failing would leave a server that has stopped applying the default while
	// still showing the state the default exists to fix.
	choice := "0"
	if on {
		choice = "1"
	}
	if err := c.SetGlobalOption(statusShowOption, choice); err != nil {
		return Settings{}, fmt.Errorf("failed to record the status-bar choice: %w", err)
	}
	return c.ReadSettings()
}

// rememberStatus stores the CURRENT status value in @wt_status_saved so it can be
// restored later. Only a drawing value is worth saving — overwriting the memory
// with "off" (which happens if this is called twice, e.g. two regions attaching)
// would erase the very thing it exists to hold.
func (c *Controller) rememberStatus() {
	cur, err := globalOption(c.run, "status")
	if err != nil || !statusIsOn(cur) {
		return
	}
	if err := c.SetGlobalOption(statusSavedOption, strings.TrimSpace(cur)); err != nil {
		// Best effort: failing to remember costs a restored "on" instead of a
		// restored "3", never the hide itself.
		return
	}
}

// ApplyStatusDefault is the hide-on-attach default, run once per connection as
// the controller starts.
//
// It is a DEFAULT, not a policy: the moment the user has said what they want
// (@wt_status_show is set either way) this does nothing at all, so reloading the
// page or opening a second split region cannot undo a choice. Every failure is
// swallowed — this runs on the attach path, and a tmux that will not answer a
// show-options must cost a cosmetic default rather than the pane.
func (c *Controller) ApplyStatusDefault() {
	chosen, err := globalOption(c.run, statusShowOption)
	if err != nil {
		return
	}
	if chosen == "1" || chosen == "0" {
		return // the user has decided; leave tmux alone
	}
	cur, err := globalOption(c.run, "status")
	if err != nil || !statusIsOn(cur) {
		return // already hidden (tmux.conf, or a region that got here first)
	}
	c.rememberStatus()
	if _, err := c.runTmux("set-option", "-g", "status", statusOff); err != nil {
		return
	}
}
