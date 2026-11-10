/**
 * KAN-110: allowlist and leakage fixtures for the public-dataset import (bench/public/).
 * - The field policy is an allowlist: unknown columns are quarantined; grading material never
 *   reaches the agent packet; the agent packet is exactly the published problem fields.
 * - The leak scanner removes answer-bearing IDs (instance ID, fix SHA, fixing PR) and links to
 *   the same repository's history, and nothing else.
 * - The ported QB rules agree with the real QB code they copy (context/detector.js, test-plan.js).
 * - If the importer has been run locally (bench/public/out/ exists), the real agent packets are
 *   scanned too. That data is gitignored, so on CI those checks are skipped, not failed.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PUB = path.join(__dirname, '..', '..', 'bench', 'public');
const load = (m) => import(path.join(PUB, m));

const PRO_ID = 'instance_NodeBB__NodeBB-0123456789abcdef0123456789abcdef01234567-vabc123';
const PRO_SHA = '0123456789abcdef0123456789abcdef01234567';

describe('KAN-110 field policy (allowlist)', () => {
  test('every column has exactly one valid class, and the agent sees only published problem fields', async () => {
    const { POLICY, CLASSES } = await load('field-policy.mjs');
    const agentAllowed = new Set(['problem_statement', 'requirements', 'interface']);
    for (const [src, cols] of Object.entries(POLICY)) {
      for (const [col, [cls, why]] of Object.entries(cols)) {
        assert.ok(CLASSES.includes(cls), `${src}.${col}: ${cls}`);
        assert.ok(why && why.length > 10, `${src}.${col} needs a field-dictionary explanation`);
        if (cls === 'agent') assert.ok(agentAllowed.has(col), `${src}.${col} must not be agent-visible`);
      }
    }
  });

  test('grading material, hints and answer-bearing IDs are never agent-visible', async () => {
    const { POLICY } = await load('field-policy.mjs');
    const never = ['patch', 'test_patch', 'fail_to_pass', 'pass_to_pass', 'FAIL_TO_PASS', 'PASS_TO_PASS', 'F2P', 'P2P', 'F2F',
      'eval_script', 'test_command', 'before_repo_set_cmd', 'selected_test_files_to_run', 'log_parser', 'hints_text', 'modified_nodes',
      'instance_id', 'pull_number', 'hard', 'num_nodes', 'num_func_changes', 'dockerhub_tag', 'docker_image', 'image'];
    for (const [src, cols] of Object.entries(POLICY)) for (const c of never) if (cols[c]) assert.notEqual(cols[c][0], 'agent', `${src}.${c}`);
    for (const g of ['patch', 'test_patch']) for (const [src, cols] of Object.entries(POLICY)) assert.equal(cols[g][0], 'vault', `${src}.${g}`);
    for (const [src, cols] of Object.entries(POLICY)) if (cols.hints_text) assert.equal(cols.hints_text[0], 'quarantine', src);
  });

  test('an unknown upstream column is quarantined (fail closed), never agent-visible', async () => {
    const { partition } = await load('field-policy.mjs');
    const p = partition('swe-bench-pro-v2', { problem_statement: 'x', patch: 'GOLD', solution_trajectory: 'leak', new_hint: 'h' });
    assert.deepEqual(Object.keys(p.agent), ['problem_statement']);
    assert.deepEqual(p.unknown.sort(), ['new_hint', 'solution_trajectory']);
    assert.equal(p.quarantine.solution_trajectory, 'leak');
    assert.equal(p.vault.patch, 'GOLD');
    assert.throws(() => partition('nope', {}), /no field policy/);
  });
});

describe('KAN-110 leak scanner', () => {
  test('answer IDs: Pro fix SHA from the instance ID; PR number from Multilingual/PolyBench IDs', async () => {
    const { answerIds } = await load('leak.mjs');
    assert.equal(answerIds('swe-bench-pro-v2', { instance_id: PRO_ID, repo: 'NodeBB/NodeBB' }).fix_sha, PRO_SHA);
    assert.equal(answerIds('swe-bench-multilingual', { instance_id: 'preactjs__preact-4152', repo: 'preactjs/preact' }).fix_pr, '4152');
    assert.equal(answerIds('swe-polybench', { instance_id: 'mui__material-ui-123', pull_number: 456, repo: 'mui/material-ui' }).fix_pr, '456');
  });

  test('redacts the instance ID, full and short fix SHA, same-repo PR/commit links and #PR', async () => {
    const { answerIds, redact } = await load('leak.mjs');
    const ids = answerIds('swe-bench-pro-v2', { instance_id: PRO_ID, repo: 'NodeBB/NodeBB' });
    const t = `See ${PRO_ID}. Fixed in ${PRO_SHA} (short ${PRO_SHA.slice(0, 9)}). https://github.com/NodeBB/NodeBB/pull/999 and https://github.com/NodeBB/NodeBB/commit/abcdef1 and https://github.com/NodeBB/NodeBB/blob/0123abc/src/x.js`;
    const r = redact(t, ids);
    assert.ok(!r.text.includes(PRO_SHA.slice(0, 7)), r.text);
    assert.ok(!r.text.includes(PRO_ID));
    assert.ok(!/github\.com\/NodeBB\/NodeBB\/(pull|commit|blob)/.test(r.text), r.text);
    assert.deepEqual([...new Set(r.redactions.map((x) => x.kind))].sort(), ['fix_sha', 'instance_id', 'repo_history_link']);
    const pr = redact('Fixes #4152, see preactjs/preact#4152; unrelated #41520 and #12', answerIds('swe-bench-multilingual', { instance_id: 'preactjs__preact-4152', repo: 'preactjs/preact' }));
    assert.equal(pr.text, 'Fixes #[pr], see [pr]; unrelated #41520 and #12');
  });

  test('leaves everything else alone: other repositories, issue links, ordinary hex and numbers', async () => {
    const { answerIds, redact } = await load('leak.mjs');
    const ids = answerIds('swe-bench-multilingual', { instance_id: 'axios__axios-5085', repo: 'axios/axios' });
    const t = 'Repro: https://github.com/other/repo/pull/5085 and https://github.com/axios/axios/issues/5000, color #ff0000, port 5085.';
    assert.deepEqual(redact(t, ids), { text: t, redactions: [] });
  });

  test('gold overlap is reported as counts only, never lines', async () => {
    const { goldOverlap } = await load('leak.mjs');
    const patch = '+++ b/x.js\n+  return computeTheAnswerFromInputs(a, b);\n+  x;\n';
    assert.deepEqual(goldOverlap('the fix is return computeTheAnswerFromInputs(a, b); thanks', patch), { added_lines: 1, found: 1 });
    assert.deepEqual(goldOverlap('nothing here', patch), { added_lines: 1, found: 0 });
  });

  test('opaque task IDs are deterministic and carry no instance ID, SHA or PR number', async () => {
    const { opaqueId } = await load('util.mjs');
    const id = opaqueId('swe-bench-pro-v2', PRO_ID);
    assert.match(id, /^qbt_[0-9a-f]{12}$/);
    assert.equal(id, opaqueId('swe-bench-pro-v2', PRO_ID));
    assert.notEqual(id, opaqueId('swe-polybench', PRO_ID));
    assert.ok(!PRO_SHA.includes(id.slice(4)) && !id.includes('4152'));
  });

  test('CSV parser handles quoted commas, quotes and newlines', async () => {
    const { parseCsv } = await load('util.mjs');
    assert.deepEqual(parseCsv('a,b,c\n1,"x, ""y""\nz",3\r\n4,5,6\n'), [{ a: '1', b: 'x, "y"\nz', c: '3' }, { a: '4', b: '5', c: '6' }]);
    assert.throws(() => parseCsv('a,b\n1,2,3\n'), /header has 2/);
  });
});

describe('KAN-110 QB rules port agrees with QB source', () => {
  const { detectTestRunner } = require('../../context/detector.js');
  const { testPlan } = require('../../context/test-plan.js');
  const fixtures = [
    { name: 'jest dep', pkg: { devDependencies: { jest: '1' }, scripts: { test: 'jest' } } },
    { name: 'vitest beats jest', pkg: { devDependencies: { jest: '1', vitest: '1' }, scripts: { test: 'vitest' } } },
    { name: 'mocha in script only', pkg: { scripts: { test: 'mocha test/' } } },
    { name: 'node --test script', pkg: { scripts: { test: 'node --test test/' } } },
    { name: 'ts-jest only (QB detector misses it)', pkg: { devDependencies: { 'ts-jest': '1' }, scripts: { test: 'yarn unit' } } },
    { name: 'no test script', pkg: { scripts: { build: 'tsc' } } },
    { name: 'karma (QB detector misses it)', pkg: { devDependencies: { karma: '6' }, scripts: { test: 'karma start' } } },
    { name: 'node:test import in test/', pkg: { scripts: { test: 'node test/a.js' } }, files: { 'test/a.js': "const t = require('node:test');\n" } },
  ];
  for (const f of fixtures) {
    test(`parity: ${f.name}`, async () => {
      const R = await load('qb-rules.mjs');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kan110-'));
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(f.pkg));
      const heads = [];
      for (const [p, c] of Object.entries(f.files || {})) { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), c); heads.push(c); }
      assert.equal(R.detectTestRunner(f.pkg, heads), detectTestRunner(dir));
      const real = testPlan(dir); const port = R.testPlan(f.pkg, heads);
      assert.equal(port.status, real.status); assert.equal(port.reason, real.reason);
      fs.rmSync(dir, { recursive: true, force: true });
    });
  }

  test('deps plan mirrors sandbox/scripts/deps-plan.sh', async () => {
    const { depsPlan } = await load('qb-rules.mjs');
    const ok = { lockfileVersion: 3, packages: { '': {}, 'node_modules/a': { resolved: 'https://registry.npmjs.org/a/-/a-1.tgz' } } };
    assert.equal(depsPlan({ scripts: {} }, ok).status, 'ready');
    assert.equal(depsPlan({}, null).reason, 'setup_missing_lockfile');
    assert.match(depsPlan({}, { lockfileVersion: 1 }).detail, /lockfileVersion 1/);
    assert.equal(depsPlan({ workspaces: ['p/*'] }, ok).detail, 'npm workspaces');
    assert.match(depsPlan({}, { lockfileVersion: 2, packages: { x: { resolved: 'git+ssh://x' } } }).detail, /1 file:\/link:\/git/);
    assert.match(depsPlan({ scripts: { postinstall: 'x' } }, ok).detail, /postinstall/);
    // The real script uses the same keyword list
    const sh = fs.readFileSync(path.join(__dirname, '..', '..', 'sandbox', 'scripts', 'deps-plan.sh'), 'utf8');
    for (const k of ['"preinstall"', '"install"', '"postinstall"', '"prepublish"', '"preprepare"', '"prepare"', '"postprepare"', 'lockfileVersion', 'workspaces', 'file:|git|github:|link:']) assert.ok(sh.includes(k), k);
  });

  test('actual runner follows script indirection and grading commands; classify is strict', async () => {
    const R = await load('qb-rules.mjs');
    assert.deepEqual(R.actualRunnerFromScripts({ scripts: { test: 'yarn test:unit', 'test:unit': 'cross-env X=1 jest --ci' } }).frameworks, ['jest']);
    assert.deepEqual(R.actualRunnerFromScripts({ scripts: { test: 'run-s test:*', 'test:a': 'karma start', 'test:b': 'node --test' } }).frameworks.sort(), ['karma', 'node-test']);
    assert.deepEqual(R.frameworksIn('npx jest path/to/file.test.ts'), ['jest']);
    const base = { pkg_present: true, quarterback_json: false, test_plan: { status: 'run', runner: 'node-test' }, deps_plan: { status: 'ready' }, runner_from_scripts: { frameworks: ['node-test'] }, runner_from_grader: [], services: [] };
    assert.equal(R.classify(base).status, 'compatible');
    assert.equal(R.classify({ ...base, runner_from_grader: ['jest'] }).status, 'incompatible');
    assert.equal(R.classify({ ...base, services: ['redis'] }).status, 'incompatible');
    assert.equal(R.classify({ ...base, test_plan: { status: 'run', runner: null }, runner_from_scripts: { frameworks: [] } }).status, 'unknown');
    assert.equal(R.classify({ fetch_error: 'HTTP 404' }).status, 'unknown');
  });
});

describe('KAN-110 real agent packets (local data only)', () => {
  const out = path.join(PUB, 'out');
  const have = fs.existsSync(path.join(out, 'agent'));
  test('every agent packet has only allowed keys and no answer-bearing IDs', { skip: !have && 'bench/public/out not present (gitignored data; run bench/public/import.mjs)' }, () => {
    const allowed = new Set(['task_id', 'problem_statement', 'requirements', 'interface']);
    let n = 0;
    for (const f of fs.readdirSync(path.join(out, 'agent'))) {
      const ctl = new Map(fs.readFileSync(path.join(out, 'controller', f), 'utf8').trim().split('\n').map((l) => { const c = JSON.parse(l); return [c.task_id, c]; }));
      for (const line of fs.readFileSync(path.join(out, 'agent', f), 'utf8').trim().split('\n')) {
        const a = JSON.parse(line); n++;
        for (const k of Object.keys(a)) assert.ok(allowed.has(k), `${f}: agent key ${k}`);
        const c = ctl.get(a.task_id); assert.ok(c, `${a.task_id} has a controller row`);
        const text = Object.values(a).join('\n');
        assert.ok(!text.includes(c.instance_id), `${a.task_id}: instance ID in agent text`);
        const sha = /-([0-9a-f]{40})(?:-v[0-9a-f]+)?$/.exec(c.instance_id)?.[1];
        if (sha) assert.ok(!text.toLowerCase().includes(sha.slice(0, 10)), `${a.task_id}: fix SHA in agent text`);
        assert.ok(!new RegExp(`github\\.com/${c.repo.replace('/', '\\/')}/(pull|commit|compare)/`, 'i').test(text), `${a.task_id}: same-repo history link`);
      }
    }
    assert.ok(n > 0);
  });
});

describe('KAN-110 frozen shortlist rule', () => {
  const mk = (i, src, repo, extra = {}) => ({ task_id: `qbt_${String(i).padStart(12, '0')}`, source: src, repo, classification: { status: 'compatible', reasons: [] }, leak: { gold_overlap_lines: 0 }, facts: { services: [] }, prior_exposure_arshad: 'none', ...extra });
  test('seed matches its frozen input; selection is deterministic, diverse and ignores outcomes', async () => {
    const { select, eligible } = await load('shortlist.mjs');
    const list = [mk(1, 'swe-polybench', 'a/a'), mk(2, 'swe-polybench', 'a/a'), mk(3, 'swe-polybench', 'b/b'), mk(4, 'swe-bench-pro-v2', 'c/c'),
      mk(5, 'swe-bench-multilingual', 'd/d', { classification: { status: 'incompatible', reasons: ['x'] } }), mk(6, 'swe-polybench', 'e/e', { leak: { gold_overlap_lines: 2 } }),
      mk(7, 'swe-bench-pro-v2', 'f/f', { prior_exposure_arshad: null }), mk(8, 'swe-polybench', 'g/g', { duplicate_of: 'qbt_x' })];
    const a = select(list); const b = select([...list].reverse());
    assert.deepEqual(a.picks.map((t) => t.task_id), b.picks.map((t) => t.task_id), 'order of input does not matter');
    const poly = a.picks.filter((t) => t.source === 'swe-polybench');
    assert.equal(poly.length, 2); assert.equal(new Set(poly.map((t) => t.repo)).size, 2, 'different repositories first');
    assert.deepEqual(a.shortfall, { 'swe-bench-pro-v2': 1, 'swe-bench-multilingual': 2 }, 'shortfall is reported, not hidden');
    assert.ok(eligible(list[4]).length && eligible(list[5]).length && eligible(list[6]).length && eligible(list[7]).length);
    // Outcome-like fields have no effect
    const withOutcomes = list.map((t) => ({ ...t, hard: true, qb_result: 'pass', baseline: 'fail' }));
    assert.deepEqual(select(withOutcomes).picks.map((t) => t.task_id), a.picks.map((t) => t.task_id));
  });

  test('blocker tags cover runners the QB detector misses and old runtimes', async () => {
    const { blockers } = await load('adapters.mjs');
    const t = { facts: { qb_detected_runner: null, runner_from_scripts: { frameworks: [] }, runner_from_grader: ['jest'], qb_deps_plan: { status: 'blocked', reason: 'setup_missing_lockfile' }, package_manager: { lockfiles: ['yarn'] }, qb_test_plan: { status: 'run' }, services: ['xvfb'], node: { image_or_setup: '16.20.2' } } };
    assert.deepEqual([...blockers(t)].sort(), ['deps:yarn', 'runner:jest', 'runtime:node<20', 'service:xvfb']);
  });
});
