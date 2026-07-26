package tmux

import "testing"

// `list-windows -a -F allWindowsFormat` fixture, in the shape a real tmux emits:
// window_id | @wt_working | session_name | window_index | window_name.
//
// It covers the four things the parse has to get right at once — an unset
// @wt_working, a window LINKED into two sessions (two placements, different
// indexes), the web-* grouped shadow a split adds, and a window name containing the
// field separator.
const allWindowsFixture = `@0||services|0|shell
@1|1|services|1|claude Dominion
@2|2|services|2|claude llmrefine
@1|1|editors|4|claude Dominion
@1|1|web-abc123|1|claude Dominion
@0||web-abc123|0|shell
@7|0|editors|5|build | test
`

func TestParseAllWindowsStatus(t *testing.T) {
	working, _ := parseAllWindows(allWindowsFixture)
	// Every window on the server gets a light, including the ones in sessions no
	// region is attached to — that is the whole point of the -a listing.
	for id, want := range map[string]string{"@0": "", "@1": "1", "@2": "2", "@7": "0"} {
		if got, ok := working[id]; !ok || got != want {
			t.Errorf("working[%s] = %q (present=%v), want %q", id, got, ok, want)
		}
	}
}

func TestParseAllWindowsDirectory(t *testing.T) {
	_, refs := parseAllWindows(allWindowsFixture)
	// The two web-* rows are dropped (they mirror services), leaving five placements.
	if len(refs) != 5 {
		t.Fatalf("want 5 placements, got %d: %+v", len(refs), refs)
	}
	for _, r := range refs {
		if r.Session == "web-abc123" {
			t.Errorf("a grouped shadow leaked into the directory: %+v", r)
		}
	}
	if refs[1].ID != "@1" || refs[1].Session != "services" || refs[1].Index != 1 ||
		refs[1].Name != "claude Dominion" || refs[1].Working != "1" {
		t.Errorf("bad placement: %+v", refs[1])
	}
}

func TestParseAllWindowsLinkedWindowKeepsBothPlacements(t *testing.T) {
	// @1 lives in services (index 1) and editors (index 4). The attention arrow
	// navigates BY placement — collapsing these would make one of the two
	// unreachable, and would label the survivor with the wrong window number.
	_, refs := parseAllWindows(allWindowsFixture)
	seen := map[string]int{}
	for _, r := range refs {
		if r.ID == "@1" {
			seen[r.Session] = r.Index
		}
	}
	if seen["services"] != 1 || seen["editors"] != 4 {
		t.Errorf("linked window placements = %+v, want services:1 and editors:4", seen)
	}
}

func TestParseAllWindowsNameWithSeparator(t *testing.T) {
	// window_name is last precisely so a '|' typed (or scripted) into it lands inside
	// the final field instead of shifting every machine field before it.
	_, refs := parseAllWindows(allWindowsFixture)
	last := refs[len(refs)-1]
	if last.ID != "@7" || last.Name != "build | test" || last.Index != 5 {
		t.Errorf("separator in a window name broke the row: %+v", last)
	}
}

func TestParseAllWindowsSkipsShortRows(t *testing.T) {
	// A truncated row is dropped rather than half-parsed: a WindowRef with a blank
	// session is a navigation target that goes nowhere.
	working, refs := parseAllWindows("@0|1|services\n@1|1|services|1|ok\n")
	if len(refs) != 1 || refs[0].ID != "@1" {
		t.Errorf("want only the well-formed row, got %+v", refs)
	}
	if _, ok := working["@0"]; ok {
		t.Errorf("a short row must not contribute a status either: %+v", working)
	}
}

func TestParseAllWindowsEmpty(t *testing.T) {
	working, refs := parseAllWindows("")
	if len(working) != 0 || len(refs) != 0 {
		t.Errorf("empty listing must yield nothing, got %+v / %+v", working, refs)
	}
}
