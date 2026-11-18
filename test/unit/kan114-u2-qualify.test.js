// KAN-114 10720 items 3-4: the bounded, no-model U2 qualification workflow (NOT launched) and the rule that the first
// six environmentally eligible tasks are frozen BEFORE any checklist is authored. Fixtures only; nothing runs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const Q = require('../../lib/pilot/u2-qualify');
const plan = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'bench/opus-pilot/kan114-six-task-proposal.json'), 'utf8'));
const allow = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'bench/opus-pilot/u2/root-build-allow.json'), 'utf8'));
const SCREEN = ['preact-4245', 'preact-3567', 'preact-3454', 'preact-4436', 'preact-4316', 'preact-3739', 'preact-4152', 'preact-3689', 'preact-3562'];
const WF = '.github/workflows/u2-qualify.yml';
const REQ = 'bench/opus-pilot/u2/qualify-request.txt';

test('U2 scope from the committed order: 9 pattern-B tasks are screened; everything else is recorded, not screened', () => {
  const s = Q.u2Scope(plan(), allow());
  assert.deepEqual(s.screen, SCREEN);
  const why = Object.fromEntries(s.not_screened.map((x) => [x.key, x.reason]));
  for (const k of ['axios-5892', 'axios-4738', 'axios-4731']) assert.match(why[k], /exposed/);
  for (const k of ['preact-2757', 'preact-3062', 'preact-2927', 'preact-3010']) assert.match(why[k], /lockfile v1/);
  for (const k of ['preact-3345', 'preact-3763', 'preact-4182', 'preact-2896']) assert.match(why[k], /leak/);
  for (const k of ['threejs-27395', 'threejs-25687', 'threejs-26589', 'axios-6539', 'axios-5085', 'axios-5316']) assert.match(why[k], /out of U2 scope|not a U2 blocker|leak/);
  assert.equal(s.screen.length + s.not_screened.length, 26);
});

test('limits are explicit: at most 9 tasks, concurrency 1, every job timed out, a stated job-minute ceiling', () => {
  assert.equal(Q.LIMITS.max_tasks, 9);
  assert.equal(Q.LIMITS.concurrency, 1);
  const t = Q.LIMITS.job_timeout_min;
  assert.ok(t.plan > 0 && t.qualify > 0 && t.summary > 0);
  assert.equal(Q.LIMITS.job_minutes_ceiling, t.plan + Q.LIMITS.max_tasks * t.qualify + t.summary);
  assert.ok(Q.LIMITS.job_minutes_ceiling <= 450);
});

const approvals = (o = {}) => ({ u2_image: { build_run_id: '55501', image_digest: `sha256:${'d'.repeat(64)}`, approval_comment_id: '30001' },
  u2_qualification: { approval_comment_id: '30002' }, ...o });
const req = (o = {}) => Object.entries({ mode: 'qualify', tasks: SCREEN.slice(0, 6).join(','), images_run: '55501', approval: '30002', ...o }).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';

test('request validation: refused unless qualification AND the image are approved, tasks are a prefix of the screen order, and <= max', () => {
  const ok = Q.validateRequest(req(), { approvals: approvals(), screen: SCREEN });
  assert.deepEqual(ok.tasks, SCREEN.slice(0, 6));
  assert.equal(ok.images_run, '55501');
  const committed = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench/opus-pilot/u2/approvals.json'), 'utf8'));
  assert.equal(committed.u2_qualification.approval_comment_id, null, 'qualification is NOT approved in the committed file');
  assert.equal(committed.u2_image.approval_comment_id, null, 'the image build is NOT approved in the committed file');
  assert.throws(() => Q.validateRequest(req(), { approvals: committed, screen: SCREEN }), /not approved/);
  const bad = [
    [req({ mode: 'pair' }), approvals()],
    [req({ tasks: SCREEN.join(',') + ',preact-2757' }), approvals()],
    [req({ tasks: 'preact-3567,preact-4245' }), approvals()],
    [req({ tasks: 'preact-4245,preact-4245' }), approvals()],
    [req({ tasks: 'preact-2757' }), approvals()],
    [req({ tasks: '' }), approvals()],
    [req({ images_run: '1' }), approvals()],
    [req({ approval: '1' }), approvals()],
    [req(), approvals({ u2_qualification: { approval_comment_id: null } })],
    [req(), approvals({ u2_image: { build_run_id: '55501', image_digest: null, approval_comment_id: '30001' } })],
    ['mode=qualify\n', approvals()],
  ];
  for (const [text, a] of bad) assert.throws(() => Q.validateRequest(text, { approvals: a, screen: SCREEN }), /u2 qualify request/, text);
  assert.doesNotThrow(() => Q.validateRequest(req({ tasks: SCREEN.join(',') }), { approvals: approvals(), screen: SCREEN }));
});

const pass = { setup: true, agent_input: true, calibration: true, visible_channel: true };
test('freeze: the first six environmentally eligible tasks in committed order, frozen before any checklist', () => {
  const results = Object.fromEntries(SCREEN.map((k) => [k, pass]));
  results['preact-3454'] = { ...pass, calibration: false, reason: 'calibration expectations not met' };
  const f = Q.freezeFirstSix(SCREEN, results);
  assert.deepEqual(f.frozen, ['preact-4245', 'preact-3567', 'preact-4436', 'preact-4316', 'preact-3739', 'preact-4152']);
  assert.equal(f.frozen_before_checklists, true);
  assert.equal(f.checklists_authored, 0);
  assert.deepEqual(f.environment_failures, [{ key: 'preact-3454', reason: 'calibration expectations not met' }]);
  assert.equal(f.shortfall, 0);
  assert.deepEqual(f.not_needed, ['preact-3689', 'preact-3562']);
});

test('freeze is incomplete (not padded) while an earlier task has no result, and reports a shortfall honestly', () => {
  const partial = { 'preact-4245': pass };
  const f = Q.freezeFirstSix(SCREEN, partial);
  assert.equal(f.status, 'incomplete');
  assert.deepEqual(f.frozen, []);
  const fails = Object.fromEntries(SCREEN.map((k, i) => [k, i < 5 ? { ...pass, visible_channel: false, reason: 'browser sandbox unavailable' } : pass]));
  const g = Q.freezeFirstSix(SCREEN, fails);
  assert.equal(g.status, 'shortfall');
  assert.deepEqual(g.frozen, SCREEN.slice(5));
  assert.equal(g.shortfall, 2);
  assert.match(g.note, /report the shortfall before expanding scope/i);
});

test('QB preparation failures are recorded and NEVER replace a frozen task', () => {
  const f = Q.freezeFirstSix(SCREEN, Object.fromEntries(SCREEN.map((k) => [k, pass])));
  const g = Q.recordPrepFailure(f, 'preact-3454', 'reviewed contract fails on the reference');
  assert.deepEqual(g.frozen, f.frozen);
  assert.deepEqual(g.qb_preparation_failures, [{ key: 'preact-3454', reason: 'reviewed contract fails on the reference', outcome: 'qb_preparation_failure (unresolved; counts in the denominator)' }]);
  assert.throws(() => Q.recordPrepFailure(f, 'preact-3689', 'x'), /not a frozen task/);
  assert.throws(() => Q.replaceTask(f, 'preact-3454', 'preact-3689'), /never replaced/);
});

test('the qualification workflow: manual dispatch or its own (absent) request file only, concurrency 1, bounded, no secrets, no model', () => {
  const y = fs.readFileSync(path.join(ROOT, WF), 'utf8');
  assert.match(y, /^on:\n  push:\n    branches: \[kan114-u2\]\n    paths: \[bench\/opus-pilot\/u2\/qualify-request\.txt\]\n  workflow_dispatch:\n/m);
  assert.ok(!fs.existsSync(path.join(ROOT, REQ)), 'the request file is NOT created');
  assert.match(y, /concurrency:\n  group: u2-qualify\n  cancel-in-progress: false/);
  for (const bad of ['secrets.', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_', 'environment:', 'pull_request', 'schedule:', 'workflow_run', 'ollama', 'qwen', 'pair.mjs']) {
    assert.ok(!y.includes(bad), `qualification workflow must not contain ${bad}`);
  }
  const jobs = [...y.matchAll(/^  ([a-z-]+):\n    (?:needs|runs-on|if)/gm)].map((m) => m[1]);
  assert.deepEqual(jobs, ['plan', 'qualify', 'summary']);
  for (const j of jobs) {
    const body = y.split(new RegExp(`^  ${j}:\\n`, 'm'))[1].split(/^  [a-z-]+:\n    (?:needs|runs-on|if)/m)[0];
    assert.match(body, new RegExp(`timeout-minutes: ${Q.LIMITS.job_timeout_min[j]}\\n`), `${j} timeout`);
  }
  assert.match(y, /max-parallel: 1\n/);
  assert.match(y, /fromJSON\(needs\.plan\.outputs\.tasks\)/);
  assert.match(y, /u2-qualify\.mjs --plan/);
  assert.match(y, /persist-credentials: false/);
  assert.match(y, /permissions:\n  contents: read\n  actions: read\n/);
});

test('no U2 workflow trigger path matches any committed file (the push of this branch cannot start one)', () => {
  const dir = path.join(ROOT, '.github/workflows');
  for (const f of fs.readdirSync(dir).filter((x) => /^u2-/.test(x))) {
    const y = fs.readFileSync(path.join(dir, f), 'utf8');
    const paths = (y.match(/^    paths: \[(.*)\]$/m) || [])[1].split(',').map((s) => s.trim());
    for (const p of paths) {
      assert.ok(/request\.txt$/.test(p), `${f}: trigger ${p} is a request file`);
      // KAN-114 10728: only the approved build request may exist, and only citing KAN-114 10724.
      // Every other trigger (the qualification request included) must stay absent.
      if (p === 'bench/opus-pilot/u2/build-request.txt' && fs.existsSync(path.join(ROOT, p))) {
        assert.match(fs.readFileSync(path.join(ROOT, p), 'utf8').split('\n')[0], /^KAN-114 10724:/, `${f}: ${p} must cite KAN-114 10724`);
        continue;
      }
      assert.ok(!fs.existsSync(path.join(ROOT, p)), `${f}: ${p} must not exist`);
    }
  }
});

test('the CI driver refuses outside CI and with credential-like variables; --plan refuses the unapproved committed state', () => {
  const f = path.join(ROOT, 'bench/opus-pilot/u2/u2-qualify.mjs');
  let r = spawnSync(process.execPath, [f, '--plan'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(r.status, 2); assert.match(r.stderr, /CI only/);
  r = spawnSync(process.execPath, [f, '--plan'], { encoding: 'utf8', env: { PATH: process.env.PATH, GITHUB_ACTIONS: 'true', U2_CI_RUN: '1', ANTHROPIC_API_KEY: 'fake' } });
  assert.equal(r.status, 2); assert.match(r.stderr, /credential-like variable ANTHROPIC_API_KEY/);
  r = spawnSync(process.execPath, [f, '--plan', `--request=${path.join(__dirname, '..', 'fixtures', 'kan114-u2', 'no-such-request.txt')}`],
    { encoding: 'utf8', env: { PATH: process.env.PATH, GITHUB_ACTIONS: 'true', U2_CI_RUN: '1' } });
  assert.notEqual(r.status, 0);
});
