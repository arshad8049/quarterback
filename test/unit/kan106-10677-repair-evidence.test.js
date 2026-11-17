/**
 * KAN-106, senior decision 10677 (on 10675/10676): the owner's timed Qwen dry-run smoke b2416ebc
 * (qwen2.5-coder:14b, profile qwen-14b-experimental, QB eaa3882) ended BLOCKED after 350.1 s:
 *   - both drafts invented AC-6 "Existing tests in test/asNumber.test.js still pass" and AC-7 "No
 *     other tests regress", each preserving test/asNumber.test.js (the file the request asks to add
 *     tests to) and tied to R-6 ("Add node:test cases in test/asNumber.test.js."); no request
 *     passage asks for either. The F-c rule rejected them; the repair left them unchanged.
 *   - R-1 ("In lib/serializer.js,") was neither cited by a criterion nor marked context, but no
 *     rule said so: traceability runs only after the earlier stages pass.
 *   - the terminal cut the reason mid-word ("require the added t...").
 *
 * 10677 approves: (1) a repair instruction that names each conflicting criterion and why, without
 * weakening validation (an explicitly requested preservation that conflicts is reported, never
 * deleted); (2) closing the adds_tests evidence gap (comment-only edits, deleted tests, unrelated
 * added tests); (3) R-1's disposition shown in the saved draft, and its coverage gap fixed;
 * (4) a complete short terminal explanation. Fixtures: b2416ebc-initial.json / b2416ebc-repair.json
 * are the model-authored fields of both drafts from that run's contract-repair artifact (quotes,
 * which QB copies from passages, removed); b2416ebc-errors.json the validator's errors and the
 * run's timings; b2416ebc-structural-only.json the repair as a correct reply would be (AC-6/AC-7 and
 * their constraints removed, R-1 and R-6 cited by AC-1…AC-5). No live model, no Claude, no Docker.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const proc = require('../../lib/proc');
const { mockFetch, ollamaReply } = require('../helpers/mocks');
const { makeRepo } = require('../helpers/tmprepo');

const FIX = path.join(__dirname, '..', 'fixtures', 'kan106');
const REQUEST = fs.readFileSync(path.join(FIX, 'request.txt'), 'utf8').trim();
const INITIAL = fs.readFileSync(path.join(FIX, 'b2416ebc-initial.json'), 'utf8');
const REPAIRED = fs.readFileSync(path.join(FIX, 'b2416ebc-repair.json'), 'utf8');
// 10690: the old "corrected" reply is structural-only (its checks never call asNumber); the repair-shape
// tests now use the human-reviewed reply faithful to the pinned repository's API.
const CORRECTED = fs.readFileSync(path.join(FIX, 'pinned-api-honest.json'), 'utf8');
const FAITHFUL = fs.readFileSync(path.join(FIX, 'faithful-draft.json'), 'utf8');
const SMOKE = JSON.parse(fs.readFileSync(path.join(FIX, 'b2416ebc-errors.json'), 'utf8'));
const QB = path.join(__dirname, '..', '..', 'qb.js');
const PRELOAD_OLLAMA = path.join(__dirname, '..', 'helpers', 'preload-ollama.js');

const load = {
  session: () => require('../../intent/session'),
  state: () => require('../../intent/contract-state'),
  compiler: () => require('../../intent/compiler'),
  preservation: () => require('../../verify/preservation'),
  added: () => require('../../verify/added-tests'),
  verifier: () => require('../../verify/verifier'),
  short: () => require('../../lib/short-text'),
};
const variant = (text, edit) => { const d = JSON.parse(text); edit(d); return JSON.stringify(d); };

async function compileWith(replies, o = {}) {
  let i = 0;
  const m = mockFetch(async () => ollamaReply(replies[Math.min(i++, replies.length - 1)]));
  try {
    const s = await load.session().compileIntent(o.request || REQUEST, o.session || {});
    return { s, calls: m.calls.length, prompts: m.calls.map((c) => JSON.parse(c.init.body).messages.map((x) => x.content).join('\n')) };
  } finally { m.restore(); }
}
function contractOf(text, request = REQUEST) {
  const { resolveInRequest } = require('../../intent/passages');
  const raw = JSON.parse(text);
  raw.requirements = raw.requirements.map((r) => (r.passage_ids ? { ...r, quote: resolveInRequest(request, r.passage_ids).text } : r));
  return load.compiler().contractFromObject(raw, request);
}
const errorsOf = (text, edit = null, request = REQUEST) => { const s = load.state().contractState(contractOf(edit ? variant(text, edit) : text, request)); return s.state === 'finalized' ? [] : s.errors; };

describe('10677: the b2416ebc drafts, reproduced offline', () => {
  test('the exact smoke drafts give the exact recorded errors (eaa3882), and the timings fixture is the run\'s', () => {
    // 10690: the recorded errors are still reported first and unchanged; the check-fidelity rules add theirs after them.
    for (const [draft, recorded] of [[INITIAL, SMOKE.errors[0]], [REPAIRED, SMOKE.errors[1]]]) {
      const e = errorsOf(draft);
      assert.deepEqual(e.slice(0, recorded.length), recorded);
      assert.ok(e.slice(recorded.length).length > 0 && e.slice(recorded.length).every((x) => /never calls asNumber|make the identical call|is about behaviour/.test(x)), e.slice(recorded.length).join('\n'));
    }
    assert.equal(SMOKE.qb_revision, 'eaa38820425982b4236e3492e52a2c8967eb5e1e');
    assert.equal(SMOKE.timings.l1_ms, 350110);
    assert.deepEqual(SMOKE.timings.calls.map((c) => [c.kind, c.ms, c.limit_ms]), [['initial', 179063, 240000], ['repair', 170885, 240000]]);
  });
  test('the fixtures carry no private paths or run-local metadata', () => {
    for (const f of ['b2416ebc-initial.json', 'b2416ebc-repair.json', 'b2416ebc-structural-only.json', 'b2416ebc-errors.json']) {
      const t = fs.readFileSync(path.join(FIX, f), 'utf8');
      assert.doesNotMatch(t, /\/Users\/|qb_test_grounds|repo_path|raw_request/, f);
    }
  });
});

describe('10677 (1): the repair names each conflicting criterion and why; validation is not weakened', () => {
  test('through compile(): the repair prompt names AC-6 and AC-7, the passage they misattribute, and says to remove them with their bindings', async () => {
    const { s, calls, prompts } = await compileWith([INITIAL, REPAIRED]);
    assert.equal(calls, 2);
    assert.equal(s.state, 'invalid');
    const p = prompts[1];
    assert.match(p, /CONFLICTING CRITERIA/);
    for (const id of ['AC-6', 'AC-7']) {
      assert.match(p, new RegExp(`- ${id} claims that existing tests in test/asNumber\\.test\\.js still pass\\. No request passage asks for that: it cites R-6 \\(P6 "Add node:test cases in test/asNumber\\.test\\.js\\."\\), which asks to ADD tests to that file, and the task changes that file\\. Remove ${id}`));
    }
    assert.match(p, /Remove AC-6, the checks bound to it \(CHK-2\), and the constraints and constraint_policy entries that exist only for it/);
    assert.match(p, /Do not keep the same claim with "preserves" deleted, reworded, or with the criterion marked non_behavioral/);
    assert.match(p, /QB's own regression gate already fails the task on any new test failure/);
    assert.match(p, /cover R-6 with the criterion that requires adding the tests \("adds_tests"\)/);
  });
  test('a corrected reply (AC-6/AC-7 removed with their constraints; R-1 and R-6 cited; checks faithful to the pinned API) passes FULL validation through the real compiler path', async () => {
    const { s, calls } = await compileWith([INITIAL, CORRECTED]);
    assert.equal(calls, 2);
    assert.equal(s.state, 'finalized', JSON.stringify(s.errors));
    assert.deepEqual(s.contract.acceptance_criteria.map((a) => a.id), ['AC-1', 'AC-2', 'AC-3', 'AC-4', 'AC-5', 'AC-6']);
    assert.equal(s.repair.rejected.length, 1, 'the rejected first draft stays in the record');
    assert.ok(!s.contract.approval, 'still needs human review and approval');
  });
  test('the claim kept with "preserves" deleted, or relabelled non_behavioral, is still rejected', () => {
    const strip = (d) => { for (const a of d.acceptance_criteria) if (a.preserves) delete a.preserves; };
    assert.match(errorsOf(REPAIRED, strip).join('\n'), /AC-6 is a preservation criterion: name the tests it preserves \(preserves\.tests\)/);
    const relabel = (d) => { strip(d); for (const a of d.acceptance_criteria) if (a.id === 'AC-6' || a.id === 'AC-7') a.kind = 'non_behavioral'; };
    assert.match(errorsOf(REPAIRED, relabel).join('\n'), /AC-7 is a preservation criterion/);
  });
  test('an EXPLICITLY requested preservation of a file the request also changes is reported as unsupported: no repair call, the requirement is not deleted', async () => {
    const request = `${REQUEST} Existing tests in test/asNumber.test.js must still pass.`;
    const draft = variant(FAITHFUL, (d) => {
      d.requirements.push({ id: 'R-7', passage_ids: ['P7'] });
      d.acceptance_criteria.push({ id: 'AC-7', criterion: 'Existing tests in test/asNumber.test.js still pass.', met: null, kind: 'behavioral', requirement_ids: ['R-7'], preserves: { tests: ['test/asNumber.test.js'] } });
    });
    const { s, calls } = await compileWith([draft, CORRECTED], { request });
    assert.equal(calls, 1, 'no repair: no draft can verify this without deleting the user\'s requirement');
    assert.equal(s.state, 'invalid');
    assert.equal(s.unsupported.length, 1);
    assert.deepEqual([s.unsupported[0].criterion_id, s.unsupported[0].files, s.unsupported[0].passages], [['AC-7'][0], ['test/asNumber.test.js'], ['P7']]);
    assert.match(s.unsupported[0].reason, /The request asks both to change test\/asNumber\.test\.js and to keep its existing tests passing \(P7\)\. QB can only show that preserved tests still pass for a file the task does not edit/);
    assert.equal(s.repair.attempted, false);
    assert.equal(s.repair.reason, 'unsupported_request');
  });
});

describe('10677 (3): the R-1 locator: its disposition is saved, and the coverage gap is reported', () => {
  test('each rejected draft records every requirement\'s disposition; R-1 was uncovered in both b2416ebc drafts', async () => {
    const { s } = await compileWith([INITIAL, REPAIRED]);
    for (const r of s.repair.rejected) {
      const t = Object.fromEntries(r.trace.map((x) => [x.id, x.disposition]));
      assert.deepEqual(t, { 'R-1': 'uncovered', 'R-2': 'covered', 'R-3': 'covered', 'R-4': 'covered', 'R-5': 'covered', 'R-6': 'covered' });
    }
  });
  test('the later-stage errors (traceability) reach the repair even when an earlier stage failed', async () => {
    const { s, prompts } = await compileWith([INITIAL, REPAIRED]);
    assert.match(prompts[1], /ALSO TO FIX \(QB checks these after the errors above\):\n- requirement R-1 "In lib\/serializer\.js," is not covered by any acceptance criterion/);
    assert.ok(s.repair.rejected[0].later_errors.some((e) => /requirement R-1 .* is not covered/.test(e)));
    assert.ok(s.errors.some((e) => /requirement R-1 .* is not covered/.test(e)), 'the final errors include the gap the earlier stage masked');
  });
  test('R-1 as context with a location-only reason (and the target path validated) is accepted; uncovered and unexplained is not', () => {
    const ctx = (d) => { const r = d.requirements.find((x) => x.id === 'R-1'); r.disposition = 'context'; r.reason = 'location only'; for (const a of d.acceptance_criteria) a.requirement_ids = a.requirement_ids.filter((x) => x !== 'R-1'); };
    assert.deepEqual(errorsOf(CORRECTED, ctx), []);
    const bare = (d) => { for (const a of d.acceptance_criteria) a.requirement_ids = a.requirement_ids.filter((x) => x !== 'R-1'); };
    assert.match(errorsOf(CORRECTED, bare).join('\n'), /requirement R-1 "In lib\/serializer\.js," is not covered by any acceptance criterion/);
  });
});

describe('10677 (2): adds_tests needs a witness of NEW, relevant, passing test cases', () => {
  const L = (o) => JSON.stringify(o) + '\n';
  const report = (tests) => L({ type: 'qb:start', format: 'qb-node-test-events/1' })
    + tests.map(([file, name, ok]) => L({ type: ok ? 'test:pass' : 'test:fail', name, nesting: 0, path: [], file: `/verify/${file}`, kind: 'test', skip: false, todo: false, failureType: ok ? null : 'testCodeFailure', ...(ok ? {} : { error: 'boom' }) })).join('')
    + L({ type: 'test:summary', file: null, counts: { tests: tests.length, passed: tests.filter((t) => t[2]).length, failed: tests.filter((t) => !t[2]).length, cancelled: 0, skipped: 0, todo: 0 }, success: tests.every((t) => t[2]) })
    + L({ type: 'qb:end' });
  const hunk = (file, lines) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,1 +1,${lines.length} @@\n${lines.join('\n')}\n`;
  const SRC = hunk('lib/serializer.js', ['-  return Number(v)', '+  if (String(v).trim() === \'\') throw new Error(\'cannot be converted\')', '+  return Number(v)']);
  const exec = (testLines, tests) => ({ id: 'e', status: 'completed', diff: SRC + hunk('test/asNumber.test.js', testLines),
    changes: [{ file: 'lib/serializer.js', status: 'M' }, { file: 'test/asNumber.test.js', status: 'M' }],
    sandbox: { verification: { status: 'ran', state: tests.every((t) => t[2]) ? 'completed' : 'execution_error', exit_code: tests.every((t) => t[2]) ? 0 : 1, output: '', report: report(tests) } } });
  const approved = () => load.state().approve(contractOf(FAITHFUL), { via: 'test' });
  const decide = async (execution) => (await load.verifier().verify(approved(), null, execution, { noLlm: true })).criteria_results.find((x) => x.id === 'AC-6');
  const OLD = ['test/asNumber.test.js', 'returns numbers', true];

  test('new relevant cases that ran and passed: the witness is recorded, but it is advisory (10690): human review, never met on its own', async () => {
    const r = await decide(exec(["+test('empty string throws', () => { assert.throws(() => asNumber('')) })", "+test('whitespace throws', () => { assert.throws(() => asNumber('   ')) })"],
      [OLD, ['test/asNumber.test.js', 'empty string throws', true], ['test/asNumber.test.js', 'whitespace throws', true]]));
    assert.equal(r.met, null, r.evidence);
    assert.equal(r.human_review, true);
    assert.deepEqual(r.witness.files['test/asNumber.test.js'].added, ['empty string throws', 'whitespace throws']);
    assert.deepEqual(r.witness.files['test/asNumber.test.js'].mentions, ['asNumber']);
    assert.match(r.evidence, /2 new test case\(s\) added in the diff; the added code calls asNumber \(identifiers from the whole contract\); textual heuristic only \(advisory\): human review required/);
    assert.match(r.evidence, /does not show that their assertions are meaningful/);
  });
  test('a comment-only edit while an old test passes: NOT met', async () => {
    const r = await decide(exec(['+// TODO: cover empty strings with asNumber'], [OLD]));
    assert.equal(r.met, false);
    assert.match(r.evidence, /the diff of test\/asNumber\.test\.js adds no code \(comments or blank lines only\)/);
  });
  test('deleting tests while one old test passes: NOT met', async () => {
    const r = await decide(exec(["-test('handles negatives', () => { assert.equal(asNumber('-7'), -7) })"], [OLD]));
    assert.equal(r.met, false);
    assert.match(r.evidence, /adds no code \(it only removes lines\)/);
    assert.match(r.evidence, /removed: handles negatives/);
  });
  test('cases added while others are removed: unresolved, human review', async () => {
    const r = await decide(exec(["-test('handles negatives', () => { assert.equal(asNumber('-7'), -7) })", "+test('empty string throws', () => { assert.throws(() => asNumber('')) })"],
      [OLD, ['test/asNumber.test.js', 'empty string throws', true]]));
    assert.equal(r.met, null);
    assert.equal(r.human_review, true);
    assert.match(r.evidence, /existing test case\(s\) were removed \(handles negatives\)/);
  });
  test('unrelated added tests (they never call the behaviour under test): unresolved, human review, never met', async () => {
    const r = await decide(exec(["+test('formats dates', () => { assert.equal(formatDate(0), '1970') })"], [OLD, ['test/asNumber.test.js', 'formats dates', true]]));
    assert.equal(r.met, null);
    assert.equal(r.human_review, true);
    assert.match(r.evidence, /the added cases do not call any function the checks exercise \(asNumber\)/);
  });
  test('an added case missing from the report: insufficient evidence (unresolved); an added case reported failing: NOT met', async () => {
    const r = await decide(exec(["+test('empty string throws', () => { assert.throws(() => asNumber('')) })"], [OLD]));
    assert.equal(r.met, null);
    assert.match(r.evidence, /not found in the test report \(empty string throws\): insufficient evidence, not a demonstrated failure/);
    const f = await decide(exec(["+test('empty string throws', () => { assert.throws(() => asNumber('')) })"], [OLD, ['test/asNumber.test.js', 'empty string throws', false]]));
    assert.equal(f.met, false);
    assert.match(f.evidence, /added but failed: empty string throws/);
  });
  test('L1 vs execution: the checklist text says what L1 checked structurally and what only the run can show', () => {
    const view = require('../../intent/oracle-view').formatOracle(approved());
    assert.match(view, /\[added tests: L1 checked only that test\/asNumber\.test\.js is in scope; the run must show new test cases there that pass and call the behaviour under test\]/);
  });
});

describe('10677 (4): the terminal explanation is complete and short', () => {
  test('shortText never cuts mid-word; short reasons are printed whole', () => {
    const { shortText } = load.short();
    const e = SMOKE.errors[1][0];
    assert.equal(shortText(e), e, 'the b2416ebc reason is short enough to print whole');
    const long = `${'word '.repeat(80)}end`;
    const s = shortText(long, 120);
    assert.ok(s.length <= 160);
    assert.match(s, /word …$|word \(full text in the run record\)$/);
    assert.doesNotMatch(s, /wor$|\.\.\.$/);
  });
  test('qb.js with the b2416ebc drafts: each reason printed complete (no mid-word "..."), with the artifact location', () => {
    const repo = makeRepo({ 'package.json': '{"name":"x","scripts":{"test":"node --test"}}', 'lib/serializer.js': 'module.exports = {};\n', 'test/asNumber.test.js': '' });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kan106-'));
    try {
      const r = proc.run(process.execPath, ['--require', PRELOAD_OLLAMA, QB, REQUEST, '--repo', repo.dir, '--agent', 'dry-run', '--no-llm-context', '--no-llm-verify'], {
        env: { ...process.env, QB_RUNS_DIR: path.join(tmp, 'runs'), QB_MEMORY_DIR: path.join(tmp, 'mem'), QB_TEST_OLLAMA_SEQUENCE: JSON.stringify([INITIAL, REPAIRED]), QB_L1_BUDGET_MS: '' },
        encoding: 'utf8', timeout: 60_000,
      });
      const out = r.stdout + r.stderr;
      assert.equal(r.status, 2, out);
      assert.ok(out.includes(`• ${SMOKE.errors[1][0]}`), out);
      assert.doesNotMatch(out, /require the added t\.\.\./);
      assert.match(out, /Engineering details: .* \(artifact contract-repair\)/);
    } finally { repo.cleanup(); fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});
