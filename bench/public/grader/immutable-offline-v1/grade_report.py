#!/usr/bin/env python3
"""
KAN-111 (immutable-offline-v1): grade one run's test output with the PINNED SWE-bench harness code
(SWE-bench/SWE-bench @ 02e7a74ffd0b707aab73d203fe87bdc7c76afc8e), plus additive strict checks and a
mode-aware acceptance gate (reviews 10549, 10551). The official result is reported unchanged.

usage: grade_report.py <instance_id> <test_output.txt> <required.json> <out.json> <mode: empty|gold>
  required.json = {"FAIL_TO_PASS": [...], "PASS_TO_PASS": [...]}  (from the grader vault; never agent-visible)
exit: 0 = graded (accepted or not: read acceptance.accepted); 3 = infrastructure error (harness/API/log);
      2 = bad usage.
"""
import json
import re
import sys
from types import SimpleNamespace

if len(sys.argv) != 6 or sys.argv[5] not in ("empty", "gold"):
    print("usage: grade_report.py <instance_id> <log> <required.json> <out.json> <empty|gold>", file=sys.stderr)
    sys.exit(2)
instance_id, log_fp, req_fp, out_fp, mode = sys.argv[1:6]
out = {"instance_id": instance_id, "mode": mode, "harness": "SWE-bench@02e7a74ffd0b707aab73d203fe87bdc7c76afc8e",
       "official": None, "strict": None, "acceptance": None}


def infra(msg):
    out["infra_error"] = msg
    json.dump(out, open(out_fp, "w"), indent=2)
    print(json.dumps({"infra_error": msg}))
    sys.exit(3)


try:
    from swebench.harness.constants import END_TEST_OUTPUT, FAIL_TO_PASS, PASS_TO_PASS, START_TEST_OUTPUT
    from swebench.harness.grading import get_eval_tests_report, get_logs_eval, get_resolution_status
    required = json.load(open(req_fp))
    log = open(log_fp, encoding="utf-8", errors="replace").read()
except Exception as e:
    infra(f"setup: {type(e).__name__}: {e}")

spec = SimpleNamespace(instance_id=instance_id, repo="immutable-js/immutable-js", FAIL_TO_PASS=required[FAIL_TO_PASS],
                       PASS_TO_PASS=required[PASS_TO_PASS], log_parser="parse_log_immutable_js")  # registry key, as in the harness

# ── Official path: the harness's own log gate, parser and report (unchanged) ──
try:
    status_map, found = get_logs_eval(spec, log_fp)
    if found:
        report = get_eval_tests_report(status_map, {FAIL_TO_PASS: required[FAIL_TO_PASS], PASS_TO_PASS: required[PASS_TO_PASS]})
        out["official"] = {"log_gate": "ok", "resolution": get_resolution_status(report), "report": report}
    else:
        out["official"] = {"log_gate": "failed (patch/test error codes or missing Start/End markers)", "resolution": None}
except Exception as e:  # a harness API mismatch must surface, never be guessed around
    infra(f"harness: {type(e).__name__}: {e}")

# ── Diagnostics (review 10568): counts and booleans only, never names or log text ──
_RESULT = re.compile(r"^(\[(PASSED|FAILED|PENDING|TODO|SKIPPED)\]\s|(✓|✕|○|✎)\s)")
_count = lambda t: sum(1 for l in t.split("\n") if _RESULT.match(l.strip()))
_has = START_TEST_OUTPUT in log and END_TEST_OUTPUT in log
out["diagnostics"] = {
    "start_marker": START_TEST_OUTPUT in log, "end_marker": END_TEST_OUTPUT in log,
    "section_result_lines": _count(log.split(START_TEST_OUTPUT, 1)[1].split(END_TEST_OUTPUT, 1)[0]) if _has else 0,
    "whole_log_result_lines": _count(log),
    "official_status_map_entries": len(status_map) if found else 0,
}

# ── Strict, additive view: every raw result line in the official test section counts, whatever its status ──
section = log.split(START_TEST_OUTPUT, 1)[1].split(END_TEST_OUTPUT, 1)[0] if (START_TEST_OUTPUT in log and END_TEST_OUTPUT in log) else ""
raw = []  # (key, status)
if instance_id.rsplit("-", 1)[-1] == "2006":   # parse_log_jest (--verbose): leaf title on a ✓/✕/○/✎ line
    sym = {"✓": "passed", "✕": "failed", "○": "skipped", "✎": "todo"}
    for l in section.split("\n"):
        m = re.match(r"^\s*(✓|✕|○|✎)\s(.+?)(?:\s\((\d+\s*m?s)\))?$", l.strip())
        if m:
            raw.append((m.group(2).strip(), sym[m.group(1)]))
else:                                          # parse_log_jest_json: "[STATUS] ancestors > title", ALL statuses counted
    for l in section.split("\n"):
        m = re.match(r"^\[([A-Z]+)\]\s(.+)$", l.strip())
        if m:
            st = m.group(1).lower()
            raw.append((m.group(2), {"pending": "skipped"}.get(st, st)))
by_key = {}
for k, st in raw:
    by_key.setdefault(k, []).append(st)

strict = {"raw_result_lines": len(raw), "required": {}}
for kind in (FAIL_TO_PASS, PASS_TO_PASS):
    rows = []
    for name in required[kind]:
        sts = by_key.get(name, [])
        if not sts:
            verdict = "missing"
        elif len(sts) > 1:
            verdict = "ambiguous"     # more than one raw result line (any statuses): the parser's dict would collapse them
        elif sts[0] in ("passed", "failed", "skipped", "todo"):
            verdict = sts[0]
        else:
            verdict = f"unknown:{sts[0]}"
        rows.append({"index": len(rows), "occurrences": len(sts), "raw_statuses": sts,
                     "parsed_status": (status_map or {}).get(name) if found else None, "strict": verdict})
    strict["required"][kind] = {"total": len(rows), "rows": rows,  # by index into the vault list; names stay in the vault
                                "counts": {v: sum(1 for r in rows if r["strict"] == v) for v in sorted({r["strict"] for r in rows})}}
# Structural only (every required identity has exactly one raw result line). NOT the acceptance decision.
strict["structural_present_and_unique"] = all(r["occurrences"] == 1 for kind in (FAIL_TO_PASS, PASS_TO_PASS) for r in strict["required"][kind]["rows"])
out["strict"] = strict

# ── Acceptance gate (mode-aware): official gate + resolution, and EACH required identity as expected ──
reasons = []
off = out["official"] or {}
if off.get("log_gate") != "ok":
    reasons.append("official log gate failed")
expected_resolution = "RESOLVED_NO" if mode == "empty" else "RESOLVED_FULL"
if off.get("resolution") != expected_resolution:
    reasons.append(f"official resolution {off.get('resolution')!r}, expected {expected_resolution!r}")
expect = {FAIL_TO_PASS: "failed" if mode == "empty" else "passed", PASS_TO_PASS: "passed"}
for kind in (FAIL_TO_PASS, PASS_TO_PASS):
    for r in strict["required"][kind]["rows"]:
        if r["strict"] != expect[kind]:
            reasons.append(f"{kind}[{r['index']}]: expected {expect[kind]}, got {r['strict']}")
out["acceptance"] = {"mode": mode, "accepted": not reasons, "reasons": reasons}
json.dump(out, open(out_fp, "w"), indent=2)
print(json.dumps({"mode": mode, "accepted": not reasons, "official": off.get("resolution"), "reasons": reasons[:5]}))
