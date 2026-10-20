#!/bin/bash
# The command webtmux spawns per connection — the harness's stand-in for
# scripts/webtmux-docker/attach-web.sh, and it has to attach the way that does:
# the primary region on the shared base session, every added split region on its OWN
# grouped session (named by the server in HTTP_WEBTMUX_SESSION). Attaching a split to
# the base as well made it a second client of the primary's session, so the two
# mirrored each other whenever both were on it — a split view the product never has.
export LANG=C.UTF-8
SOCK=/tmp/wt.sock
BASE="${WEBTMUX_SESSION:-dev}"
NAME="${HTTP_WEBTMUX_SESSION:-}"
if [ -n "$NAME" ] && [ "$NAME" != "$BASE" ]; then
  exec tmux -u -S "$SOCK" new-session -t "$BASE" -s "$NAME" \; set-option destroy-unattached on
fi
exec tmux -u -S "$SOCK" new-session -A -s "$BASE"
