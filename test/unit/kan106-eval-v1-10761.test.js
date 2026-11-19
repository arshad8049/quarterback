/**
 * KAN-106 10761 (senior review of the c89ddf2 package): three harness fixes before launch. Offline only: no
 * model call, and no generated checklist for any of the eight frozen requests. Every run record here is a
 * hand-built FIXTURE (failure, refusal or corrupt shapes); the batch loop is exercised with a FAKE qb.js that
 * only records how it was launched.
 *
 *   1. an unsuccessful execution never scores as a successful refusal; all eight rows, fixed denominators
 *   2. the launched child gets the pinned local endpoint, model and L1 budget, whatever it inherits
 *   3. a scored record must match its frozen item (revision, request, base, model, profile, budget, agent)
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const EVAL = path.join(ROOT, 'bench', 'kan106-eval-v1');
const FREEZE = JSON.parse(fs.readFileSync(path.join(EVAL, 'FREEZE.json'), 'utf8'));
const IDS = FREEZE.order;
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const REV = 'a'.repeat(40);
const QWEN = 'qwen2.5-coder:14b';

// ── fixtures ────────────────────────────────────────────────────────────────
function writeRun(root, runId, { manifest, artifacts = {}, events = [] }) {
  const dir = path.join(root, runId);
  fs.mkdirSync(path.join(dir, 'artifacts'), { recursive: true });
  const refs = {};
  for (const [name, obj] of Object.entries(artifacts)) {
    const buf = Buffer.from(JSON.stringify(obj));
    const h = sha(buf);
    fs.writeFileSync(path.join(dir, 'artifacts', `${h}.json`), buf);
    refs[name] = { name, sha256: h, path: `artifacts/${h}.json`, bytes: buf.length };
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ ...manifest, run_id: runId, artifacts: refs }));
  fs.writeFileSync(path.join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return dir;
}
function manifestFor(id, over = {}) {
  const { requestOf } = require('../../bench/kan106-eval-v1/score');
  return {
    schema_version: 1, kind: 'qb', qb_revision: REV, request: requestOf(id),
    repo: { path: '/fixture', identity: 'fixture', base_sha: FREEZE.base_shas[id] },
    agent: { type: 'dry-run', version: 'builtin', isolation: 'none' },
    models: { intent: QWEN, context: QWEN, judge: QWEN },
    config: { ...FREEZE.expected_config, repo: '/fixture', maxRetries: 3, clarify: [] },
    outcome: 'BLOCKED', outcome_reason: null, attempts: [], ...over,
  };
}
const timings = (over = {}) => ({ type: 'l1.timings', data: { schema: 'qb-l1-timings/1', l1_ms: 1200, calls: [],
  l1_budget: { ms: 420000, source: '--l1-budget', enforced: true, per_call_ms: 240000, profile: 'qwen-14b-staged', exhausted: false }, ...over } });
const staged = (over = {}) => ({ format: 'qb-staged-l1/1', roles: [], call_targets: [], unsupported_targets: [], fragments: [], fragment_list: [], facts: [], ...over });
const U1_REASON = 'the constructor of UserRepo in lib/users.js may need arguments QB cannot supply (QB constructs with new and no arguments)';
const shapes = {
  u1Refusal: (id = 'U1-userrepo') => ({
    manifest: manifestFor(id, { outcome_reason: `staged_l1_invalid: unsupported call shape UserRepo.find: ${U1_REASON}` }),
    artifacts: { 'contract-staged': staged({ unsupported_targets: [{ label: 'UserRepo.find', module: 'lib/users.js', kind: 'default_class', grounding: 'unsupported', reason: U1_REASON }] }) },
    events: [timings()],
  }),
  u2Refusal: (id = 'U2-roundto') => ({
    manifest: manifestFor(id, { outcome_reason: 'staged_l1_invalid: the staged L1 prototype does not ask clarification questions: what should roundTo return for a negative number?' }),
    artifacts: { 'contract-staged': staged() }, events: [timings()],
  }),
  invalidJson: (id) => ({
    manifest: manifestFor(id, { outcome_reason: "staged_l1_invalid: R-1 (P-1): the model's facts were refused after one repair: the reply is not JSON" }),
    artifacts: { 'contract-staged': staged({ facts: [{ requirement_id: 'R-1', attempts: [{ model: QWEN, errors: ['the reply is not JSON'] }, { model: QWEN, errors: ['the reply is not JSON'] }], cases: null }] }) },
    events: [timings({ calls: [{ requirement_id: 'R-1', ms: 900, outcome: 'invalid' }, { requirement_id: 'R-1', ms: 800, outcome: 'invalid' }] })],
  }),
  timeout: (id) => ({
    manifest: manifestFor(id, { outcome: 'CANCELLED', outcome_reason: 'L1 budget (420000ms, --l1-budget) exhausted during the R-1 fact call' }),
    artifacts: { 'contract-staged': staged({ facts: [{ requirement_id: 'R-1', attempts: [], cases: null }] }) },
    events: [timings({ l1_ms: 420004, l1_budget: { ms: 420000, source: '--l1-budget', enforced: true, per_call_ms: 240000, profile: 'qwen-14b-staged', exhausted: true } })],
  }),
  transport: (id) => ({ manifest: manifestFor(id, { outcome: 'ERROR', outcome_reason: 'fetch failed (connect ECONNREFUSED 127.0.0.1:11434)' }), events: [] }),
};
const EXIT = { BLOCKED: 2, DRY_RUN: 0, ERROR: 1, CANCELLED: 3 };
/** A runs root + runs.json from { id: shape }. Items without a shape get no batch entry at all. */
function batch(spec) {
  const root = tmp('kan106-10761-runs-');
  const runs = {};
  for (const [id, s] of Object.entries(spec)) {
    const runId = crypto.randomUUID();
    writeRun(root, runId, s);
    runs[id] = { run_id: runId, exit_code: s.exit_code !== undefined ? s.exit_code : EXIT[s.manifest.outcome], signal: null };
  }
  return { root, runs };
}
const score = (b, o = {}) => require('../../bench/kan106-eval-v1/score').scoreBatch({ runs: b.runs, runsRoot: b.root, qbRevision: REV, ...o });
const row = (out, id) => out.items.find((x) => x.id === id);

// ── 1. unsuccessful execution is never a successful refusal ─────────────────
describe('10761 fix 1: outcomes from the frozen roster, never a failure counted as a refusal', () => {
  test('all eight rows are reported, with fixed denominators 6 supported / 2 unsupported, even when runs are missing', () => {
    const b = batch({ 'U1-userrepo': shapes.u1Refusal() });
    try {
      const out = score(b);
      assert.deepEqual(out.items.map((x) => x.id), IDS);
      assert.equal(out.summary.supported.total, 6);
      assert.equal(out.summary.unsupported.total, 2);
      for (const id of IDS.filter((x) => x !== 'U1-userrepo')) assert.equal(row(out, id).result, 'invalid_record', id);
      assert.match(row(out, 'S1-slug').problems.join(' '), /no batch entry/);
      assert.equal(out.summary.supported.by_result.invalid_record, 6);
      assert.equal(out.summary.unsupported.intended_refusals, 1);
    } finally { fs.rmSync(b.root, { recursive: true, force: true }); }
  });
  test('a run id that was never recorded is invalid, not a refusal', () => {
    const b = batch({});
    try {
      const out = score({ ...b, runs: { 'U2-roundto': { run_id: null, exit_code: 1, signal: null } } });
      assert.equal(row(out, 'U2-roundto').result, 'invalid_record');
      assert.equal(out.summary.unsupported.intended_refusals, 0);
    } finally { fs.rmSync(b.root, { recursive: true, force: true }); }
  });
  test('genuine U1/U2-style refusals (task-relevant decision, no checklist, no agent launch) are intended refusals', () => {
    const b = batch({ 'U1-userrepo': shapes.u1Refusal(), 'U2-roundto': shapes.u2Refusal() });
    try {
      const out = score(b);
      assert.equal(row(out, 'U1-userrepo').result, 'intended_refusal');
      assert.equal(row(out, 'U1-userrepo').decision.kind, 'unsupported_call_shape');
      assert.equal(row(out, 'U2-roundto').result, 'intended_refusal');
      assert.equal(row(out, 'U2-roundto').decision.kind, 'clarification');
      assert.equal(out.summary.unsupported.intended_refusals, 2);
    } finally { fs.rmSync(b.root, { recursive: true, force: true }); }
  });
  test('a refusal for the wrong reason is "safely blocked", not an intended refusal', () => {
    const b = batch({ 'U2-roundto': shapes.u1Refusal('U2-roundto'), 'U1-userrepo': shapes.u2Refusal('U1-userrepo') });
    try {
      const out = score(b);
      assert.equal(row(out, 'U1-userrepo').result, 'blocked_other_reason');
      assert.equal(row(out, 'U2-roundto').result, 'blocked_other_reason');
      assert.equal(out.summary.unsupported.intended_refusals, 0);
      assert.equal(out.summary.unsupported.blocked_other_reason, 2);
    } finally { fs.rmSync(b.root, { recursive: true, force: true }); }
  });
  test('generic invalid JSON from the model is not evidence of an intended refusal', () => {
    const b = batch({ 'U1-userrepo': shapes.invalidJson('U1-userrepo'), 'U2-roundto': shapes.invalidJson('U2-roundto') });
    try {
      const out = score(b);
      for (const id of ['U1-userrepo', 'U2-roundto']) {
        assert.equal(row(out, id).result, 'blocked_other_reason', id);
        assert.equal(row(out, id).decision.kind, 'invalid_model_output', id);
      }
      assert.equal(out.summary.unsupported.intended_refusals, 0);
    } finally { fs.rmSync(b.root, { recursive: true, force: true }); }
  });
  test('a timeout or a transport failure is an execution failure, on supported and unsupported items alike', () => {
    const b = batch({ 'U1-userrepo': shapes.timeout('U1-userrepo'), 'U2-roundto': shapes.transport('U2-roundto'), 'S1-slug': shapes.timeout('S1-slug'), 'S2-formatter': shapes.transport('S2-formatter') });
    try {
      const out = score(b);
      assert.deepEqual([row(out, 'U1-userrepo').result, row(out, 'U1-userrepo').failure.kind], ['execution_failed', 'timeout']);
      assert.deepEqual([row(out, 'U2-roundto').result, row(out, 'U2-roundto').failure.kind], ['execution_failed', 'model_or_transport']);
      assert.deepEqual([row(out, 'S1-slug').result, row(out, 'S1-slug').failure.kind], ['execution_failed', 'timeout']);
      assert.deepEqual([row(out, 'S2-formatter').result, row(out, 'S2-formatter').failure.kind], ['execution_failed', 'model_or_transport']);
      assert.equal(out.summary.unsupported.intended_refusals, 0);
      assert.equal(out.summary.unsupported.execution_failed, 2);
      assert.equal(out.summary.supported.by_result.execution_failed, 2);
    } finally { fs.rmSync(b.root, { recursive: true, force: true }); }
  });
  test('a process killed by a signal is a crash, never a refusal', () => {
    const b = batch({ 'U1-userrepo': { ...shapes.u1Refusal(), manifest: manifestFor('U1-userrepo', { outcome: 'RUNNING' }), exit_code: null } });
    try {
      const out = score({ ...b, runs: { 'U1-userrepo': { ...b.runs['U1-userrepo'], signal: 'SIGKILL' } } });
      assert.deepEqual([row(out, 'U1-userrepo').result, row(out, 'U1-userrepo').failure.kind], ['execution_failed', 'crash']);
    } finally { fs.rmSync(b.root, { recursive: true, force: true }); }
  });
  test('a corrupt artifact or event log makes that row invalid and the other rows are still reported', () => {
    const b = batch({ 'U1-userrepo': shapes.u1Refusal(), 'U2-roundto': shapes.u2Refusal() });
    try {
      const u1 = path.join(b.root, b.runs['U1-userrepo'].run_id);
      const ref = JSON.parse(fs.readFileSync(path.join(u1, 'manifest.json'), 'utf8')).artifacts['contract-staged'];
      fs.appendFileSync(path.join(u1, ref.path), ' ');
      fs.appendFileSync(path.join(b.root, b.runs['U2-roundto'].run_id, 'events.jsonl'), '{not json\n');
      const out = score(b);
      assert.equal(row(out, 'U1-userrepo').result, 'invalid_record');
      assert.match(row(out, 'U1-userrepo').problems.join(' '), /contract-staged.*sha256/);
      assert.equal(row(out, 'U2-roundto').result, 'invalid_record');
      assert.match(row(out, 'U2-roundto').problems.join(' '), /events\.jsonl/);
      assert.equal(out.items.length, 8);
    } finally { fs.rmSync(b.root, { recursive: true, force: true }); }
  });
  test('a missing manifest is invalid, not a refusal', () => {
    const b = batch({ 'U1-userrepo': shapes.u1Refusal() });
    try {
      fs.rmSync(path.join(b.root, b.runs['U1-userrepo'].run_id, 'manifest.json'));
      assert.equal(row(score(b), 'U1-userrepo').result, 'invalid_record');
    } finally { fs.rmSync(b.root, { recursive: true, force: true }); }
  });
  test('an unexpected agent identity is invalid, even with a perfect refusal', () => {
    const s = shapes.u1Refusal();
    s.manifest.agent = { type: 'claude-code', version: '2.1.322', isolation: 'docker' };
    const b = batch({ 'U1-userrepo': s });
    try {
      const r = row(score(b), 'U1-userrepo');
      assert.equal(r.result, 'invalid_record');
      assert.match(r.problems.join(' '), /agent/);
    } finally { fs.rmSync(b.root, { recursive: true, force: true }); }
  });
  test('an agent launch (any attempt) on a refusal item is not an intended refusal', () => {
    const s = shapes.u1Refusal();
    s.manifest.attempts = [{ attempt: 1 }];
    const b = batch({ 'U1-userrepo': s });
    try { assert.notEqual(row(score(b), 'U1-userrepo').result, 'intended_refusal'); } finally { fs.rmSync(b.root, { recursive: true, force: true }); }
  });
  test('U1 must refuse before any model call (the 10758 rule): a U1 refusal after model calls is not intended', () => {
    const s = shapes.u1Refusal();
    s.artifacts['contract-staged'].facts = [{ requirement_id: 'R-1', attempts: [{ model: QWEN, errors: [] }], cases: null }];
    const b = batch({ 'U1-userrepo': s });
    try { assert.equal(row(score(b), 'U1-userrepo').result, 'blocked_other_reason'); } finally { fs.rmSync(b.root, { recursive: true, force: true }); }
  });
  test('missing timings are counted: the latency median is never presented as complete coverage', () => {
    const b = batch({ 'S1-slug': shapes.transport('S1-slug'), 'S2-formatter': shapes.timeout('S2-formatter') });
    try {
      const l = score(b).summary.latency;
      assert.equal(l.timings_expected, 6);
      assert.equal(l.timings_available, 1);
      assert.equal(l.complete_coverage, false);
      assert.deepEqual(l.missing, ['S1-slug', 'S3-percent', 'S4-parsebool', 'S5-clock', 'S6-money']);
    } finally { fs.rmSync(b.root, { recursive: true, force: true }); }
  });
});

// ── 3. a scored record is bound to its frozen item ──────────────────────────
describe('10761 fix 3: identity checks before any passing result', () => {
  test('a swapped run id (U1 pointing at U2\'s record) is invalid: request and base differ', () => {
    const b = batch({ 'U1-userrepo': shapes.u1Refusal(), 'U2-roundto': shapes.u2Refusal() });
    try {
      const swapped = { 'U1-userrepo': b.runs['U2-roundto'], 'U2-roundto': b.runs['U1-userrepo'] };
      const out = score({ ...b, runs: swapped });
      for (const id of ['U1-userrepo', 'U2-roundto']) {
        assert.equal(row(out, id).result, 'invalid_record', id);
        assert.match(row(out, id).problems.join(' '), /request/, id);
        assert.match(row(out, id).problems.join(' '), /base/, id);
      }
    } finally { fs.rmSync(b.root, { recursive: true, force: true }); }
  });
  test('an altered artifact (bytes not matching the manifest sha256) is invalid', () => {
    const b = batch({ 'U2-roundto': shapes.u2Refusal() });
    try {
      const d = path.join(b.root, b.runs['U2-roundto'].run_id);
      const ref = JSON.parse(fs.readFileSync(path.join(d, 'manifest.json'), 'utf8')).artifacts['contract-staged'];
      const obj = JSON.parse(fs.readFileSync(path.join(d, ref.path), 'utf8'));
      obj.facts = [];
      obj.note = 'edited after the run';
      fs.writeFileSync(path.join(d, ref.path), JSON.stringify(obj));
      assert.equal(row(score(b), 'U2-roundto').result, 'invalid_record');
    } finally { fs.rmSync(b.root, { recursive: true, force: true }); }
  });
  test('each identity field is checked: revision, model, profile, effective L1 budget, flags, endpoint, exit code', () => {
    const cases = {
      revision: (s) => { s.manifest.qb_revision = 'b'.repeat(40); },
      model: (s) => { s.manifest.models.intent = 'qwen2.5-coder:7b'; },
      reply_model: (s) => { s.artifacts['contract-staged'].facts = [{ requirement_id: 'R-1', attempts: [{ model: 'other:1b', errors: [] }], cases: null }]; },
      profile: (s) => { s.manifest.config.l1Profile = 'qwen-14b-experimental'; },
      budget: (s) => { s.events = [timings({ l1_budget: { ms: 1000, source: 'env QB_L1_BUDGET_MS', enforced: true, per_call_ms: 240000, profile: 'qwen-14b-staged', exhausted: false } })]; },
      per_call: (s) => { s.events = [timings({ l1_budget: { ms: 420000, source: '--l1-budget', enforced: true, per_call_ms: 180000, profile: 'qwen-14b-staged', exhausted: false } })]; },
      llm_verify: (s) => { s.manifest.config.llmVerify = true; },
      endpoint: (s) => { s.events = [timings(), { type: 'run.usage', data: { model: { endpoints: { '10.0.0.5:11434': 1 } } } }]; },
      timings_missing: (s) => { s.events = []; },
      exit_code: (s) => { s.exit_code = 0; },
    };
    for (const [name, mutate] of Object.entries(cases)) {
      const s = shapes.u2Refusal();
      mutate(s);
      const b = batch({ 'U2-roundto': s });
      try { assert.equal(row(score(b), 'U2-roundto').result, 'invalid_record', name); } finally { fs.rmSync(b.root, { recursive: true, force: true }); }
    }
  });
  test('the batch settings themselves must match the freeze, or every row is invalid', () => {
    const b = batch({ 'U1-userrepo': shapes.u1Refusal() });
    try {
      const out = score(b, { batchSettings: { model_digest: 'f'.repeat(64) } });
      assert.ok(out.batch_problems.length > 0);
      assert.equal(row(out, 'U1-userrepo').result, 'invalid_record');
    } finally { fs.rmSync(b.root, { recursive: true, force: true }); }
  });
});

// ── 2. the launched child cannot inherit another endpoint, model or budget ──
describe('10761 fix 2: batch.js pins the local endpoint, model, digest and L1 budget (fake qb.js)', () => {
  const { runBatch } = require('../../bench/kan106-eval-v1/batch');
  const TAGS = { models: [{ name: QWEN, model: QWEN, digest: FREEZE.model_digest }] };
  const FAKE = [
    "const fs = require('fs'); const path = require('path');",
    "const f = path.join(__dirname, 'seen.jsonl');",
    "const n = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\\n').filter(Boolean).length : 0;",
    "fs.appendFileSync(f, JSON.stringify({ argv: process.argv.slice(2), env: process.env, cwd: process.cwd() }) + '\\n');",
    "console.log('[RUN]  ' + require('crypto').randomUUID() + '  (fake)');",
    'process.exit([0, 2, 1, 3, 2, 0, 2, 2][n]);',
  ].join('\n');
  const CONFLICTING = {
    PATH: process.env.PATH, HOME: os.homedir(),
    QB_OLLAMA_URL: 'http://10.9.9.9:11434', QB_MODEL: 'other:1b', QB_L1_BUDGET_MS: '1', QB_L1_PROFILE: 'qwen-14b-experimental',
    QB_MODEL_CALL_TIMEOUT_MS: '5', QB_RUN_DEADLINE_MS: '1', QB_MODEL_CONCURRENCY: '9', QB_RUNS_DIR: '/elsewhere',
    NODE_OPTIONS: '--require /nonexistent-kan106-10761', ANTHROPIC_API_KEY: 'fake-not-a-key',
  };
  function setup() {
    const d = tmp('kan106-10761-batch-');
    fs.writeFileSync(path.join(d, 'fake-qb.js'), FAKE);
    const seen = () => fs.readFileSync(path.join(d, 'seen.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    return { d, out: path.join(d, 'out'), qbEntry: path.join(d, 'fake-qb.js'), seen };
  }

  test('with conflicting inherited endpoint, model, budget and NODE_OPTIONS, every launch gets exactly the pinned settings', async () => {
    const t = setup();
    const urls = [];
    try {
      const r = await runBatch({ out: t.out, expectedSha: REV, inherited: CONFLICTING, qbEntry: t.qbEntry, dotenvPath: path.join(t.d, 'no.env'),
        fetchTags: async (u) => { urls.push(u); return TAGS; }, log: () => {} });
      assert.equal(r.refused, false);
      const seen = t.seen();
      assert.equal(seen.length, 8);
      seen.forEach((s, i) => {
        const id = IDS[i];
        assert.deepEqual(Object.keys(s.env).filter((k) => !['PATH', 'HOME', 'TMPDIR', 'LANG', '__CF_USER_TEXT_ENCODING'].includes(k)).sort(), ['QB_MODEL', 'QB_OLLAMA_URL', 'QB_RUNS_DIR'], id);
        assert.equal(s.env.QB_OLLAMA_URL, 'http://127.0.0.1:11434');
        assert.equal(s.env.QB_MODEL, QWEN);
        assert.equal(s.env.QB_RUNS_DIR, path.join(t.out, 'runs'));
        for (const k of ['QB_L1_BUDGET_MS', 'QB_L1_PROFILE', 'QB_MODEL_CALL_TIMEOUT_MS', 'QB_RUN_DEADLINE_MS', 'QB_MODEL_CONCURRENCY', 'NODE_OPTIONS', 'ANTHROPIC_API_KEY']) assert.equal(s.env[k], undefined, k);
        const { requestOf } = require('../../bench/kan106-eval-v1/score');
        assert.deepEqual(s.argv, [requestOf(id), '--repo', path.join(t.out, 'repos', id), ...FREEZE.flags]);
      });
      assert.deepEqual([...new Set(urls)], ['http://127.0.0.1:11434']);
      assert.equal(urls.length, 2, 'the digest is checked before and after the batch');
      const runs = JSON.parse(fs.readFileSync(path.join(t.out, 'runs.json'), 'utf8'));
      assert.deepEqual(IDS.map((id) => runs[id].exit_code), [0, 2, 1, 3, 2, 0, 2, 2]);
      for (const id of IDS) assert.match(runs[id].run_id, /^[0-9a-f-]{36}$/);
      const b = JSON.parse(fs.readFileSync(path.join(t.out, 'batch.json'), 'utf8'));
      assert.equal(b.qb_revision, REV);
      assert.deepEqual(b.settings.flags, FREEZE.flags);
      assert.equal(b.settings.ollama_url, 'http://127.0.0.1:11434');
      assert.equal(b.settings.model_digest, FREEZE.model_digest);
      assert.deepEqual(b.settings.child_env, { QB_OLLAMA_URL: 'http://127.0.0.1:11434', QB_MODEL: QWEN, QB_RUNS_DIR: path.join(t.out, 'runs') });
      assert.equal(b.model_after.digest_matches, true);
      assert.match(b.settings.budget_note, /sum of the L1 budgets/);
    } finally { fs.rmSync(t.d, { recursive: true, force: true }); }
  });
  test('the frozen flags pass the L1 budget explicitly and disable both later model stages', () => {
    assert.deepEqual(FREEZE.flags, ['--agent', 'dry-run', '--no-llm-context', '--no-llm-verify', '--l1-profile', 'qwen-14b-staged', '--l1-budget', '420', '--deadline', '15']);
    assert.deepEqual(FREEZE.expected_config, { agent: 'dry-run', llmContext: false, llmVerify: false, l1Profile: 'qwen-14b-staged', l1Budget: '420', deadline: '15' });
    assert.match(FREEZE.model_digest, /^[0-9a-f]{64}$/);
    assert.equal(FREEZE.ollama_url, 'http://127.0.0.1:11434');
  });
  test('QB itself: --l1-budget 420 wins over an inherited QB_L1_BUDGET_MS and keeps the staged 240 s per call', () => {
    const { l1Budget } = require('../../lib/budget');
    const saved = { b: process.env.QB_L1_BUDGET_MS, p: process.env.QB_L1_PROFILE };
    process.env.QB_L1_BUDGET_MS = '1'; process.env.QB_L1_PROFILE = 'qwen-14b-experimental';
    try {
      const b = l1Budget({ flagMs: 420 * 1000, profile: 'qwen-14b-staged' });
      assert.deepEqual([b.ms, b.source, b.enforced, b.per_call_ms, b.profile], [420000, '--l1-budget', true, 240000, 'qwen-14b-staged']);
    } finally {
      if (saved.b === undefined) delete process.env.QB_L1_BUDGET_MS; else process.env.QB_L1_BUDGET_MS = saved.b;
      if (saved.p === undefined) delete process.env.QB_L1_PROFILE; else process.env.QB_L1_PROFILE = saved.p;
    }
  });
  for (const [name, tags] of Object.entries({
    'a different digest under the same tag': { models: [{ name: QWEN, model: QWEN, digest: '0'.repeat(64) }] },
    'the model missing': { models: [{ name: 'deepseek-r1:7b', digest: '1'.repeat(64) }] },
    'no model server': null,
  })) {
    test(`refuses before any launch with ${name}`, async () => {
      const t = setup();
      try {
        const r = await runBatch({ out: t.out, expectedSha: REV, inherited: CONFLICTING, qbEntry: t.qbEntry, dotenvPath: path.join(t.d, 'no.env'), fetchTags: async () => tags, log: () => {} });
        assert.equal(r.refused, true);
        assert.equal(fs.existsSync(path.join(t.d, 'seen.jsonl')), false, 'nothing was launched');
        assert.equal(JSON.parse(fs.readFileSync(path.join(t.out, 'batch.json'), 'utf8')).refused, true);
      } finally { fs.rmSync(t.d, { recursive: true, force: true }); }
    });
  }
  test('refuses before any launch when intent/.env exists (dotenv could add settings the batch does not pin)', async () => {
    const t = setup();
    try {
      fs.writeFileSync(path.join(t.d, 'x.env'), 'QB_MODEL_CONCURRENCY=9\n');
      const r = await runBatch({ out: t.out, expectedSha: REV, inherited: CONFLICTING, qbEntry: t.qbEntry, dotenvPath: path.join(t.d, 'x.env'), fetchTags: async () => TAGS, log: () => {} });
      assert.equal(r.refused, true);
      assert.equal(fs.existsSync(path.join(t.d, 'seen.jsonl')), false);
    } finally { fs.rmSync(t.d, { recursive: true, force: true }); }
  });
  test('a digest change during the batch is recorded and makes every row invalid when scored', async () => {
    const t = setup();
    let n = 0;
    try {
      await runBatch({ out: t.out, expectedSha: REV, inherited: CONFLICTING, qbEntry: t.qbEntry, dotenvPath: path.join(t.d, 'no.env'),
        fetchTags: async () => (n++ === 0 ? TAGS : { models: [{ name: QWEN, digest: '2'.repeat(64) }] }), log: () => {} });
      const b = JSON.parse(fs.readFileSync(path.join(t.out, 'batch.json'), 'utf8'));
      assert.equal(b.model_after.digest_matches, false);
      const out = require('../../bench/kan106-eval-v1/score').scoreBatchDir(t.out);
      assert.ok(out.batch_problems.some((p) => /digest/.test(p)));
      assert.ok(out.items.every((x) => x.result === 'invalid_record'));
    } finally { fs.rmSync(t.d, { recursive: true, force: true }); }
  });
});
