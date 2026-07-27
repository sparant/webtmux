#!/bin/bash
# A stand-in for Claude Code / vim / htop for the mouse-mode drivers.
#
#   $1  mouse tracking mode: 1000 (press/release, default), 1002 (button-event,
#       i.e. motion while a button is down), 1003 (any-event, motion always)
#   $2  repaint style: inplace (cursor-addressed, default) | scroll (emits lines
#       that push the screen up, the way a streaming agent transcript does)
#
# The first stand-in here was too weak to find real bugs: mouse mode 1000, static
# output, normal screen. A real TUI differs on three axes that all turned out to
# matter, so they are knobs rather than assumptions:
#
#   1. alternate screen  — tmux is emulating a screen for the pane
#   2. mouse tracking    — which mode decides what xterm forwards, and when
#   3. repaint behaviour — an in-place redraw touches cells; a scrolling one
#                          moves buffer lines, which is a different event
#                          entirely as far as a live text selection is concerned
#
# It also echoes what it receives, so a mouse report the pane got shows up on
# screen as "^[[<..." and a driver can count them.
export LANG=C.UTF-8

MODE="${1:-1000}"
REPAINT="${2:-inplace}"

printf '\e[?1049h'                        # alternate screen
printf '\e[?%sh\e[?1006h' "$MODE"         # mouse tracking, SGR encoding
printf '\e[2J\e[H'

paint_rows() {
  printf '\e[H'
  for w in AAAA BBBB CCCC DDDD EEEE FFFF GGGG HHHH; do
    printf 'SELECTME-%s some line of program output here\n' "$w"
  done
}
paint_rows
# A COUNT of mouse reports on a fixed row, not the raw bytes inline: the scrolling
# repaint below would otherwise wipe the evidence a driver is trying to read, and
# echoed escape bytes move the cursor around unpredictably.
# Button events and pointer MOTION are counted apart, because mode 1003 reports
# motion with no button down at all — so "did the program get this click?" cannot
# be answered by counting reports. In SGR encoding (ESC [ < b ; x ; y M|m) a motion
# report has bit 32 set in b; anything below that is a real press or release.
presses=0
motion=0
render_reports() { printf '\e7\e[10;1HPRESSES: %-5d MOTION: %-6d\e8' "$presses" "$motion"; }
render_reports

(
  i=0
  while true; do
    i=$(( (i + 1) % 1000 ))
    if [ "$REPAINT" = "scroll" ]; then
      # Repaint the whole screen AND scroll it, the way a TUI streaming new
      # output does: the target rows stay readable, but buffer lines move under
      # any selection anchored on them.
      # Scroll a REGION (rows 12-20) rather than the whole screen, so the target
      # rows and the report counter above them survive to be asserted on.
      printf '\e7\e[12;20r\e[20;1H\n  streaming line %04d\e[r\e8' "$i"
    else
      printf '\e7\e[14;1H\e[2K  working... tick %04d \e8' "$i"
    fi
    sleep 0.15
  done
) &
SPIN=$!
trap 'kill $SPIN 2>/dev/null; printf "\e[?%sl\e[?1006l\e[?1049l" "$MODE"' EXIT

buf=''
while IFS= read -r -n1 c; do
  if [ "$c" = $'\e' ]; then buf=''; continue; fi
  buf="$buf$c"
  case "$c" in
    M|m)
      code="${buf#*<}"; code="${code%%;*}"
      if [ -n "$code" ] && [ "$code" -ge 32 ] 2>/dev/null; then
        motion=$(( motion + 1 ))
      else
        presses=$(( presses + 1 ))
      fi
      buf=''
      render_reports
      ;;
  esac
done
