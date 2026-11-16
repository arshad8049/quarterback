// KAN-117 review 10640: the KAN-99 scenario capability, RESEARCH-ONLY. No Docker, no model, no network.
//   - a scenario is accepted only through the explicit research reviewed path, bound to the reviewed source sha256;
//   - the research check runner is mounted read-only at its own path, with its sha recorded (stage ⑥ consumes it);
//   - check results stay fail-closed on the research result-consumption path (verify()).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..', '..');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const R = require('../../lib/research/reviewed-checks');
const { checkSetHash } = require('../../verify/checks/registry');
const SRC = "module.exports = async ({ require, assert }) => { assert.equal(require('./index.js').f(), 1); };";
const ACS = [{ id: 'AC-1', criterion: 'f() returns 1', kind: 'behavioral', met: null }];
const scenario = (src = SRC, id = 'SC-1') => ({ id, ac_id: 'AC-1', adapter: 'scenario', params: { source: src } });
const reviewed = (src = SRC, id = 'SC-1') => ({ check_id: id, source_sha256: sha(src), reviewed_by: 'reviewer (fixture)', ref: 'fixture' });

test('research reviewed path: a scenario is accepted ONLY when its exact source sha256 is in the reviewed list', () => {
  const ok = R.validateResearchChecks([scenario()], ACS, { reviewed: [reviewed()] });
  assert.deepEqual(ok.accepted.map((c) => c.adapter), ['scenario']);
  assert.equal(ok.accepted_scenarios[0].source_sha256, sha(SRC));
  for (const [why, rev] of [['no review', []], ['other source', [reviewed(`${SRC} `)]], ['other check id', [reviewed(SRC, 'SC-2')]], ['no reviewer', [{ ...reviewed(), reviewed_by: '' }]]]) {
    const r = R.validateResearchChecks([scenario()], ACS, { reviewed: rev });
    assert.deepEqual(r.accepted, [], why);
    assert.match(r.rejected[0].reason, /reviewed/, why);
  }
  // data checks pass through unchanged
  const data = { id: 'D-1', ac_id: 'AC-1', adapter: 'module_exports', params: { module: 'index.js', export: 'f', type: 'function' } };
  assert.equal(R.validateResearchChecks([data], ACS, { reviewed: [] }).accepted.length, 1);
});

test('the default validator, model output and global entry points still reject scenario code', () => {
  const { validateChecks } = require('../../verify/checks/registry');
  assert.equal(validateChecks([scenario()], ACS).accepted.length, 0);
});

// ── stage ⑥ with the research runner ──
test('runChecks: the research runner is mounted READ-ONLY at its own path and is what node executes; default is unchanged', async () => {
  const S = require('../../lib/sandbox/stages');
  const calls = [];
  const seams = {
    runStage: async (name, args) => { calls.push({ name, args }); return name.endsWith('-checks-prep')
      ? { state: 'completed', exit_code: 0, stdout: '{"status":"ready","tree":"' + 'a'.repeat(40) + '"}\n', stderr: '' }
      : { state: 'completed', exit_code: 0, stdout: '', stderr: '' }; },
    readResults: async () => '{"x":1}',
  };
  const WS = { runId: 'qb-t', image: 'tools-img', mount: (n, ro) => ['-v', `qb-t-${n}:/${n}${ro ? ':ro' : ''}`] };
  const runner = R.researchCheckRunner();
  assert.equal(runner.sha256, sha(fs.readFileSync(path.join(ROOT, 'sandbox/agent/qb-check-runner.mjs'))));
  await S.runChecks(WS, { status: 'ready' }, [scenario()], { seams, runner });
  const a = calls.find((c) => c.name.endsWith('-checks')).args;
  assert.ok(a.includes(`${runner.host}:${runner.path}:ro`), 'read-only bind mount');
  assert.equal(a[a.length - 1], runner.path, 'node runs the mounted research runner');
  calls.length = 0;
  await S.runChecks(WS, { status: 'ready' }, [scenario()], { seams });
  const d = calls.find((c) => c.name.endsWith('-checks')).args;
  assert.equal(d[d.length - 1], '/usr/local/lib/qb/qb-check-runner.mjs', 'default: the image runner, no extra mount');
  assert.ok(!d.some((x) => /qb-research/.test(x)));
});

// ── fail-closed results on the research result-consumption path ──
test('check results: missing, empty, duplicate, unexpected, unknown status or a hash mismatch never verify a criterion', () => {
  const { validateCheckResults } = require('../../verify/checks/results');
  const checks = [scenario()]; const h = checkSetHash(checks);
  const res = (results, hash = h, complete = true) => JSON.stringify({ format: 'qb-check-results/1', complete, check_set_hash: hash, results });
  const one = { id: 'SC-1', ac_id: 'AC-1', adapter: 'scenario', status: 'pass', detail: 'ok' };
  assert.equal(validateCheckResults(res([one]), checks, h).ok, true, 'control: a valid record');
  for (const [why, text] of [
    ['missing', null], ['empty', res([])], ['duplicate', res([one, one])], ['unexpected', res([one, { ...one, id: 'SC-9' }])],
    ['unknown status', res([{ ...one, status: 'skipped' }])], ['incomplete', res([one], h, false)], ['hash mismatch', res([one], 'f'.repeat(64))], ['not json', '{'],
  ]) assert.notEqual(validateCheckResults(text, checks, h).ok, true, why);
});
