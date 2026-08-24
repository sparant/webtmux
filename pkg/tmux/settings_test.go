package tmux

import "testing"

// The status-line default and the toggle behind it. Four properties, each of which
// was a bug waiting in the obvious implementation:
//
//  1. hiding on attach is a DEFAULT, so it stops applying the moment the user says
//     what they want — otherwise a reload silently undoes their choice;
//  2. `status` is not a boolean (tmux 2.9+ takes 2..5 for a multi-row status line),
//     so restoring it as "on" throws rows of someone's configuration away;
//  3. two regions attaching must not overwrite the saved value with "off", which is
//     what a naive "remember the current value" does the second time it runs;
//  4. a server whose status line is ALREADY off keeps its own saved value rather
//     than acquiring "off" as the thing to restore.

func settingsController(f *fakeServer) *Controller {
	return newControllerWithRunner("services", false, "", f.run)
}

// The default: nothing said either way, so webtmux hides the bar and remembers
// what it hid.
func TestApplyStatusDefaultHidesAndRemembers(t *testing.T) {
	f := &fakeServer{options: map[string]string{"global/status": "on"}}
	c := settingsController(f)
	c.ApplyStatusDefault()

	if got := f.options["global/status"]; got != "off" {
		t.Fatalf("status = %q, want off", got)
	}
	if got := f.options["global/"+statusSavedOption]; got != "on" {
		t.Fatalf("saved status = %q, want on", got)
	}
	// The DECISION is untouched: hiding by default is not the user deciding.
	if v, ok := f.options["global/"+statusShowOption]; ok {
		t.Fatalf("%s = %q, want unset — the default must not count as a choice",
			statusShowOption, v)
	}
}

// Once the user has said they want it, attaching again leaves tmux alone. This is
// the property that makes a reload — or a second split region, which attaches its
// own controller — safe.
func TestApplyStatusDefaultRespectsAChoice(t *testing.T) {
	for _, choice := range []string{"1", "0"} {
		f := &fakeServer{options: map[string]string{
			"global/status":              "on",
			"global/" + statusShowOption: choice,
		}}
		settingsController(f).ApplyStatusDefault()
		if got := f.options["global/status"]; got != "on" {
			t.Fatalf("choice %q: status = %q, want on (untouched)", choice, got)
		}
	}
}

// A multi-row status line survives a round trip through the menu. Restoring "on"
// here would silently drop two of someone's three rows.
func TestStatusBarRoundTripPreservesRowCount(t *testing.T) {
	f := &fakeServer{options: map[string]string{"global/status": "3"}}
	c := settingsController(f)

	off, err := c.SetStatusBar(false)
	if err != nil {
		t.Fatalf("SetStatusBar(false): %v", err)
	}
	if off.On || off.Status != "off" {
		t.Fatalf("after off: %+v, want Status=off On=false", off)
	}
	if got := f.options["global/"+statusShowOption]; got != "0" {
		t.Fatalf("%s = %q, want 0", statusShowOption, got)
	}

	on, err := c.SetStatusBar(true)
	if err != nil {
		t.Fatalf("SetStatusBar(true): %v", err)
	}
	if on.Status != "3" || !on.On {
		t.Fatalf("after on: %+v, want Status=3 On=true", on)
	}
	if got := f.options["global/"+statusShowOption]; got != "1" {
		t.Fatalf("%s = %q, want 1", statusShowOption, got)
	}
}

// Hiding twice — two regions attaching, or a toggle after the default already ran
// — must not overwrite the memory with "off". If it did, turning the bar back on
// would restore nothing and read as a dead control.
func TestHidingTwiceKeepsTheSavedValue(t *testing.T) {
	f := &fakeServer{options: map[string]string{"global/status": "2"}}
	c := settingsController(f)
	c.ApplyStatusDefault()
	c.ApplyStatusDefault()
	if got := f.options["global/"+statusSavedOption]; got != "2" {
		t.Fatalf("saved status = %q, want 2", got)
	}
	if _, err := c.SetStatusBar(false); err != nil {
		t.Fatalf("SetStatusBar(false): %v", err)
	}
	if got := f.options["global/"+statusSavedOption]; got != "2" {
		t.Fatalf("saved status after an explicit off = %q, want 2", got)
	}
}

// A server whose status line is already off (a .tmux.conf that turned it off)
// needs nothing done to it, and must not have "off" recorded as the value to
// restore. Turning it on then falls back to plain "on", which is the only honest
// answer available.
func TestAlreadyHiddenIsLeftAloneAndRestoresToOn(t *testing.T) {
	f := &fakeServer{options: map[string]string{"global/status": "off"}}
	c := settingsController(f)
	c.ApplyStatusDefault()
	if v, ok := f.options["global/"+statusSavedOption]; ok {
		t.Fatalf("%s = %q, want unset", statusSavedOption, v)
	}
	on, err := c.SetStatusBar(true)
	if err != nil {
		t.Fatalf("SetStatusBar(true): %v", err)
	}
	if on.Status != "on" || !on.On {
		t.Fatalf("restored to %+v, want Status=on", on)
	}
}

// ReadSettings reports the value verbatim, the boolean the checkbox draws, and
// whether the user has ever decided — the three things the menu's one row needs to
// say "hidden by webtmux" rather than merely "hidden".
func TestReadSettingsReportsChosen(t *testing.T) {
	f := &fakeServer{options: map[string]string{"global/status": "off"}}
	c := settingsController(f)
	set, err := c.ReadSettings()
	if err != nil {
		t.Fatalf("ReadSettings: %v", err)
	}
	if set.On || set.Chosen || set.Status != "off" {
		t.Fatalf("%+v, want Status=off On=false Chosen=false", set)
	}
	if _, err := c.SetStatusBar(false); err != nil {
		t.Fatalf("SetStatusBar(false): %v", err)
	}
	set, _ = c.ReadSettings()
	if !set.Chosen {
		t.Fatalf("%+v, want Chosen=true after an explicit toggle", set)
	}
}
