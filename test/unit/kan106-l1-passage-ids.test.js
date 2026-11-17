/**
 * KAN-106 (senior comment 10666, Qwen L1 smoke run 9e0d3257-7839-4e7c-862b-81fa5961aaa9 on d946ff3):
 * qwen2.5-coder:14b reached L1 in dry-run mode, but its first checklist AND the one automatic repair
 * were rejected by the traceability validator: it retyped the request's clauses instead of copying
 * them ("Keep the behavior for string '0'"), and left the source file, "instead of returning 0." and
 * part of the preservation and test instructions untraced. The repair repeated the draft verbatim.
 *
 * Fix: the prompt gives the model the request split into numbered passages (P1…Pn,
 * intent/passages.js). The model cites passage ids per requirement (`passage_ids`) instead of
 * retyping quotes; QB copies the exact source text into `quote`. One passage may support several
 * requirements. Unknown or non-adjacent ids are validation errors, and the coverage rule is
 * unchanged: every passage must be inside some requirement's span, and every requirement is covered
 * by a criterion or is `disposition: "context"` with a reason. Literal quotes still work as before.
 *
 * Also: L1 timings (initial call, validation, each repair call, L1 overall) in the handoff, the run
 * events and the CLI, and a configurable L1 budget recorded in the run.
 *
 * Fixtures: test/fixtures/kan106 — malformed-draft.json is the model-authored part of the rejected
 * draft stored in that run's contract-repair artifact (the repair was byte-identical), and
 * smoke-errors.json the validator's errors from that run. passage-draft.json is that draft as a
 * passage-citing model would write it: requirements by passage id, a criterion for the requested
 * tests, and a scope that does not protect the files it allows (KAN-105, merged after d946ff3,
 * rejects the smoke draft's scope too). No live model.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const proc = require('../../lib/proc');
const { mockFetch, ollamaReply } = require('../helpers/mocks');
const { makeRepo } = require('../helpers/tmprepo');
const { compileIntent } = require('../../intent/session');
const { contractState } = require('../../intent/contract-state');
const { validateTraceability } = require('../../intent/requirements');

const FIX = path.join(__dirname, '..', 'fixtures', 'kan106');
const REQUEST = fs.readFileSync(path.join(FIX, 'request.txt'), 'utf8').trim();
const MALFORMED = fs.readFileSync(path.join(FIX, 'malformed-draft.json'), 'utf8');
const PASSAGE = fs.readFileSync(path.join(FIX, 'passage-draft.json'), 'utf8');
const SMOKE_ERRORS = JSON.parse(fs.readFileSync(path.join(FIX, 'smoke-errors.json'), 'utf8'));
const QB = path.join(__dirname, '..', '..', 'qb.js');
const PRELOAD_OLLAMA = path.join(__dirname, '..', 'helpers', 'preload-ollama.js');

/** The passage-ID draft with `edit` applied to a fresh copy. */
const variant = (edit) => { const d = JSON.parse(PASSAGE); edit(d); return JSON.stringify(d); };

/** compileIntent through the real compiler, with the model replying `replies` in order. */
async function compileWith(replies, o = {}) {
  let i = 0;
  const m = mockFetch(async () => {
    const k = Math.min(i++, replies.length - 1);
    if (o.onCall) await o.onCall(k);
    return ollamaReply(replies[k]);
  });
  try {
    const s = await compileIntent(REQUEST, o.session || {});
    return { s, calls: m.calls.length, prompts: m.calls.map((c) => JSON.parse(c.init.body).messages) };
  } finally { m.restore(); }
}

const EXPECTED_PASSAGES = [
  'In lib/serializer.js,',
  'make Serializer.asNumber() throw a number conversion error for an empty string or a string containing only whitespace instead of returning 0.',
  'Keep the behavior for numeric 0,',
  'string "0",',
  'and valid numeric strings.',
  'Add node:test cases in test/asNumber.test.js.',
];

describe('KAN-106: the Qwen smoke draft, reproduced offline through compile()', () => {
  test('the exact smoke draft (first draft and identical repair) is rejected with the smoke\'s own errors; nothing is finalized', async () => {
    const { s, calls } = await compileWith([MALFORMED, MALFORMED]);
    assert.equal(calls, 2, 'one draft and one repair, as in the smoke');
    assert.equal(s.state, 'invalid');
    assert.equal(s.repair.rejected.length, 2);
    // KAN-105 (d71b1f5, merged after d946ff3) now also rejects the draft's self-defeating scope
    // (it protects lib/**/* and **/*.test.js while allowing lib/serializer.js and the test file),
    // and contractState reports policy errors before traceability ones.
    assert.match(s.errors.join('\n'), /allowed_changes entry "lib\/serializer\.js" is entirely covered by scope\.protected_paths "lib\/\*\*\/\*"/);
    // The traceability errors are exactly the smoke's, from the same validator (intent/requirements.js
    // is unchanged since d946ff3), on the contract compile() built from the draft.
    assert.deepEqual(validateTraceability(s.contract).errors, SMOKE_ERRORS);
  });
});

describe('KAN-106: request passages (split rule)', () => {
  test('the smoke request splits into six passages at sentence and clause ends; paths, method calls and node:test stay whole', () => {
    const { splitPassages } = require('../../intent/passages');
    const ps = splitPassages(REQUEST);
    assert.deepEqual(ps.map((p) => p.id), ['P1', 'P2', 'P3', 'P4', 'P5', 'P6']);
    assert.deepEqual(ps.map((p) => p.text), EXPECTED_PASSAGES);
    for (const p of ps) assert.equal(REQUEST.slice(p.start, p.end), p.text, `${p.id} is the exact source text`);
    // The passages tile the request: only whitespace lies between them.
    let at = 0;
    for (const p of ps) { assert.match(REQUEST.slice(at, p.start), /^\s*$/); at = p.end; }
    assert.match(REQUEST.slice(at), /^\s*$/);
  });

  test('no split inside parentheses, brackets or backticks, or at a dot/colon/comma not followed by whitespace; newlines and ;?! end passages', () => {
    const { splitPassages } = require('../../intent/passages');
    const texts = (s) => splitPassages(s).map((p) => p.text);
    assert.deepEqual(texts('Make clamp(5, 0, 3) return 3. Keep `a, b` as is'), ['Make clamp(5, 0, 3) return 3.', 'Keep `a, b` as is']);
    assert.deepEqual(texts('Fix src/a.js; keep 1,000 and v1.2.3 intact? Yes!'), ['Fix src/a.js;', 'keep 1,000 and v1.2.3 intact?', 'Yes!']);
    assert.deepEqual(texts('Say "stop." Then go\n- add tests\n- update docs'), ['Say "stop."', 'Then go', '- add tests', '- update docs']);
    assert.deepEqual(texts('   '), []);
  });

  test('the compiler prompt lists the passages with their ids, the exact text, after the request', async () => {
    const { prompts } = await compileWith([PASSAGE]);
    const user = prompts[0].find((m) => m.role === 'user').content;
    assert.ok(user.startsWith(`REQUEST:\n${REQUEST}`), 'the request itself is unchanged');
    for (const [i, t] of EXPECTED_PASSAGES.entries()) assert.ok(user.includes(`P${i + 1}: ${t}\n`) || user.endsWith(`P${i + 1}: ${t}`), `P${i + 1} listed`);
    const system = prompts[0].find((m) => m.role === 'system').content;
    assert.match(system, /passage_ids/);
  });
});

describe('KAN-106: passage-ID requirements through compile()', () => {
  test('the smoke draft citing passage ids is finalized in one call; QB copies the exact source text; one passage supports two requirements', async () => {
    const { s, calls } = await compileWith([PASSAGE, MALFORMED]);
    assert.equal(s.state, 'finalized', JSON.stringify(s.errors));
    assert.equal(calls, 1);
    const q = Object.fromEntries(s.contract.requirements.map((r) => [r.id, r.quote]));
    assert.equal(q['R-1'], `${EXPECTED_PASSAGES[0]} ${EXPECTED_PASSAGES[1]}`, 'adjacent passages copied as one exact span');
    assert.equal(q['R-2'], EXPECTED_PASSAGES[1], 'P2 also supports R-2');
    assert.equal(q['R-3'], 'Keep the behavior for numeric 0,');
    assert.equal(q['R-4'], 'string "0",', 'copied, not retyped (the smoke wrote "Keep the behavior for string \'0\'")');
    assert.equal(q['R-5'], 'and valid numeric strings.');
    assert.equal(q['R-6'], 'Add node:test cases in test/asNumber.test.js.');
    for (const r of s.contract.requirements) assert.ok(REQUEST.includes(r.quote), `${r.id} quote is verbatim`);
    // The checklist covers what the senior listed: the source file (in R-1's span), empty AND
    // whitespace-only strings instead of returning 0, the three preserved cases, the tests.
    const crit = s.contract.acceptance_criteria.map((a) => `${a.id} ${a.requirement_ids.join(',')} ${a.criterion}`).join('\n');
    assert.match(crit, /AC-1 R-1 .*empty string/);
    assert.match(crit, /AC-2 R-2 .*only whitespace/);
    assert.match(crit, /AC-3 R-3 .*numeric 0/);
    assert.match(crit, /AC-4 R-4 .*string '0'/);
    assert.match(crit, /AC-5 R-5 .*valid numeric strings/);
    assert.match(crit, /AC-6 R-6 .*test\/asNumber\.test\.js/);
  });

  test('a paraphrased quote next to passage ids is replaced by the exact text of the passages (the ids decide)', async () => {
    const { s } = await compileWith([variant((d) => { d.requirements[3].quote = "Keep the behavior for string '0'"; })]);
    assert.equal(s.state, 'finalized', JSON.stringify(s.errors));
    assert.equal(s.contract.requirements[3].quote, 'string "0",');
  });

  test('an unknown passage id is a validation error, sent back once; the correction is validated from scratch', async () => {
    const bad = variant((d) => { d.requirements[5].passage_ids = ['P7']; });
    const { s, calls, prompts } = await compileWith([bad, PASSAGE]);
    assert.equal(calls, 2);
    assert.equal(s.state, 'finalized', JSON.stringify(s.errors));
    const sent = prompts[1].map((m) => m.content).join('\n');
    assert.match(sent, /R-6 cites unknown passage "P7" \(the request has passages P1–P6\)/);
    assert.match(sent, /passage P6 "Add node:test cases in test\/asNumber\.test\.js\." is not cited by any requirement/);
  });

  for (const [label, edit, re] of [
    ['malformed ids', (d) => { d.requirements[2].passage_ids = ['3']; }, /R-3 cites unknown passage "3"/],
    ['an empty list', (d) => { d.requirements[2].passage_ids = []; }, /R-3 passage_ids is empty/],
    ['non-adjacent passages', (d) => { d.requirements[2].passage_ids = ['P3', 'P5']; }, /R-3 cites passages P3, P5, which are not adjacent/],
  ]) {
    test(`${label} is a validation error`, async () => {
      const { s } = await compileWith([variant(edit), variant(edit)]);
      assert.equal(s.state, 'invalid');
      assert.match(s.errors.join('\n'), re);
    });
  }

  test('missing coverage stays an error: the test instruction (P6) uncited', async () => {
    const drop = variant((d) => { d.requirements.pop(); d.acceptance_criteria.pop(); });
    const { s } = await compileWith([drop, drop]);
    assert.equal(s.state, 'invalid');
    const errors = s.errors.join('\n');
    assert.match(errors, /passage P6 "Add node:test cases in test\/asNumber\.test\.js\." is not cited by any requirement/);
    assert.match(errors, /request text not traced to any requirement: "add node:test cases in test\/asnumber\.test\.js\."/, 'the existing QB-14 rule still reports it');
  });

  test('missing coverage stays an error: the source file (P1) and "instead of returning 0." cannot be dropped', async () => {
    const drop = variant((d) => { d.requirements[0].passage_ids = ['P2']; d.requirements = d.requirements.filter((r) => r.id !== 'R-2'); d.acceptance_criteria[1].requirement_ids = ['R-1']; });
    const { s } = await compileWith([drop, drop]);
    assert.equal(s.state, 'invalid');
    assert.match(s.errors.join('\n'), /passage P1 "In lib\/serializer\.js," is not cited by any requirement/);
    assert.match(s.errors.join('\n'), /request text not traced to any requirement: "in lib\/serializer\.js,"/);
    // A quote cannot drop a clause inside a passage: a literal quote without "instead of returning 0."
    const partial = variant((d) => { d.requirements[1] = { id: 'R-2', quote: 'make Serializer.asNumber() throw a number conversion error for an empty string or a string containing only whitespace' }; d.requirements[0].passage_ids = ['P1']; d.acceptance_criteria[0].requirement_ids = ['R-2']; d.acceptance_criteria.push({ id: 'AC-7', criterion: 'lib/serializer.js is the file changed.', met: null, kind: 'non_behavioral', requirement_ids: ['R-1'] }); });
    const r = await compileWith([partial, partial]);
    assert.equal(r.s.state, 'invalid');
    assert.match(r.s.errors.join('\n'), /request text not traced to any requirement: "instead of returning 0\."/);
  });

  test('a cited passage still needs a criterion, or disposition "context" with a reason', async () => {
    const ctxNoReason = variant((d) => { d.requirements[0].passage_ids = ['P1']; d.requirements[1].passage_ids = ['P2']; d.acceptance_criteria[0].requirement_ids = ['R-2']; });
    const a = await compileWith([ctxNoReason, ctxNoReason]);
    assert.equal(a.s.state, 'invalid');
    assert.match(a.s.errors.join('\n'), /requirement R-1 "In lib\/serializer\.js," is not covered by any acceptance criterion/);
    const ctx = variant((d) => { d.requirements[0] = { id: 'R-1', passage_ids: ['P1'], disposition: 'context', reason: 'the file the change belongs in' }; d.requirements[1].passage_ids = ['P2']; d.acceptance_criteria[0].requirement_ids = ['R-2']; });
    const b = await compileWith([ctx]);
    assert.equal(b.s.state, 'finalized', JSON.stringify(b.s.errors));
    assert.equal(b.s.contract.requirements[0].quote, 'In lib/serializer.js,');
  });

  test('backward compatible: literal verbatim quotes are validated by the existing rule, alone or mixed with passage ids', async () => {
    const quotes = variant((d) => { d.requirements = d.requirements.map((r, i) => ({ id: r.id, quote: i === 0 ? `${EXPECTED_PASSAGES[0]} ${EXPECTED_PASSAGES[1]}` : EXPECTED_PASSAGES[i] })); });
    const a = await compileWith([quotes]);
    assert.equal(a.s.state, 'finalized', JSON.stringify(a.s.errors));
    const mixed = variant((d) => { d.requirements[3] = { id: 'R-4', quote: 'string "0",' }; });
    const b = await compileWith([mixed]);
    assert.equal(b.s.state, 'finalized', JSON.stringify(b.s.errors));
  });

  test('a contract whose quote was edited away from its passage ids is invalid (the validator re-derives the text)', async () => {
    const { s } = await compileWith([PASSAGE]);
    const edited = JSON.parse(JSON.stringify(s.contract));
    edited.requirements[3].quote = 'string';
    const cs = contractState(edited);
    assert.equal(cs.state, 'invalid');
    assert.match(cs.errors.join('\n'), /R-4 quote does not match its passages P4/);
  });

  test('a repeated passage text is located by its id, not by "occurrence"', async () => {
    const { splitPassages } = require('../../intent/passages');
    const { validateTraceability } = require('../../intent/requirements');
    const req = 'Add tests. Fix the bug. Add tests.';
    assert.deepEqual(splitPassages(req).map((p) => p.text), ['Add tests.', 'Fix the bug.', 'Add tests.']);
    const c = { raw_request: req,
      requirements: [{ id: 'R-1', passage_ids: ['P1'], quote: 'Add tests.' }, { id: 'R-2', passage_ids: ['P2'], quote: 'Fix the bug.' }],
      acceptance_criteria: [{ id: 'AC-1', criterion: 'tests', requirement_ids: ['R-1'] }, { id: 'AC-2', criterion: 'bug', requirement_ids: ['R-2'] }] };
    const errors = validateTraceability(c).errors.join('\n');
    assert.match(errors, /passage P3 "Add tests\." is not cited/, 'P1 does not cover the repeat in P3');
    assert.doesNotMatch(errors, /occurs 2 times/);
  });
});

describe('KAN-106: L1 timings and the L1 budget', () => {
  test('fake clock: initial call, validation, the repair call and L1 overall are recorded exactly', async () => {
    let clock = 10_000;
    const now = () => clock;
    // The model "takes" 1500 ms for the draft and 2500 ms for the repair.
    const { s } = await compileWith([MALFORMED, PASSAGE], { session: { now }, onCall: (k) => { clock += k === 0 ? 1500 : 2500; } });
    assert.equal(s.state, 'finalized', JSON.stringify(s.errors));
    const t = s.timings;
    assert.equal(t.schema, 'qb-l1-timings/1');
    assert.equal(t.initial_call_ms, 1500);
    assert.deepEqual(t.repair_call_ms, [2500]);
    assert.equal(t.validation_ms, 0, 'no clock time passes during validation on the fake clock');
    assert.equal(t.l1_ms, 4000);
    assert.deepEqual(t.calls.map((c) => [c.kind, c.round, c.ms, c.outcome]), [['initial', 1, 1500, 'invalid'], ['repair', 1, 2500, 'finalized']]);
  });

  test('fake clock: no repair → repair_call_ms is empty; validation time is measured around the validator', async () => {
    let clock = 0;
    const { s } = await compileWith([PASSAGE], { session: { now: () => clock++ }, onCall: () => { clock += 700; } });
    assert.equal(s.state, 'finalized');
    assert.deepEqual(s.timings.repair_call_ms, []);
    assert.ok(s.timings.validation_ms >= 1, 'the validator ran between two clock reads');
    assert.ok(s.timings.initial_call_ms >= 700);
    assert.ok(s.timings.l1_ms >= s.timings.initial_call_ms + s.timings.validation_ms);
  });

  test('real clock: a model that answers after 60 ms yields initial_call_ms ≥ 60', async () => {
    const { s } = await compileWith([PASSAGE], { onCall: () => new Promise((r) => setTimeout(r, 60)) });
    assert.ok(s.timings.initial_call_ms >= 55, JSON.stringify(s.timings));
    assert.ok(s.timings.l1_ms >= s.timings.initial_call_ms);
  });

  test('a failed repair call still reports the timings so far (error.l1_timings)', async () => {
    let i = 0;
    const m = mockFetch(() => { if (i++ === 0) return ollamaReply(MALFORMED); throw new Error('connection reset'); });
    try {
      await assert.rejects(compileIntent(REQUEST), (e) => {
        assert.equal(e.l1_timings.schema, 'qb-l1-timings/1');
        assert.equal(e.l1_timings.calls.length, 2);
        assert.equal(e.l1_timings.calls[1].outcome, 'error');
        return true;
      });
    } finally { m.restore(); }
  });

  test('L1 budget: provisional default is one draft + one repair at the per-call deadline; env and --l1-budget override; recorded with its source', () => {
    const budget = require('../../lib/budget');
    const { validateRunOptions } = require('../../lib/run-options');
    const saved = { b: process.env.QB_L1_BUDGET_MS, c: process.env.QB_MODEL_CALL_TIMEOUT_MS };
    try {
      delete process.env.QB_L1_BUDGET_MS; delete process.env.QB_MODEL_CALL_TIMEOUT_MS;
      assert.deepEqual(budget.l1Budget(), { ms: 360_000, source: 'provisional_default', enforced: false });
      process.env.QB_MODEL_CALL_TIMEOUT_MS = '100000';
      assert.equal(budget.l1Budget().ms, 200_000);
      process.env.QB_L1_BUDGET_MS = '240000';
      assert.deepEqual(budget.l1Budget(), { ms: 240_000, source: 'env QB_L1_BUDGET_MS', enforced: false });
      assert.deepEqual(budget.l1Budget({ flagMs: 90_000 }), { ms: 90_000, source: '--l1-budget', enforced: false });
      const base = { agent: 'dry-run', repo: os.tmpdir(), maxRetries: '3' };
      assert.equal(validateRunOptions({ ...base, l1Budget: '300' }, 'x').l1BudgetMs, 300_000);
      assert.match(validateRunOptions({ ...base, l1Budget: 'soon' }, 'x').errors.join('\n'), /--l1-budget must be a positive number of seconds/);
      assert.equal(validateRunOptions(base, 'x').l1BudgetMs, 0);
    } finally {
      for (const [k, v] of [['QB_L1_BUDGET_MS', saved.b], ['QB_MODEL_CALL_TIMEOUT_MS', saved.c]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });

  /** qb.js end to end in dry-run mode, model replies scripted; returns the output and the run record. */
  function runCli(replies, extra = [], env = {}) {
    const repo = makeRepo({ 'package.json': '{"name":"x","scripts":{"test":"node --test"}}', 'lib/serializer.js': 'module.exports = {};\n', 'test/asNumber.test.js': '' });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kan106-'));
    try {
      const runs = path.join(tmp, 'runs');
      const r = proc.run(process.execPath, ['--require', PRELOAD_OLLAMA, QB, REQUEST, '--repo', repo.dir, '--agent', 'dry-run', '--no-llm-context', '--no-llm-verify', ...extra], {
        env: { ...process.env, QB_RUNS_DIR: runs, QB_MEMORY_DIR: path.join(tmp, 'mem'), QB_TEST_OLLAMA_SEQUENCE: JSON.stringify(replies), QB_L1_BUDGET_MS: '', ...env },
        encoding: 'utf8', timeout: 60_000,
      });
      const [id] = fs.readdirSync(runs);
      const dir = path.join(runs, id);
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
      const events = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      return { status: r.status, out: r.stdout + r.stderr, manifest, events };
    } finally { repo.cleanup(); fs.rmSync(tmp, { recursive: true, force: true }); }
  }

  test('qb.js dry run with a passage-ID draft: DRY_RUN, an l1.timings event with the budget, timings printed', () => {
    const r = runCli([PASSAGE], ['--l1-budget', '300']);
    assert.equal(r.manifest.outcome, 'DRY_RUN', r.out);
    const ev = r.events.find((e) => e.type === 'l1.timings');
    assert.ok(ev, 'l1.timings event');
    assert.equal(ev.data.schema, 'qb-l1-timings/1');
    for (const k of ['initial_call_ms', 'validation_ms', 'l1_ms']) assert.ok(Number.isInteger(ev.data[k]) && ev.data[k] >= 0, k);
    assert.deepEqual(ev.data.repair_call_ms, []);
    assert.deepEqual(ev.data.budget, { ms: 300_000, source: '--l1-budget', enforced: false, over_budget: false });
    assert.match(r.out, /\[L1\]\s+Timings: first draft \d+(\.\d)?s · validation \d+(\.\d)?s · repair none · L1 total \d+(\.\d)?s \(budget 300s from --l1-budget, not enforced\)/);
  });

  test('qb.js dry run with the smoke draft: BLOCKED as in the smoke, and the timings of both calls are in the run record and the output', () => {
    const r = runCli([MALFORMED, MALFORMED]);
    assert.equal(r.status, 2, r.out);
    assert.equal(r.manifest.outcome, 'BLOCKED');
    // On main, KAN-105's scope rule reports first (see the reproduction test above).
    assert.match(r.manifest.outcome_reason, /^invalid_contract_after_repair: scope\.allowed_changes entry "lib\/serializer\.js" is entirely covered/);
    const ev = r.events.find((e) => e.type === 'l1.timings');
    assert.ok(ev, 'l1.timings event');
    assert.equal(ev.data.repair_call_ms.length, 1);
    assert.equal(ev.data.budget.source, 'provisional_default');
    assert.match(r.out, /\[L1\]\s+Timings: first draft .* · repair \d+(\.\d)?s · L1 total .*provisional/);
  });
});
