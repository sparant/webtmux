# webtmux stoplight hooks (bash) — HOST side
#
# Sets a per-window tmux variable @wt_working:
#   1 = a command is running   -> green
#   0 = back at the prompt      -> red
#
# IMPORTANT: this file must be *sourced* from an interactive bash shell,
# not executed. The DEBUG trap / PROMPT_COMMAND / functions have to be
# installed into the live shell environment. In ~/.bashrc add:
#
#     [[ -f /path/to/webtmux/install_stoplight_hooks_bash.sh ]] && \
#         source /path/to/webtmux/install_stoplight_hooks_bash.sh
#
# The $TMUX guard means it only activates in shells started inside tmux;
# the 2>/dev/null absorbs the rare case where tmux is set but unreachable.
#
# WT_STOPLIGHT_SUPPRESS=1 in the environment disables the hooks entirely —
# export it when something else owns this window's stoplight.
#
# WT_STOPLIGHT_DELEGATES names the launchers that own the light themselves —
# see the block below. Run `wt_stoplight_status` in any shell to see what this
# file actually installed.

if [[ -n "$TMUX" && -z "$__wt_hooks_installed" && -z "$WT_STOPLIGHT_SUPPRESS" ]]; then
  __wt_hooks_installed=1

  # Some commands HAND this window's status to something else for their whole
  # lifetime, and must not be painted here:
  #   - agent launches — the agent drives @wt_working from its own lifecycle
  #     hooks, possibly from inside a container;
  #   - entering a nested shell/container that installs these same hooks and
  #     reports its own commands.
  # Each is ONE foreground command that runs until you exit it, so preexec-green
  # would latch for the entire session (precmd cannot fire until it returns) and
  # mask the real state coming from inside.
  #
  # WHICH commands those are is a property of your machine, not of webtmux, so
  # the list is configuration: WT_STOPLIGHT_DELEGATES, colon-separated glob
  # patterns, EMPTY by default (nothing delegates; every command paints). A
  # pattern is tried twice against each command:
  #
  #   - against the WHOLE command string, so `*mylauncher.sh*` still matches when
  #     env-var prefixes and `docker exec` bury the real target in the middle;
  #   - against the BASENAME OF THE FIRST WORD, so a bare `claude` matches
  #     `claude --resume` and `/opt/bin/claude`, but not `echo claude`.
  #
  # Patterns cannot themselves contain `:`. The variable is read LIVE, so
  # exporting a new value mid-session takes effect on the next command.
  __wt_delegates_status() {
    [[ -n "${WT_STOPLIGHT_DELEGATES:-}" ]] || return 1
    local cmd="$1" first pat
    local -a pats
    IFS=: read -r -a pats <<< "$WT_STOPLIGHT_DELEGATES"
    first="${cmd%% *}"
    first="${first##*/}"
    for pat in "${pats[@]}"; do
      [[ -n "$pat" ]] || continue
      # Unquoted RHS in [[ == ]] is glob MATCHING, not pathname expansion.
      [[ "$cmd" == $pat || "$first" == $pat ]] && return 0
    done
    return 1
  }

  # Where the patterns come from, in priority order. An explicit
  # WT_STOPLIGHT_DELEGATES always wins — including an explicitly EMPTY one, which
  # is how you say "nothing delegates here" and mean it. Otherwise a site file
  # shipped beside this script is sourced if present; that file is how a fork
  # carries its own machines' launchers without every user inheriting them, and
  # it is absent from a stock checkout, which is why the default is empty.
  if [[ -z "${WT_STOPLIGHT_DELEGATES+set}" ]]; then
    __wt_site="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)/scripts/stoplight-delegates.env.sh"
    if [[ -r "$__wt_site" ]]; then
      # shellcheck disable=SC1090
      source "$__wt_site"
      __wt_delegates_origin="$__wt_site"
    else
      __wt_delegates_origin="unset (no site file, no environment)"
    fi
    unset __wt_site
  else
    __wt_delegates_origin="environment"
  fi
  export WT_STOPLIGHT_DELEGATES="${WT_STOPLIGHT_DELEGATES:-}"

  # Say out loud what got installed. An empty delegate list is BOTH the correct
  # stock configuration and the exact shape of a local setup that quietly lost
  # its patterns (an rc that stopped exporting them, a site file that moved) —
  # and the symptom, a window latched green for a whole agent session, points
  # nowhere near here. So there is one command that answers it.
  # WT_STOPLIGHT_VERBOSE=1 prints the same line at every shell start.
  wt_stoplight_status() {
    printf 'webtmux stoplight hooks: installed (pane %s)\n' "${TMUX_PANE:-<no TMUX_PANE!>}"
    if [[ -n "$WT_STOPLIGHT_DELEGATES" ]]; then
      printf '  delegates from %s:\n' "$__wt_delegates_origin"
      local pat
      local -a pats
      IFS=: read -r -a pats <<< "$WT_STOPLIGHT_DELEGATES"
      for pat in "${pats[@]}"; do [[ -n "$pat" ]] && printf '    %s\n' "$pat"; done
    else
      printf '  delegates: NONE (%s) — every command paints this window green.\n' \
        "$__wt_delegates_origin"
      printf '  If a launcher here drives @wt_working itself, export\n'
      printf '  WT_STOPLIGHT_DELEGATES (colon-separated globs) or it will fight these hooks.\n'
    fi
  }
  if [[ -n "${WT_STOPLIGHT_VERBOSE:-}" ]]; then wt_stoplight_status; fi

  # Leaving the shell is not work, and green for `exit` is the last thing the
  # shell ever does — no prompt follows to clear it, so walking away from a
  # window would leave it green.
  __wt_is_exit() {
    case "${1%% *}" in
      exit|logout) return 0 ;;
    esac
    return 1
  }

  # EVERY write names the pane it came from. A bare `tmux set -w @wt_working …`
  # does NOT mean "the window I am running in": with no -t, tmux resolves the
  # target from the CURRENT window of the session it picks for this command
  # client — i.e. the window being LOOKED at, not the window this shell lives in.
  #
  # The two coincide only while the pane is on screen, which is exactly why the
  # bug hid: watch a long command and the dot behaves perfectly. Switch away and
  # every write goes to the wrong window — the finishing red lands on whatever you
  # switched TO (reddening a window that is still working, and flashing it at you),
  # while the window that actually finished never leaves green, so the one signal
  # the stoplight exists to give — "the thing you walked away from is done" — is
  # the one signal it could never deliver.
  #
  # $TMUX_PANE is the pane's own id (%N), exported by tmux into every pane; tmux
  # resolves a pane target to its window. It is read LIVE rather than captured at
  # source time because a pane can be moved between windows (break-pane/join-pane)
  # and the id follows the pane, where a captured window id would go stale.
  #
  # No fallback when it is somehow unset: a write that cannot say which window it
  # is about is not a weaker signal, it is a false one about some other window.
  __wt_set() {
    [[ -n "$TMUX_PANE" ]] || return
    tmux set -w -t "$TMUX_PANE" @wt_working "$1" 2>/dev/null
  }

  __wt_preexec() {
    [[ -n "$COMP_LINE" ]] && return                 # skip during completion
    [[ "$BASH_COMMAND" == "$PROMPT_COMMAND" ]] && return
    [[ -n "$__wt_running" ]] && return              # already green
    __wt_delegates_status "$BASH_COMMAND" && return # something else owns it now
    __wt_is_exit "$BASH_COMMAND" && return          # leaving is not work
    __wt_running=1
    __wt_set 1                                      # start work -> green
  }
  __wt_precmd() {
    __wt_set 0                                      # stop work -> red
    __wt_running=
  }
  # However the shell ends — exit, EOF, or a signal — hand the window back red
  # rather than stranding it in whatever colour it happened to be.
  __wt_on_exit() { __wt_set 0; }
  trap '__wt_preexec' DEBUG
  trap '__wt_on_exit' EXIT
  PROMPT_COMMAND="__wt_precmd${PROMPT_COMMAND:+; $PROMPT_COMMAND}"
fi
