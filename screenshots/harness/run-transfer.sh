#!/bin/bash
# Boots webtmux with a tmux session and a declared shared directory, then drives
# the transfer UI in a real browser. Runs inside wt-xfer-verify (playwright
# browsers + node + tmux), with the repo at /src.
set -u
export DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8

FAR=/tmp/far
rm -rf "$FAR"; mkdir -p "$FAR/incoming" "$FAR/project/nested"
echo "the build log" > "$FAR/build.log"
echo "alpha" > "$FAR/project/a.txt"
echo "bravo" > "$FAR/project/nested/b.txt"

# WEBTMUX_SAVE_DIR is the operator declaring which directory is shared; without
# it a containerized webtmux refuses every path, and the dropdown asks for one
# instead of showing the transfer controls (which is correct, but not what this
# driver is here to test).
export WEBTMUX_SAVE_DIR="$FAR" WEBTMUX_HOME="$FAR" WEBTMUX_IN_CONTAINER=1
export WEBTMUX_SOCKET=/tmp/wt-ui.sock WEBTMUX_SESSION=xfer

tmux -S "$WEBTMUX_SOCKET" kill-server 2>/dev/null
tmux -S "$WEBTMUX_SOCKET" new-session -d -s xfer -c "$FAR" -x 100 -y 30
sleep 0.5

pkill -f webtmux-test 2>/dev/null
/src/webtmux-test -w -p 8090 -a 0.0.0.0 -c wt:wt \
  tmux -S "$WEBTMUX_SOCKET" attach -t xfer > /tmp/webtmux-ui.log 2>&1 &
SV=$!
trap 'kill $SV 2>/dev/null; tmux -S "$WEBTMUX_SOCKET" kill-server 2>/dev/null' EXIT

for _ in $(seq 1 40); do
  curl -fsS -u wt:wt -o /dev/null http://localhost:8090/ && break
  sleep 0.25
done
curl -fsS -u wt:wt -o /dev/null http://localhost:8090/ || {
  echo "server never came up"; tail -20 /tmp/webtmux-ui.log; exit 1; }
echo "webtmux up on :8090"

mkdir -p /src/screenshots
NODE_PATH=/pw/node_modules node /src/screenshots/harness/verify-transfer-ui.js
rc=$?
pkill -f webtmux-test 2>/dev/null
exit $rc
