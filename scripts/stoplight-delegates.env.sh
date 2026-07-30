# stoplight-delegates.env.sh — THIS FORK'S machines, not upstream's.
#
# The stoplight installer (../install_stoplight_hooks_bash.sh) paints a window
# green for the whole lifetime of whatever command is in the foreground. That is
# wrong for a launcher that hands the window's light to the thing it launches:
# the launch command does not return until you quit the agent, so the window
# would sit green for the entire session and mask the real state coming from
# inside it.
#
# WT_STOPLIGHT_DELEGATES is the list of those launchers. It is deliberately EMPTY
# in the installer, because which launchers exist is a property of a machine. This
# file carries the ones used here; the installer sources it if it is present, and
# it is stripped from the upstream PR branch (see scripts/make-upstream-pr.sh), so
# upstream keeps the empty default.
#
# Two ways to use it, and the environment always wins:
#
#   1. Do nothing. The installer finds this file next to itself and sources it.
#   2. Put the export in your own ~/.bashrc, which overrides this file entirely:
#
#        export WT_STOPLIGHT_DELEGATES='*claude-docker/launch.sh*:*pi-docker/launch.sh*:*enter_secure_container.sh*:claude:pi'
#
# Colon-separated glob patterns. Each is matched against the whole command string
# AND against the basename of its first word — so `*claude-docker/launch.sh*`
# catches the launcher however deeply it is buried in env prefixes and
# `docker exec`, while a bare `claude` catches `claude --resume` but not
# `echo claude`. Patterns cannot contain `:`.
#
# Run `wt_stoplight_status` in any shell to see what actually took effect.

export WT_STOPLIGHT_DELEGATES='*claude-docker/launch.sh*:*pi-docker/launch.sh*:*enter_secure_container.sh*:claude:pi'
