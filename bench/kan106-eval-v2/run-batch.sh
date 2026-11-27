#!/bin/sh
# KAN-106 evaluation v2 (10838): ONE profile, the 12 frozen held-out requests once each, in order.
# POSIX sh (no zsh, no bash-only syntax): runs on macOS and on Linux hosts without zsh.
# NOT AUTHORIZED until the plan and the held-out packet are frozen and the owner has named this host and
# approved its local-model time window in plan.json; batch.js refuses until then.
#
#   sh bench/kan106-eval-v2/run-batch.sh <PROFILE> <frozen QB commit SHA>
#
# Preflight here (frozen SHA, clean tree, plan document == plan.json, harness freeze); batch.js does the rest.
# Everything goes under $HOME/qb-evidence/kan106-eval-v2/<PROFILE>/<UTC>/. Nothing is retried.
set -u
PROFILE=${1:-}
EXPECTED_SHA=${2:-}
if [ -z "$PROFILE" ] || [ -z "$EXPECTED_SHA" ]; then echo "usage: sh bench/kan106-eval-v2/run-batch.sh <PROFILE> <frozen QB commit SHA>"; exit 2; fi
QB=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd) || exit 2
cd "$QB" || exit 2

HEAD_SHA=$(git rev-parse HEAD 2>/dev/null) || { echo "✗ not a git checkout. Nothing was run."; exit 2; }
[ "$HEAD_SHA" = "$EXPECTED_SHA" ] || { echo "✗ QB is at $HEAD_SHA, not $EXPECTED_SHA. Nothing was run."; exit 2; }
[ -z "$(git status --porcelain)" ] || { echo "✗ the QB checkout has local changes. Nothing was run."; exit 2; }
node bench/kan106-eval-v2/plan-check.js || { echo "Nothing was run."; exit 2; }
node bench/kan106-eval-v2/freeze.js --check-harness || { echo "Nothing was run."; exit 2; }
[ -d bench/kan106-eval-v2/held-out ] || { echo "✗ no held-out packet. Nothing was run."; exit 2; }

OUT="$HOME/qb-evidence/kan106-eval-v2/$PROFILE/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUT" || exit 2
node bench/kan106-eval-v2/items.js materialize bench/kan106-eval-v2/held-out "$OUT/repos" > "$OUT/base-shas.json" || { echo "✗ materialize failed. Nothing was run."; exit 2; }

node bench/kan106-eval-v2/batch.js "$OUT" "$EXPECTED_SHA" "$PROFILE"
code=$?
if [ "$code" -eq 2 ]; then exit 2; fi
if [ "$code" -ne 0 ]; then echo "✗ batch.js failed (exit $code). Send the junior the folder anyway: $OUT"; exit 1; fi
node bench/kan106-eval-v2/score.js --batch-dir "$OUT" --profile "$PROFILE" --out "$OUT/scores.json" && echo "Scores: $OUT/scores.json (semantic review still pending)"
echo "Done. Nothing is retried. Send the junior the folder name: $OUT"
