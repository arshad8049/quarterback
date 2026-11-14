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
#
# FAILS CLOSED (reviews 10554, 10557): every enumeration is an ordinary, checked command writing to a file
# (no process substitution, whose exit status bash ignores); hashes are read from those files in loops whose
# failures stop the script; a grep read error (exit >= 2) is an error, only exit 1 means "no marker"; paths
# containing a newline are refused; the entry count is checked against the enumerations before anything is
# printed. On any failure nothing is printed to stdout and no finished manifest is left behind.
set -euo pipefail
shopt -s inherit_errexit 2>/dev/null || true   # bash >= 4.4; every step is also checked explicitly
mode="${1:-}"
case "$mode" in start|tested|final) ;; *) echo "qbx-boundary: unknown mode '$mode'" >&2; exit 2 ;; esac
root="${QBX_ROOT:-/testbed}"; tmp="${QBX_TMP:-/tmp}"
out="$tmp/qbx-${mode}.txt"; work="$tmp/qbx-${mode}.work"
rm -rf -- "$work" "$out"; mkdir -- "$work"
fail() { echo "qbx-boundary: $*" >&2; rm -rf -- "$work"; exit 3; }
trap 'rm -rf -- "$work"' EXIT
cd "$root"

# Count NUL-terminated entries in a list file
count0() { tr -cd '\0' < "$1" | wc -c | tr -d ' '; }
# Refuse any path containing a newline (the manifest format is one entry per line)
no_newlines() { local n; n=$(tr -cd '\n' < "$1" | wc -c | tr -d ' ') || fail "list check failed"; [ "$n" = 0 ] || fail "a path contains a newline ($2)"; }

# 1. Enumerate (checked: a find error stops the script here)
find . \( -path ./node_modules -o -path ./.git \) -prune -o -type f -print0 > "$work/files.raw" || fail "file enumeration failed"
find . \( -path ./node_modules -o -path ./.git \) -prune -o -type l -print0 > "$work/links.raw" || fail "symlink enumeration failed"
LC_ALL=C sort -z -o "$work/files" "$work/files.raw" || fail "sort failed"
LC_ALL=C sort -z -o "$work/links" "$work/links.raw" || fail "sort failed"
no_newlines "$work/files" files; no_newlines "$work/links" symlinks

# 2. Hash from the lists (a failed read stops the script)
: > "$work/manifest"
while IFS= read -r -d '' f; do
  h=$(sha256sum -- "$f") || fail "cannot read $f"
  printf '%s\n' "$h" >> "$work/manifest"
done < "$work/files"
while IFS= read -r -d '' l; do
  t=$(readlink -- "$l") || fail "cannot read link $l"
  case "$t" in *$'\n'*) fail "a link target contains a newline" ;; esac
  printf 'symlink %s -> %s\n' "$l" "$t" >> "$work/manifest"
done < "$work/links"

# 3. The entry count must equal what was enumerated
expected=$(( $(count0 "$work/files") + $(count0 "$work/links") ))
actual=$(wc -l < "$work/manifest" | tr -d ' ')
[ "$expected" = "$actual" ] || fail "entry count mismatch (enumerated $expected, wrote $actual)"
[ "$actual" -gt 0 ] || fail "empty manifest"

# 4. node_modules content digest (paths + content hashes), or an explicit "absent"
if [ -d node_modules ]; then
  (cd node_modules && find . \( -type f -o -type l \) -print0) > "$work/nm.raw" || fail "node_modules enumeration failed"
  LC_ALL=C sort -z -o "$work/nm" "$work/nm.raw" || fail "sort failed"
  no_newlines "$work/nm" node_modules
  : > "$work/nm.manifest"
  while IFS= read -r -d '' f; do
    if [ -L "node_modules/$f" ]; then
      t=$(readlink -- "node_modules/$f") || fail "cannot read link node_modules/$f"
      printf 'symlink %s -> %s\n' "$f" "$t" >> "$work/nm.manifest"
    else
      h=$(cd node_modules && sha256sum -- "$f") || fail "cannot read node_modules/$f"
      printf '%s\n' "$h" >> "$work/nm.manifest"
    fi
  done < "$work/nm"
  [ "$(count0 "$work/nm")" = "$(wc -l < "$work/nm.manifest" | tr -d ' ')" ] || fail "node_modules entry count mismatch"
  nm=$(sha256sum < "$work/nm.manifest" | cut -c1-64) || fail "node_modules digest failed"
else
  nm="absent"
fi

# 5. Tamper markers in the official test files: grep exit 1 = no match (0); exit >= 2 = read error
markers=0
for f in __tests__/*.ts __tests__/*.js; do
  [ -e "$f" ] || continue
  rc=0; n=$(grep -c -- 'KAN-111 tamper marker' "$f") || rc=$?
  case "$rc" in 0) ;; 1) n=0 ;; *) fail "cannot read $f for the marker count (grep exit $rc)" ;; esac
  markers=$((markers + n))
done

# 6. Publish: the manifest appears only now, then the values are printed
digest=$(sha256sum < "$work/manifest" | cut -c1-64) || fail "manifest digest failed"
mv -- "$work/manifest" "$out"
up=$(printf '%s' "$mode" | tr '[:lower:]' '[:upper:]')
printf 'QBX_%s_SHA256=%s\nQBX_%s_FILES=%s\nQBX_%s_MARKER_COUNT=%s\nQBX_%s_NODE_MODULES_SHA256=%s\n' \
  "$up" "$digest" "$up" "$actual" "$up" "$markers" "$up" "$nm"
