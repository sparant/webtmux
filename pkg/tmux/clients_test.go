package tmux

import "testing"

// Fixture: a container pane (pid 4242) colliding on tty string with a host ssh
// console (different pid, same "/dev/pts/1"), plus a second container pane.
const clientsFixture = `901|/dev/pts/1|services
4242|/dev/pts/1|web-abc123
4243|/dev/pts/300|other
`

func TestParseClientRows(t *testing.T) {
	rows := parseClientRows(clientsFixture)
	if len(rows) != 3 {
		t.Fatalf("want 3 rows, got %d", len(rows))
	}
	if rows[1].pid != 4242 || rows[1].tty != "/dev/pts/1" || rows[1].session != "web-abc123" {
		t.Errorf("bad row: %+v", rows[1])
	}
}

func TestParseClientRowsSessionWithSeparator(t *testing.T) {
	rows := parseClientRows("7|/dev/pts/9|odd|name\n")
	if len(rows) != 1 || rows[0].session != "odd|name" {
		t.Fatalf("session-with-separator not preserved: %+v", rows)
	}
}

func TestFindClientPidBeatsTTYCollision(t *testing.T) {
	rows := parseClientRows(clientsFixture)
	r, ok := findClient(rows, 4242, "/dev/pts/1")
	if !ok || r.session != "web-abc123" {
		t.Fatalf("pid match should pick OUR row despite tty collision, got %+v ok=%v", r, ok)
	}
	// pid known but not attached: must NOT fall back to a tty guess.
	if _, ok := findClient(rows, 9999, "/dev/pts/1"); ok {
		t.Error("unknown pid must not resolve via ambiguous tty")
	}
}

func TestFindClientTTYFallbackWithoutPid(t *testing.T) {
	rows := parseClientRows(clientsFixture)
	r, ok := findClient(rows, 0, "/dev/pts/300")
	if !ok || r.session != "other" {
		t.Fatalf("tty fallback failed: %+v ok=%v", r, ok)
	}
	if _, ok := findClient(rows, 0, ""); ok {
		t.Error("empty identity must not match")
	}
}

func TestCountTTY(t *testing.T) {
	rows := parseClientRows(clientsFixture)
	if n := countTTY(rows, "/dev/pts/1"); n != 2 {
		t.Errorf("collision count = %d, want 2", n)
	}
	if n := countTTY(rows, "/dev/pts/300"); n != 1 {
		t.Errorf("unique count = %d, want 1", n)
	}
	if n := countTTY(rows, ""); n != 0 {
		t.Errorf("empty tty count = %d, want 0", n)
	}
}
