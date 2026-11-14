"""KAN-111 installed-harness smoke (review 10559). Runs in the grade job AFTER the locked install and BEFORE any
Docker replay. Fully synthetic: made-up test names and logs, no task material.

Checks that the installed, pinned harness:
  1. exposes the functions grade_report.py uses (get_logs_eval, get_eval_tests_report, get_resolution_status,
     PARSER_REGISTRY) and the immutable-js parser routing (2006 -> verbose Jest, 2005 -> Jest JSON lines);
  2. parses both formats as the reviewed source does;
  3. resolves a synthetic report to RESOLVED_FULL / RESOLVED_NO.
Exit 0 = all checks passed; any failure raises (non-zero exit). Prints one line per check.
"""
from types import SimpleNamespace

from swebench.harness.grading import get_eval_tests_report, get_logs_eval, get_resolution_status  # noqa: F401 (import is the check)
from swebench.harness.log_parsers import PARSER_REGISTRY
from swebench.harness.log_parsers.javascript import parse_log_immutable_js

assert callable(get_logs_eval)
print("ok   grading functions import")

spec = lambda pr: SimpleNamespace(instance_id=f"immutable-js__immutable-js-{pr}")  # noqa: E731

verbose = "\n".join([
    "  smoke suite",
    "    ✓ alpha works (3 ms)",
    "    ✕ beta breaks (12 ms)",
    "    ○ gamma is skipped",
])
m = parse_log_immutable_js(verbose, spec("2006"))
assert m == {"alpha works": "PASSED", "beta breaks": "FAILED", "gamma is skipped": "SKIPPED"}, m
print("ok   2006 routes to the verbose Jest parser")

jsonl = "\n".join(["[PASSED] smoke suite alpha works", "[FAILED] smoke suite beta breaks", "[PENDING] smoke suite gamma"])
m = parse_log_immutable_js(jsonl, spec("2005"))
assert m == {"smoke suite alpha works": "PASSED", "smoke suite beta breaks": "FAILED"}, m
print("ok   2005 routes to the Jest JSON-line parser (PENDING is not a result)")

try:
    parse_log_immutable_js(verbose, spec("9999"))
    raise AssertionError("an unknown instance must raise")
except ValueError:
    print("ok   unknown immutable-js instance is refused")

assert PARSER_REGISTRY["parse_log_immutable_js"] is parse_log_immutable_js, "registry key grade_report.py uses is missing"
print("ok   PARSER_REGISTRY['parse_log_immutable_js'] is the reviewed parser (the key grade_report.py uses)")

gold = {"FAIL_TO_PASS": ["alpha works"], "PASS_TO_PASS": ["delta stays"]}
full = get_resolution_status(get_eval_tests_report({"alpha works": "PASSED", "delta stays": "PASSED"}, gold))
none = get_resolution_status(get_eval_tests_report({"alpha works": "FAILED", "delta stays": "PASSED"}, gold))
assert (full, none) == ("RESOLVED_FULL", "RESOLVED_NO"), (full, none)
print("ok   synthetic report resolves RESOLVED_FULL / RESOLVED_NO")
