package tmux

import "testing"

// `list-windows -a -F allWindowsFormat` fixture, in the shape a real tmux emits:
// window_id | session_id | window_index | @wt_working | window_name.
//
// It covers the things the parse has to get right at once — an unset @wt_working,
// a window LINKED into two sessions (two placements, different indexes), the web-*
// grouped shadow a split adds, a window name containing the field separator, and a
// SESSION name containing it (which is why the session rides as an id: only one
// user-typed string can hold the final slot).
const allWindowsFixture = `@0|$0|0||shell
@1|$0|1|1|claude Dominion
@2|$0|2|2|claude llmrefine
@1|$1|4|1|claude Dominion
@1|$9|1|1|claude Dominion
@0|$9|0||shell
@7|$1|5|0|build | test
@8|$2|0|1|a, b | c
`

// The `list-sessions` half of the same refresh: $0 services, $1 editors, $9 the
// split's grouped shadow, $2 a session someone named with the separator in it.
var allWindowsSessions = []sessionRow{
	{id: "$0", name: "services"},
	{id: "$1", name: "editors"},
	{id: "$9", name: "web-abc123", grouped: true},
	{id: "$2", name: "ops | staging"},
}

func TestParseAllWindowsStatus(t *testing.T) {
	working, _ := parseAllWindows(allWindowsFixture, allWindowsSessions)
	// Every window on the server gets a light, including the ones in sessions no
	// region is attached to — that is the whole point of the -a listing.
	for id, want := range map[string]string{"@0": "", "@1": "1", "@2": "2", "@7": "0", "@8": "1"} {
		if got, ok := working[id]; !ok || got != want {
			t.Errorf("working[%s] = %q (present=%v), want %q", id, got, ok, want)
		}
	}
}

func TestParseAllWindowsDirectory(t *testing.T) {
	_, refs := parseAllWindows(allWindowsFixture, allWindowsSessions)
	// The two web-* rows are dropped (they mirror services), leaving six placements.
	if len(refs) != 6 {
		t.Fatalf("want 6 placements, got %d: %+v", len(refs), refs)
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
	_, refs := parseAllWindows(allWindowsFixture, allWindowsSessions)
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
	_, refs := parseAllWindows(allWindowsFixture, allWindowsSessions)
	var got WindowRef
	for _, r := range refs {
		if r.ID == "@7" {
			got = r
		}
	}
	if got.Name != "build | test" || got.Index != 5 || got.Session != "editors" {
		t.Errorf("separator in a window name broke the row: %+v", got)
	}
}

func TestParseAllWindowsSessionNameWithSeparator(t *testing.T) {
	// The row carries #{session_id}, so a '|' in the SESSION name — the second
	// user-typed string on the line, which cannot also have the last slot — reaches
	// the directory whole instead of shifting the index and eating the window name.
	// A window called "a, b | c" in a session called "ops | staging" is the case
	// that used to corrupt both.
	_, refs := parseAllWindows(allWindowsFixture, allWindowsSessions)
	var got WindowRef
	for _, r := range refs {
		if r.ID == "@8" {
			got = r
		}
	}
	if got.Session != "ops | staging" || got.Name != "a, b | c" || got.Index != 0 {
		t.Errorf("separator in a session name broke the row: %+v", got)
	}
}

func TestParseAllWindowsSkipsShortRows(t *testing.T) {
	// A truncated row is dropped rather than half-parsed: a WindowRef with a blank
	// session is a navigation target that goes nowhere.
	working, refs := parseAllWindows("@0|$0|1\n@1|$0|1|1|ok\n", allWindowsSessions)
	if len(refs) != 1 || refs[0].ID != "@1" {
		t.Errorf("want only the well-formed row, got %+v", refs)
	}
	if _, ok := working["@0"]; ok {
		t.Errorf("a short row must not contribute a status either: %+v", working)
	}
}

func TestParseAllWindowsUnknownSessionKeepsTheLightDropsThePlacement(t *testing.T) {
	// A session created between `list-sessions` and `list-windows -a` can't be
	// named. Its window still has a status (the light doesn't depend on knowing
	// where it lives), but it must not enter the directory, which exists to be
	// navigated to.
	working, refs := parseAllWindows("@4|$77|0|2|fresh\n", allWindowsSessions)
	if working["@4"] != "2" {
		t.Errorf("status for an unnamed session's window = %q, want 2", working["@4"])
	}
	if len(refs) != 0 {
		t.Errorf("want no placements for an unresolvable session, got %+v", refs)
	}
}

func TestParseAllWindowsEmpty(t *testing.T) {
	working, refs := parseAllWindows("", allWindowsSessions)
	if len(working) != 0 || len(refs) != 0 {
		t.Errorf("empty listing must yield nothing, got %+v / %+v", working, refs)
	}
}

// `list-windows -t <session> -F "#{window_index} #{window_id}"` output. tmux lists
// a session's windows in index order already, but the indexes are NOT dense (a
// killed window leaves a hole) — which is the whole reason a reorder is expressed
// as an ordinal POSITION and realized by bubbling across the holes.
const sessionWindowsFixture = `0 @0
3 @5
4 @1
9 @7
`

func TestParseWindowOrder(t *testing.T) {
	order, pos, idx := parseWindowOrder(sessionWindowsFixture, "@1")
	want := []int{0, 3, 4, 9}
	if len(order) != len(want) {
		t.Fatalf("order = %v, want %v", order, want)
	}
	for i := range want {
		if order[i] != want[i] {
			t.Fatalf("order = %v, want %v", order, want)
		}
	}
	// @1 sits in index slot 4, which is the THIRD window (ordinal 2) — the number the
	// sidebar's drop arithmetic speaks in.
	if pos != 2 || idx != 4 {
		t.Errorf("pos, idx = %d, %d; want 2, 4", pos, idx)
	}
}

func TestParseWindowOrderSortsByIndex(t *testing.T) {
	// Order must come from the INDEX, not from the listing order: MoveWindow bubbles
	// by adjacent swaps, so a mis-sorted order swaps the wrong pair of windows.
	order, pos, _ := parseWindowOrder("9 @7\n0 @0\n4 @1\n", "@7")
	if len(order) != 3 || order[0] != 0 || order[1] != 4 || order[2] != 9 {
		t.Fatalf("order = %v, want [0 4 9]", order)
	}
	if pos != 2 {
		t.Errorf("pos = %d, want 2 (last)", pos)
	}
}

func TestParseWindowOrderMissingWindow(t *testing.T) {
	// The window isn't in that session — the caller must be able to tell, because
	// "not there" is a refused command, not a move to position 0.
	order, pos, idx := parseWindowOrder(sessionWindowsFixture, "@99")
	if len(order) != 4 {
		t.Fatalf("order = %v, want the session's 4 windows", order)
	}
	if pos != -1 || idx != -1 {
		t.Errorf("pos, idx = %d, %d; want -1, -1", pos, idx)
	}
}

func TestParseWindowOrderIgnoresJunk(t *testing.T) {
	// Short/garbled rows (a tmux error line, a truncated read) are skipped rather
	// than counted — a phantom slot in `order` would bubble a window one step too far.
	order, pos, _ := parseWindowOrder("0 @0\nnot-a-row\nx @9\n1 @1\n", "@1")
	if len(order) != 2 || order[0] != 0 || order[1] != 1 {
		t.Fatalf("order = %v, want [0 1]", order)
	}
	if pos != 1 {
		t.Errorf("pos = %d, want 1", pos)
	}
	if o, p, i := parseWindowOrder("", "@1"); len(o) != 0 || p != -1 || i != -1 {
		t.Errorf("empty listing = %v, %d, %d; want [], -1, -1", o, p, i)
	}
}
