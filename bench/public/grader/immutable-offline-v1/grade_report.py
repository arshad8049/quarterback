#!/usr/bin/env python3
"""
KAN-111 (immutable-offline-v1): grade one run's test output with the PINNED SWE-bench harness code
(SWE-bench/SWE-bench @ 02e7a74ffd0b707aab73d203fe87bdc7c76afc8e), plus additive strict checks
required by KAN-110 review 10549. The official result is never altered; strict findings are reported beside it.

usage: grade_report.py <instance_id> <test_output.txt> <required.json> <out.json>
  required.json = {"FAIL_TO_PASS": [...], "PASS_TO_PASS": [...]}  (from the grader vault; never agent-visible)
"""
import json
import re
import sys
from types import SimpleNamespace

from swebench.harness.constants import END_TEST_OUTPUT, FAIL_TO_PASS, PASS_TO_PASS, START_TEST_OUTPUT
from swebench.harness.grading import get_eval_tests_report, get_logs_eval, get_resolution_status
from swebench.harness.log_parsers.javascript import parse_log_immutable_js

instance_id, log_fp, req_fp, out_fp = sys.argv[1:5]
required = json.load(open(req_fp))
spec = SimpleNamespace(instance_id=instance_id, repo="immutable-js/immutable-js", FAIL_TO_PASS=required[FAIL_TO_PASS],
                       PASS_TO_PASS=required[PASS_TO_PASS], log_parser="parse_log_immutable_js")  # registry key, as in the harness

out = {"instance_id": instance_id, "harness": "SWE-bench@02e7a74ffd0b707aab73d203fe87bdc7c76afc8e", "official": None, "strict": None}

# ── Official path: the harness's own log gate, parser and report ──
try:
    status_map, found = get_logs_eval(spec, log_fp)
except Exception as e:  # a harness API mismatch must surface, never be guessed around
    out["official"] = {"error": f"get_logs_eval failed: {type(e).__name__}: {e}"}
    json.dump(out, open(out_fp, "w"), indent=2)
    sys.exit(2)
if not found:
    out["official"] = {"log_gate": "failed (patch/test error codes or missing Start/End markers)", "resolution": None}
else:
    report = get_eval_tests_report(status_map, {FAIL_TO_PASS: required[FAIL_TO_PASS], PASS_TO_PASS: required[PASS_TO_PASS]})
    out["official"] = {"log_gate": "ok", "resolution": get_resolution_status(report), "report": report}

# ── Strict, additive checks (review 10549) ──
log = open(log_fp, encoding="utf-8", errors="replace").read()
section = log.split(START_TEST_OUTPUT, 1)[1].split(END_TEST_OUTPUT, 1)[0] if (START_TEST_OUTPUT in log and END_TEST_OUTPUT in log) else ""
pr = instance_id.rsplit("-", 1)[-1]
if pr == "2006":   # parse_log_jest (--verbose): key = leaf title on a ✓/✕/○ line
    line_re = re.compile(r"^\s*(✓|✕|○)\s(.+?)(?:\s\((\d+\s*m?s)\))?$")
    keys = [m.group(2).strip() for m in (line_re.match(l.strip()) for l in section.split("\n")) if m]
    not_run = set()
else:              # parse_log_jest_json (jq transform): "[STATUS] ancestors > title". The official parser keeps only
    #                PASSED/FAILED lines; PENDING/TODO/SKIPPED lines are recorded here as not-run, never as results.
    line_re = re.compile(r"^\[([A-Z]+)\]\s(.+)$")
    hits = [m for m in (line_re.match(l.strip()) for l in section.split("\n")) if m]
    keys = [m.group(2) for m in hits if m.group(1) in ("PASSED", "FAILED")]
    not_run = {m.group(2) for m in hits if m.group(1) not in ("PASSED", "FAILED")}
occ = {}
for k in keys:
    occ[k] = occ.get(k, 0) + 1
strict = {"raw_result_lines": len(keys), "required": {}}
for kind in (FAIL_TO_PASS, PASS_TO_PASS):
    rows = []
    for name in required[kind]:
        n = occ.get(name, 0)
        st = (status_map or {}).get(name) if found else None
        if n == 0 and name in not_run:
            verdict = "skipped"            # seen only as PENDING/TODO/SKIPPED (official: missing = failure); never a pass
        elif n == 0:
            verdict = "missing"            # official harness counts this as a failure; reported distinctly here
        elif n > 1:
            verdict = "ambiguous"          # the parser's dict collapsed n raw results into one: never a pass
        elif st == "PASSED":
            verdict = "passed"
        elif st == "SKIPPED":
            verdict = "skipped"            # official P2P treats skipped as maintained; strict: never a pass
        else:
            verdict = "failed" if st == "FAILED" else f"other:{st}"
        rows.append({"index": len(rows), "occurrences": n, "parsed_status": st, "strict": verdict})
    strict["required"][kind] = {
        "total": len(rows),
        "counts": {v: sum(1 for r in rows if r["strict"] == v) for v in sorted({r["strict"] for r in rows})},
        "rows": rows,  # by index into the vault list; names stay in the vault
    }
f2p = strict["required"][FAIL_TO_PASS]["counts"]; p2p = strict["required"][PASS_TO_PASS]["counts"]
strict["all_required_unambiguous_and_present"] = not any(k in f2p or k in p2p for k in ("missing", "ambiguous"))
out["strict"] = strict
json.dump(out, open(out_fp, "w"), indent=2)
print(json.dumps({"official": (out["official"] or {}).get("resolution"), "log_gate": (out["official"] or {}).get("log_gate"),
                  "strict_f2p": f2p, "strict_p2p": p2p, "unambiguous_present": strict["all_required_unambiguous_and_present"]}))
