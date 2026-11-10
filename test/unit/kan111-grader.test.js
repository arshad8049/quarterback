/**
 * KAN-111 (immutable-offline-v1): the grader's own logic, tested without Docker and without the external
 * SWE-bench package. The official harness functions are replaced by a minimal stand-in written here, so
 * these tests check only QB's additions: the A0/A1 eval-script handling and the strict checks
 * (missing / ambiguous / skipped required tests, malformed logs). The real pinned harness runs only in
 * the reviewed KAN-111 execution.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const DIR = path.join(__dirname, '..', '..', 'bench', 'public', 'grader', 'immutable-offline-v1');
const load = () => import(path.join(DIR, 'grade.mjs'));
const OFFICIAL = 'set -uxo pipefail\ncd /testbed\ngit apply -v - <<\'EOF_1\'\nX\nEOF_1\nnpm run build\n: \'>>>>> Start Test Output\'\n(npx jest __tests__/Range.ts --verbose) | cat\n: \'>>>>> End Test Output\'\n';

describe('KAN-111 eval-script variants', () => {
  test('A0 is the official script verbatim', async () => {
    const { evalScript, TASKS } = await load();
    assert.equal(evalScript(OFFICIAL, TASKS[2006], 'A0'), OFFICIAL);
  });
  test('A1 replaces only the single `npm run build` line', async () => {
    const { evalScript, TASKS } = await load();
    const a1 = evalScript(OFFICIAL, TASKS[2006], 'A1');
    const o = OFFICIAL.split('\n'); const n = a1.split('\n');
    assert.equal(n.length, o.length);
    const changed = o.map((l, i) => (l !== n[i] ? i : -1)).filter((i) => i >= 0);
    assert.deepEqual(changed, [o.indexOf('npm run build')]);
    assert.equal(n[changed[0]], `if ! ( ${TASKS[2006].a1_build} ); then echo '>>>>> QBX Build Failed'; exit 97; fi`, 'A1 refuses to test after any required build step fails');
    assert.ok(!/build:stats/.test(a1));
  });
  test('A1 refuses a script without exactly one build line, and unknown variants', async () => {
    const { evalScript, TASKS } = await load();
    assert.throws(() => evalScript(OFFICIAL.replace('npm run build\n', ''), TASKS[2006], 'A1'), /exactly one/);
    assert.throws(() => evalScript(OFFICIAL + 'npm run build\n', TASKS[2006], 'A1'), /exactly one/);
    assert.throws(() => evalScript(OFFICIAL, TASKS[2006], 'B'), /unknown variant/);
  });
  test('instrumentation adds exactly one test-boundary line before the Start marker, separately from A1', async () => {
    const { evalScript, TASKS } = await load();
    const a1 = evalScript(OFFICIAL, TASKS[2006], 'A1'); const a1i = evalScript(OFFICIAL, TASKS[2006], 'A1', { instrument: true });
    const x = a1.split('\n'); const y = a1i.split('\n');
    assert.equal(y.length, x.length + 1);
    const at = x.findIndex((l) => l.includes('>>>>> Start Test Output'));
    assert.equal(y[at], 'bash /qbx-boundary.sh tested');
    assert.deepEqual([...y.slice(0, at), ...y.slice(at + 1)], x);
    assert.throws(() => evalScript(OFFICIAL.replace(": '>>>>> Start Test Output'\n", ''), TASKS[2006], 'A1', { instrument: true }), /Start Test Output/);
  });
  test('pinned identities are exact', async () => {
    const { TASKS, H } = await load();
    for (const t of Object.values(TASKS)) { assert.match(t.image, /@sha256:[0-9a-f]{64}$/); assert.match(t.eval_sha256, /^[0-9a-f]{64}$/); }
    assert.deepEqual(H.applyCmds, ['git apply --verbose', 'git apply --verbose --3way', 'git apply --verbose --reject', 'patch --batch --forward --fuzz=5 -p1 -i']);
    assert.equal(H.user, 'root'); assert.equal(H.workdir, '/testbed');
  });
});

// Minimal stand-in for the three harness modules grade_report.py imports (behaviour of the pinned parsers:
// verbose ✓/✕/○ keyed by leaf title; JSON "[PASSED|FAILED] name"; markers gate).
const STUB = {
  'swebench/__init__.py': '',
  'swebench/harness/__init__.py': '',
  'swebench/harness/constants.py': 'START_TEST_OUTPUT=">>>>> Start Test Output"\nEND_TEST_OUTPUT=">>>>> End Test Output"\nFAIL_TO_PASS="FAIL_TO_PASS"\nPASS_TO_PASS="PASS_TO_PASS"\n',
  'swebench/harness/log_parsers/__init__.py': '',
  'swebench/harness/log_parsers/javascript.py': [
    'import re',
    'def parse_log_immutable_js(log, spec):',
    '    m = {}',
    '    pr = spec.instance_id.split("-")[-1]',
    '    for line in log.split("\\n"):',
    '        if pr == "2006":',
    '            x = re.match(r"^\\s*(✓|✕|○)\\s(.+?)(?:\\s\\((\\d+\\s*m?s)\\))?$", line.strip())',
    '            if x: m[x.group(2).strip()] = {"✓": "PASSED", "✕": "FAILED", "○": "SKIPPED"}[x.group(1)]',
    '        else:',
    '            x = re.match(r"^\\[(PASSED|FAILED)\\]\\s(.+)$", line.strip())',
    '            if x: m[x.group(2)] = x.group(1)',
    '    return m',
  ].join('\n'),
  'swebench/harness/grading.py': [
    'from swebench.harness.constants import START_TEST_OUTPUT, END_TEST_OUTPUT',
    'from swebench.harness.log_parsers.javascript import parse_log_immutable_js',
    'def get_logs_eval(spec, fp):',
    '    c = open(fp).read()',
    '    if START_TEST_OUTPUT not in c or END_TEST_OUTPUT not in c: return {}, False',
    '    return parse_log_immutable_js(c.split(START_TEST_OUTPUT)[1].split(END_TEST_OUTPUT)[0], spec), True',
    'def get_eval_tests_report(sm, gold):',
    '    ok = lambda n: sm.get(n) == "PASSED"',
    '    return {"FAIL_TO_PASS": {"success": [n for n in gold["FAIL_TO_PASS"] if ok(n)], "failure": [n for n in gold["FAIL_TO_PASS"] if not ok(n)]},',
    '            "PASS_TO_PASS": {"success": [n for n in gold["PASS_TO_PASS"] if sm.get(n) in ("PASSED", "SKIPPED")], "failure": [n for n in gold["PASS_TO_PASS"] if sm.get(n) not in ("PASSED", "SKIPPED")]}}',
    'def get_resolution_status(r):',
    '    f, p = r["FAIL_TO_PASS"], r["PASS_TO_PASS"]',
    '    if not f["failure"] and not p["failure"]: return "RESOLVED_FULL"',
    '    return "RESOLVED_NO" if not f["success"] else "RESOLVED_PARTIAL"',
  ].join('\n'),
};
const hasPython = spawnSync('python3', ['--version']).status === 0;

function grade(instance, log, required, mode = 'gold') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kan111-'));
  for (const [p, c] of Object.entries(STUB)) { fs.mkdirSync(path.dirname(path.join(d, 'stub', p)), { recursive: true }); fs.writeFileSync(path.join(d, 'stub', p), c); }
  fs.writeFileSync(path.join(d, 'log.txt'), log); fs.writeFileSync(path.join(d, 'req.json'), JSON.stringify(required));
  const r = spawnSync('python3', [path.join(DIR, 'grade_report.py'), instance, path.join(d, 'log.txt'), path.join(d, 'req.json'), path.join(d, 'out.json'), mode],
    { env: { ...process.env, PYTHONPATH: path.join(d, 'stub') }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(fs.readFileSync(path.join(d, 'out.json'), 'utf8')); fs.rmSync(d, { recursive: true, force: true }); return out;
}
const wrap = (body) => `QBX_ENV_BEGIN\nCI=<unset>\nQBX_ENV_END\n>>>>> Start Test Output\n${body}\n>>>>> End Test Output\n`;

describe('KAN-111 strict grading checks (QB additions; harness stubbed)', { skip: !hasPython && 'python3 not available' }, () => {
  test('verbose (2006): missing, ambiguous and skipped required tests are never a pass', () => {
    const out = grade('immutable-js__immutable-js-2006', wrap('  ✓ alpha (3 ms)\n  ✓ beta (1 ms)\n  ✓ beta (2 ms)\n  ○ gamma'),
      { FAIL_TO_PASS: ['alpha'], PASS_TO_PASS: ['beta', 'gamma', 'delta'] });
    assert.deepEqual(out.strict.required.FAIL_TO_PASS.counts, { passed: 1 });
    assert.deepEqual(out.strict.required.PASS_TO_PASS.rows.map((r) => r.strict), ['ambiguous', 'skipped', 'missing']);
    assert.equal(out.strict.required.PASS_TO_PASS.rows[0].occurrences, 2, 'the duplicate is counted from raw lines, not the collapsed map');
    assert.equal(out.strict.all_required_unambiguous_and_present, false);
    assert.ok(!JSON.stringify(out.strict).includes('beta'), 'strict rows carry indexes, not test names');
  });
  test('JSON (2005): a required test seen only as PENDING is reported skipped (the official parser ignores it), never a pass', () => {
    const out = grade('immutable-js__immutable-js-2005', wrap('[PASSED] OrderedMap > a\n[PENDING] OrderedMap > p\n[FAILED] OrderedSet > f'),
      { FAIL_TO_PASS: ['OrderedSet > f'], PASS_TO_PASS: ['OrderedMap > a', 'OrderedMap > p'] });
    assert.deepEqual(out.strict.required.FAIL_TO_PASS.rows.map((r) => r.strict), ['failed']);
    assert.deepEqual(out.strict.required.PASS_TO_PASS.rows.map((r) => r.strict), ['passed', 'skipped']);
    assert.equal(out.strict.required.PASS_TO_PASS.rows[1].parsed_status, null, 'the official parser has no entry for it');
  });
  test('malformed report (no End marker): the log gate fails and nothing counts as present', () => {
    const out = grade('immutable-js__immutable-js-2006', '>>>>> Start Test Output\n  ✓ alpha (3 ms)\n(truncated', { FAIL_TO_PASS: ['alpha'], PASS_TO_PASS: [] });
    assert.match(out.official.log_gate, /failed/);
    assert.deepEqual(out.strict.required.FAIL_TO_PASS.counts, { missing: 1 });
  });
  test('all present and unique: strict agrees', () => {
    const out = grade('immutable-js__immutable-js-2006', wrap('  ✓ alpha (3 ms)\n  ✓ beta (1 ms)'), { FAIL_TO_PASS: ['alpha'], PASS_TO_PASS: ['beta'] });
    assert.equal(out.strict.all_required_unambiguous_and_present, true);
  });
});

describe('KAN-111 review 10551: mode-aware acceptance gate (harness stubbed)', { skip: !hasPython && 'python3 not available' }, () => {
  const R = { FAIL_TO_PASS: ['alpha'], PASS_TO_PASS: ['beta'] };
  test('gold: exactly one real pass per F2P and P2P is accepted', () => {
    const out = grade('immutable-js__immutable-js-2006', wrap('  ✓ alpha (3 ms)\n  ✓ beta (1 ms)'), R, 'gold');
    assert.equal(out.acceptance.accepted, true, JSON.stringify(out.acceptance));
  });
  test('empty: each F2P must genuinely fail and each P2P pass', () => {
    assert.equal(grade('immutable-js__immutable-js-2006', wrap('  ✕ alpha (3 ms)\n  ✓ beta (1 ms)'), R, 'empty').acceptance.accepted, true);
    const wrong = grade('immutable-js__immutable-js-2006', wrap('  ✓ alpha (3 ms)\n  ✓ beta (1 ms)'), R, 'empty');
    assert.equal(wrong.acceptance.accepted, false, 'an F2P that passes without the fix is a wrong F2P pattern');
    assert.ok(wrong.acceptance.reasons.some((x) => /FAIL_TO_PASS\[0\].*expected failed.*passed/.test(x)), JSON.stringify(wrong.acceptance.reasons));
  });
  test('skipped-only required test is never accepted (not even P2P, unlike the official maintained rule)', () => {
    const out = grade('immutable-js__immutable-js-2006', wrap('  ✓ alpha (3 ms)\n  ○ beta'), R, 'gold');
    assert.equal(out.acceptance.accepted, false);
    assert.equal(out.official.resolution, 'RESOLVED_FULL', 'the stand-in mirrors the official P2P rule: skipped counts as maintained');
  });
  test('unknown status is never accepted', () => {
    const out = grade('immutable-js__immutable-js-2005', wrap('[PASSED] alpha\n[WEIRD] beta'), R, 'gold');
    assert.equal(out.acceptance.accepted, false);
    assert.ok(out.acceptance.reasons.some((x) => /PASS_TO_PASS\[0\]/.test(x)));
  });
  test('2005 mixed-status duplicate (PASSED + PENDING for one key) is ambiguous, not a pass', () => {
    const out = grade('immutable-js__immutable-js-2005', wrap('[PASSED] alpha\n[PENDING] alpha\n[PASSED] beta'), R, 'gold');
    assert.equal(out.strict.required.FAIL_TO_PASS.rows[0].strict, 'ambiguous');
    assert.equal(out.acceptance.accepted, false);
  });
  test('the structural flag is not the acceptance decision: skipped keeps it true but acceptance false', () => {
    const out = grade('immutable-js__immutable-js-2006', wrap('  ✓ alpha (3 ms)\n  ○ beta'), R, 'gold');
    assert.equal(out.strict.structural_present_and_unique, true);
    assert.equal(out.acceptance.accepted, false);
  });
  test('a failed log gate is never accepted, and the mode must be given', () => {
    assert.equal(grade('immutable-js__immutable-js-2006', '>>>>> Start Test Output\n  ✓ alpha', R, 'gold').acceptance.accepted, false);
  });
});
