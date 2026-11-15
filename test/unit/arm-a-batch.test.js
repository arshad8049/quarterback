// Arm-A batch 1 (owner plan 2026-11-14): selection, grader tasks file, briefing and live-route guard.
// Everything here is fake: no Docker, no model, no network, no real token.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..', '..');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const imp = (p) => import(path.join(ROOT, p));

test('the seeded selection is deterministic, excludes the 2005/2006 setup examples, and matches the committed batch', async () => {
  const S = await imp('bench/opus-pilot/arm-a-select.mjs');
  const buf = fs.readFileSync(path.join(ROOT, 'bench/public/manifest/candidates.json'));
  const c = JSON.parse(buf); c.__sha256 = sha(buf);
  const b1 = S.batch(c); const b2 = S.batch(c);
  assert.deepEqual(b1, b2);
  const ids = [...b1.selected, ...b1.reserve].map((x) => x.task_id);
  for (const ex of S.SETUP_EXAMPLES) assert.ok(!ids.includes(ex), 'a setup example is never a fresh task');
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(b1.selected.length, 5);
  for (const x of [...b1.selected, ...b1.reserve]) assert.match(x.image, /@sha256:[0-9a-f]{64}$/);
  const committed = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench/opus-pilot/arm-a-batch-1.json'), 'utf8'));
  assert.deepEqual(committed.selected, b1.selected); assert.deepEqual(committed.reserve, b1.reserve);
  // a different seed gives a different order (the seed, not the solutions, decides)
  assert.notDeepEqual(S.batch(c, { seed: 'other' }).selected.map((x) => x.task_id), b1.selected.map((x) => x.task_id));
});

test('the committed grader tasks file validates: A0, pinned digests, eval hashes, modified test files, harness parsers', async () => {
  const G = await imp('bench/public/grader/immutable-offline-v1/grade.mjs');
  const f = path.join(ROOT, 'bench/opus-pilot/arm-a-grader-tasks.json');
  const tf = G.loadTasksFile(f);
  assert.equal(Object.keys(tf.tasks).length, 26, '5 selected + all 21 reserves');
  for (const t of Object.values(tf.tasks)) {
    assert.equal(t.variant, 'A0');
    assert.ok(['parse_log_tap', 'parse_log_karma'].includes(t.log_parser), t.log_parser);
    assert.ok(t.test_files.length >= 1);
  }
  const approvals = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench/opus-pilot/approvals.json'), 'utf8'));
  assert.equal(approvals.calibration.tasks_file_sha256, tf.sha256);
  assert.equal(approvals.candidate_grade.tasks_file_sha256, tf.sha256);
  assert.equal(approvals.auth_route, null, 'the live route is not confirmed by this commit');
});

test('loadTasksFile refuses an unpinned image, a non-A0 variant, unsafe test paths and a missing parser', async () => {
  const G = await imp('bench/public/grader/immutable-offline-v1/grade.mjs');
  const good = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench/opus-pilot/arm-a-grader-tasks.json'), 'utf8'));
  const k = Object.keys(good.tasks)[0];
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'arma-'));
  for (const [what, patch] of [['image', { image: 'x/y:latest' }], ['variant', { variant: 'A1' }], ['test_files', { test_files: ['../etc/passwd'] }], ['log_parser', { log_parser: '' }]]) {
    const j = structuredClone(good); Object.assign(j.tasks[k], patch);
    const f = path.join(d, `${what}.json`); fs.writeFileSync(f, JSON.stringify(j));
    assert.throws(() => G.loadTasksFile(f), new RegExp(`tasks file: ${k.replace('.', '\\.')}`), what);
  }
  fs.rmSync(d, { recursive: true, force: true });
});

test('modifiedTestFiles lists only files the official test patch modifies (never created ones)', async () => {
  const T = await imp('bench/opus-pilot/arm-a-tasks.mjs');
  const tp = 'diff --git a/test/a.js b/test/a.js\nindex 1..2 100644\n--- a/test/a.js\n+++ b/test/a.js\n@@ -1 +1 @@\n-x\n+y\n'
    + 'diff --git a/test/new.js b/test/new.js\nnew file mode 100644\n--- /dev/null\n+++ b/test/new.js\n@@ -0,0 +1 @@\n+z\n';
  assert.deepEqual(T.modifiedTestFiles(tp), ['test/a.js']);
});

test('the arm-A briefing is the task text + QB\'s arm-A line, and refuses leaked hidden material (counts only)', () => {
  const A = require('../../lib/pilot/arm-a');
  const { NATIVE_NOTE } = require('../../bench/arms');
  const vault = { patch: '+  return computeTheFixedValueForTheIssue(input);\n', test_patch: '+  expect(render(<progress value={0} />)).to.equal(0);\n', FAIL_TO_PASS: ['should set progress value to 0'], PASS_TO_PASS: [] };
  const b = A.armABriefing({ task_id: 'qbt_000000000001', problem_statement: 'Progress value 0 is dropped.' }, vault);
  assert.equal(b.briefing, `Progress value 0 is dropped.\n\n${NATIVE_NOTE}\n`);
  assert.equal(b.sha256, sha(b.briefing));
  assert.throws(() => A.armABriefing({ task_id: 'q', problem_statement: 'see should set progress value to 0' }, vault), /required_test_name/);
  assert.throws(() => A.armABriefing({ task_id: 'q', problem_statement: 'return computeTheFixedValueForTheIssue(input);' }, vault), /gold_patch_line/);
  assert.throws(() => A.armABriefing({ task_id: 'q', problem_statement: 'x', hints_text: 'y' }, vault), /unexpected agent-store fields/);
});

const confirmed = { auth_route: { route: 'subscription_token_env', confirmed_by: 'Arshad (chat)', confirmed_at: '2026-11-14T00:00:00Z', residual_risk_sha256: 'f'.repeat(64) } };
const liveEnv = { GITHUB_ACTIONS: 'true', ARM_A_LIVE: '1', CLAUDE_CODE_OAUTH_TOKEN: 'dummy-not-a-token' };
test('the live route is refused outside the research driver, outside the protected workflow, without the owner confirmation, or with a billing override', async () => {
  const A = require('../../lib/pilot/arm-a');
  assert.deepEqual(A.liveRouteProblems(liveEnv, '/x/bench/opus-pilot/arm-a.mjs', { approvals: confirmed }), []);
  assert.match(A.liveRouteProblems(liveEnv, '/x/bench/experiment-run.js', { approvals: confirmed }).join(), /research driver/);
  assert.match(A.liveRouteProblems({ ...liveEnv, ARM_A_LIVE: '' }, '/x/arm-a.mjs', { approvals: confirmed }).join(), /protected arm-A live workflow/);
  assert.match(A.liveRouteProblems(liveEnv, '/x/arm-a.mjs', { approvals: { auth_route: null } }).join(), /not confirmed/);
  assert.match(A.liveRouteProblems({ ...liveEnv, CLAUDE_CODE_OAUTH_TOKEN: '' }, '/x/arm-a.mjs', { approvals: confirmed }).join(), /not set/);
  for (const k of A.FORBIDDEN_ENV) assert.match(A.liveRouteProblems({ ...liveEnv, [k]: '1' }, '/x/arm-a.mjs', { approvals: confirmed }).join(), new RegExp(k));
  const ok = await A.signInAdapter(liveEnv, '/x/arm-a.mjs', { approvals: confirmed })();
  assert.equal(ok.status, 'ok'); assert.match(ok.kind, /not proof of authentication/);
  assert.equal((await A.signInAdapter({}, '/x/arm-a.mjs', { approvals: confirmed })()).status, 'error');
});

test('ordinary QB runs still have no approved auth route (the live route lives only in the research driver)', () => {
  const P = require('../../lib/sandbox/agent-profile');
  assert.deepEqual([...P.APPROVED_AUTH_ROUTES], []);
});

test('a candidate record can carry an explicit grader task key from the tasks file, and checkCandidate requires the mapping', () => {
  const C = require('../../lib/research/candidate');
  const r = { status: 'completed', patch_raw: Buffer.from('diff'), changes: [], sandbox: { capture: { verdict: { state: 'captured' } } } };
  const rec = C.candidateRecord(r, { label: 'trial-1', env: { task_id: 'qbt_2b0029100b75' }, graderTask: 'preact-2757' });
  assert.equal(rec.grader_task, 'preact-2757');
  assert.doesNotThrow(() => C.checkCandidate(rec, Buffer.from('diff'), { task_id: 'qbt_2b0029100b75' }, { graderTasks: { qbt_2b0029100b75: 'preact-2757' } }));
  assert.throws(() => C.checkCandidate(rec, Buffer.from('diff'), { task_id: 'qbt_2b0029100b75' }), /task does not match/);
});

test('the freeze replaces a setup failure with the next QUALIFIED reserve in order, and records every exclusion', async () => {
  const F = await imp('bench/opus-pilot/arm-a-freeze.mjs');
  const mk = (id) => ({ instance_id: `o__${id}` }); const keyOf = (i) => i.replace(/^o__/, '');
  const batch = { selected: ['s1', 's2', 's3'].map(mk), reserve: ['r1', 'r2', 'r3'].map(mk) };
  const ok = { qualified: true }; const bad = (why) => ({ qualified: false, failure: { where: 'coding_env', why } });
  const { chosen, excluded } = F.chooseQualified(batch, keyOf, { s1: ok, s2: bad('no browser'), s3: ok, r1: bad('deps'), r2: ok, r3: ok });
  assert.deepEqual(chosen.map((c) => c.key), ['s1', 'r2', 's3']);
  assert.equal(chosen[1].role, 'replaces s2');
  assert.deepEqual(excluded.map((e) => e.key), ['s2', 'r1']);
  // fewer qualified than selected: deliver the smaller batch honestly
  const few = F.chooseQualified(batch, keyOf, { s1: bad('x'), s2: bad('x'), s3: bad('x'), r1: ok, r2: bad('y'), r3: bad('z') });
  assert.deepEqual(few.chosen.map((c) => c.key), ['r1']);
});
