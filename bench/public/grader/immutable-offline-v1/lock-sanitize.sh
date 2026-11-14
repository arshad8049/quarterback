#!/bin/bash
# KAN-111 lock-phase sanitizer. Runs BEFORE any upload; the upload step only runs if this exits 0.
# Verifies that the lock output directory holds exactly the allowlisted files, each small, plain text,
# and free of secret-like strings. Anything else fails closed.
set -euo pipefail
dir="${1:?usage: lock-sanitize.sh <lock-dir>}"
allow=(requirements.lock dists.sha256 harness-files.sha256 archive.sha256 env.txt build-notes.txt)
cd "$dir"
# 1. exactly the allowlist: no extra files, no directories, no symlinks
extra=$(find . -mindepth 1 \( -type d -o -type l \) -print; find . -mindepth 1 -type f -print | sed 's|^\./||' | while IFS= read -r f; do
  ok=0; for a in "${allow[@]}"; do [ "$f" = "$a" ] && ok=1; done; [ "$ok" = 1 ] || echo "$f"; done)
if [ -n "$extra" ]; then echo "::error::not allowlisted: $extra"; exit 1; fi
for a in "${allow[@]}"; do [ -f "$a" ] || { echo "::error::missing $a"; exit 1; }; done
# 2. small plain text only
for a in "${allow[@]}"; do
  [ "$(wc -c < "$a")" -le 262144 ] || { echo "::error::$a too large"; exit 1; }
  if LC_ALL=C grep -q '[^[:print:][:space:]]' "$a"; then echo "::error::$a is not plain text"; exit 1; fi
done
# 3. secret-like strings
if grep -IEn '(ghp_|gho_|ghs_|ghu_|github_pat_|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY|sk-ant-|xox[abprs]-|Authorization:|password=)' "${allow[@]}"; then
  echo "::error::secret-like string"; exit 1
fi
# 4. no grading material (lock output must never contain task data)
if grep -IEln '(FAIL_TO_PASS|PASS_TO_PASS|diff --git|immutable-js)' "${allow[@]}"; then echo "::error::task material in lock output"; exit 1; fi
echo "sanitize ok: ${allow[*]}"
