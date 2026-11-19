/**
 * KAN-106 10758: the published evidence pack of owner run 69e576f5 (QB 95f9d58, qwen2.5-coder:14b, staged
 * profile): docs/research/kan106/2026-11-18-staged-69e576f5/.
 *
 *  1. The pack's files are the run's own artifacts, byte for byte (their sha256 is the artifact name).
 *  2. Its recorded replies, replayed through the CURRENT compiler with the model faked, still give exactly the
 *     recorded checks: the 10758 constructor change does not alter this result. NOT a new model run.
 *  3. Its control results match a fresh run of those checks by the real check runner.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { mockFetch, ollamaReply } = require('../helpers/mocks');

const ROOT = path.join(__dirname, '..', '..');
const PACK = path.join(ROOT, 'docs', 'research', 'kan106', '2026-11-18-staged-69e576f5');
const FIX = path.join(__dirname, '..', 'fixtures', 'kan106');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const readPack = (f) => fs.readFileSync(path.join(PACK, f));
const REQUEST = fs.readFileSync(path.join(FIX, 'request.txt'), 'utf8').trim();
const PINNED = fs.readFileSync(path.join(FIX, 'pinned-fast-json-stringify/serializer-07d7196.js'), 'utf8');
const GUARD = "    // reject blank strings, which Number() would coerce to 0\n    if (typeof i === 'string' && i.trim() === '') {\n      throw new Error(`The value \"${i}\" cannot be converted to a number.`)\n    }\n";
const BASE = PINNED.replace(GUARD, '');
const RUNNER = path.join(ROOT, 'sandbox', 'agent', 'qb-check-runner.mjs');
const STAGED = JSON.parse(readPack('contract-staged.json'));
const CONTRACT = JSON.parse(readPack('contract.json'));

function makeRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kan106-69e-'));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const repoFiles = (src) => ({ 'package.json': '{"name":"pinned","type":"commonjs"}', 'lib/serializer.js': src, 'test/asNumber.test.js': "'use strict'\n" });

test('the pack holds the run artifacts byte for byte, with no local paths', () => {
  assert.equal(sha(readPack('contract-staged.json')), '8e4f788c72d9ea903579ad12ecbd24fa65f14dda9c370c97402c287498cc09aa');
  assert.equal(sha(readPack('contract.json')), '35fcd621467d9f4049b7cf5f7b7f0c54fe5fd481dfb14343fdabd9acbae487ba');
  for (const f of fs.readdirSync(PACK)) {
    assert.doesNotMatch(readPack(f).toString('utf8'), /\/Users\/|\/home\//, f);
    if (f.endsWith('.json')) assert.doesNotMatch(readPack(f).toString('utf8'), /\.qb\/runs/, f);   // the README names ~/.qb/runs generically
  }
  const t = JSON.parse(readPack('l1-timings.event.json')).data;
  assert.equal(t.l1_ms, 84462);
  assert.deepEqual(t.calls.map((c) => [c.requirement_id, c.ms, c.outcome]), [['R-2', 29401, 'ok'], ['R-3', 12473, 'ok'], ['R-4', 12665, 'ok'], ['R-5', 29787, 'ok']]);
  for (const f of STAGED.facts) { assert.equal(f.attempts.length, 1); assert.equal(Buffer.byteLength(f.attempts[0].raw), f.attempts[0].raw_bytes); assert.deepEqual(f.attempts[0].errors, []); }
  assert.equal(sha(BASE), 'ae9d3d2fdfcfea0477c3802d2e80ea2c15126aad073629d3ef8711ee36e80c5e', 'the faked base is the target serializer');
});

test('recorded replies replayed through the CURRENT compiler (model faked, NOT a new model run): finalized, the same checks and criteria', async () => {
  const replies = Object.fromEntries(STAGED.facts.map((f) => [f.requirement_id, f.attempts[0].raw]));
  const repo = makeRepo(repoFiles(BASE));
  const sent = [];
  const m = mockFetch(async (url, init) => {
    const rid = JSON.parse(init.body).format.properties.cases.items.properties.requirement.enum[0];
    sent.push(rid);
    return { ...ollamaReply(replies[rid]), model: 'qwen2.5-coder:14b' };
  });
  const { l1Budget } = require('../../lib/budget');
  let s;
  try { s = await require('../../intent/session').compileIntent(REQUEST, { repoPath: repo.dir, l1Budget: l1Budget({ profile: 'qwen-14b-staged' }) }); }
  finally { m.restore(); repo.cleanup(); }
  assert.deepEqual(sent, ['R-2', 'R-3', 'R-4', 'R-5']);
  assert.equal(s.state, 'finalized', (s.errors || []).join('\n'));
  assert.deepEqual(s.contract.checks, CONTRACT.checks);
  assert.deepEqual(s.contract.acceptance_criteria, CONTRACT.acceptance_criteria);
  assert.deepEqual(s.contract.constraint_policy, CONTRACT.constraint_policy);
  assert.deepEqual(s.contract.scope, CONTRACT.scope);
  const [t] = s.staged.call_targets;
  assert.deepEqual([t.grounding, t.constructor_args], ['grounded', 'appears_optional'], 'recorded as "optional" at 95f9d58; renamed in 10758');
});

test('the control results in the pack match a fresh run of the unchanged checks by the real check runner', () => {
  const recorded = JSON.parse(readPack('control-results.json'));
  assert.equal(recorded.runner.sha256, sha(fs.readFileSync(RUNNER)));
  assert.equal(recorded.controls.base.sha256, sha(BASE));
  assert.equal(recorded.controls.correct.sha256, sha(PINNED));
  for (const [name, src] of [['base', BASE], ['correct', PINNED]]) {
    const repo = makeRepo(repoFiles(src));
    try {
      const out = path.join(repo.dir, 'r.json');
      const r = spawnSync(process.execPath, [RUNNER], { input: JSON.stringify({ root: repo.dir, checks: CONTRACT.checks }), encoding: 'utf8',
        env: { ...process.env, QB_CHECK_RESULTS: out, QB_CHECK_TIMEOUT_MS: '5000' }, timeout: 60_000 });
      assert.equal(r.status, 0, r.stderr);
      const got = Object.fromEntries(JSON.parse(fs.readFileSync(out, 'utf8')).results.map((x) => [x.id, x.status]));
      assert.deepEqual(got, Object.fromEntries(recorded.results.map((x) => [x.id, x[name].status])), name);
    } finally { repo.cleanup(); }
  }
  assert.deepEqual(recorded.results.map((x) => [x.id, x.base.status, x.correct.status]),
    [['CHK-1', 'fail', 'pass'], ['CHK-2', 'fail', 'pass'], ...['CHK-3', 'CHK-4', 'CHK-5', 'CHK-6', 'CHK-7', 'CHK-8'].map((id) => [id, 'pass', 'pass'])]);
});
