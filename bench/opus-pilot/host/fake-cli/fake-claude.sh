#!/bin/sh
# KAN-113 10596: a FAKE Claude Code CLI for the no-model host qualification. It never reads a credential,
# never opens a network connection and never calls a model. Every event it prints is synthetic and
# carries "qb_fake_cli":true so no record built from it can be mistaken for a real trial.
set -eu
if [ "${1:-}" = "--version" ]; then echo "2.1.322 (Claude Code)"; exit 0; fi
model="claude-opus-5-5"
while [ $# -gt 0 ]; do
  case "$1" in --model) shift; model="${1:-$model}" ;; esac
  shift || true
done
prompt="$(cat || true)"
secs="$(printf '%s\n' "$prompt" | sed -n 's/^FAKE_SLEEP=\([0-9][0-9]*\)$/\1/p' | head -n 1)"
if [ -n "$secs" ]; then sleep "$secs"; fi
printf 'fake agent change (no model call)\n' > QB_FAKE_AGENT_CHANGE.txt
printf '{"type":"system","subtype":"init","qb_fake_cli":true,"claude_code_version":"2.1.322","model":"%s","apiKeySource":"none","permissionMode":"dontAsk","tools":[]}\n' "$model"
printf '{"type":"assistant","qb_fake_cli":true,"message":{"model":"%s","content":[{"type":"text","text":"synthetic"}]}}\n' "$model"
printf '{"type":"rate_limit_event","qb_fake_cli":true,"rate_limit_info":{"status":"allowed","rateLimitType":"five_hour","isUsingOverage":false,"overageStatus":"disabled"}}\n'
printf '{"type":"result","subtype":"success","qb_fake_cli":true,"is_error":false,"num_turns":1,"total_cost_usd":0,"modelUsage":{"%s":{"inputTokens":0,"outputTokens":0,"cacheReadInputTokens":0,"cacheCreationInputTokens":0,"costUSD":0,"provider":"firstParty"}}}\n' "$model"
