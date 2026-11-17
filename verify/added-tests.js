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
 * KAN-106 (10677 item 2): "the file changed and one of its tests passes" is not evidence that tests
 * were ADDED: a comment-only edit, or deleting tests while one old test passes, satisfied it. The
 * criterion is now met only with a bounded witness, per named file, from the captured diff and the
 * test run:
 *   - the diff adds ≥ 1 new test case declaration (test(…) / it(…) with a literal title) and removes
 *     none (a removed case that is not re-added with the same title → unresolved, human review);
 *   - every added case ran and passed (by title, in that file's test report);
 *   - the added lines call at least one function the contract's checks exercise (their export /
 *     method names); otherwise the added cases may be unrelated → unresolved, human review.
 * Limitation, stated in the evidence: this shows that new, passing cases calling the behaviour under
 * test were added. It does not show that their assertions are meaningful; the behaviour itself is
 * proven by the behaviour criteria's own checks. L1 only checks structurally that the file is in
 * scope and bound to the requirement; only the run can show this witness.
 */
const DECL = /^\s*(?:\w+\.)?(?:test|it)(?:\.(?:only|skip|todo))?\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/;

/** Added / removed lines of one file in a unified diff. */
function fileDiffLines(diff, file) {
  const { parseDiffHeader } = require('./policy');
  const out = { added: [], removed: [] };
  let mine = false;
  for (const line of String(diff || '').split('\n')) {
    if (line.startsWith('diff --git ')) { const p = parseDiffHeader(line); mine = Boolean(p && p[1] === file); continue; }
    if (!mine || line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) out.added.push(line.slice(1));
    else if (line.startsWith('-')) out.removed.push(line.slice(1));
  }
  return out;
}
const titles = (lines) => lines.map((l) => DECL.exec(l)).filter(Boolean).map((m) => m[2]);

/** The witness for one file: added and removed case titles, and which checked functions the added lines call. */
function witnessFor(diff, file, identifiers) {
  const d = fileDiffLines(diff, file);
  const added = titles(d.added);
  const removedAll = titles(d.removed);
  const removed = removedAll.filter((t) => !added.includes(t));
  const text = d.added.join('\n');
  const mentions = identifiers.filter((id) => new RegExp(`(^|[^\\w$])${id.replace(/\$/g, '\\$')}\\s*\\(`).test(text));
  return { added: added.filter((t) => !removedAll.includes(t)), modified: added.filter((t) => removedAll.includes(t)), removed, mentions };
}

/**
 * @param {object} ac           with adds_tests.files
 * @param {object} classified   classifyTestRun() result (with byFile)
 * @param {object} execution    the captured result (its change set and diff)
 * @param {string[]} identifiers  the functions the contract's checks exercise
 */
function decideAddedTests(ac, classified, execution, identifiers = []) {
  const base = { id: ac.id, criterion: ac.criterion, method: 'test-runner+change-set' };
  const files = ac.adds_tests.files;
  const limitation = 'does not show that their assertions are meaningful';
  const changed = new Set(changedFiles(execution));
  const unchanged = files.filter((f) => !changed.has(f));
  if (unchanged.length) {
    return { ...base, met: false, evidence: `not changed by the task: ${unchanged.join(', ')}`, repair: `Add the requested tests in ${unchanged.join(', ')}` };
  }
  const usable = classified && ['passed', 'failed', 'preexisting_failures'].includes(classified.outcome) && classified.byFile;
  if (!usable) return { ...base, met: null, evidence: `The test run cannot show that the tests in ${files.join(', ')} pass (${classified ? classified.reason : 'no test run'}); not verified.` };
  const lines = [];
  const witness = { files: {}, identifiers };
  let verdict = true;
  const worst = (v) => { if (v === false) verdict = false; else if (v === null && verdict !== false) verdict = null; };
  for (const f of files) {
    const s = classified.byFile[f];
    const w = witnessFor(execution?.diff, f, identifiers);
    witness.files[f] = w;
    if (!s || s.passed + s.failed === 0) { lines.push(`${f} did not run`); worst(false); continue; }
    const head = `${f}: changed; ${s.passed} passed, ${s.failed} failed`;
    if (s.failed > 0) { lines.push(head); worst(false); continue; }
    const passedNames = Array.isArray(s.passed_names) ? s.passed_names : [];
    const fresh = [...w.added, ...w.modified];
    if (!w.added.length) {
      lines.push(`${head}; no new test case in the diff of ${f}${w.removed.length ? ` (removed: ${w.removed.join(', ')})` : ''}`);
      worst(false); continue;
    }
    const notPassed = fresh.filter((t) => !passedNames.includes(t));
    if (notPassed.length) { lines.push(`${head}; added but did not pass: ${notPassed.join(', ')}`); worst(false); continue; }
    if (w.removed.length) { lines.push(`${head}; ${w.added.length} new test case(s) added, but existing test case(s) were removed (${w.removed.join(', ')}): human review required`); worst(null); continue; }
    if (!w.mentions.length) {
      lines.push(`${head}; ${w.added.length} new test case(s) added and passed, but the added cases do not call any function the checks exercise (${identifiers.join(', ') || 'none named'}): they may be unrelated; human review required`);
      worst(null); continue;
    }
    lines.push(`${head}; ${w.added.length} new test case(s) added in the diff, all ran and passed, and they call ${w.mentions.join(', ')} (${limitation})`);
  }
  const evidence = lines.join('; ');
  if (verdict === false) return { ...base, met: false, witness, evidence, repair: `Add new test cases in ${files.join(', ')} that call the changed behaviour, run and pass` };
  if (verdict === null) return { ...base, met: null, human_review: true, evidence_missing: [{ what: 'added-tests witness', reason: 'partial: human review required' }], witness, evidence };
  return { ...base, met: true, witness, evidence };
}

module.exports = { addedTestsErrors, decideAddedTests, witnessFor };
