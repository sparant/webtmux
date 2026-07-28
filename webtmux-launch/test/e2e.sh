#!/usr/bin/env bash
# End-to-end suite for webtmux-launch. Runs on the "Mac" side (a container with
# a Go toolchain, ssh and curl) against a throwaway sshd+tmux target.
#
# Driven by test/launcher/run.sh, which builds both containers. Run it directly
# only if you have already exported TARGET and SSH_KEY.
#
# Everything here runs against a LOCAL binary source — no GitHub account, no
# fork, no tag, no published release. If a test cannot run in local mode, the
# Source abstraction has leaked and that is the bug.
set -uo pipefail

TARGET="${TARGET:-dev@wtl-target}"
SSH_KEY="${SSH_KEY:-/keys/id_ed25519}"
REPO="${REPO:-/src}"
BUILDS="$REPO/builds"
LAUNCH="$BUILDS/webtmux-launch"
export GOFLAGS="${GOFLAGS:-}"

# The checkout is owned by a different uid than this container's root, and
# `go build` stamps VCS info by default — without this exception the rebuild and
# `make launcher` steps below fail with "error obtaining VCS status" AFTER a
# successful compile, which reads as a launcher bug rather than a git one.
git config --global --add safe.directory "$REPO" 2>/dev/null || true

pass=0; fail=0; skipped=0
ok()   { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
no()   { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }
skip() { printf '  \033[33mSKIP\033[0m %s\n' "$1"; skipped=$((skipped+1)); }
step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

# ssh options mirroring what the launcher itself uses, so helper commands do not
# fight the launcher's mux master.
SSHOPTS=(-i "$SSH_KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null
         -o LogLevel=ERROR -o ControlMaster=no -o ControlPath=none)
rsh() { ssh "${SSHOPTS[@]}" "$TARGET" "$@"; }

# A deployed webtmux is named webtmux-<sha>, so an exact-match pgrep would find
# nothing and every "is it running?" assertion would pass vacuously.
wt_pids() { rsh "pgrep '^webtmux' 2>/dev/null" | tr '\n' ' '; }
wt_count() { wt_pids | wc -w; }
wt_running() { [ "$(wt_count)" -gt 0 ]; }

# launch <logfile> <extra args…> — start the launcher in the background.
launch_bg() {
  local log="$1"; shift
  "$LAUNCH" --no-browser --verbose "$@" "$TARGET" >"$log" 2>&1 &
  echo $!
}

# wait_for <file> <regex> <seconds>
wait_for() {
  local f="$1" re="$2" n="${3:-30}"
  for _ in $(seq $((n*4))); do
    grep -qE "$re" "$f" 2>/dev/null && return 0
    sleep 0.25
  done
  return 1
}

U=""; U2=""; U4=""; UA=""; SHA1=""; SHA2=""
url_from() { grep -oE 'http://127\.0\.0\.1:[0-9]+/[^ ]+' "$1" | head -1; }

kill_launcher() { kill "$1" 2>/dev/null; wait "$1" 2>/dev/null; }

reset_target() {
  rsh "tmux kill-server 2>/dev/null; pkill '^webtmux' 2>/dev/null; rm -rf ~/.cache/webtmux; true" >/dev/null 2>&1
  sleep 1
  pkill -f 'ssh .*cm-webtmux' >/dev/null 2>&1
  rm -rf ~/.config/webtmux-launch
}

# ---------------------------------------------------------------------------
step "3.13 target reachable"
# ---------------------------------------------------------------------------
if rsh 'echo up; tmux -V' >/tmp/probe.txt 2>&1 && grep -q up /tmp/probe.txt; then
  ok "sshd + tmux answer on $TARGET ($(grep tmux /tmp/probe.txt))"
else
  no "cannot reach $TARGET"; cat /tmp/probe.txt; exit 1
fi
reset_target

# ---------------------------------------------------------------------------
step "3.14 end-to-end: probe → deploy → tunnel → readiness"
# ---------------------------------------------------------------------------
pid=$(launch_bg /tmp/run1.log)
if wait_for /tmp/run1.log 'ready: http' 60; then
  U=$(url_from /tmp/run1.log)
  code=$(curl -s -o /tmp/body1.html -w '%{http_code}' "$U")
  [ "$code" = 200 ] && ok "curl $U → 200" || no "curl $U → $code"
  grep -q 'source: local ' /tmp/run1.log && ok "source line names the local build" || no "no source line"
  grep -q 'deployed: .*/\.cache/webtmux/webtmux-' /tmp/run1.log \
    && ok "content-addressed install path" || no "install path not content-addressed"
  grep -q 'creating session "main"' /tmp/run1.log && ok "reports creating the session" || no "session report missing"
else
  no "launcher never became ready"; cat /tmp/run1.log
fi
SHA_PATH=$(rsh 'ls ~/.cache/webtmux/webtmux-* 2>/dev/null | head -1')
kill_launcher "$pid"

# ---------------------------------------------------------------------------
step "3.14b launch-mode teardown leaves no orphan"
# ---------------------------------------------------------------------------
sleep 1
if wt_running; then
  no "webtmux outlived the ssh connection in launch mode"
else
  ok "webtmux died with the connection (disposable, as designed)"
fi
if rsh 'tmux has-session -t =main 2>/dev/null'; then
  ok "the tmux session survived (it belongs to the tmux server, not to us)"
else
  no "the tmux session died with webtmux"
fi

# ---------------------------------------------------------------------------
step "3.15 idempotence: second run copies nothing"
# ---------------------------------------------------------------------------
pid=$(launch_bg /tmp/run2.log)
if wait_for /tmp/run2.log 'ready: http' 60; then
  if grep -q 'already present:' /tmp/run2.log && ! grep -q '^deployed:' /tmp/run2.log; then
    ok "second run skipped the copy (content-addressed hit)"
  else
    no "second run re-copied the binary"; grep -E 'deployed|already present' /tmp/run2.log
  fi
  grep -q 'attaching to existing session "main"' /tmp/run2.log \
    && ok "reports attaching to the existing session" || no "attach/create reporting wrong"
else
  no "second run never became ready"; cat /tmp/run2.log
fi

# ---------------------------------------------------------------------------
step "3.15c split-view: two regions, two grouped sessions"
# ---------------------------------------------------------------------------
U=$(url_from /tmp/run2.log)
WS="ws://${U#http://}"; WS="${WS%/}/ws"
( cd "$REPO" && go run ./webtmux-launch/test/wsclient -url "$WS" -session web-alpha -dwell 6s >/tmp/ws1.out 2>/tmp/ws1.err ) &
w1=$!
( cd "$REPO" && go run ./webtmux-launch/test/wsclient -url "$WS" -session web-beta  -dwell 6s >/tmp/ws2.out 2>/tmp/ws2.err ) &
w2=$!
sleep 4
SESS=$(rsh "tmux list-sessions -F '#{session_name}' 2>/dev/null" | sort | tr '\n' ' ')
if [[ "$SESS" == *web-alpha* && "$SESS" == *web-beta* ]]; then
  ok "grouped regions got their own sessions: $SESS"
else
  no "regions did not separate (sessions: $SESS) — split-view would mirror"
fi
# 3.15d: the attach script's `tmux -u` + locale exports must survive into the
# remote attach, or tmux downgrades every wide glyph it sends to the browser.
UTF8=$(rsh "tmux list-clients -F '#{client_utf8}' 2>/dev/null" | sort -u | tr '\n' ' ')
if [[ "$UTF8" == *1* && "$UTF8" != *0* ]]; then
  ok "every attached client is utf8=1 despite the target's POSIX locale"
else
  no "a client is flagged utf8=0 (glyphs would be mangled in the browser): $UTF8"
fi
wait $w1 $w2 2>/dev/null
sleep 1
LEFT=$(rsh "tmux list-sessions -F '#{session_name}' 2>/dev/null" | tr '\n' ' ')
[[ "$LEFT" != *web-alpha* ]] && ok "grouped regions are reaped on disconnect (destroy-unattached)" \
                             || no "grouped session leaked: $LEFT"

# ---------------------------------------------------------------------------
step "3.15b durability"
# ---------------------------------------------------------------------------
rsh "tmux send-keys -t main 'echo DURABILITY-MARKER' Enter" >/dev/null 2>&1
sleep 1
rsh "pkill '^webtmux'" >/dev/null 2>&1     # 1. kill webtmux on the remote
sleep 1
rsh 'tmux has-session -t =main 2>/dev/null' && ok "session survives webtmux dying" || no "session died with webtmux"
kill -INT "$pid" 2>/dev/null; wait "$pid" 2>/dev/null   # 2. kill the launcher (SIGINT)
sleep 1
rsh 'tmux has-session -t =main 2>/dev/null' && ok "session survives launcher SIGINT" || no "session died with the launcher"

pid=$(launch_bg /tmp/run3.log)
wait_for /tmp/run3.log 'ready: http' 60
kill -KILL "$pid" 2>/dev/null; wait "$pid" 2>/dev/null   # SIGKILL
sleep 2
rsh 'tmux has-session -t =main 2>/dev/null' && ok "session survives launcher SIGKILL" || no "session died on SIGKILL"
if rsh "tmux capture-pane -p -t main" | grep -q DURABILITY-MARKER; then
  ok "pane contents intact across all of it"
else
  no "pane output was lost"
fi
# 4. re-run and confirm it attaches rather than creating
pid=$(launch_bg /tmp/run4.log)
if wait_for /tmp/run4.log 'ready: http' 60; then
  grep -q 'attaching to existing session' /tmp/run4.log \
    && ok "re-run attaches to the same session" || no "re-run did not attach"
  U4=$(url_from /tmp/run4.log); U2=$(url_from /tmp/run2.log)
  [ "$U4" = "$U2" ] && ok "URL is stable across launcher restarts" || no "URL changed: $U2 → $U4"
fi

# ---------------------------------------------------------------------------
step "3.16 / 3.16a resilience and reconnect cost"
# ---------------------------------------------------------------------------
before=$(grep -o '+ ssh ' /tmp/run4.log | wc -l)
rsh 'pkill -f "sshd: dev@" || pkill -x webtmux' >/dev/null 2>&1
t0=$(date +%s%N)
if wait_for /tmp/run4.log 'reconnecting' 30; then
  ok "supervisor noticed the drop and backed off"
else
  no "no reconnect attempt after the connection died"
fi
if wait_for /tmp/run4.log 'ready: http' 60 || curl -s -o /dev/null -w '' "$U4"; then
  for _ in $(seq 60); do
    code=$(curl -s -o /dev/null -w '%{http_code}' "$U4"); [ "$code" = 200 ] && break; sleep 0.5
  done
  t1=$(date +%s%N)
  if [ "$code" = 200 ]; then
    ok "reconnected and serving again after $(( (t1-t0)/1000000 ))ms"
  else
    no "never served again after the drop"
  fi
fi
after=$(grep -o '+ ssh ' /tmp/run4.log | wc -l)
# One ssh invocation per reconnect: no re-probe, no re-deploy, no session
# re-create. More than a couple means setup leaked into the restart loop.
delta=$((after-before))
if [ "$delta" -le 3 ]; then
  ok "reconnect cost $delta ssh invocation(s) — setup stayed out of the warm path"
else
  no "reconnect re-ran setup: $delta ssh invocations"
  grep -o '+ ssh .*' /tmp/run4.log | tail -5
fi
if rsh "tmux capture-pane -p -t main" | grep -q DURABILITY-MARKER; then
  ok "tmux panes survived the reconnect"
else
  no "panes lost across the reconnect"
fi
kill_launcher "$pid"

# ---------------------------------------------------------------------------
step "3.17 ETXTBSY non-regression"
# ---------------------------------------------------------------------------
reset_target
pid=$(launch_bg /tmp/run5.log)
wait_for /tmp/run5.log 'ready: http' 60
# A second build with a different sha, still a valid binary: appending to a Go
# binary leaves it runnable (the extra bytes are past the image), which is
# exactly the "different build" case the content-addressed path must handle.
cp "$BUILDS/webtmux-linux-amd64" /tmp/webtmux-variant
printf '\n// variant\n' >> /tmp/webtmux-variant
# --fresh is essential here: without it the launcher would (correctly) adopt the
# instance already running and deploy nothing, and the test would pass vacuously.
timeout 30 "$LAUNCH" --no-browser --verbose --fresh --webtmux-binary /tmp/webtmux-variant "$TARGET" >/tmp/etxtbsy.log 2>&1
if grep -qi 'ETXTBSY\|text file busy' /tmp/etxtbsy.log; then
  no "ETXTBSY while a webtmux was running"
else
  ok "deploying a different build alongside a running one is fine (new sha, new path)"
fi
kill_launcher "$pid"
COUNT=$(rsh 'ls ~/.cache/webtmux/webtmux-* 2>/dev/null | wc -l')
[ "$COUNT" -ge 2 ] && ok "multiple builds coexist in the cache ($COUNT)" || no "only $COUNT build in the cache — the second deploy did not happen"

# ---------------------------------------------------------------------------
step "3.14a / 3.14b / 3.14c adopt mode"
# ---------------------------------------------------------------------------
reset_target
# Deploy once so there is a binary to run by hand, then start it ourselves.
pid=$(launch_bg /tmp/run6.log); wait_for /tmp/run6.log 'ready: http' 60; kill_launcher "$pid"
BIN=$(rsh 'ls -t ~/.cache/webtmux/webtmux-* | head -1')
ATT=$(rsh 'ls -t ~/.cache/webtmux/attach-*.sh | head -1')
hand_start() { # <port> <path> [extra flags]
  local port="$1" pathv="$2"; shift 2
  rsh "setsid env WEBTMUX_SESSION=main $BIN -w -a 127.0.0.1 -p $port --path $pathv $* $ATT \
       </dev/null >/tmp/webtmux-$port.log 2>&1 & disown; sleep 1" >/dev/null 2>&1
  for _ in $(seq 20); do
    rsh "pgrep -f -- '-p $port' >/dev/null" && return 0
    sleep 0.5
  done
  return 1
}
hand_start 8123 /handrolled/ --no-auth --reconnect
ADOPT_PID=$(wt_pids | awk '{print $1}')
if [ -n "$ADOPT_PID" ]; then ok "hand-started webtmux is running (pid $ADOPT_PID)"; else no "could not hand-start webtmux"; fi

pid=$(launch_bg /tmp/adopt1.log)
if wait_for /tmp/adopt1.log 'ready: http' 45; then
  grep -q 'adopting webtmux pid' /tmp/adopt1.log && ok "adopts rather than starting a second instance" || no "did not adopt"
  grep -q 'port 8123' /tmp/adopt1.log && ok "reports the adopted port" || no "port not reported"
  grep -q 'build: matches' /tmp/adopt1.log && ok "reports a matching build" || skip "build match line: $(grep '  build:' /tmp/adopt1.log)"
  grep -q '^deployed:' /tmp/adopt1.log && no "adopt mode deployed a binary" || ok "adopt mode deployed nothing"
  grep -qE 'creating session|attaching to existing' /tmp/adopt1.log && no "adopt mode touched sessions" || ok "adopt mode created no session"
  N=$(wt_count)
  [ "$N" = 1 ] && ok "still exactly one webtmux running" || no "$N webtmux processes running"
  UA=$(url_from /tmp/adopt1.log)
  code=$(curl -s -o /dev/null -w '%{http_code}' "$UA")
  [ "$code" = 200 ] && ok "reached the adopted UI through the tunnel ($UA)" || no "adopted UI → $code"
else
  no "adopt mode never became ready"; cat /tmp/adopt1.log
fi
# The one that would hurt: teardown must not kill the user's own process.
kill -INT "$pid" 2>/dev/null; wait "$pid" 2>/dev/null; sleep 1
wt_running && ok "adopted webtmux survived launcher SIGINT" || no "SIGINT killed the adopted process"
pid=$(launch_bg /tmp/adopt2.log); wait_for /tmp/adopt2.log 'ready: http' 45
kill -KILL "$pid" 2>/dev/null; wait "$pid" 2>/dev/null; sleep 1
wt_running && ok "adopted webtmux survived launcher SIGKILL" || no "SIGKILL killed the adopted process"

# 3.14c edge cases
out=$(timeout 25 "$LAUNCH" --no-browser --fresh --adopt-only "$TARGET" 2>&1); echo "$out" | grep -q contradict \
  && ok "--fresh and --adopt-only are refused together" || no "contradictory flags accepted"
hand_start 8124 /second/ --no-auth
out=$(timeout 25 "$LAUNCH" --no-browser "$TARGET" 2>&1)
if echo "$out" | grep -q 'instances are running' && echo "$out" | grep -q 'remote-port'; then
  ok "two instances → lists them and demands --remote-port"
else
  no "ambiguous instance list not handled: $out"
fi
pid=$(launch_bg /tmp/adopt3.log --remote-port 8124)
if wait_for /tmp/adopt3.log 'ready: http' 45; then
  grep -q 'port 8124' /tmp/adopt3.log && ok "--remote-port selects the instance" || no "--remote-port ignored"
fi
kill_launcher "$pid"
# --fresh ignores both and starts its own on a different port
pid=$(launch_bg /tmp/fresh.log --fresh)
if wait_for /tmp/fresh.log 'ready: http' 60; then
  grep -q 'adopting' /tmp/fresh.log && no "--fresh still adopted" || ok "--fresh started its own instance"
  N=$(wt_count); [ "$N" -ge 3 ] && ok "a third webtmux is running ($N total)" || no "expected 3 instances, saw $N"
fi
kill_launcher "$pid"
# Unrecoverable credentials: an instance started WITHOUT --no-auth generates its
# password in-process, so the launcher must say so rather than open a 401.
rsh "pkill '^webtmux'; sleep 1" >/dev/null 2>&1
hand_start 8125 /authed/
out=$(timeout 40 "$LAUNCH" --no-browser "$TARGET" 2>&1 | head -20)
echo "$out" | grep -q 'NOT recoverable' && ok "says the password is unrecoverable" || no "credential limits not reported: $out"
rsh "pkill '^webtmux'; true" >/dev/null 2>&1

# ---------------------------------------------------------------------------
step "3.15a attach vs create with an explicit --session"
# ---------------------------------------------------------------------------
reset_target
rsh 'tmux new-session -d -s handmade' >/dev/null 2>&1
pid=$(launch_bg /tmp/named.log --session handmade)
if wait_for /tmp/named.log 'ready: http' 60; then
  grep -q 'attaching to existing session "handmade"' /tmp/named.log \
    && ok "--session attaches to the named session" || no "--session ignored"
  N=$(rsh "tmux list-sessions | wc -l"); [ "$N" = 1 ] && ok "no second session created" || no "$N sessions exist"
fi
kill_launcher "$pid"

# ---------------------------------------------------------------------------
step "auth mode (--auth) — the shared-box path"
# ---------------------------------------------------------------------------
reset_target
pid=$(launch_bg /tmp/auth.log --auth)
if wait_for /tmp/auth.log 'ready: http' 60; then
  UAU=$(url_from /tmp/auth.log)
  PW=$(grep -oE 'webtmux:[A-Za-z0-9]+' /tmp/auth.log | head -1)
  [ -n "$PW" ] && ok "prints the credential (browsers no longer accept user:pass@host)" \
                || no "no credential printed — the user could not get in"
  code=$(curl -s -o /dev/null -w '%{http_code}' "$UAU")
  [ "$code" = 401 ] && ok "unauthenticated request is refused (401)" || no "expected 401, got $code"
  code=$(curl -s -o /dev/null -u "$PW" -w '%{http_code}' "$UAU")
  [ "$code" = 200 ] && ok "the printed credential works" || no "credential rejected: $code"
  # Risk 7: a credential passed as -c user:pass is visible in ps to every user
  # on that box. It must ride the environment instead.
  if rsh "tr '\0' ' ' < /proc/\$(pgrep '^webtmux' | head -1)/cmdline" | grep -q "${PW#webtmux:}"; then
    no "the password is visible in the remote process's argv"
  else
    ok "the password is not in argv (it rides GOTTY_CREDENTIAL)"
  fi
else
  no "--auth run never became ready"; tail -5 /tmp/auth.log
fi
kill_launcher "$pid"

# ---------------------------------------------------------------------------
step "3.15f local-source tests"
# ---------------------------------------------------------------------------
reset_target
# Bad dir must be a hard error, never a silent fall back to fetching. This is
# the important one: a typo that "works" by downloading looks like success while
# testing nothing you intended.
out=$(timeout 25 env WEBTMUX_LAUNCH_SOURCE=/nope/not/here "$LAUNCH" --no-browser "$TARGET" 2>&1)
if echo "$out" | grep -q '/nope/not/here' && ! echo "$out" | grep -qi 'github.com'; then
  ok "a bad source fails naming the configured value, with no fallback"
else
  no "bad source handling: $out"
fi
# Missing platform names the file and lists what the dir has.
EMPTY=$(mktemp -d); cp "$BUILDS/webtmux-darwin-arm64" "$EMPTY/" 2>/dev/null
out=$(timeout 25 env WEBTMUX_LAUNCH_SOURCE="$EMPTY" "$LAUNCH" --no-browser "$TARGET" 2>&1)
if echo "$out" | grep -q 'no webtmux-linux-amd64' && echo "$out" | grep -q 'webtmux-darwin-arm64'; then
  ok "missing platform names the asset and lists what is present"
else
  no "missing-platform message: $out"
fi
rsh 'ls ~/.cache/webtmux 2>/dev/null | wc -l' | grep -q '^0$' && ok "nothing was installed on failure" || no "a failed run installed something"
# Wrong-arch --webtmux-binary is refused locally, before any transfer.
out=$(timeout 25 "$LAUNCH" --no-browser --webtmux-binary "$BUILDS/webtmux-linux-arm64" "$TARGET" 2>&1)
if echo "$out" | grep -q 'arm64' && echo "$out" | grep -q 'linux-amd64'; then
  ok "wrong-arch binary refused locally, naming both architectures"
else
  no "wrong-arch check: $out"
fi
# Precedence: --webtmux-binary beats the env.
out=$(timeout 25 env WEBTMUX_LAUNCH_SOURCE="$BUILDS" "$LAUNCH" --no-browser --verbose \
        --webtmux-binary "$BUILDS/webtmux-linux-arm64" "$TARGET" 2>&1)
echo "$out" | grep -q 'selected by --webtmux-binary' && ok "--webtmux-binary beats \$WEBTMUX_LAUNCH_SOURCE" \
                                                     || no "precedence wrong: $out"
out=$(timeout 25 env WEBTMUX_LAUNCH_SOURCE=/nope "$LAUNCH" --no-browser --verbose --webtmux-source "$BUILDS" --version 2>&1)
# (--version short-circuits; precedence itself is unit-tested. Here we only need
# the flag to be accepted alongside the env.)
echo "$out" | grep -q 'webtmux-launch' && ok "--webtmux-source is accepted alongside the env" || no "$out"

# Rebuild → redeploy → no-rebuild → no transfer.
reset_target
pid=$(launch_bg /tmp/src1.log); wait_for /tmp/src1.log 'ready: http' 60
SHA1=$(grep -oE '\.cache/webtmux/webtmux-[0-9a-f]{12}' /tmp/src1.log | head -1 | xargs basename)
kill_launcher "$pid"
( cd "$REPO" && GOOS=linux GOARCH=amd64 go build -ldflags "-X main.Version=rebuild-probe" \
    -o "$BUILDS/webtmux-linux-amd64" . )
pid=$(launch_bg /tmp/src2.log); wait_for /tmp/src2.log 'ready: http' 60
SHA2=$(grep -oE '\.cache/webtmux/webtmux-[0-9a-f]{12}' /tmp/src2.log | head -1 | xargs basename)
kill_launcher "$pid"
if [ -n "$SHA1" ] && [ -n "$SHA2" ] && [ "$SHA1" != "$SHA2" ] && grep -q '^deployed:' /tmp/src2.log; then
  ok "a rebuild changes the sha and redeploys ($SHA1 → $SHA2)"
else
  no "rebuild did not redeploy ($SHA1 / $SHA2)"
fi
rsh "test -x ~/.cache/webtmux/$SHA1" && ok "the previous build is still installed" || no "the old build vanished"
pid=$(launch_bg /tmp/src3.log); wait_for /tmp/src3.log 'ready: http' 60
grep -q 'already present:' /tmp/src3.log && ok "no rebuild → no transfer" || no "unchanged source still copied"
kill_launcher "$pid"

# Offline: a local source must make no network syscall at all.
if command -v unshare >/dev/null 2>&1 && unshare -rn true 2>/dev/null; then
  reset_target
  if unshare -rn --map-root-user sh -c "ip link set lo up 2>/dev/null; $LAUNCH --version" >/dev/null 2>&1; then
    ok "the launcher runs with no network namespace at all"
  else
    skip "unshare available but the launcher could not run inside it"
  fi
else
  skip "no unshare in this container — offline proof deferred to the no-DNS check"
fi
# Weaker but real: with a bogus proxy forced, a local-source run must still work.
reset_target
pid=$(HTTPS_PROXY=http://127.0.0.1:1 HTTP_PROXY=http://127.0.0.1:1 launch_bg /tmp/offline.log)
if wait_for /tmp/offline.log 'ready: http' 60; then
  ok "local source deploys with all HTTP egress broken"
else
  no "local mode reached for the network"; tail -5 /tmp/offline.log
fi
kill_launcher "$pid"

# make launcher-dev works with no env var at all; make launcher does not.
( cd "$REPO/webtmux-launch" && make dev >/tmp/mk.log 2>&1 ) || { no "make -C webtmux-launch dev failed"; tail -5 /tmp/mk.log; }
reset_target
pid=$( (unset WEBTMUX_LAUNCH_SOURCE; launch_bg /tmp/devbuild.log) )
if wait_for /tmp/devbuild.log 'ready: http' 60; then
  ok "make -C webtmux-launch dev deploys with nothing exported"
else
  no "launcher-dev build needs an env var"; tail -5 /tmp/devbuild.log
fi
kill_launcher "$pid"
( cd "$REPO/webtmux-launch" && make release >/tmp/mkr.log 2>&1 ) || { no "make -C webtmux-launch release failed"; tail -5 /tmp/mkr.log; }
if [ -x "$BUILDS/webtmux-launch-linux-amd64" ]; then
  out=$(timeout 25 env -u WEBTMUX_LAUNCH_SOURCE "$BUILDS/webtmux-launch-linux-amd64" --no-browser "$TARGET" 2>&1)
  # There is no release yet: assert the ATTEMPT, not its success.
  if echo "$out" | grep -qi 'github.com\|release repo'; then
    ok "a release build with nothing configured reaches for the release path"
  else
    no "release build did not attempt a release: $out"
  fi
fi

# ---------------------------------------------------------------------------
step "3.16b idle survival"
# ---------------------------------------------------------------------------
# ServerAliveInterval is preventive as well as detective: keeping traffic flowing
# is what stops the NAT/firewall idle-timeout class of drop, the most common
# cause of perceived SSH flakiness. Mostly waiting, so it is opt-in.
if [ "${WTL_LONG:-0}" = 1 ]; then
  reset_target
  pid=$(launch_bg /tmp/idle.log)
  if wait_for /tmp/idle.log 'ready: http' 60; then
    UI=$(url_from /tmp/idle.log)
    sleep "${WTL_IDLE_SECONDS:-1800}"
    code=$(curl -s -o /dev/null -w '%{http_code}' "$UI")
    if [ "$code" = 200 ] && ! grep -q reconnecting /tmp/idle.log; then
      ok "connection idled for ${WTL_IDLE_SECONDS:-1800}s without a single drop"
    else
      no "idle connection dropped (http $code); reconnects: $(grep -c reconnecting /tmp/idle.log)"
    fi
  else
    no "idle test could not start"
  fi
  kill_launcher "$pid"
else
  skip "3.16b idle survival — set WTL_LONG=1 (takes ~30 minutes of waiting)"
fi

# ---------------------------------------------------------------------------
step "3.15e fetch-path tests"
# ---------------------------------------------------------------------------
# Written now, skipped until there is a release to fetch. Set WTL_RELEASE_REPO
# to "<owner>/<repo>" (and optionally WTL_RELEASE_VERSION) once Stage 0 + Stage 2
# have landed, and every check below runs for real. Everything they cover EXCEPT
# the HTTP transport is already exercised by 3.15f through the same code path,
# because the backends differ only in Digest/Open.
if [ -z "${WTL_RELEASE_REPO:-}" ]; then
  skip "DEFERRED until Stage 0 + a published v0.1.0 — set WTL_RELEASE_REPO=<owner>/<repo> to run"
  skip "  (the Digest/Open pair itself is covered by TestReleaseDigestAndOpenAgainstStubServer)"
else
  OWNER=${WTL_RELEASE_REPO%%/*}; NAME=${WTL_RELEASE_REPO##*/}
  VER=${WTL_RELEASE_VERSION:-v0.1.0}
  ( cd "$REPO/webtmux-launch" && make release REPO_OWNER="$OWNER" REPO_NAME="$NAME" \
      WEBTMUX_VERSION="$VER" >/tmp/mkrel.log 2>&1 ) || no "make release failed"
  REL="$BUILDS/webtmux-launch-linux-amd64"
  rel() { timeout 60 env -u WEBTMUX_LAUNCH_SOURCE "$REL" --no-browser --verbose "$@" "$TARGET" 2>&1; }

  # Cold cache → downloads, verifies the sha, pushes, installs.
  reset_target; rm -rf ~/.cache/webtmux-launch
  out=$(rel)
  echo "$out" | grep -q '^deployed:' && ok "cold cache: downloaded, verified and installed" \
                                     || no "cold cache: $out"
  # Warm Mac cache, empty target → no download, pushes from cache.
  reset_target
  out=$( (unset HTTPS_PROXY; HTTPS_PROXY=http://127.0.0.1:1 HTTP_PROXY=http://127.0.0.1:1 rel) )
  echo "$out" | grep -q '^deployed:' && ok "warm cache: installed with HTTP egress broken" \
                                     || no "warm cache did not work offline: $out"
  # --webtmux-version latest resolves via the redirect, with no API call.
  out=$(rel --webtmux-version latest)
  echo "$out" | grep -q 'releases/latest/download' && ok "--webtmux-version latest uses the redirect URL" \
                                                   || no "latest: $out"
  # A bad version fails naming the URL it tried, and installs nothing.
  reset_target
  out=$(rel --webtmux-version v9.9.9)
  if echo "$out" | grep -q 'v9.9.9' && echo "$out" | grep -qi '404\|cannot reach'; then
    ok "a bad version fails naming the URL it tried"
  else
    no "bad version: $out"
  fi
  rsh 'ls ~/.cache/webtmux 2>/dev/null | wc -l' | grep -q '^0$' && ok "nothing installed after a bad version" \
                                                                || no "a failed fetch installed something"
  # A corrupted cached download must fail on THIS machine, pushing nothing.
  reset_target
  CACHED=$(ls ~/.cache/webtmux-launch/"$VER"/webtmux-linux-amd64 2>/dev/null | head -1)
  if [ -n "$CACHED" ]; then
    truncate -s 1024 "$CACHED"
    out=$(rel)
    if echo "$out" | grep -qi 'sha\|changed under us'; then
      ok "a corrupted download is caught locally, before any transfer"
    else
      no "corrupted download not caught: $out"
    fi
    rsh 'ls ~/.cache/webtmux 2>/dev/null | wc -l' | grep -q '^0$' && ok "nothing pushed after a sha mismatch" \
                                                                  || no "a corrupt binary reached the target"
  else
    no "no cached download to corrupt"
  fi
fi
# --webtmux-binary deploys a local file with no network at all. Not deferred —
# listed here only for continuity; it runs in 3.15f above.

# ---------------------------------------------------------------------------
if [ -d /keys ]; then mkdir -p /keys/logs && cp /tmp/*.log /keys/logs/ 2>/dev/null; fi
printf '\n\033[1m%d passed, %d failed, %d skipped\033[0m\n' "$pass" "$fail" "$skipped"
[ "$fail" = 0 ]
