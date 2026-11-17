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
 * KAN-106 (10677 item 2, 10690 item 2): "the file changed and one of its tests passes" is not
 * evidence that tests were ADDED. 10677 added a textual witness from the captured diff and the test
 * run; 10690 showed it still overclaims (a function name anywhere in the added lines, skip/todo
 * declarations, a title that matches an old passing case, identifiers pooled across the contract).
 * The witness is therefore ADVISORY: it never makes the criterion met on its own.
 *   met=false (demonstrated)   a named file is not in the change set; it ran no tests; one of its
 *                              tests failed; an added case is reported failing; the diff adds only
 *                              comments / blank lines, or only removes lines
 *   met=null, human review     everything else, including a witness that looks right: new cases
 *                              that passed and call a checked function (textual heuristic only);
 *                              code added in a declaration syntax QB does not recognise, or an
 *                              added title not found in the report (insufficient evidence, not a
 *                              demonstrated failure); removed cases; duplicate titles
 * The witness records per file: added / modified / removed / skipped titles, duplicate titles, and
 * which checked functions the added code (comments stripped) calls. Identifiers come from all the
 * contract's checks, not this criterion's (stated in the witness). L1 only checks structurally that
 * the file is in scope and bound to the requirement; only the run can show this witness, and it does
 * not show that the new tests' assertions are meaningful.
 */
const DECL = /^\s*(?:\w+\.)?(?:test|it)(\.(?:only|skip|todo))?\s*\(\s*(['"`])((?:\\.|(?!\2).)*)\2/;

/** Added / removed / context lines of one file in a unified diff. */
function fileDiffLines(diff, file) {
  const { parseDiffHeader } = require('./policy');
  const out = { added: [], removed: [], context: [] };
  let mine = false;
  for (const line of String(diff || '').split('\n')) {
    if (line.startsWith('diff --git ')) { const p = parseDiffHeader(line); mine = Boolean(p && p[1] === file); continue; }
    if (!mine || line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) continue;
    if (line.startsWith('+')) out.added.push(line.slice(1));
    else if (line.startsWith('-')) out.removed.push(line.slice(1));
    else if (line.startsWith(' ')) out.context.push(line.slice(1));
  }
  return out;
}
const decls = (lines) => lines.map((l) => DECL.exec(l)).filter(Boolean).map((m) => ({ title: m[3], skipped: m[1] === '.skip' || m[1] === '.todo' }));
const titles = (lines) => decls(lines).filter((d) => !d.skipped).map((d) => d.title);
/** Added code with comments removed (line and block comments; strings are left as they are). */
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\])\/\/.*$/gm, '$1');

/** The witness for one file (advisory). */
function witnessFor(diff, file, identifiers) {
  const d = fileDiffLines(diff, file);
  const added = titles(d.added);
  const skipped = decls(d.added).filter((x) => x.skipped).map((x) => x.title);
  const removedAll = titles(d.removed);
  const removed = removedAll.filter((t) => !added.includes(t));
  const code = stripComments(d.added.join('\n'));
  const mentions = identifiers.filter((id) => new RegExp(`(^|[^\\w$])${id.replace(/\$/g, '\\$')}\\s*\\(`).test(code));
  const existing = new Set(titles(d.context));
  const fresh = added.filter((t) => !removedAll.includes(t));
  const dup = [...new Set(added.filter((t, i) => existing.has(t) || added.indexOf(t) !== i))];
  const onlyComments = d.added.length > 0 && !code.split('\n').some((l) => l.trim());
  return { added: fresh, modified: added.filter((t) => removedAll.includes(t)), removed, skipped, duplicate_titles: dup, mentions,
    code_added: d.added.length > 0 && !onlyComments, lines_added: d.added.length };
}

/**
 * @param {object} ac           with adds_tests.files
 * @param {object} classified   classifyTestRun() result (with byFile)
 * @param {object} execution    the captured result (its change set and diff)
 * @param {string[]} identifiers  the functions the contract's checks exercise (all checks, not only this criterion's)
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
  const witness = { advisory: true, identifiers, identifiers_scope: 'contract (not specific to this criterion)', files: {} };
  let failed = false;
  for (const f of files) {
    const s = classified.byFile[f];
    const w = witnessFor(execution?.diff, f, identifiers);
    witness.files[f] = w;
    if (!s || s.passed + s.failed === 0) { lines.push(`${f} did not run`); failed = true; continue; }
    const head = `${f}: changed; ${s.passed} passed, ${s.failed} failed`;
    const passedNames = Array.isArray(s.passed_names) ? s.passed_names : [];
    const failedNames = Array.isArray(s.failed_names) ? s.failed_names : [];
    const fresh = [...w.added, ...w.modified];
    const failing = fresh.filter((t) => failedNames.includes(t));
    if (failing.length) { lines.push(`${head}; added but failed: ${failing.join(', ')}`); failed = true; continue; }
    if (s.failed > 0) { lines.push(head); failed = true; continue; }
    if (!fresh.length) {
      if (!w.code_added) {
        lines.push(`${head}; the diff of ${f} adds no code (${w.lines_added ? 'comments or blank lines only' : 'it only removes lines'})${w.removed.length ? ` (removed: ${w.removed.join(', ')})` : ''}`);
        failed = true; continue;
      }
      lines.push(`${head}; no test case declaration QB recognises in the added code${w.skipped.length ? ` (skip/todo only: ${w.skipped.join(', ')})` : ''}: insufficient evidence, not a demonstrated failure; human review required`);
      continue;
    }
    const notes = [];
    const notFound = fresh.filter((t) => !passedNames.includes(t));
    if (notFound.length) notes.push(`added case(s) not found in the test report (${notFound.join(', ')}): insufficient evidence, not a demonstrated failure`);
    if (w.duplicate_titles.length) notes.push(`an added title also names an existing case (${w.duplicate_titles.join(', ')}): the report cannot tell them apart`);
    if (w.removed.length) notes.push(`existing test case(s) were removed (${w.removed.join(', ')})`);
    if (w.skipped.length) notes.push(`skip/todo declarations are not counted (${w.skipped.join(', ')})`);
    if (!w.mentions.length) notes.push(`the added cases do not call any function the checks exercise (${identifiers.join(', ') || 'none named'}): they may be unrelated`);
    else notes.push(`the added code calls ${w.mentions.join(', ')} (identifiers from the whole contract)`);
    lines.push(`${head}; ${fresh.length} new test case(s) added in the diff; ${notes.join('; ')}; textual heuristic only (advisory): human review required (${limitation})`);
  }
  const evidence = lines.join('; ');
  if (failed) return { ...base, met: false, witness, evidence, repair: `Add new test cases in ${files.join(', ')} that call the changed behaviour, run and pass` };
  return { ...base, met: null, human_review: true, evidence_missing: [{ what: 'added-tests witness', reason: 'textual heuristic only (advisory): human review required' }], witness, evidence };
}

module.exports = { addedTestsErrors, decideAddedTests, witnessFor };
