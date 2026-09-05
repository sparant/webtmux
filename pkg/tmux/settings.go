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

// ---------------------------------------------------------------------------
// set-clipboard: whether a program running INSIDE tmux can reach the clipboard
// of the machine running the BROWSER.
//
// THE PROBLEM. A terminal program that offers to copy something — an OAuth URL,
// a token, a diff — has no access to your clipboard. It has a byte stream. The
// one portable way to cross that gap is OSC 52: the program writes
// `ESC ] 52 ; c ; <base64> BEL` and the terminal emulator at the far end puts the
// decoded text on ITS clipboard. webtmux's browser side has read that sequence
// since copy buffers shipped (terminal-unit.js, handleOSC52), so the far end is
// ready. The sequence just never gets there.
//
// It never gets there because tmux is in the middle and, by DEFAULT, eats it.
// `set-clipboard` has three values, and tmux ships with the middle one:
//
//	off       tmux never drives the outer terminal's clipboard.
//	external  tmux may set the outer clipboard for ITS OWN copies (copy-mode `y`,
//	          copy-pipe -w, load-buffer -w) but IGNORES the escape sequence when an
//	          application inside a pane writes it.   <-- the default
//	on        an application's OSC 52 is honoured: tmux stores it as a paste buffer
//	          AND forwards it to the attached client's terminal — i.e. to webtmux,
//	          i.e. to the browser.
//
// So on a stock tmux the app-driven half of the clipboard is off, and the failure
// is silent in both directions: the program says "copied", tmux drops it, and
// nothing anywhere reports that a copy did not happen. Verified against tmux 3.2a
// and 3.3a — see screenshots/harness/diag-osc52.js, which emits all three channels
// a real program uses and reports which arrive.
//
// WHY WEBTMUX TURNS IT ON. webtmux exists to be the terminal at the far end of
// exactly this gap: the tmux server is on one machine, the person is on another,
// and the clipboard they mean is the browser's. `external` is a sensible default
// for a tmux whose client is a local terminal emulator the user already trusts;
// for a tmux whose client is a browser tab it is the setting that breaks the one
// thing the browser is better at than ssh. Hence the same shape as the status
// line: applied once as a DEFAULT on attach, remembered the moment the user says
// otherwise, and shown in the link menu with what it does.
//
// WHAT IT DOES NOT DO. Turning this on does not let a pane READ the clipboard —
// OSC 52 queries (`ESC ] 52 ; c ; ? BEL`) are answered by nothing here, and
// handleOSC52 drops a "?" payload on the floor rather than replying. The trust
// being extended is one-directional: a program that can already draw anything on
// your screen may also offer you text to paste.

// clipboardChoiceOption records the user's DECISION: "1" = they want app copies
// forwarded, "0" = they do not, unset = they have never said. Same role as
// statusShowOption, and the same reason: a default that cannot be overruled is
// not a default.
const clipboardChoiceOption = "@wt_clipboard_choice"

// clipboardSavedOption remembers what `set-clipboard` was before webtmux turned it
// on, so turning it back off restores THAT rather than a guess. Unlike `status`
// this one really is a small enum, but the distinction between `off` and
// `external` is exactly the distinction between "tmux never touches my clipboard"
// and "tmux's own copies do" — collapsing them would quietly enable copy-mode
// clipboard writes for someone who had turned them off.
const clipboardSavedOption = "@wt_clipboard_saved"

// clipboardOn is the one value that forwards an APPLICATION's OSC 52. The others
// (off, external) both drop it.
const clipboardOn = "on"

// clipboardDefault is tmux's own out-of-the-box value, used when webtmux is asked
// to turn forwarding off and has nothing remembered to restore. Restoring "off"
// instead would leave tmux quieter than it was found.
const clipboardDefault = "external"

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

	// Clipboard is tmux's `set-clipboard` option verbatim ("off", "external",
	// "on"), reported as what it is: the menu says which of the two "no" values is
	// in force, because they differ in whether tmux's OWN copies reach the browser.
	Clipboard string `json:"clipboard"`
	// ClipboardOn is the boolean the checkbox draws: Clipboard == "on", the only
	// value that forwards an application's OSC 52.
	ClipboardOn bool `json:"clipboardOn"`
	// ClipboardChosen is true once the user has decided, exactly as Chosen is.
	ClipboardChosen bool `json:"clipboardChosen"`

	// RenameHook is what the tmux `after-rename-window` hook currently runs, one
	// entry per hooked command, verbatim. Shown rather than summarised: it names a
	// script on the server's filesystem, and "a command runs when you rename a
	// window" is not something a person should have to take on trust. Empty means
	// nothing is hooked. See rename_forward.go.
	RenameHook []string `json:"renameHook"`
	// RenameOn is the boolean the checkbox draws: something is hooked.
	RenameOn bool `json:"renameOn"`
	// RenameSaved is whether webtmux is holding a hook it can put back. It is what
	// separates "off, click to restore" from "this server has no rename hook at
	// all", which look identical from RenameOn alone and mean very different things.
	RenameSaved bool `json:"renameSaved"`
	// RenameWindows lists the windows that have opted in, on or off. The hook fires
	// for every window; this is the set that will actually DO anything.
	RenameWindows []RenameWindow `json:"renameWindows"`

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
	// set-clipboard is read on the same best-effort footing as the decisions: a
	// tmux too old to have the option (it has existed since 2.6) or one that will
	// not answer costs the clipboard ROW its state, not the whole reply.
	clip, _ := globalOption(c.run, "set-clipboard")
	clipChosen, _ := globalOption(c.run, clipboardChoiceOption)
	// Same best-effort footing, and here it buys something specific: the hook read
	// and the window read are independent, so a server with windows opted in and no
	// hook installed reports exactly that rather than nothing at all. That state is
	// real — the launcher ran, the hook did not — and it is the one this row exists
	// to make visible.
	hook, savedHook, renameWins := readRenameForward(c.run)
	return Settings{
		Status:          strings.TrimSpace(status),
		On:              statusIsOn(status),
		Chosen:          chosen == "1" || chosen == "0",
		Clipboard:       strings.TrimSpace(clip),
		ClipboardOn:     strings.TrimSpace(clip) == clipboardOn,
		ClipboardChosen: clipChosen == "1" || clipChosen == "0",
		RenameHook:      hook,
		RenameOn:        len(hook) > 0,
		RenameSaved:     len(savedHook) > 0,
		RenameWindows:   renameWins,
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

// SetClipboard turns application OSC 52 forwarding on or off and records that the
// user chose it, so the on-attach default stops applying.
//
// Turning it ON saves the previous value first; turning it OFF restores that saved
// value, falling back to tmux's own default rather than to "off" — see
// clipboardDefault for why the difference matters.
func (c *Controller) SetClipboard(on bool) (Settings, error) {
	want := clipboardOn
	if on {
		c.rememberClipboard()
	} else {
		saved, _ := globalOption(c.run, clipboardSavedOption)
		want = strings.TrimSpace(saved)
		// A saved "on" is not a restore point — it would make "turn it off" a
		// no-op, the one outcome a person clicking this can only read as broken.
		if want == "" || want == clipboardOn {
			want = clipboardDefault
		}
	}
	if _, err := c.runTmux("set-option", "-g", "set-clipboard", want); err != nil {
		return Settings{}, fmt.Errorf("failed to set tmux set-clipboard option: %w", err)
	}
	// Recorded AFTER the change lands, for the same reason SetStatusBar does it in
	// that order: a recorded decision over an unchanged server is a default that
	// has stopped applying to a setting it never fixed.
	choice := "0"
	if on {
		choice = "1"
	}
	if err := c.SetGlobalOption(clipboardChoiceOption, choice); err != nil {
		return Settings{}, fmt.Errorf("failed to record the clipboard choice: %w", err)
	}
	return c.ReadSettings()
}

// rememberClipboard stores the CURRENT set-clipboard value so it can be restored.
// Saving "on" is refused: that is what webtmux is about to set, so recording it
// would overwrite the memory with the thing the memory exists to undo — which is
// what a SECOND region attaching would otherwise do.
func (c *Controller) rememberClipboard() {
	cur, err := globalOption(c.run, "set-clipboard")
	cur = strings.TrimSpace(cur)
	if err != nil || cur == "" || cur == clipboardOn {
		return
	}
	// Best effort: failing to remember costs a restored "external" instead of a
	// restored "off", never the forwarding itself.
	_ = c.SetGlobalOption(clipboardSavedOption, cur)
}

// ApplyClipboardDefault is the forward-clipboard-on-attach default, run once per
// connection beside ApplyStatusDefault.
//
// Same rules as that one, for the same reasons: it is a DEFAULT, so a user who has
// decided either way is left alone, and every failure is swallowed because this is
// on the attach path — a tmux that will not answer must cost the clipboard, not
// the pane.
func (c *Controller) ApplyClipboardDefault() {
	chosen, err := globalOption(c.run, clipboardChoiceOption)
	if err != nil {
		return
	}
	if chosen == "1" || chosen == "0" {
		return // the user has decided; leave tmux alone
	}
	cur, err := globalOption(c.run, "set-clipboard")
	if err != nil {
		return
	}
	if strings.TrimSpace(cur) == clipboardOn {
		return // already forwarding (tmux.conf, or a region that got here first)
	}
	c.rememberClipboard()
	if _, err := c.runTmux("set-option", "-g", "set-clipboard", clipboardOn); err != nil {
		return
	}
}
