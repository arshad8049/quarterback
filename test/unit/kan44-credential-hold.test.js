/**
 * KAN-44 (senior 10837 B): the credential controls are defence in depth. Three blockers, plus the scan container's
 * cleanup. DUMMY values only; Docker is a fake `op` everywhere here (real containers: test/integration).
 *   B1 untrusted file names never reach findings or output (opaque file numbers instead);
 *   B2 a scan that could not finish is a security HOLD, never clean: no judge, no further attempt, export refused;
 *   B3 a failed own-credential check is cleared at export only against the SAME credential (salted fingerprint
 *      recorded when the run got it), never against whatever credential is current.
 */
require('../helpers/empty-docker');   // FIRST: no real Docker, even if old code ignores an injected op (red phase)
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../../run/store');
const { approve } = require('../../intent/contract-state');

const S = () => require('../../lib/credential-scan');
const C = () => require('../../lib/sandbox/credential-check');
// assembled so that no literal in this file matches a known format
const GH = `gh${'p'}_${'D'.repeat(36)}`; const NPM = `np${'m'}_${'D'.repeat(36)}`;
const OWN = 'plain-dummy-own-credential-0123456789';      // matches no known format: only an exact search finds it
const OTHER = 'plain-dummy-replaced-credential-9876543210';
const patchOf = (lines, file = 'lib/a.js', extraHeaders = []) => Buffer.from([`diff --git a/${file} b/${file}`, ...extraHeaders, 'index 111..222 100644', `--- a/${file}`, `+++ b/${file}`,
  `@@ -1,${lines.filter((l) => l[0] !== '+').length} +1,${lines.filter((l) => l[0] !== '-').length} @@`, ...lines, ''].join('\n'));
const twoFiles = () => Buffer.concat([patchOf([' a', '+b']), patchOf([' a', `+k = '${GH}'`, `+n = '${NPM}'`], `src/${OWN}.js`)]);

describe('B1: untrusted file names never reach findings or output', () => {
  test('a dummy own credential as a FILE NAME, with two known-format findings in that file', () => {
    const r = S().scanPatch(twoFiles());
    assert.equal(r.status, 'finding');
    const text = JSON.stringify(r) + S().describeFindings(r.findings).join('\n');
    assert.ok(!text.includes(OWN) && !text.includes(OWN.slice(0, 16)), text);
    assert.ok(!text.includes('src/'), 'no part of the name');
    assert.deepEqual(r.findings.map((f) => [f.kind, f.file_index]).sort(), [['github_token', 2], ['npm_token', 2]]);
    for (const f of r.findings) assert.ok(!('file' in f), 'no file name field');
    assert.match(S().describeFindings(r.findings).join('\n'), /file 2 of the patch/);
  });
  test('the name in headers (rename from/to, ---/+++), and a known format in a header line', () => {
    const p = patchOf([' a', `+${GH}`], `x/${OWN}`, [`rename from old/${OWN}`, `rename to x/${OWN}`, `similarity index 90%`]);
    const r = S().scanPatch(p);
    assert.ok(!JSON.stringify(r).includes(OWN));
    const named = S().scanPatch(patchOf([' a', '+b'], `lib/${GH}.js`));
    assert.equal(named.status, 'finding');
    assert.ok(!JSON.stringify(named).includes(GH) && !S().describeFindings(named.findings).join('').includes(GH));
    assert.ok(named.findings.every((f) => f.file_index === 1));
  });
  test('checkCaptured (Mode K finds the run credential too): the evidence never carries a name or a value', async () => {
    const r = await C().checkCaptured(twoFiles(), { cred: { mode: 'K', variable: 'ANTHROPIC_API_KEY' }, env: { ANTHROPIC_API_KEY: OWN } });
    assert.equal(r.status, 'finding');
    assert.ok(r.findings.some((f) => f.kind === 'run_credential'));
    assert.ok(!JSON.stringify(r).includes(OWN));
  });
  test('the qb.js hold message and change listing withhold names when the scan is not clean', () => {
    const scan = S().scanPatch(twoFiles());
    const execution = { changes: [{ file: 'lib/a.js', additions: 1, deletions: 0 }, { file: `src/${OWN}.js`, additions: 2, deletions: 0 }], sandbox: { credential_scan: scan } };
    const out = [...S().holdMessage(scan), ...S().changeListing(execution)].join('\n');
    assert.ok(!out.includes(OWN) && !out.includes('src/'), out);
    assert.match(out, /2 file\(s\) changed; names withheld/);
    assert.deepEqual(S().changeListing({ changes: [{ file: 'lib/a.js', additions: 1, deletions: 0 }], sandbox: { credential_scan: { status: 'clean' } } }).length, 1);
  });
});

describe('B2: a scan that could not finish is a security hold, never clean', () => {
  const clean = patchOf([' a', '+b']);
  test('checkCaptured: Mode S comparison failed → incomplete (not clean); Mode K variable vanished → incomplete', async () => {
    const s = await C().checkCaptured(clean, { cred: { mode: 'S' }, ws: { runId: 'r', image: 'i' }, authVolume: 'v', op: async () => ({ ok: false, stdout: '', stderr: 'x' }) });
    assert.equal(s.exact.status, 'error'); assert.equal(s.status, 'incomplete');
    const k = await C().checkCaptured(clean, { cred: { mode: 'K', variable: 'ANTHROPIC_API_KEY' }, env: {} });
    assert.equal(k.status, 'incomplete');
  });
  test('securityHold: only a present, clean scan is not a hold', () => {
    assert.equal(S().securityHold({ sandbox: { credential_scan: { status: 'clean' } } }), null);
    for (const st of ['finding', 'incomplete', 'anything']) assert.equal(S().securityHold({ sandbox: { credential_scan: { status: st } } }).status, st);
    assert.equal(S().securityHold({ sandbox: {} }), null, 'no patch was captured: nothing to hold');
  });

  const runPipe = async (scan) => {
    const { runPipeline } = require('../../lib/qb-pipeline');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'k44h-'));
    const run = store.createRun({ kind: 'qb', request: 'x', repoPath: dir, runsDir: path.join(dir, 'runs') });
    let agentCalls = 0; const verifyOpts = []; const seen = [];
    const r = await runPipeline({ contract: { goal: 'g', acceptance_criteria: [] }, repoPath: dir, agent: 'claude-code', maxRetries: 3, run, noLlmVerify: false,
      memory: { recallFiles: () => [], recallRepairs: () => [], remember: async (...a) => seen.push(['remember', a[3]]), stats: () => ({}) },
      hooks: { credentialHold: (s) => seen.push(['hold', s.status]) },
      deps: { buildContext: async () => ({ relevant_files: [], symbol_map: {} }), refreshContext: async (c) => ({ context: c, refresh: {} }),
        orchestrate: async () => { agentCalls++; return { id: 'e', status: 'completed', changes: [{ file: `src/${OWN}.js` }], diff: 'd', sandbox: { run_id: 'r', stages: {}, credential_scan: scan } }; },
        verify: async (c, x, e, o) => { verifyOpts.push(o); return { verdict: 'fail', criteria_results: [], repair_hints: [{ criterion_id: 'AC-1', diagnosis: 'd', suggested_fix: 'f' }], failures: ['AC-1'] }; } } });
    return { r, run, agentCalls, verifyOpts, seen };
  };
  test('runPipeline: an incomplete scan → no judge, no further attempt, a local diagnostic and event; memory gets no file names', async () => {
    const { run, agentCalls, verifyOpts, seen } = await runPipe({ status: 'incomplete', findings: [], exact: { mode: 'S', status: 'error' } });
    assert.equal(agentCalls, 1);
    assert.equal(verifyOpts[0].noLlm, true);
    assert.deepEqual(seen.filter((s) => s[0] === 'hold'), [['hold', 'incomplete']]);
    const remembered = seen.find((s) => s[0] === 'remember');
    assert.ok(!remembered || !JSON.stringify(remembered[1] && remembered[1].changes).includes(OWN), 'held file names are not stored in memory (recalled into later model prompts)');
    assert.match(fs.readFileSync(path.join(run.dir, 'events.jsonl'), 'utf8'), /"credential\.hold"/);
  });
  test('the hold message says the check did not finish and export will be refused', () => {
    const out = S().holdMessage({ status: 'incomplete', findings: [], exact: { mode: 'S', status: 'error' } }).join('\n');
    assert.match(out, /could not finish/); assert.match(out, /qb patch` will refuse/); assert.doesNotMatch(out, /nothing found|clean/i);
  });
  test('verify() itself (bench baseline calls it directly): a held execution is never sent to the model judge', async () => {
    const { verify } = require('../../verify/verifier');
    const { mockFetch, ollamaReply } = require('../helpers/mocks');
    const contract = approve({ id: 'c', goal: 'g', acceptance_criteria: [{ id: 'AC-1', criterion: 'x', met: null, kind: 'non_behavioral' }], clarifying_question: null, scope: { allowed_changes: ['**'] } }, { via: 'test' });
    const diff = 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-a\n+b\n';
    for (const status of ['incomplete', 'finding']) {
      const m = mockFetch(ollamaReply({ met: true, evidence: 'ok' }));
      try {
        const rep = await verify(contract, null, { status: 'completed', diff, changes: [{ file: 'a.js', status: 'M', additions: 1, deletions: 1 }], sandbox: { credential_scan: { status, findings: [] } } }, { repoPath: '/repo' });
        assert.equal(m.calls.length, 0, `${status}: no model call`);
        assert.notEqual(rep.verdict, 'pass');
        assert.ok(rep.criteria_results.some((c) => c.method === 'security-hold'));
      } finally { m.restore(); }
    }
  });
  test('bench native arms (B–D): a held attempt is not retried', async () => {
    const { runArm } = require('../../bench/arms');
    const { gradingFixture } = require('../helpers/grading-fixture');
    const f = gradingFixture();
    try {
      const run = store.createRun({ kind: 'bench-arm', request: 'x', repoPath: f.repo.dir, baseSha: f.repo.head(), runsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'k44a-')) });
      const ORACLE = { approved_by: 'qb-test-oracle', goal: 'g', required_behavior: ['x'], acceptance_criteria: [{ id: 'AC-1', criterion: 'x', kind: 'non_behavioral', requirement_ids: ['R-1'] }],
        requirements: [{ id: 'R-1', quote: 'g' }], verification_plan: ['t'], scope: { allowed_changes: ['**'] } };
      let calls = 0;
      const failing = { status: 'ran', state: 'execution_error', exit_code: 1, report: null, report_error: 'no_report', output: 'fail' };
      const r = await runArm({ arm: 'B', spec: { ...f.spec, oracle: ORACLE }, repoPath: f.repo.dir, run, agentTimeMs: 60_000,
        runSandboxed: async () => { calls++; return { status: 'completed', diff: 'd', changes: [], unsupported_changes: [], sandbox: { verification: failing, credential_scan: { status: 'incomplete', findings: [] } } }; } });
      assert.equal(calls, 1);
      assert.equal(r.credential_hold, 'incomplete');
    } finally { f.cleanup(); }
  });
});

describe('B3: a failed own-credential check is cleared only against the same credential', () => {
  const raw = patchOf([' a', '+b']);
  test('fingerprint: salted SHA-256, never the value; different salt → different fingerprint', () => {
    const a = C().fingerprint('00'.repeat(16), OWN); const b = C().fingerprint('11'.repeat(16), OWN);
    assert.match(a, /^[0-9a-f]{64}$/); assert.notEqual(a, b);
    assert.equal(a, crypto.createHash('sha256').update(`${'00'.repeat(16)}:${OWN}`).digest('hex'));
  });
  test('credentialsForRun Mode K records the binding (variable, salt, fingerprint), no plaintext', async () => {
    const A = require('../../lib/sandbox/auth');
    const c = await A.credentialsForRun({ runId: 'r', image: 'i' }, os.tmpdir(), { stageDeadlineMs: 1, env: { ANTHROPIC_API_KEY: OWN } });
    assert.equal(c.binding.mode, 'K'); assert.equal(c.binding.variable, 'ANTHROPIC_API_KEY');
    assert.deepEqual(c.binding.fingerprints, [C().fingerprint(c.binding.salt, OWN)]);
    assert.ok(!JSON.stringify(c).includes(OWN));
  });
  test('checkCaptured carries the binding into the evidence', async () => {
    const binding = { schema: 'qb-credential-binding/1', mode: 'K', variable: 'ANTHROPIC_API_KEY', salt: 'ab'.repeat(16), fingerprints: [C().fingerprint('ab'.repeat(16), OWN)] };
    const r = await C().checkCaptured(raw, { cred: { mode: 'K', variable: 'ANTHROPIC_API_KEY', binding }, env: {} });
    assert.deepEqual(r.exact.binding, binding); assert.equal(r.status, 'incomplete');
  });
  test('recheck Mode K: a REPLACED key is "unbound", never absent; the same key is compared', async () => {
    const { recheckExact } = require('../../lib/sandbox/cli');
    const salt = 'cd'.repeat(16);
    const exact = { mode: 'K', status: 'error', binding: { schema: 'qb-credential-binding/1', mode: 'K', variable: 'ANTHROPIC_API_KEY', salt, fingerprints: [C().fingerprint(salt, OWN)] } };
    assert.equal((await recheckExact(raw, exact, { env: { ANTHROPIC_API_KEY: OTHER } })).status, 'unbound');
    assert.equal((await recheckExact(raw, exact, { env: { CLAUDE_CODE_OAUTH_TOKEN: OWN } })).status, 'unbound', 'only the recorded variable');
    assert.equal((await recheckExact(raw, exact, { env: { ANTHROPIC_API_KEY: OWN } })).status, 'absent');
    assert.equal((await recheckExact(patchOf([' a', `+${OWN}`]), exact, { env: { ANTHROPIC_API_KEY: OWN } })).status, 'found');
    assert.equal((await recheckExact(raw, { mode: 'K', status: 'error' }, { env: { ANTHROPIC_API_KEY: OWN } })).status, 'unbound', 'no binding: cannot be cleared');
  });
  test('recheck Mode S: the container gets the salt and expected fingerprints (not secrets) and answers UNBOUND when the login changed', async () => {
    const { recheckExact } = require('../../lib/sandbox/cli');
    const binding = { schema: 'qb-credential-binding/1', mode: 'S', salt: 'ef'.repeat(16), fingerprints: ['1'.repeat(64), '2'.repeat(64)] };
    for (const [word, want] of [['UNBOUND\n', 'unbound'], ['ABSENT\n', 'absent'], ['FOUND\n', 'found'], ['ABSENT', 'error']]) {
      const calls = [];
      const op = async (args) => { calls.push(args); return args[0] === 'start' ? { ok: true, stdout: word, stderr: '' } : { ok: true, stdout: 'id\n', stderr: '' }; };
      const r = await recheckExact(raw, { mode: 'S', status: 'error', binding }, { op, image: 'tools' });
      assert.equal(r.status, want, word);
      const create = calls.find((a) => a[0] === 'create').join(' ');
      assert.match(create, new RegExp(`QB_FP_SALT=${binding.salt}`)); assert.match(create, /QB_FP_EXPECT=1{64} 2{64}/);
      assert.match(create, /--network none/); assert.doesNotMatch(create, /run-copy/, 'the run copy is gone at export');
    }
    assert.equal((await recheckExact(raw, { mode: 'S', status: 'error' }, { op: async () => { throw new Error('must not run'); }, image: 't' })).status, 'unbound');
  });

  // qb patch, through the real export command
  function makeRun(rawBytes, scan) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'k44p-')); const repo = path.join(dir, 'repo'); fs.mkdirSync(repo);
    const runsDir = path.join(dir, 'runs');
    const run = store.createRun({ kind: 'qb', request: 'x', repoPath: repo, runsDir });
    run.startAttempt({ attempt: 1 });
    run.finishAttempt(1, { execution: { status: 'completed', changes: [], sandbox: { credential_scan: scan } }, report: { verdict: 'pass' } });
    run.artifact('a1-patch-raw', rawBytes, { ext: 'bin' });
    run.finish('VERIFIED', {});
    return { dir, runsDir, id: run.id };
  }
  async function patch(r, deps) {
    const errs = []; const ew = process.stderr.write; const ow = process.stdout.write;
    process.stderr.write = (x) => { errs.push(String(x)); return true; }; process.stdout.write = () => true;
    let code;
    try { code = await require('../../lib/sandbox/cli').patch([r.id, '--out', path.join(r.dir, 'out', 'p.patch')], { loadRun: (id) => store.loadRun(id, r.runsDir), env: {}, ...deps }); }
    finally { process.stderr.write = ew; process.stdout.write = ow; }
    return { code, err: errs.join('') };
  }
  test('qb patch: unbound recheck → refused, explained, no value', async () => {
    const ev = { ...S().scanPatch(raw), status: 'incomplete', exact: { mode: 'K', status: 'error' } };
    const p = await patch(makeRun(raw, ev), { recheck: async () => ({ mode: 'K', status: 'unbound' }) });
    assert.equal(p.code, 1);
    assert.match(p.err, /not the one this run used|cannot show/);
  });
  test('qb patch: the real recheck with today\'s (replaced) key refuses; the run\'s own key exports', async () => {
    const salt = '12'.repeat(16);
    const ev = { ...S().scanPatch(raw), status: 'incomplete', exact: { mode: 'K', status: 'error', binding: { schema: 'qb-credential-binding/1', mode: 'K', variable: 'ANTHROPIC_API_KEY', salt, fingerprints: [C().fingerprint(salt, OWN)] } } };
    const { recheckExact } = require('../../lib/sandbox/cli');
    const replaced = await patch(makeRun(raw, ev), { env: { ANTHROPIC_API_KEY: OTHER }, recheck: (b, e) => recheckExact(b, e, { env: { ANTHROPIC_API_KEY: OTHER } }) });
    assert.equal(replaced.code, 1); assert.ok(!replaced.err.includes(OTHER));
    const same = await patch(makeRun(raw, ev), { env: { ANTHROPIC_API_KEY: OWN }, recheck: (b, e) => recheckExact(b, e, { env: { ANTHROPIC_API_KEY: OWN } }) });
    assert.equal(same.code, 0, same.err);
  });
  test('qb patch: a stored scan that is not clean but has no failed exact check (e.g. status forged to incomplete) still refuses', async () => {
    const ev = { ...S().scanPatch(raw), status: 'incomplete', exact: { mode: 'S', status: 'absent' } };
    assert.equal((await patch(makeRun(raw, ev), { recheck: async () => { throw new Error('no'); } })).code, 1);
  });
});

describe('the temporary scan container is always removed (timeout, cancellation, failure)', () => {
  const rec = (start) => { const calls = []; const op = async (args, o) => { calls.push(args); if (args[0] === 'start') return start(o); return { ok: true, stdout: 'cid\n', stderr: '' }; }; return { calls, op }; };
  const name = (calls) => calls.find((a) => a[0] === 'create')[calls.find((a) => a[0] === 'create').indexOf('--name') + 1];
  test('a named, labelled container; removed after a normal answer', async () => {
    const { calls, op } = rec(async () => ({ ok: true, stdout: 'ABSENT\n', stderr: '' }));
    assert.equal(await C().exactModeS(Buffer.from('x'), { image: 'i', runId: 'qb-run1', authVolume: 'v', op, labels: ['--label', 'qb.run=qb-run1'] }), 'absent');
    const n = name(calls);
    assert.match(n, /^qb-run1-credcheck-[0-9a-f]+$/);
    assert.ok(calls.find((a) => a[0] === 'create').includes('qb.run=qb-run1'));
    assert.deepEqual(calls.at(-1), ['rm', '-f', n]);
  });
  test('timeout: the attached client is stopped → error, and the container is removed', async () => {
    const { calls, op } = rec(async () => ({ ok: false, timedOut: true, stdout: '', stderr: '' }));
    assert.equal(await C().exactModeS(Buffer.from('x'), { image: 'i', authVolume: 'v', op, timeoutMs: 5 }), 'error');
    assert.deepEqual(calls.at(-1), ['rm', '-f', name(calls)]);
    assert.ok(calls.find((a) => a[0] === 'create').some((a) => /^qb\.role=credential-check$/.test(a)), 'labelled for cleanup');
  });
  test('cancellation: an abort removes the container at once → error', async () => {
    const ac = new AbortController();
    let release;
    const { calls, op } = rec(() => new Promise((r) => { release = r; setTimeout(() => ac.abort(new Error('run cancelled')), 5); }));
    const wrapped = async (args, o) => { const r = op(args, o); if (args[0] === 'rm' && release) release({ ok: false, stdout: '', stderr: 'killed' }); return r; };
    assert.equal(await C().exactModeS(Buffer.from('x'), { image: 'i', authVolume: 'v', op: wrapped, signal: ac.signal }), 'error');
    assert.ok(calls.filter((a) => a[0] === 'rm').length >= 1);
  });
  test('create failed (or threw): still removed by name; error', async () => {
    const calls = [];
    const op = async (args) => { calls.push(args); if (args[0] === 'create') throw new Error('daemon'); return { ok: true, stdout: '', stderr: '' }; };
    assert.equal(await C().exactModeS(Buffer.from('x'), { image: 'i', authVolume: 'v', op }), 'error');
    assert.equal(calls.at(-1)[0], 'rm');
  });
});
