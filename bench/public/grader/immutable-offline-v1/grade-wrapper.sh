#!/bin/bash
# KAN-111 offline grading wrapper (immutable-offline-v1). Records the environment the eval script sees,
# runs the chosen eval script (official or reviewed A1 copy) unmodified, and exits WITH ITS STATUS
# (review 10551: a trailing echo must not mask it). A nonzero Jest exit on an empty candidate is expected;
# exit 97 is the A1 build gate (a required build step failed: never a qualified replay).
#   $1 = path to the eval script
set -u
echo "QBX_ENV_BEGIN"
echo "CI=${CI-<unset>}"
echo "node=$(node -v) npm=$(npm -v) arch=$(uname -m)"
cd /testbed && node -e '
  const r = require("./resources/jestResolver.js");
  console.log("jest_resolves_immutable_to=" + r("immutable", { rootDir: "/testbed", defaultResolver: () => "default" }));'
echo "QBX_ENV_END"
bash "$1"
ec=$?
echo "QBX_EVAL_EXIT=$ec"
exit $ec
