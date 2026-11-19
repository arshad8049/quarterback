#!/bin/zsh
# KAN-106 10758, eight-request evaluation v1: ONE generation-only run per item, in the frozen order.
# NOT AUTHORIZED until the senior has reviewed the frozen package AND the owner has approved the model time
# (at most 8 x 420 s of L1 = 56 minutes of local qwen2.5-coder:14b). No Claude, no agent (--agent dry-run),
# no retry: a failure, timeout or refusal is an outcome. Do not run it during the Velora demo.
#
#   zsh bench/kan106-eval-v1/run-batch.sh <frozen QB commit SHA, as posted on KAN-106>
#
# Writes everything under ~/qb-evidence/kan106-eval-v1/<UTC time>/ (repos, logs, runs.json, scores.json).
set -u
EXPECTED_SHA=${1:-}
if [[ -z "$EXPECTED_SHA" ]]; then print "usage: zsh bench/kan106-eval-v1/run-batch.sh <frozen QB commit SHA>"; exit 2; fi
QB=${0:A:h:h:h}
cd "$QB" || exit 2
ITEMS=(S1-slug S2-formatter S3-percent S4-parsebool S5-clock S6-money U1-userrepo U2-roundto)
MODEL=qwen2.5-coder:14b

[[ "$(git rev-parse HEAD)" == "$EXPECTED_SHA" ]] || { print "✗ QB is at $(git rev-parse HEAD), not $EXPECTED_SHA. Nothing was run."; exit 2; }
[[ -z "$(git status --porcelain)" ]] || { print "✗ the QB checkout has local changes. Nothing was run."; exit 2; }
node bench/kan106-eval-v1/check-freeze.js || { print "Nothing was run."; exit 2; }
curl -s -m 3 http://127.0.0.1:11434/api/tags | grep -q "\"$MODEL\"" || { print "✗ Ollama is not running or $MODEL is missing. Nothing was run."; exit 2; }

OUT=~/qb-evidence/kan106-eval-v1/$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$OUT/logs" || exit 2
node bench/kan106-eval-v1/materialize.js "$OUT/repos" > "$OUT/base-shas.json" || { print "✗ materialize failed. Nothing was run."; exit 2; }
node bench/kan106-eval-v1/check-freeze.js --base-shas "$OUT/base-shas.json" || { print "Nothing was run."; exit 2; }
curl -s -m 3 http://127.0.0.1:11434/api/tags > "$OUT/ollama-tags.json"
print "{\"qb_revision\": \"$EXPECTED_SHA\", \"model\": \"$MODEL\", \"started_utc\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" > "$OUT/batch.json"

print "Running ${#ITEMS} items once each, in order. Output: $OUT"
typeset -A RUNS
for id in $ITEMS; do
  print -n "  $id ... "
  QB_MODEL=$MODEL node qb.js "$(cat bench/kan106-eval-v1/items/$id/request.txt)" --repo "$OUT/repos/$id" --agent dry-run --no-llm-context --l1-profile qwen-14b-staged --deadline 15 > "$OUT/logs/$id.log" 2>&1
  code=$?
  run=$(grep -o -m1 '\[RUN\]  [0-9a-f-]\{36\}' "$OUT/logs/$id.log" | awk '{print $2}')
  RUNS[$id]=$run
  print "exit $code, run ${run:-none}"
done

PAIRS=()
for id in $ITEMS; do PAIRS+=("$id=${RUNS[$id]}"); done
node -e 'const o={}; for (const a of process.argv.slice(1)) { const [k, v] = a.split("="); o[k] = v || null; } process.stdout.write(JSON.stringify(o, null, 2) + "\n")' $PAIRS > "$OUT/runs.json"
node bench/kan106-eval-v1/score.js --runs "$OUT/runs.json" --out "$OUT/scores.json" && print "Scores: $OUT/scores.json (semantic review still pending)"
print "Done. Nothing is retried. Send the junior the folder name: $OUT"
