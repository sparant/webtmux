#!/bin/bash
# Record per-feature demo videos and convert them to the README's animated gifs.
# Runs inside mcr.microsoft.com/playwright:v1.48.0-jammy with the repo at /src.
set -e
export DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8

if ! command -v tmux >/dev/null || ! command -v ffmpeg >/dev/null; then
  apt-get update -qq && apt-get install -y -qq tmux htop python3-pygments ffmpeg >/dev/null
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
  echo "server died on first boot (known gotcha), retrying"
  start_server
  wait_up || { echo "server failed twice"; tail -20 /tmp/webtmux.log; exit 1; }
fi
echo "webtmux up on :8090"

rm -rf /tmp/videos && mkdir -p /tmp/videos
rc=0
NODE_PATH=/tmp/pw/node_modules node /src/screenshots/harness/driver-gifs.js || rc=$?
pkill -f webtmux-test 2>/dev/null || true
[ $rc -ne 0 ] && [ $rc -ne 2 ] && exit $rc

# ---- webm -> gif (palette pass keeps the dark UI banding-free) ---------------
togif() { # in.webm out.gif trim-seconds [extra-filter]
  local in="$1" out="$2" ss="$3" pre="${4:+$4,}"
  ffmpeg -v error -y -ss "$ss" -i "$in" -vf \
    "${pre}fps=8,scale=800:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5" \
    "$out"
  echo "wrote $out ($(du -h "$out" | cut -f1))"
}

cd /tmp/videos
for f in expose split-view sidebar hover-preview preview-pip copy-scroll save-file state-persistence stoplights; do
  [ -f "$f.webm" ] && togif "$f.webm" "/src/screenshots/$f.gif" 3.4
done
# flashing tabs + attention arrow, cropped to the toolbar strip
[ -f stoplights.webm ] && ffmpeg -v error -y -ss 3.4 -i stoplights.webm -vf \
  "crop=iw:46:0:0,fps=10,scale=1100:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5" \
  /src/screenshots/toolbar-alerts.gif && echo "wrote toolbar-alerts.gif ($(du -h /src/screenshots/toolbar-alerts.gif | cut -f1))"

exit $rc
