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
#     [[ -f /workspace/webtmux/install_stoplight_hooks_bash.sh ]] && \
#         source /workspace/webtmux/install_stoplight_hooks_bash.sh
#
# The $TMUX guard means it only activates in shells started inside tmux;
# the 2>/dev/null absorbs the rare case where tmux is set but unreachable.
#
# WT_STOPLIGHT_SUPPRESS=1 in the environment disables the hooks entirely —
# export it when something else owns this window's stoplight.

if [[ -n "$TMUX" && -z "$__wt_hooks_installed" && -z "$WT_STOPLIGHT_SUPPRESS" ]]; then
  __wt_hooks_installed=1

  # Some commands HAND this window's status to something else for their whole
  # lifetime, and must not be painted here:
  #   - agent launches (claude/pi) — the agent drives @wt_working from its own
  #     lifecycle hooks inside the container;
  #   - entering the secure daemon — the shell you land on in there installs these
  #     same hooks and reports its own commands.
  # Each is ONE foreground command that runs until you exit it, so preexec-green
  # would latch for the entire session (precmd cannot fire until it returns) and
  # mask the real state coming from inside. Match the COMMAND STRING, not the
  # first token: env-var prefixes and `docker exec` bury the real target.
  __wt_delegates_status() {
    case "$1" in
      *claude-docker/launch.sh*|*pi-docker/launch.sh*|*enter_secure_container.sh*) return 0 ;;
    esac
    local first="${1%% *}"
    case "${first##*/}" in
      claude|pi) return 0 ;;
    esac
    return 1
  }

  __wt_preexec() {
    [[ -n "$COMP_LINE" ]] && return                 # skip during completion
    [[ "$BASH_COMMAND" == "$PROMPT_COMMAND" ]] && return
    [[ -n "$__wt_running" ]] && return              # already green
    __wt_delegates_status "$BASH_COMMAND" && return # something else owns it now
    __wt_running=1
    tmux set -w @wt_working 1 2>/dev/null           # start work -> green
  }
  __wt_precmd() {
    tmux set -w @wt_working 0 2>/dev/null           # stop work -> red
    __wt_running=
  }
  trap '__wt_preexec' DEBUG
  PROMPT_COMMAND="__wt_precmd${PROMPT_COMMAND:+; $PROMPT_COMMAND}"
fi
