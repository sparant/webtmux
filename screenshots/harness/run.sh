#!/bin/bash
# Runs inside mcr.microsoft.com/playwright:v1.48.0-jammy with /workspace/webtmux-shots at /src
set -e
export DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8

if ! command -v tmux >/dev/null; then
  apt-get update -qq && apt-get install -y -qq tmux htop python3-pygments >/dev/null
fi

if [ ! -d /tmp/pw/node_modules/playwright ]; then
  mkdir -p /tmp/pw && cd /tmp/pw && npm init -y >/dev/null 2>&1
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm i playwright@1.48.0 >/dev/null 2>&1
fi

chmod +x /src/screenshots/harness/*.sh /src/webtmux-test
bash /src/screenshots/harness/boot-tmux.sh

pkill -f webtmux-test 2>/dev/null || true
sleep 1

start_server() {
  export WEBTMUX_SOCKET=/tmp/wt.sock WEBTMUX_SESSION=dev
  /src/webtmux-test -w -p 8090 -a 0.0.0.0 --reconnect -c wt:wt /src/screenshots/harness/attach.sh \
    > /tmp/webtmux.log 2>&1 &
  SVPID=$!
}

wait_up() {
  for i in $(seq 1 30); do
    if curl -fsS -u wt:wt -o /dev/null http://localhost:8090/; then return 0; fi
    kill -0 $SVPID 2>/dev/null || return 1
    sleep 0.5
  done
  return 1
}

start_server
if ! wait_up; then
  echo "server died on first boot (known gotcha), retrying"; tail -5 /tmp/webtmux.log
  start_server
  wait_up || { echo "server failed twice"; tail -20 /tmp/webtmux.log; exit 1; }
fi
echo "webtmux up on :8090"

mkdir -p /src/screenshots
NODE_PATH=/tmp/pw/node_modules node /src/screenshots/harness/driver.js
rc=$?
pkill -f webtmux-test 2>/dev/null || true
exit $rc
