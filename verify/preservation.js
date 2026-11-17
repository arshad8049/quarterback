/**
 * verify/preservation.js — preservation claims are bounded to named tests (QB-15).
 *
 * "Existing tests remain unchanged", "no regressions", "backward compatible": a
 * claim that something is NOT broken cannot be read from a diff. It used to be set
 * to null by the judge — avoiding a false repair, but never verifying anything.
 *
 * Now a preservation criterion must name what it preserves:
 *   preserves: { tests: ["test/parser.test.js", …] }   repository-relative test files
 * (interfaces are preserved with executable checks bound to the criterion, QB-16).
 * It is decided by the sandbox's classified test report, never by the judge:
 *   met     every named file ran, with ≥ 1 passing test and no failing test,
 *           and the criterion's checks (if any) passed
 *   false   a named test failed, or a named file did not run at all
 *   null    the test run is unusable (timeout, OOM, no report, …): unresolved —
 *           null is never proof of preservation
 * An unbound preservation criterion makes the contract invalid (contractState).
 */

const PRESERVATION_PATTERNS = [
  /existing\s+\w*\s*(functionality|behavior|behaviour|code|tests?)\s+(remains?\s+)?unchanged/i,
  /remains?\s+unchanged/i,
  /no\s+other\s+parts?\s+(of\s+the\s+code\s+)?(are\s+)?affected/i,
  /without\s+(affecting|breaking|changing|modifying)\s+(existing|other|the\s+rest)/i,
  /existing\s+(code|behavior|behaviour|tests?|interface)\s+(is\s+)?(not\s+)?(modified|changed|broken|affected)/i,
  /no\s+regressions?/i,
  /backward[\s-]?compat/i,
  /existing\s+\w*\s*tests?\s+(still\s+|continue\s+to\s+)?pass/i,
  // KAN-106 (10674 F-c): "No other tests regress" (smoke eba7015e AC-7) was not recognized.
  /\bno\s+(other\s+|existing\s+)?tests?\s+(regress|break|fail)/i,
  // KAN-106 (10674 F-c): "Existing tests in test/asNumber.test.js still pass" (smoke eba7015e AC-6):
  // the pattern above stops at "tests in …", so this exact wording was NOT recognized at 4ed4be5.
  /existing\s+(\w+\s+)?tests?\s+(in|for|of|under)\s+\S+\s+(still\s+|continue\s+to\s+)?pass/i,
  /\btests?\s+(do\s+not|don't|must\s+not|should\s+not|will\s+not|won't)\s+(regress|break|fail)/i,
];

/**
 * KAN-106 (10674 F-c): a claim about the TEST SUITE ("existing tests still pass", "no other tests
 * regress"). Its evidence is the named test files only: a value check (call_returns, call_throws, …)
 * proves one behaviour, not that a suite passed, so binding one to such a claim is rejected. A claim
 * about behaviour or an interface ("backward compatible", "remains unchanged") may still bind checks.
 */
const TEST_SUITE_PATTERNS = [
  /existing\s+\w*\s*tests?\b/i,
  /\btests?\s+(still\s+|continue\s+to\s+)?pass/i,
  /\btests?\s+(do\s+not\s+|don't\s+|must\s+not\s+|should\s+not\s+|will\s+not\s+|won't\s+)?(regress|break|fail)/i,
  /no\s+(\w+\s+)?regressions?/i,
];
const isTestSuiteClaim = (criterion) => TEST_SUITE_PATTERNS.some((p) => p.test(String(criterion || '')));
const GLOB = /[*?[\]{}!]/;

const isPreservationCriterion = (criterion) => PRESERVATION_PATTERNS.some((p) => p.test(String(criterion || '')));
const plainPath = (p) => typeof p === 'string' && p.length > 0 && p.length <= 300 && !p.startsWith('/')
  && !/[\u0000-\u001f\u007f]/.test(p) && !p.split('/').some((s) => s === '' || s === '.' || s === '..');

/**
 * Structural errors for every criterion's preservation binding.
 * KAN-106 (10674 F-c), for a criterion that names tests:
 *   - each entry is a literal test file: a glob ("test/**") cannot show which tests ran, and the
 *     whole suite is never claimed from a pattern or a subset (QB's test gate already fails the task
 *     on any new failure);
 *   - a named file the REQUEST asks to change (intent/request-targets.js) cannot prove that its
 *     existing tests were kept: the task rewrites it (decidePreservation also refuses a named file
 *     the captured change set edited);
 *   - a test-suite claim binds no value checks (they do not show that a suite passed).
 */
function preservationErrors(c) {
  const errors = [];
  const { requestTargets } = require('../intent/request-targets');
  const targets = typeof c?.raw_request === 'string' ? new Set(requestTargets(c.raw_request).targets.map((t) => t.path)) : new Set();
  for (const ac of c?.acceptance_criteria || []) {
    const p = ac?.preserves;
    if (p === undefined) {
      if (isPreservationCriterion(ac?.criterion)) errors.push(`${ac.id} is a preservation criterion: name the tests it preserves (preserves.tests)`);
      continue;
    }
    if (!p || typeof p !== 'object' || Array.isArray(p) || Object.keys(p).some((k) => k !== 'tests')
      || !Array.isArray(p.tests) || !p.tests.length || p.tests.length > 32 || !p.tests.every(plainPath)) {
      errors.push(`${ac.id} preserves must be { "tests": [<repository-relative test files>] } (1–32 plain paths)`);
      continue;
    }
    const globs = p.tests.filter((f) => GLOB.test(f));
    if (globs.length) errors.push(`${ac.id} preserves.tests ${globs.map((g) => JSON.stringify(g)).join(', ')} is a pattern: name the test files (a pattern cannot show which tests ran; QB's test gate already fails the task on any new test failure)`);
    const edited = p.tests.filter((f) => targets.has(f));
    if (edited.length) errors.push(`${ac.id} preserves ${edited.join(', ')}, which the request asks to change: passing afterwards cannot show that its existing tests were kept (require the added tests with adds_tests instead)`);
    if (isTestSuiteClaim(ac.criterion)) {
      const bound = (c.checks || []).filter((k) => k && k.ac_id === ac.id).map((k) => `${k.id} (${k.adapter})`);
      if (bound.length) errors.push(`${ac.id} claims tests still pass, but is bound to ${bound.join(', ')}: a value check cannot show that a test suite passed; bind it to the behaviour criterion it tests, or remove it`);
    }
  }
  return errors;
}

/**
 * Decide a preservation criterion from the classified test run (verify/tests.js).
 * @param {object} ac        - with preserves.tests
 * @param {object} classified - classifyTestRun() result (with byFile)
 */
function decidePreservation(ac, classified, execution = null) {
  const base = { id: ac.id, criterion: ac.criterion, method: 'test-runner' };
  // KAN-106 (10674 F-c): a preserved file the task edited cannot show its existing tests were kept.
  if (execution) {
    const { changedFiles } = require('./policy');
    const changed = new Set(changedFiles(execution));
    const edited = ac.preserves.tests.filter((f) => changed.has(f));
    if (edited.length) return { ...base, met: false, evidence: `edited by the task: ${edited.join(', ')}; passing afterwards cannot show that its existing tests were kept`, repair: `Keep these tests passing without editing them: ${ac.preserves.tests.join(', ')}` };
  }
  const usable = classified && ['passed', 'failed', 'preexisting_failures'].includes(classified.outcome) && classified.byFile;
  if (!usable) {
    return { ...base, met: null, evidence: `The test run cannot show that ${ac.preserves.tests.join(', ')} still pass (${classified ? classified.reason : 'no test run'}); not verified.` };
  }
  const lines = [];
  let broken = false;
  for (const f of ac.preserves.tests) {
    const s = classified.byFile[f];
    if (!s || s.passed + s.failed === 0) { lines.push(`${f} did not run`); broken = true; continue; }
    lines.push(`${f}: ${s.passed} passed, ${s.failed} failed`);
    if (s.failed > 0 || s.passed === 0) broken = true;
  }
  return broken
    ? { ...base, met: false, evidence: lines.join('; '), repair: `Keep these tests passing without editing them: ${ac.preserves.tests.join(', ')}` }
    : { ...base, met: true, evidence: lines.join('; ') };
}

module.exports = { isTestSuiteClaim, isPreservationCriterion, preservationErrors, decidePreservation, PRESERVATION_PATTERNS };
