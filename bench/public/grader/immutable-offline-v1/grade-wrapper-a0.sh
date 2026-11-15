#!/bin/bash
# KAN-111 offline grading wrapper, A0 copy for the arm-A batch tasks (no immutable-js resolver probe). Records the environment the eval script sees,
# runs the chosen eval script (official or reviewed A1 copy) unmodified, and exits WITH ITS STATUS
# (review 10551: a trailing echo must not mask it). A nonzero Jest exit on an empty candidate is expected;
# exit 97 is the A1 build gate (a required build step failed: never a qualified replay).
#   $1 = path to the eval script
set -u
echo "QBX_ENV_BEGIN"
echo "CI=${CI-<unset>}"
echo "node=$(node -v) npm=$(npm -v) arch=$(uname -m)"
echo "QBX_ENV_END"
bash "$1"
ec=$?
echo "QBX_EVAL_EXIT=$ec"
exit $ec
