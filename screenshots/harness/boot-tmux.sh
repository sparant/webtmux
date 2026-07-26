#!/bin/bash
# Stage a realistic tmux server on a private socket for README screenshots.
set -e
export LANG=C.UTF-8
SOCK=/tmp/wt.sock
T() { tmux -u -S "$SOCK" "$@"; }

pkill -f "tmux -u -S $SOCK" 2>/dev/null || true
rm -f "$SOCK"

# --- helper content scripts ---------------------------------------------------
cat > /tmp/build-loop.sh <<'EOF'
#!/bin/bash
files=(server/server.go server/handlers.go pkg/tmux/controller.go pkg/tmux/capture.go webtty/webtty.go webtty/message.go backend/localcommand/local_command.go main.go server/asset_cache.go pkg/tmux/layout.go)
i=0; total=214
printf '\e[1mgo build ./...\e[0m\n'
while true; do
  i=$(( (i % total) + 1 ))
  f=${files[$((RANDOM % ${#files[@]}))]}
  if [ $((RANDOM % 11)) -eq 3 ]; then
    printf '\e[90m[%3d/%d]\e[0m compile \e[36m%-38s\e[0m \e[33mwarn\e[0m unused parameter "opts"\n' "$i" "$total" "$f"
  else
    printf '\e[90m[%3d/%d]\e[0m compile \e[36m%-38s\e[0m \e[32mok\e[0m %d ms\n' "$i" "$total" "$f" $((RANDOM % 300 + 40))
  fi
  sleep 0.8
done
EOF

cat > /tmp/server-log.sh <<'EOF'
#!/bin/bash
paths=(/api/layout /ws /api/capture /auth/token /api/state /api/save /api/windows)
while true; do
  ts=$(date '+%H:%M:%S')
  p=${paths[$((RANDOM % ${#paths[@]}))]}
  ms=$((RANDOM % 90 + 2))
  case $((RANDOM % 14)) in
    3)  printf '\e[90m%s\e[0m \e[33mWARN\e[0m  http    slow request \e[36m%s\e[0m %dms\n' "$ts" "$p" $((ms+250));;
    7)  printf '\e[90m%s\e[0m \e[35mDEBUG\e[0m websock capture coalesced window=@%d\n' "$ts" $((RANDOM % 9));;
    11) printf '\e[90m%s\e[0m \e[31mERROR\e[0m tmux    client detached tty=/dev/pts/%d (reconnecting)\n' "$ts" $((RANDOM % 20));;
    *)  printf '\e[90m%s\e[0m \e[32mINFO\e[0m  http    200 GET \e[36m%s\e[0m %dms\n' "$ts" "$p" "$ms";;
  esac
  sleep 0.5
done
EOF

cat > /tmp/tests-done.sh <<'EOF'
#!/bin/bash
printf '\e[1m$ make test\e[0m\n\n'
suites=(state-store split-state recents-strip work-alerts stoplight capture-cache save-target hover-preview copy-mode tooltip)
for s in "${suites[@]}"; do
  n=$((RANDOM % 30 + 8))
  printf '  \e[32m✓\e[0m %-22s \e[90m%d tests, %d ms\e[0m\n' "$s" "$n" $((RANDOM % 400 + 60))
done
printf '\n\e[1;32mPASS\e[0m  10 suites, 205 tests, 0 failures\n'
printf '\e[90mwaiting for changes…\e[0m\n'
exec sleep infinity
EOF

cat > /tmp/tail-logs.sh <<'EOF'
#!/bin/bash
units=(webtmux.service docker.service tmux-hooks.timer)
printf '\e[1m$ journalctl -fu webtmux\e[0m\n'
while true; do
  ts=$(date '+%b %d %H:%M:%S')
  u=${units[$((RANDOM % ${#units[@]}))]}
  printf '\e[90m%s host\e[0m %s[%d]: layout sync ok (%d windows, %d sessions)\n' "$ts" "$u" $((RANDOM % 9000 + 100)) $((RANDOM % 9 + 1)) 3
  sleep 1.1
done
EOF

cat > /tmp/glyphs.sh <<'EOF'
#!/bin/bash
printf '\e[1mGlyph fidelity — box drawing, blocks, powerline\e[0m\n\n'
printf '┌──────────────┬──────────────────────┐\n'
printf '│ \e[36mrenderer\e[0m     │ DOM (WebGL opt-in)   │\n'
printf '│ \e[36mclient\e[0m       │ UTF-8 clean (tmux -u)│\n'
printf '├──────────────┼──────────────────────┤\n'
printf '│ \e[36mblocks\e[0m       │ ░░▒▒▓▓██ ▁▂▃▄▅▆▇█    │\n'
printf '│ \e[36mlines\e[0m        │ ─ │ ┼ ╭─╮ ╰─╯ ═ ║ ╬  │\n'
printf '│ \e[36mpowerline\e[0m    │  main  ✚2 ⚑        │\n'
printf '└──────────────┴──────────────────────┘\n\n'
printf '\e[32m▶\e[0m sparkline: \e[35m▁▂▄▆█▆▄▂▁▂▄▆█\e[0m   braille: ⠋⠙⠹⠸⠼⠴\n'
exec sleep infinity
EOF

cat > /tmp/state-dump.sh <<'EOF'
#!/bin/bash
printf '\e[1m$ tmux show -g @wt_state   \e[0m\e[90m# shared UI state, stored in the tmux server itself\e[0m\n\n'
tmux -S /tmp/wt.sock show -gv @wt_state 2>/dev/null | python3 -m json.tool 2>/dev/null | head -34 || echo '(no state yet)'
exec sleep infinity
EOF

chmod +x /tmp/build-loop.sh /tmp/server-log.sh /tmp/tests-done.sh /tmp/tail-logs.sh /tmp/glyphs.sh /tmp/state-dump.sh

# --- sessions & windows -------------------------------------------------------
T new-session -d -s dev -n editor -x 220 -y 50
T set -g automatic-rename off
T set -g allow-rename off
T set -g history-limit 5000

T send-keys -t dev:editor "clear; pygmentize -g /src/pkg/tmux/capture.go 2>/dev/null | head -44 || head -44 /src/pkg/tmux/capture.go" Enter
T new-window -t dev -n build   /tmp/build-loop.sh
T new-window -t dev -n server  /tmp/server-log.sh
T new-window -t dev -n tests   /tmp/tests-done.sh

T new-session -d -s ops -n htop -x 220 -y 50
T send-keys -t ops:htop "htop" Enter
T new-window -t ops -n logs /tmp/tail-logs.sh

T new-session -d -s scratch -n shell -x 220 -y 50
T send-keys -t scratch:shell "clear; ls --color=always -la /src | head -20" Enter
T new-window -t scratch -n panes /tmp/glyphs.sh
T split-window -t scratch:panes -h /tmp/server-log.sh
T split-window -t scratch:panes -v /tmp/build-loop.sh
T select-pane -t scratch:panes.0
T new-window -t scratch -n state
T select-window -t scratch:shell
T select-window -t ops:htop
T select-window -t dev:editor

echo "tmux staged on $SOCK:"
T list-windows -a
