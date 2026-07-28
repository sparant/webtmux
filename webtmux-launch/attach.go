package main

// The attach script the launcher ships alongside the binary.
//
// The launcher CANNOT just run `tmux` as webtmux's command. Split-view depends
// on a wrapper: server/handlers.go injects a Webtmux-Session header per
// connection, localcommand turns it into HTTP_WEBTMUX_SESSION in the pty's
// environment, and mode 1 below reads that to join a GROUPED session — sharing
// the base's window list while keeping an independent current window and size.
// With a bare `tmux new-session -A -s main` as the command, every browser
// region would attach the same session and all splits would mirror each other:
// the split-view feature would be silently broken.
//
// Adapted from scripts/webtmux-docker/attach-web.sh, dropping the
// container-specific socket default (a native install wants tmux's own default
// socket) and the legacy WEBTMUX_GROUPED mode. Modes 1 and 2 are otherwise
// verbatim.

// attachScript is pushed to ~/.cache/webtmux/attach-<sha12>.sh, content
// addressed on its OWN sha rather than the binary's.
//
// Deviation from the plan, deliberate: the plan named it attach-<binary sha>.sh.
// Keying it to its own content is strictly more correct — otherwise editing this
// script without changing the binary would leave the stale copy in place on
// every target that already had one, which is exactly the class of bug
// content-addressing exists to prevent.
const attachScript = `#!/usr/bin/env bash
# attach-web.sh — attach each web connection to its tmux session.
# Deployed by webtmux-launch. Do not edit here; edit the launcher.
#
# webtmux runs this once per websocket connection, with a fresh pty — it is
# webtmux's "command".
#
#   1. Named grouped region (split-view). The server injects
#      HTTP_WEBTMUX_SESSION=<name> for every non-primary region; we join a
#      GROUPED session of that name (new-session -t <base> -s <name>): it shares
#      the base's window LIST but keeps an independent current window and size,
#      and is reaped on disconnect (destroy-unattached on).
#   2. Shared base (default / primary region). No injected name => attach the
#      SHARED base session (new-session -A), so the sidebar's controller drives
#      this client's view and the browser stays in sync with the ssh console.
#
# Note the asymmetry that makes durability work: grouped regions get
# destroy-unattached (disposable); the base session does not (durable).
set -euo pipefail

# Force a UTF-8 locale for this tmux CLIENT. tmux decides per client, at attach
# time, whether the terminal is UTF-8 capable — from LC_ALL/LC_CTYPE/LANG or the
# -u flag. SSH does not forward LANG unless the server sets AcceptEnv, so a
# remote login in the POSIX locale makes tmux flag the client utf8=0 and
# DOWNGRADE every wide / box-drawing glyph it draws to the browser. That is a
# server->client downgrade: no font or renderer change on the client can fix it.
# Belt and braces: export a UTF-8 locale AND pass -u on every attach below.
export LANG="${LANG:-C.UTF-8}"
export LC_ALL="${LC_ALL:-C.UTF-8}"

# Unset WEBTMUX_SOCKET means tmux's default socket, which is what a native
# install wants (empty -S would be wrong, so build the argument conditionally).
SOCKARGS=()
if [ -n "${WEBTMUX_SOCKET:-}" ]; then SOCKARGS=(-S "$WEBTMUX_SOCKET"); fi
BASE="${WEBTMUX_SESSION:-main}"
NAME="${HTTP_WEBTMUX_SESSION:-}"

ensure_base() {
  tmux "${SOCKARGS[@]}" has-session -t "=$BASE" 2>/dev/null \
    || tmux "${SOCKARGS[@]}" new-session -d -s "$BASE"
}

# 1. Named grouped region (split-view). A name equal to the base is the
#    primary/shared path, handled below.
if [ -n "$NAME" ] && [ "$NAME" != "$BASE" ]; then
  ensure_base
  exec tmux -u "${SOCKARGS[@]}" new-session -t "$BASE" -s "$NAME" \; \
    set-option destroy-unattached on
fi

# 2. Shared (default): attach-or-create the base session. -A is atomic
#    attach-or-create, so there is no check-then-create race with the launcher's
#    own session creation. Trailing arguments (webtmux-launch <target> -- cmd…)
#    become the command of a session that does not exist yet.
ensure_base
if [ "$#" -gt 0 ]; then
  exec tmux -u "${SOCKARGS[@]}" new-session -A -s "$BASE" "$@"
fi
exec tmux -u "${SOCKARGS[@]}" new-session -A -s "$BASE"
`
