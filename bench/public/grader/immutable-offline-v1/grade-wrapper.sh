#!/bin/bash
# KAN-111 PROPOSAL (not run; awaiting review). Offline grading wrapper for the two immutable-js tasks.
# It does NOT modify the official SWE-bench Multilingual eval script: it records the environment the
# script sees, then runs the official script VERBATIM (variant A0) or the single-line adapted copy (A1),
# inside the official image (pinned by digest) with --network none.
#   $1 = path to the eval script to run (official, or the reviewed A1 copy)
# Output markers are additive and outside the official ">>>>> Start/End Test Output" section.
set -u
echo "QBX_ENV_BEGIN"
echo "CI=${CI-<unset>}"
echo "node=$(node -v) npm=$(npm -v) arch=$(uname -m)"
cd /testbed && node -e '
  const r = require("./resources/jestResolver.js");
  const t = r("immutable", { rootDir: "/testbed", defaultResolver: () => "default" });
  console.log("jest_resolves_immutable_to=" + t);'
echo "tested_tree_head=$(git -C /testbed rev-parse HEAD) tested_tree_diff_sha256=$(git -C /testbed diff | sha256sum | cut -c1-64)"
echo "QBX_ENV_END"
bash "$1"
echo "QBX_EVAL_EXIT=$?"
