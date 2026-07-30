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

# The delegate cases assert an ABSENCE over a span, so they need a command that is
# still running when the span ends — otherwise the shell's own precmd lands inside
# the window being watched and reads as a hook write. Long, then interrupted.
cat > "$TMPDIR_T/agent-sim.sh" <<'SH'
#!/usr/bin/env bash
sleep 30
SH
cp "$TMPDIR_T/agent-sim.sh" "$TMPDIR_T/fakeagent"
chmod +x "$TMPDIR_T/agent-sim.sh" "$TMPDIR_T/fakeagent"

# A whole second installation, so the "site file beside the installer" resolution
# path is exercised on a tree that may not have one (the upstream PR branch strips
# it). Copying the installer is the only way to control what sits next to it.
mkdir -p "$TMPDIR_T/site/scripts"
cp "$HOOKS" "$TMPDIR_T/site/install_stoplight_hooks_bash.sh"
cat > "$TMPDIR_T/site/scripts/stoplight-delegates.env.sh" <<'SITE'
export WT_STOPLIGHT_DELEGATES='*agent-sim.sh*:fakeagent'
SITE
cat > "$TMPDIR_T/site/rc" <<RC
PS1='\$ '
source "$TMPDIR_T/site/install_stoplight_hooks_bash.sh"
RC

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

# The delegation assertions are about a write that must NEVER happen, so they are
# the mirror image: hold the value down for the whole span instead of waiting for
# it to appear.
stays_light() { # window value tries
  local i
  for ((i = 0; i < $3; i++)); do
    [ "$(light "$1")" = "$2" ] || return 1
    sleep 0.1
  done
  return 0
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

# WT_STOPLIGHT_DELEGATES decides which commands hand the window's light to
# something else. Getting it wrong is invisible in the direction that matters: a
# lost delegate pattern does not error, it just latches the window green for the
# whole agent session and buries the state the agent itself is reporting. So both
# settings are asserted against the SAME command.
echo
echo "== with delegates configured =="
"${T[@]}" select-window -t s:other
# Through the SESSION environment, not the client's: a tmux server is started once
# and every later pane inherits ITS environment, so `HOME=x tmux new-window` sets
# nothing at all — the variable never reaches the pane.
"${T[@]}" set-environment -t s WT_STOPLIGHT_DELEGATES '*agent-sim.sh*:fakeagent'
"${T[@]}" new-window -d -t s: -n deleg bash
sleep 1

# Sentinel 4: a value no hook writes, so any change to it is a hook write. "Still
# red" could not distinguish delegation from the idle shell's own precmd.
"${T[@]}" set -w -t s:deleg @wt_working 4
"${T[@]}" send-keys -t s:deleg "FOO=1 $TMPDIR_T/agent-sim.sh" Enter
if stays_light deleg 4 15; then ok "a delegated launcher is not painted (env prefix and all)"
else no "a delegated launcher is not painted (light became '$(light deleg)')"; fi
"${T[@]}" send-keys -t s:deleg C-c; sleep 1

"${T[@]}" set -w -t s:deleg @wt_working 4
"${T[@]}" send-keys -t s:deleg "$TMPDIR_T/fakeagent" Enter
if stays_light deleg 4 15; then ok "a slugless pattern matches the first word's basename"
else no "a slugless pattern matches the first word's basename (became '$(light deleg)')"; fi
"${T[@]}" send-keys -t s:deleg C-c; sleep 1

# A pattern with no wildcards must not match as a substring, or naming `claude` a
# delegate would silently stop painting every command that merely mentions it.
"${T[@]}" set -w -t s:deleg @wt_working 4
"${T[@]}" send-keys -t s:deleg "$TMPDIR_T/work.sh fakeagent" Enter
if wait_light deleg 1 30; then ok "a non-delegate that merely mentions one is still painted"
else no "a non-delegate that merely mentions one is still painted (got '$(light deleg)')"; fi
sleep 3

echo
echo "== delegates from a site file beside the installer =="
# Nothing in the environment now, so the installer has to find the list itself.
# This is the path a fork's own machines ride on, and its failure is silent: the
# window simply goes green for a whole agent session.
"${T[@]}" set-environment -t s -u WT_STOPLIGHT_DELEGATES
"${T[@]}" new-window -d -t s: -n site "bash --rcfile $TMPDIR_T/site/rc"
sleep 1
"${T[@]}" set -w -t s:site @wt_working 4
"${T[@]}" send-keys -t s:site "$TMPDIR_T/agent-sim.sh" Enter
if stays_light site 4 15; then ok "a site file's patterns are picked up with an empty environment"
else no "a site file's patterns are picked up with an empty environment (became '$(light site)')"; fi
"${T[@]}" send-keys -t s:site C-c; sleep 1

echo
echo "== with no delegates (the stock default) =="
# Set EXPLICITLY empty rather than left unset, so this says what it means instead
# of depending on whether a site file happens to sit next to \$HOOKS.
"${T[@]}" set-environment -t s WT_STOPLIGHT_DELEGATES ''
"${T[@]}" new-window -d -t s: -n nodeleg bash
sleep 1
"${T[@]}" send-keys -t s:nodeleg "FOO=1 $TMPDIR_T/agent-sim.sh" Enter
if wait_light nodeleg 1 30; then ok "the same command IS painted when nothing delegates"
else no "the same command IS painted when nothing delegates (got '$(light nodeleg)')"; fi
"${T[@]}" send-keys -t s:nodeleg C-c
if wait_light nodeleg 0 60; then ok "and returns to red at the prompt"
else no "and returns to red at the prompt (got '$(light nodeleg)')"; fi

echo
printf 'stoplight hooks: %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
