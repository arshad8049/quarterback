#!/bin/sh
# deps-root-scripts-v1 (KAN-117 review 10620): research-only, opt-in. Runs in the UNCHANGED trusted tools image only
# after deps-plan.sh refused the project for ROOT lifecycle scripts (so every earlier deps-plan check passed: package.json,
# lockfile v2/3, no workspaces, no file:/link:/git dependencies). It accepts the base only if (base tree, package.json
# sha256, exact set of root lifecycle script names) matches a reviewed entry in QB_ROOT_SCRIPTS_ALLOW; anything else
# still refuses. It then writes the disposable install copy (/scratch) from the base and removes exactly those root
# scripts from THAT copy's package.json. The base in git — what the agent, QB's verifier and the grader get — keeps
# the original package.json and lockfile. Dependency lifecycle scripts are NOT affected: npm ci still runs them,
# contained as before (DEPS proxy, no credentials); this does not claim that no repository code can run.
#   /git      trusted GIT_DIR (read-write: plan output)        QB_GIT overrides (tests)
#   /scratch  empty scratch volume (receives the install copy)  QB_SCRATCH overrides (tests)
set -eu
G=${QB_GIT:-/git}; S=${QB_SCRATCH:-/scratch}
. "${QB_GIT_ENV:-/usr/local/lib/qb/git-env.sh}"
export GIT_DIR="$G/repo"
out() { printf '%s\n' "$1" > "$G/deps-plan.json"; echo "$1"; exit 0; }
refuse() { out "{\"status\":\"blocked\",\"reason\":\"setup_unsupported_project\",\"detail\":\"root lifecycle script(s) not in the reviewed allowlist (deps-root-scripts-v1): $1\"}"; }

tgit cat-file -p refs/qb/base:package.json > /tmp/qbrs-package.json || refuse 'no package.json'
TREE=$(tgit rev-parse 'refs/qb/base^{tree}')
PSHA=$(sha256sum /tmp/qbrs-package.json | cut -c1-64)
SCRIPTS=$(jq -r '[.scripts // {} | keys[] | select(IN("preinstall","install","postinstall","prepublish","preprepare","prepare","postprepare"))] | sort | join(",")' /tmp/qbrs-package.json)
[ -n "$SCRIPTS" ] || refuse 'no root lifecycle scripts'
MATCH=$(printf '%s' "${QB_ROOT_SCRIPTS_ALLOW:-[]}" | jq -c --arg t "$TREE" --arg p "$PSHA" --arg s "$SCRIPTS" \
  '[.[] | select(.rule == "deps-root-scripts-v1" and .base_tree == $t and .package_json_sha256 == $p and ((.removed | sort | join(",")) == $s))] | first // empty')
[ -n "$MATCH" ] || refuse "$SCRIPTS"
REMOVED=$(printf '%s' "$MATCH" | jq -c '.removed | sort')

manifest_fp refs/qb/base > /tmp/qbrs-fp
tgit -c core.bare=false --work-tree="$S" checkout -f refs/qb/base -- .
jq --argjson r "$REMOVED" '.scripts |= with_entries(select(.key as $k | ($r | index($k)) == null))' "$S/package.json" > /tmp/qbrs-install.json
cat /tmp/qbrs-install.json > "$S/package.json"
TSHA=$(sha256sum "$S/package.json" | cut -c1-64)
( cd "$S" && find . -path ./node_modules -prune -o \( -type f -o -type l \) -print0 | sort -z | xargs -0 -r sha256sum ) > "$G/deps-snapshot.txt"
out "{\"status\":\"ready\",\"manifest_fp\":\"$(cat /tmp/qbrs-fp)\",\"root_scripts\":{\"rule\":\"deps-root-scripts-v1\",\"key\":$(printf '%s' "$MATCH" | jq -c .key),\"removed\":$REMOVED,\"base_tree\":\"$TREE\",\"original_package_json_sha256\":\"$PSHA\",\"install_manifest_sha256\":\"$TSHA\"}}"
