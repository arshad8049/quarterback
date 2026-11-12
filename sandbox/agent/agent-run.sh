#!/bin/sh
# Agent stage, after the proxy forwarder (entry.sh). KAN-113: the briefing arrives on stdin and is passed to
# `claude -p` unchanged (no prompt argument, no briefing path); the args are QB's (legacy or the pilot profile).
set -eu
cd "${QB_WORK_DIR:-/work}"
exec claude -p "$@"
