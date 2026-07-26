#!/bin/bash
export LANG=C.UTF-8
exec tmux -u -S /tmp/wt.sock new-session -A -s "${WEBTMUX_SESSION:-dev}"
