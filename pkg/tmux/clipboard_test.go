package tmux

import "testing"

// set-clipboard: whether a program inside a pane can reach the BROWSER's clipboard
// with OSC 52. The symptom this exists to fix is entirely silent — a program says
// "(c to copy)", tmux drops the escape, and nothing anywhere reports it — so every
// property below is one that would fail the same silent way.
//
//  1. forwarding is turned on when webtmux attaches, because tmux's default
//     ("external") drops an application's OSC 52 and there is no error to see;
//  2. that is a DEFAULT, so a user who has said no is left alone by the next
//     attach — and there is one attach per split region, so "the next attach" is
//     seconds away, not next week;
//  3. `off` and `external` are not the same value, and turning forwarding back off
//     must restore the one that was there: `off` also silences tmux's OWN
//     copy-mode yanks, so restoring the wrong one changes a setting nobody touched;
//  4. two regions attaching must not overwrite the memory with "on", which is what
//     a naive "remember the current value" does the second time it runs.

// The default: nothing said either way, so webtmux turns forwarding on and
// remembers what tmux had.
func TestApplyClipboardDefaultForwardsAndRemembers(t *testing.T) {
	f := &fakeServer{options: map[string]string{"global/set-clipboard": "external"}}
	c := settingsController(f)
	c.ApplyClipboardDefault()

	if got := f.options["global/set-clipboard"]; got != "on" {
		t.Fatalf("set-clipboard = %q, want on", got)
	}
	if got := f.options["global/"+clipboardSavedOption]; got != "external" {
		t.Fatalf("saved set-clipboard = %q, want external", got)
	}
	// Turning it on by default is not the user deciding.
	if v, ok := f.options["global/"+clipboardChoiceOption]; ok {
		t.Fatalf("%s = %q, want unset — the default must not count as a choice",
			clipboardChoiceOption, v)
	}
}

// Once the user has decided, attaching again leaves tmux alone. Without this, a
// reload — or opening a second split region — silently re-enables something
// somebody had just turned off.
func TestApplyClipboardDefaultRespectsAChoice(t *testing.T) {
	for _, choice := range []string{"1", "0"} {
		f := &fakeServer{options: map[string]string{
			"global/set-clipboard":            "off",
			"global/" + clipboardChoiceOption: choice,
		}}
		settingsController(f).ApplyClipboardDefault()
		if got := f.options["global/set-clipboard"]; got != "off" {
			t.Fatalf("choice %q: set-clipboard = %q, want off (untouched)", choice, got)
		}
	}
}

// A server already forwarding is left alone, and must not have "on" recorded as
// the thing to restore — that would make the off switch a no-op.
func TestApplyClipboardDefaultOnAnAlreadyForwardingServer(t *testing.T) {
	f := &fakeServer{options: map[string]string{"global/set-clipboard": "on"}}
	c := settingsController(f)
	c.ApplyClipboardDefault()
	if v, ok := f.options["global/"+clipboardSavedOption]; ok {
		t.Fatalf("%s = %q, want unset", clipboardSavedOption, v)
	}
}

// `off` is not `external`. A user who had turned tmux's clipboard writes off
// entirely must get that back, not tmux's default.
func TestClipboardRoundTripPreservesOff(t *testing.T) {
	f := &fakeServer{options: map[string]string{"global/set-clipboard": "off"}}
	c := settingsController(f)

	on, err := c.SetClipboard(true)
	if err != nil {
		t.Fatalf("SetClipboard(true): %v", err)
	}
	if !on.ClipboardOn || on.Clipboard != "on" {
		t.Fatalf("after on: %+v, want Clipboard=on ClipboardOn=true", on)
	}
	if got := f.options["global/"+clipboardChoiceOption]; got != "1" {
		t.Fatalf("%s = %q, want 1", clipboardChoiceOption, got)
	}

	off, err := c.SetClipboard(false)
	if err != nil {
		t.Fatalf("SetClipboard(false): %v", err)
	}
	if off.ClipboardOn || off.Clipboard != "off" {
		t.Fatalf("after off: %+v, want Clipboard=off — `external` would re-enable"+
			" tmux's own copy-mode writes that this server had turned off", off)
	}
	if got := f.options["global/"+clipboardChoiceOption]; got != "0" {
		t.Fatalf("%s = %q, want 0", clipboardChoiceOption, got)
	}
}

// Turning it off with nothing remembered falls back to tmux's own default rather
// than to "off": leaving the server quieter than it was found is a change nobody
// asked for.
func TestClipboardOffWithoutAMemoryRestoresTmuxDefault(t *testing.T) {
	f := &fakeServer{options: map[string]string{"global/set-clipboard": "on"}}
	c := settingsController(f)
	off, err := c.SetClipboard(false)
	if err != nil {
		t.Fatalf("SetClipboard(false): %v", err)
	}
	if off.Clipboard != clipboardDefault {
		t.Fatalf("Clipboard = %q, want %q", off.Clipboard, clipboardDefault)
	}
}

// Two regions attaching (or the default running before an explicit toggle) must
// not overwrite the memory with "on". If it did, the off switch would restore the
// value it was trying to undo and read as a dead control.
func TestForwardingTwiceKeepsTheSavedValue(t *testing.T) {
	f := &fakeServer{options: map[string]string{"global/set-clipboard": "off"}}
	c := settingsController(f)
	c.ApplyClipboardDefault()
	c.ApplyClipboardDefault()
	if got := f.options["global/"+clipboardSavedOption]; got != "off" {
		t.Fatalf("saved = %q, want off", got)
	}
	if _, err := c.SetClipboard(true); err != nil {
		t.Fatalf("SetClipboard(true): %v", err)
	}
	if got := f.options["global/"+clipboardSavedOption]; got != "off" {
		t.Fatalf("saved after an explicit on = %q, want off", got)
	}
}

// ReadSettings reports the value verbatim as well as the boolean, because the menu
// needs to say WHICH "no" is in force — `external` still lets tmux's own copies
// out, `off` does not, and "not forwarding" alone cannot tell them apart.
func TestReadSettingsReportsClipboardVerbatim(t *testing.T) {
	f := &fakeServer{options: map[string]string{
		"global/status":        "on",
		"global/set-clipboard": "external",
	}}
	c := settingsController(f)
	set, err := c.ReadSettings()
	if err != nil {
		t.Fatalf("ReadSettings: %v", err)
	}
	if set.Clipboard != "external" || set.ClipboardOn || set.ClipboardChosen {
		t.Fatalf("%+v, want Clipboard=external ClipboardOn=false ClipboardChosen=false", set)
	}
	if _, err := c.SetClipboard(true); err != nil {
		t.Fatalf("SetClipboard(true): %v", err)
	}
	set, err = c.ReadSettings()
	if err != nil {
		t.Fatalf("ReadSettings: %v", err)
	}
	if !set.ClipboardOn || !set.ClipboardChosen {
		t.Fatalf("%+v, want ClipboardOn=true ClipboardChosen=true", set)
	}
}

// The status line and the clipboard are independent settings on the same struct.
// Changing one must not disturb the other's DECISION — the bug the *bool payload
// fields exist to prevent, now that there are two of them.
func TestClipboardAndStatusDecisionsAreIndependent(t *testing.T) {
	f := &fakeServer{options: map[string]string{
		"global/status":        "on",
		"global/set-clipboard": "external",
	}}
	c := settingsController(f)
	if _, err := c.SetClipboard(true); err != nil {
		t.Fatalf("SetClipboard(true): %v", err)
	}
	if v, ok := f.options["global/"+statusShowOption]; ok {
		t.Fatalf("%s = %q, want unset — a clipboard change is not a status decision",
			statusShowOption, v)
	}
	if got := f.options["global/status"]; got != "on" {
		t.Fatalf("status = %q, want on (untouched)", got)
	}
}
