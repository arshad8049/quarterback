#!/bin/zsh
# Velora demo-day preflight (KAN-44 10756). Run on the demo Mac before the call:
#   zsh ~/qb-velora/demo-day-preflight.sh
# It makes NO model call (no Claude, no Ollama generation) and changes nothing.
# It checks the pins, Docker, Ollama, sign-in and qb doctor, then prints the demo
# commands and the fallback. Any ✗ line: fix it, or use the fallback.
set -u
V=~/qb-velora
QB_SHA=2f01d93df05d819d71d38515082a60e534156769
SAMPLE_SHA=14fcfe4efa8f965ae2fb08b44fe0ef2a3869cf50
CONTRACT_SHA=7fcb8c91120b5f2ba512555059b3012b275089667f75b7aafc5d14c48825c6a6
REHEARSAL_RUN=0e9eede7-be7f-41a9-a024-91e431f00f88
FALLBACK_HTML=$V/FALLBACK-velora-rehearsal-playback.html
bad=0
ok()  { print -P "%F{green}✓%f $1"; }
no()  { print -P "%F{red}✗%f $1"; bad=$((bad+1)); }

print "Velora demo-day preflight  $(date '+%Y-%m-%d %H:%M %Z')"
print "────────────────────────────────────────────────────────"
[[ "$(git -C $V/quarterback rev-parse HEAD 2>/dev/null)" == $QB_SHA ]] && ok "Quarterback pinned at 2f01d93" || no "Quarterback is not at 2f01d93: do not run live, use the fallback"
[[ -z "$(git -C $V/quarterback status --porcelain 2>/dev/null)" ]] && ok "Quarterback checkout unmodified" || no "Quarterback checkout has local changes"
[[ "$(git -C $V/velora-sample rev-parse HEAD 2>/dev/null)" == $SAMPLE_SHA ]] && ok "Sample at 14fcfe4" || no "Sample is not at 14fcfe4"
[[ -z "$(git -C $V/velora-sample status --porcelain 2>/dev/null)" ]] && ok "Sample unmodified" || no "Sample has changes: git -C ~/qb-velora/velora-sample status"
[[ "$(shasum -a 256 $V/velora-duration-contract.json 2>/dev/null | cut -d' ' -f1)" == $CONTRACT_SHA ]] && ok "Checklist hash 7fcb8c91… (the approved file)" || no "Checklist hash differs: do not run live, use the fallback"
[[ ! -e $V/velora-review && ! -e $V/velora.patch ]] && ok "No leftovers from the rehearsal" || no "Leftovers: rm -rf ~/qb-velora/velora-review ~/qb-velora/velora.patch"
[[ -d ~/.qb/runs/$REHEARSAL_RUN ]] && ok "Rehearsal run record present (fallback A)" || no "Rehearsal run record missing: fallback A unavailable"
[[ -f $FALLBACK_HTML ]] && ok "Fallback playback present (fallback B)" || no "Fallback playback missing"
docker info >/dev/null 2>&1 && ok "Docker Desktop running" || no "Docker Desktop not running: start it, wait for 'Engine running'"
curl -s -m 3 http://127.0.0.1:11434/api/tags 2>/dev/null | grep -q '"deepseek-r1:7b"' && ok "Ollama running with deepseek-r1:7b" || no "Ollama not running or deepseek-r1:7b missing: open the Ollama app"

export QBDIR=$V/quarterback
cd $V
print "\n── qb auth status ──"
node "$QBDIR/qb.js" auth status 2>&1 | grep -v 'injected env'
print "\n── qb doctor --repo velora-sample ──"
node "$QBDIR/qb.js" doctor --repo velora-sample 2>&1 | grep -v 'injected env'
[[ ${pipestatus[1]} -eq 0 ]] && ok "qb doctor passed" || no "qb doctor reported a problem: apply its fix: line"

print "\n────────────────────────────────────────────────────────"
if (( bad == 0 )); then print -P "%F{green}READY%f: all checks passed."; else print -P "%F{red}NOT READY%f: $bad problem(s) above. Fix them, or open the fallback."; fi
cat <<EOF

In the demo terminal, define qb first:
  export QBDIR=~/qb-velora/quarterback
  qb() { node "\$QBDIR/qb.js" "\$@"; }
  cd ~/qb-velora

LIVE RUN (only with the owner's go-ahead on the day; calls Claude once):
  qb 'Show durations under one minute as seconds only, for example 30000 ms as "30s" instead of "0m 30s". Durations of one minute or more keep the current format, for example 90000 ms stays "1m 30s".' --repo velora-sample --agent claude-code --contract-file velora-duration-contract.json --deadline 20

FALLBACK A (no model call): the rehearsal's own run
  qb show $REHEARSAL_RUN
  qb replay $REHEARSAL_RUN
  qb patch $REHEARSAL_RUN --out velora-fallback.patch
  git -C velora-sample apply --check ../velora-fallback.patch

FALLBACK B: the recorded terminal playback (share the browser tab)
  open $FALLBACK_HTML
EOF
