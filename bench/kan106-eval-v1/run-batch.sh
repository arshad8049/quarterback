#!/bin/zsh
# KAN-106 eight-request evaluation v1 (freeze v2, 10761): ONE generation-only run per item, in the frozen order.
# NOT AUTHORIZED until the senior has reviewed the 10761 harness delta AND the owner has approved up to 56
# minutes of LOCAL L1 model time (the sum of the L1 budgets, 8 x 420 s; wall time also includes setup and
# scoring). No Claude, no agent (--agent dry-run), no retry: a failure, timeout or refusal is an outcome.
# Do not run it during the Velora demo.
#
#   zsh bench/kan106-eval-v1/run-batch.sh <frozen QB commit SHA, as posted on KAN-106>
#
# This script is the preflight. bench/kan106-eval-v1/batch.js launches each item with a BUILT environment
# (pinned local endpoint, model and runs dir; nothing else inherited) and the frozen flags, and refuses
# unless that endpoint lists the frozen model digest. Everything goes under ~/qb-evidence/kan106-eval-v1/<UTC>/.
set -u
EXPECTED_SHA=${1:-}
if [[ -z "$EXPECTED_SHA" ]]; then print "usage: zsh bench/kan106-eval-v1/run-batch.sh <frozen QB commit SHA>"; exit 2; fi
QB=${0:A:h:h:h}
cd "$QB" || exit 2

[[ "$(git rev-parse HEAD)" == "$EXPECTED_SHA" ]] || { print "✗ QB is at $(git rev-parse HEAD), not $EXPECTED_SHA. Nothing was run."; exit 2; }
[[ -z "$(git status --porcelain)" ]] || { print "✗ the QB checkout has local changes. Nothing was run."; exit 2; }
node bench/kan106-eval-v1/check-freeze.js || { print "Nothing was run."; exit 2; }

OUT=~/qb-evidence/kan106-eval-v1/$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$OUT" || exit 2
node bench/kan106-eval-v1/materialize.js "$OUT/repos" > "$OUT/base-shas.json" || { print "✗ materialize failed. Nothing was run."; exit 2; }
node bench/kan106-eval-v1/check-freeze.js --base-shas "$OUT/base-shas.json" || { print "Nothing was run."; exit 2; }

node bench/kan106-eval-v1/batch.js "$OUT" "$EXPECTED_SHA"
code=$?
if [[ $code -eq 2 ]]; then exit 2; fi
if [[ $code -ne 0 ]]; then print "✗ batch.js failed (exit $code). Send the junior the folder anyway: $OUT"; exit 1; fi
node bench/kan106-eval-v1/score.js --batch-dir "$OUT" --out "$OUT/scores.json" && print "Scores: $OUT/scores.json (semantic review still pending)"
print "Done. Nothing is retried. Send the junior the folder name: $OUT"
