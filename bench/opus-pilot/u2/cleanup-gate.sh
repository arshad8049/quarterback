#!/bin/sh
# KAN-114 10720 item 8: the U2 cleanup gate. Records QB's leftover containers, volumes, networks and the Claude auth
# volume as key=value counts into $1, then FAILS (exit 1) on any nonzero count or if any count could not be read.
# Unlike the v8 print-only check, a leftover fails the job. DOCKER overrides the docker binary (tests use a fake).
#   sh bench/opus-pilot/u2/cleanup-gate.sh <out-file>
set -u
OUT=${1:?usage: cleanup-gate.sh <out-file>}
DK=${DOCKER:-docker}
mkdir -p "$(dirname "$OUT")"
: > "$OUT"
rc=0
count() {  # key, docker args...
  k=$1; shift
  if ids=$("$DK" "$@"); then
    n=$(printf '%s' "$ids" | grep -c . || true)
    echo "$k=$n" | tee -a "$OUT"
    [ "$n" -eq 0 ] || { echo "::error title=u2-cleanup::$k=$n leftover"; rc=1; }
  else
    echo "$k=unknown" | tee -a "$OUT"
    echo "::error title=u2-cleanup::$k could not be counted (docker failed)"; rc=1
  fi
}
count qb_containers ps -aq --filter label=qb.run
count qb_volumes volume ls -q --filter label=qb.run
count qb_networks network ls -q --filter label=qb.run
count qb_claude_auth_volume volume ls -q --filter 'name=^qb-claude-auth$'
exit $rc
