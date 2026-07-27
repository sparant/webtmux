#!/usr/bin/env bash
# Does the bash stoplight installer paint the window it is RUNNING in?
#
# The hooks are only ever read while you look at them, which is exactly how they
# hid a bug for months: a bare `tmux set -w @wt_working …` has no target, so tmux
# resolves one from the CURRENT window of the session — the window on screen. That
# is the same window as the hook's own only while you are watching it. Switch away
# and every write goes elsewhere: the command that finishes reddens the window you
# switched TO, and the window that actually finished sits green forever, which is
# precisely the case the stoplight exists for.
#
# So the assertions below are all made with the shell's window NOT current. A test
# run from the shell's own window would pass against the broken version.
#
# Standalone: needs tmux and bash, no Go toolchain, no browser. `make test` runs it
# and skips (not fails) where tmux is absent, matching the JS-store test policy.
set -uo pipefail

HOOKS="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/install_stoplight_hooks_bash.sh"
SOCKET="wt-stoplight-test-$$"
T=(tmux -L "$SOCKET")

pass=0; fail=0
ok() { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass + 1)); }
no() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail + 1)); }

if ! command -v tmux >/dev/null 2>&1; then
  echo "note: tmux not found — skipping stoplight hook tests"
  exit 0
fi
[ -f "$HOOKS" ] || { echo "missing $HOOKS"; exit 1; }

TMPDIR_T="$(mktemp -d)"
cleanup() { "${T[@]}" kill-server 2>/dev/null; rm -rf "$TMPDIR_T"; }
trap cleanup EXIT

# A HOME of our own: the hooks have to be installed by an interactive shell's rc,
# because that is the only way they are ever installed for real.
cat > "$TMPDIR_T/.bashrc" <<RC
PS1='\$ '
source "$HOOKS"
RC
cat > "$TMPDIR_T/work.sh" <<'SH'
#!/usr/bin/env bash
sleep 3
SH
chmod +x "$TMPDIR_T/work.sh"

# `work` runs the command; `other` is what we are looking at. Both windows exist
# before anything is asserted, so "the write went to the wrong window" is a state
# we can actually observe rather than infer from an absence.
"${T[@]}" kill-server 2>/dev/null
HOME="$TMPDIR_T" "${T[@]}" new-session -d -s s -n work bash
HOME="$TMPDIR_T" "${T[@]}" new-window -t s: -n other bash
sleep 1

light() { "${T[@]}" show -w -t "s:$1" -v @wt_working 2>/dev/null; }
current() { "${T[@]}" display -p -t s: '#{window_name}'; }

# Wait up to N deciseconds for a window's light, so the suite is not a race against
# the shell's prompt round-trip on a loaded machine.
wait_light() { # window value tries
  local i
  for ((i = 0; i < $3; i++)); do
    [ "$(light "$1")" = "$2" ] && return 0
    sleep 0.1
  done
  return 1
}

echo
echo "== the shell's window is NOT the current window =="
"${T[@]}" select-window -t s:other
[ "$(current)" = "other" ] || { echo "setup failed: current window is $(current)"; exit 1; }

# A sentinel on the watched window. Its own idle shell has already painted it red,
# so "is it red?" cannot tell a stray write apart from the truth; a value neither
# hook ever writes can. An idle shell writes nothing more, so any change to this is
# a write that was meant for the OTHER window.
"${T[@]}" set -w -t s:other @wt_working 2

"${T[@]}" send-keys -t s:work "$TMPDIR_T/work.sh" Enter

if wait_light work 1 30; then ok "a command paints ITS OWN window green"
else no "a command paints ITS OWN window green (got '$(light work)')"; fi

if [ "$(light other)" = "2" ]; then ok "the watched window is left alone (no cross-talk green)"
else no "the watched window is left alone (sentinel 2 became '$(light other)')"; fi

if wait_light work 0 60; then ok "the command finishing paints ITS OWN window red"
else no "the command finishing paints ITS OWN window red (got '$(light work)')"; fi

if [ "$(light other)" = "2" ]; then ok "the watched window is still left alone (no cross-talk red)"
else no "the watched window is still left alone (sentinel 2 became '$(light other)')"; fi

# The transition is what the UI flashes on (see work-alerts.js): a window that goes
# 1 -> 0 while nothing displays it is the whole signal. Landing on 0 without ever
# having been 1 raises nothing, so "ends red" is not on its own a passing state.
echo
echo "== the same window, now current (the case that always worked) =="
"${T[@]}" select-window -t s:work
"${T[@]}" send-keys -t s:work "$TMPDIR_T/work.sh" Enter
if wait_light work 1 30 && wait_light work 0 60; then ok "green then red while watched"
else no "green then red while watched (got '$(light work)')"; fi

echo
printf 'stoplight hooks: %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
