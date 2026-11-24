/**
 * KAN-44 (senior 10814): copied-credential detection in the captured patch, and its effect on `qb patch`.
 * DUMMY values only. A finding refuses ordinary export with a redacted explanation and no bypass; the patch bytes are
 * never changed; the value is never printed. A clean scan is not proof (encoded or transformed values are not found).
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../../run/store');

const S = () => require('../../lib/credential-scan');
const C = () => require('../../lib/sandbox/credential-check');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
// assembled so that no literal in this file matches a known format
const DUMMY = { oauth: ['sk', 'ant', 'oat01', 'DUMMYDUMMYDUMMY0000'].join('-'), github: `gh${'p'}_${'D'.repeat(36)}`, npm: `np${'m'}_${'D'.repeat(36)}`, aws: `AK${'IA'}${'D'.repeat(16)}` };
const EXACT = 'plain-dummy-run-credential-0123456789';   // matches no known format
const patchOf = (lines, file = 'lib/a.js') => Buffer.from([`diff --git a/${file} b/${file}`, 'index 111..222 100644', `--- a/${file}`, `+++ b/${file}`,
  `@@ -1,${lines.filter((l) => l[0] !== '+').length} +1,${lines.filter((l) => l[0] !== '-').length} @@`, ...lines, ''].join('\n'));

describe('scanPatch', () => {
  test('clean patch: clean, bound to the exact bytes, limits stated', () => {
    const p = patchOf([' a', '+b']);
    const r = S().scanPatch(p);
    assert.equal(r.schema, 'qb-credential-scan/1');
    assert.equal(r.status, 'clean');
    assert.equal(r.patch_sha256, sha(p));
    assert.deepEqual(r.findings, []);
    assert.ok(r.limits.some((l) => /not proof/.test(l)) && r.limits.some((l) => /encoded/.test(l)));
  });
  for (const [kind, v] of Object.entries(DUMMY)) {
    test(`known format on an added line: ${kind}`, () => {
      const r = S().scanPatch(patchOf([' a', `+const k = '${v}'`]));
      assert.equal(r.status, 'finding');
      assert.equal(r.findings.length, 1);
      assert.equal(r.findings[0].file, 'lib/a.js');
    });
  }
  test('a private key block header, and a credential in a file NAME', () => {
    assert.equal(S().scanPatch(patchOf([' a', `+-----BEGIN ${'PRIVATE'} KEY-----`])).status, 'finding');
    const named = S().scanPatch(patchOf([' a', '+b'], `lib/${DUMMY.github}.js`));
    assert.equal(named.status, 'finding');
    assert.ok(!JSON.stringify(named).includes(DUMMY.github), 'the file name is not repeated');
  });
  test('a known format only on removed or context lines is the user\'s own content, not a finding', () => {
    assert.equal(S().scanPatch(patchOf([` keep ${DUMMY.oauth}`, `-old ${DUMMY.github}`, '+new'])).status, 'clean');
  });
  test('hunk counting: "+" content that looks like a header is still scanned; text after a hunk is scanned', () => {
    assert.equal(S().scanPatch(patchOf([' a', `+--- a/x ${DUMMY.oauth}`])).status, 'finding');
    assert.equal(S().scanPatch(Buffer.concat([patchOf([' a', '+b']), Buffer.from(`trailer ${DUMMY.oauth}\n`)])).status, 'finding');
  });
  test('a malformed hunk header fails towards scanning every line', () => {
    assert.equal(S().scanPatch(Buffer.from(`@@ broken @@\n ${DUMMY.oauth}\n`)).status, 'finding');
  });
  test('the exact credential is found anywhere, also on context lines and in binary-safe bytes', () => {
    for (const p of [patchOf([` ctx ${EXACT}`, '+b']), patchOf([' a', `+${EXACT}`]), Buffer.concat([Buffer.from([0, 255, 254]), Buffer.from(EXACT), Buffer.from([0])])]) {
      const r = S().scanPatch(p, { exact: [EXACT] });
      assert.equal(r.status, 'finding');
      assert.ok(r.findings.some((f) => f.kind === 'run_credential'));
    }
    assert.equal(S().scanPatch(patchOf([' a', '+b']), { exact: ['', 'short'] }).status, 'clean', 'empty and very short values are not searched');
  });
  test('git binary patches are reported as not scanned, never as clean content', () => {
    const r = S().scanPatch(Buffer.from('diff --git a/x.png b/x.png\nnew file mode 100644\nindex 0000000..1\nGIT binary patch\nliteral 5\nMcmZQzABCDE\n\n'));
    assert.equal(r.status, 'clean');
    assert.equal(r.unscanned.binary_files, 1);
  });
  test('disclosed limits, pinned: base64, split and reversed values are NOT found', () => {
    for (const t of [Buffer.from(EXACT).toString('base64'), `${EXACT.slice(0, 15)}' + '${EXACT.slice(15)}`, [...EXACT].reverse().join('')]) {
      assert.equal(S().scanPatch(patchOf([' a', `+${t}`]), { exact: [EXACT] }).status, 'clean', t);
    }
  });
  test('the report never contains the value, and the input bytes are unchanged', () => {
    const p = patchOf([' a', `+${DUMMY.oauth} ${EXACT}`]); const before = sha(p);
    const r = JSON.stringify(S().scanPatch(p, { exact: [EXACT] }));
    for (const v of [DUMMY.oauth, EXACT]) assert.ok(!r.includes(v) && !r.includes(v.slice(0, 12)));
    assert.equal(sha(p), before);
  });
});

describe('checkCaptured: the exact per-run credential', () => {
  const raw = patchOf([' a', `+${EXACT}`]); const clean = patchOf([' a', '+b']);
  test('Mode K: compared in this process, by variable; never stored', async () => {
    const r = await C().checkCaptured(raw, { cred: { mode: 'K', variable: 'ANTHROPIC_API_KEY' }, env: { ANTHROPIC_API_KEY: EXACT } });
    assert.equal(r.status, 'finding');
    assert.deepEqual(r.exact, { mode: 'K', status: 'found' });
    assert.ok(!JSON.stringify(r).includes(EXACT));
    assert.deepEqual((await C().checkCaptured(clean, { cred: { mode: 'K', variable: 'ANTHROPIC_API_KEY' }, env: { ANTHROPIC_API_KEY: EXACT } })).exact, { mode: 'K', status: 'absent' });
    assert.equal((await C().checkCaptured(clean, { cred: { mode: 'K', variable: 'ANTHROPIC_API_KEY' }, env: {} })).exact.status, 'error', 'a vanished variable is not "absent"');
  });
  test('Mode S: compared in a trusted container with no network, against the stored login and the run copy; only a word comes back', async () => {
    const calls = [];
    const op = async (args, o) => { calls.push({ args, o }); return { ok: true, stdout: 'FOUND\n', stderr: '' }; };
    const r = await C().checkCaptured(raw, { cred: { mode: 'S' }, ws: { runId: 'r1', image: 'tools' }, authVolume: 'vol', op });
    assert.deepEqual(r.exact, { mode: 'S', status: 'found' });
    assert.equal(r.status, 'finding');
    const a = calls[0].args.join(' ');
    assert.match(a, /--network none/); assert.match(a, /--read-only/); assert.match(a, /--cap-drop ALL/);
    assert.match(a, /-v vol:\/stored:ro/); assert.match(a, /-v r1-cred:\/run-copy:ro/);
    assert.ok(!a.includes(EXACT)); assert.ok(Buffer.isBuffer(calls[0].o.input) && calls[0].o.input.equals(raw));
  });
  test('Mode S: anything but exactly FOUND or ABSENT is an error, never absent', async () => {
    for (const out of [{ ok: true, stdout: '' }, { ok: true, stdout: 'ABSENT FOUND' }, { ok: false, stdout: 'ABSENT\n', stderr: 'x' }, { ok: true, stdout: `${EXACT}\n` }]) {
      const r = await C().checkCaptured(clean, { cred: { mode: 'S' }, ws: { runId: 'r', image: 'i' }, authVolume: 'v', op: async () => ({ stderr: '', ...out }) });
      assert.equal(r.exact.status, 'error'); assert.ok(!JSON.stringify(r).includes(EXACT));
    }
    const thrown = await C().checkCaptured(clean, { cred: { mode: 'S' }, ws: { runId: 'r', image: 'i' }, authVolume: 'v', op: async () => { throw new Error(EXACT); } });
    assert.equal(thrown.exact.status, 'error'); assert.ok(!JSON.stringify(thrown).includes(EXACT));
  });
  test('no credential was provided to the run (scripted agent, grading): not applicable', async () => {
    assert.deepEqual((await C().checkCaptured(clean, { cred: null })).exact, { mode: 'none', status: 'not_applicable' });
  });
});

describe('qb patch', () => {
  const ROOT = path.join(__dirname, '..', '..');
  /** A finished run with one exportable patch; `scan` = the stored evidence (undefined: a run from before the scan). */
  function makeRun(raw, scan) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'k44-')); const repo = path.join(dir, 'repo'); fs.mkdirSync(repo);
    const runsDir = path.join(dir, 'runs');
    const run = store.createRun({ kind: 'qb', request: 'x', repoPath: repo, runsDir });
    run.startAttempt({ attempt: 1 });
    run.finishAttempt(1, { execution: { status: 'completed', changes: [], sandbox: { ...(scan ? { credential_scan: scan } : {}) } }, report: { verdict: 'pass' } });
    run.artifact('a1-patch-raw', raw, { ext: 'bin' });
    run.finish('VERIFIED', {});
    return { dir, runsDir, id: run.id, rawPath: path.join(run.dir, run.manifest.artifacts['a1-patch-raw'].path) };
  }
  async function patch(r, deps = {}, args = []) {
    const errs = []; let out = Buffer.alloc(0);
    const prev = process.env.QB_RUNS_DIR; process.env.QB_RUNS_DIR = r.runsDir;
    const ew = process.stderr.write; const ow = process.stdout.write;
    process.stderr.write = (x) => { errs.push(String(x)); return true; };
    process.stdout.write = (x) => { out = Buffer.concat([out, Buffer.from(x)]); return true; };
    let code; const file = path.join(r.dir, 'out', 'p.patch');
    try { code = await require('../../lib/sandbox/cli').patch([r.id, ...(args.length ? args : ['--out', file])], { loadRun: (id) => store.loadRun(id, { runsDir: r.runsDir }), env: {}, ...deps }); }
    finally { process.stderr.write = ew; process.stdout.write = ow; if (prev === undefined) delete process.env.QB_RUNS_DIR; else process.env.QB_RUNS_DIR = prev; }
    return { code, err: errs.join(''), out, file: fs.existsSync(file) ? fs.readFileSync(file) : null };
  }
  const evidence = async (raw, exact) => ({ ...S().scanPatch(raw), exact });
  const clean = patchOf([' a', '+b']); const leaked = patchOf([' a', `+${DUMMY.oauth}`]);

  test('clean, bound evidence: exported byte-exact, and the limit is stated', async () => {
    const r = makeRun(clean, await evidence(clean, { mode: 'S', status: 'absent' }));
    const p = await patch(r);
    assert.equal(p.code, 0, p.err);
    assert.ok(p.file.subarray(p.file.length - clean.length).equals(clean));
    assert.match(p.err, /credential scan: nothing found .*not proof/);
  });
  for (const flag of [[], ['--stdout']]) {
    test(`a known format refuses export${flag.length ? ' to stdout' : ''}: redacted reason, nothing written, stored bytes unchanged`, async () => {
      const r = makeRun(leaked, await evidence(leaked, { mode: 'S', status: 'absent' }));
      const p = await patch(r, {}, flag);
      assert.equal(p.code, 1);
      assert.equal(p.out.length, 0); assert.equal(p.file, null);
      assert.match(p.err, /refusing to export.*credential/);
      assert.match(p.err, /revoke or rotate/);
      assert.ok(!p.err.includes(DUMMY.oauth) && !p.err.includes('DUMMYDUMMY'));
      assert.ok(fs.readFileSync(r.rawPath).equals(leaked));
    });
  }
  test('export rescans: evidence that says clean does not outvote a finding in the bytes', async () => {
    const lie = { ...(await evidence(leaked, { mode: 'S', status: 'absent' })), status: 'clean', findings: [] };
    assert.equal((await patch(makeRun(leaked, lie))).code, 1);
  });
  test('evidence for the exact credential refuses, although the value matches no known format', async () => {
    const raw = patchOf([' a', `+${EXACT}`]);
    const p = await patch(makeRun(raw, { ...(await evidence(raw, { mode: 'S', status: 'found' })), status: 'finding', findings: [{ kind: 'run_credential', count: 1, file: null }] }));
    assert.equal(p.code, 1); assert.ok(!p.err.includes(EXACT));
  });
  test('evidence bound to another patch is refused', async () => {
    const p = await patch(makeRun(clean, await evidence(patchOf([' a', '+c']), { mode: 'S', status: 'absent' })));
    assert.equal(p.code, 1); assert.match(p.err, /scan evidence.*different patch/);
  });
  test('an exact check that failed during the run is repeated; still failing → refused, fail closed', async () => {
    const raw = clean; const ev = await evidence(raw, { mode: 'S', status: 'error' });
    const no = await patch(makeRun(raw, ev), { recheck: async () => ({ mode: 'S', status: 'error' }) });
    assert.equal(no.code, 1); assert.match(no.err, /could not check/);
    assert.equal((await patch(makeRun(raw, ev), { recheck: async () => ({ mode: 'S', status: 'found' }) })).code, 1);
    assert.equal((await patch(makeRun(raw, ev), { recheck: async () => ({ mode: 'S', status: 'absent' }) })).code, 0);
  });
  test('a run from before the scan: known formats are scanned now; the missing exact check is stated', async () => {
    const ok = await patch(makeRun(clean));
    assert.equal(ok.code, 0); assert.match(ok.err, /this run's own credential was not checked/);
    assert.equal((await patch(makeRun(leaked))).code, 1);
  });
  test('a Mode K credential still in the environment is searched at export too', async () => {
    const raw = patchOf([' a', `+${EXACT}`]);
    const p = await patch(makeRun(raw), { env: { ANTHROPIC_API_KEY: EXACT } });
    assert.equal(p.code, 1); assert.ok(!p.err.includes(EXACT));
  });
  test('there is no bypass option', () => {
    const src = fs.readFileSync(path.join(ROOT, 'lib', 'sandbox', 'cli.js'), 'utf8');
    assert.doesNotMatch(src, /--(?:force|allow|skip|no-scan|ignore)[a-z-]*/);
  });
});

describe('run wiring', () => {
  test('a finding stops the repair loop and keeps the diff away from the model judge', async () => {
    const { runPipeline } = require('../../lib/qb-pipeline');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'k44w-'));
    const run = store.createRun({ kind: 'qb', request: 'x', repoPath: dir, runsDir: path.join(dir, 'runs') });
    let agentCalls = 0; const verifyOpts = []; const seen = [];
    const contract = { goal: 'g', acceptance_criteria: [] };
    const r = await runPipeline({ contract, repoPath: dir, agent: 'claude-code', maxRetries: 3, run, noLlmVerify: false,
      hooks: { credentialFound: (scan) => seen.push(scan) },
      deps: { buildContext: async () => ({ relevant_files: [], symbol_map: {} }), refreshContext: async (c) => c,
        orchestrate: async () => { agentCalls++; return { id: 'e', status: 'completed', changes: [], diff: 'd', sandbox: { run_id: 'r', stages: {}, credential_scan: { status: 'finding', findings: [{ kind: 'anthropic_key', count: 1, file: 'lib/a.js' }] } } }; },
        verify: async (c, x, e, o) => { verifyOpts.push(o); return { verdict: 'fail', criteria_results: [], repair_hints: [], failures: [] }; } } });
    assert.equal(agentCalls, 1);
    assert.equal(verifyOpts[0].noLlm, true);
    assert.equal(seen.length, 1);
    assert.equal(r.report.verdict, 'fail', 'the verdict itself is unchanged');
    assert.ok(fs.readFileSync(path.join(run.dir, 'events.jsonl'), 'utf8').includes('credential.found'));
  });
});
