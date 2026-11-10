#!/bin/bash
# KAN-111 instrumentation (separately versioned and hashed; NOT part of the official eval script).
#   bash /qbx-boundary.sh start    -> before any patch: baseline, including the node_modules digest
#   bash /qbx-boundary.sh tested   -> from the instrumented eval script, immediately before the official test
#                                     command (`... || exit 98`): the exact tree Jest is about to run on
#   bash /qbx-boundary.sh final    -> after the eval script has finished
# Writes a complete content manifest to $QBX_TMP/qbx-<mode>.txt: "sha256  ./path" for every regular file
# and "symlink ./path -> target" for every symlink under the root, excluding .git and node_modules; and
# prints its hash, its entry count, the tamper-marker count in the official test files, and a content
# digest of node_modules (checked by the runner to be unchanged between start and the test boundary).
# FAILS CLOSED (review 10554): any error exits non-zero and prints nothing that could pass as evidence.
set -euo pipefail
mode="${1:-}"
case "$mode" in start|tested|final) ;; *) echo "qbx-boundary: unknown mode '$mode'" >&2; exit 2 ;; esac
root="${QBX_ROOT:-/testbed}"; tmp="${QBX_TMP:-/tmp}"
cd "$root"
out="$tmp/qbx-${mode}.txt"; part="$out.partial"; : > "$part"

# Regular files (errors propagate: an unreadable file fails the whole manifest)
while IFS= read -r -d '' f; do
  sha256sum -- "$f" >> "$part"
done < <(find . \( -path ./node_modules -o -path ./.git \) -prune -o -type f -print0 | LC_ALL=C sort -z)
# Symlinks are recorded with their target, never silently omitted
while IFS= read -r -d '' l; do
  printf 'symlink %s -> %s\n' "$l" "$(readlink -- "$l")" >> "$part"
done < <(find . \( -path ./node_modules -o -path ./.git \) -prune -o -type l -print0 | LC_ALL=C sort -z)

# node_modules content digest (paths + content hashes), or an explicit "absent"
if [ -d node_modules ]; then
  nm=$( (cd node_modules && find . \( -type f -o -type l \) -print0 | LC_ALL=C sort -z | while IFS= read -r -d '' f; do
          if [ -L "$f" ]; then printf 'symlink %s -> %s\n' "$f" "$(readlink -- "$f")"; else sha256sum -- "$f"; fi
        done) | sha256sum | cut -c1-64)
else
  nm="absent"
fi

markers=0
for f in __tests__/*.ts __tests__/*.js; do
  [ -e "$f" ] || continue
  n=$(grep -c 'KAN-111 tamper marker' -- "$f" || true); markers=$((markers + n))
done

mv -- "$part" "$out"
up=$(printf '%s' "$mode" | tr '[:lower:]' '[:upper:]')
echo "QBX_${up}_SHA256=$(sha256sum -- "$out" | cut -c1-64)"
echo "QBX_${up}_FILES=$(wc -l < "$out" | tr -d ' ')"
echo "QBX_${up}_MARKER_COUNT=${markers}"
echo "QBX_${up}_NODE_MODULES_SHA256=${nm}"
