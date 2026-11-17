/**
 * verify/added-tests.js: a criterion that requires ADDING tests (KAN-106, senior 10674 F-b/F-c).
 *
 * "Add node:test cases in test/asNumber.test.js" is requested work. It used to be either dropped,
 * given to a criterion whose value checks had nothing to do with it, or relabelled non_behavioral
 * so the judge would decide it. Now such a criterion is bound to the test files it adds:
 *   adds_tests: { files: ["test/asNumber.test.js"] }   literal repository-relative paths, no globs
 * and is decided from the captured result only, never by the judge:
 *   met     every named file is in the captured change set AND ran in the sandbox test run with
 *           ≥ 1 passing and no failing test (plus any checks bound to the criterion passed)
 *   false   a named file was not changed, did not run, or has a failing test
 *   null    the test run is unusable (timeout, no report, …): unresolved, never proof
 * Limitation, stated in the evidence: this shows the requested test file was changed and its tests
 * pass. It does not show that the new tests exercise the new behaviour; the behaviour itself is
 * proven by the behaviour criteria's own checks. QB's base test run happens only when the
 * candidate's run fails, so a per-file "more tests than before" comparison is not available.
 */
const { matchesAny, changedFiles } = require('./policy');

const GLOB = /[*?[\]{}!]/;
const plainFile = (p) => typeof p === 'string' && p.length > 0 && p.length <= 300 && !p.startsWith('/') && !GLOB.test(p)
  && !/[\u0000-\u001f\u007f]/.test(p) && !p.split('/').some((s) => s === '' || s === '.' || s === '..');

/** Structural errors for every criterion's adds_tests binding. */
function addedTestsErrors(c) {
  const errors = [];
  const allowed = Array.isArray(c?.scope?.allowed_changes) ? c.scope.allowed_changes : [];
  const prot = Array.isArray(c?.scope?.protected_paths) ? c.scope.protected_paths : [];
  for (const ac of c?.acceptance_criteria || []) {
    const a = ac?.adds_tests;
    if (a === undefined) continue;
    if (!a || typeof a !== 'object' || Array.isArray(a) || Object.keys(a).some((k) => k !== 'files')
      || !Array.isArray(a.files) || !a.files.length || a.files.length > 16 || !a.files.every(plainFile)) {
      errors.push(`${ac.id} adds_tests must be { "files": [<repository-relative test files>] } (1–16 literal paths, no globs)`);
      continue;
    }
    if (ac.kind === 'non_behavioral') errors.push(`${ac.id} requires adding tests, which is decided from the test run: it cannot be non_behavioral`);
    if (ac.preserves !== undefined) errors.push(`${ac.id} cannot both add tests (adds_tests) and preserve tests (preserves)`);
    for (const f of a.files) {
      const by = prot.find((g) => matchesAny(f, [g]));
      if (by) errors.push(`${ac.id} adds tests in ${f}, but scope.protected_paths ${JSON.stringify(by)} protects it`);
      else if (!matchesAny(f, allowed)) errors.push(`${ac.id} adds tests in ${f}, but scope.allowed_changes does not allow changing it`);
    }
  }
  return errors;
}

/**
 * @param {object} ac          with adds_tests.files
 * @param {object} classified  classifyTestRun() result (with byFile)
 * @param {object} execution   the captured result (its change set)
 */
function decideAddedTests(ac, classified, execution) {
  const base = { id: ac.id, criterion: ac.criterion, method: 'test-runner+change-set' };
  const files = ac.adds_tests.files;
  const limitation = 'shows the file changed and its tests pass, not that the new tests exercise the new behaviour';
  const changed = new Set(changedFiles(execution));
  const unchanged = files.filter((f) => !changed.has(f));
  if (unchanged.length) {
    return { ...base, met: false, evidence: `not changed by the task: ${unchanged.join(', ')}`, repair: `Add the requested tests in ${unchanged.join(', ')}` };
  }
  const usable = classified && ['passed', 'failed', 'preexisting_failures'].includes(classified.outcome) && classified.byFile;
  if (!usable) return { ...base, met: null, evidence: `The test run cannot show that the tests in ${files.join(', ')} pass (${classified ? classified.reason : 'no test run'}); not verified.` };
  const lines = [];
  let broken = false;
  for (const f of files) {
    const s = classified.byFile[f];
    if (!s || s.passed + s.failed === 0) { lines.push(`${f} did not run`); broken = true; continue; }
    lines.push(`${f}: changed; ${s.passed} passed, ${s.failed} failed`);
    if (s.failed > 0 || s.passed === 0) broken = true;
  }
  const evidence = `${lines.join('; ')} (${limitation})`;
  return broken ? { ...base, met: false, evidence, repair: `Make the added tests in ${files.join(', ')} run and pass` } : { ...base, met: true, evidence };
}

module.exports = { addedTestsErrors, decideAddedTests };
