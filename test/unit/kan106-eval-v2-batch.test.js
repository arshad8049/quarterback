/**
 * KAN-106 10838: launch refusals (doc/JSON disagreement, not frozen, no host approval, packet/harness changes),
 * resource_blocked items, the built child environment, the POSIX launcher and the freezes. Fakes only: every
 * model-server fetch, snapshot and child launch is injected, and the tests assert the model server is never
 * contacted when the batch refuses. No model call.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { runBatch } = require('../../bench/kan106-eval-v2/batch');
const { checkPlan, checkFiles } = require('../../bench/kan106-eval-v2/plan-check');
const freeze = require('../../bench/kan106-eval-v2/freeze');
const items = require('../../bench/kan106-eval-v2/items');

const ROOT = path.join(__dirname, '..', '..');
const V2 = path.join(ROOT, 'bench', 'kan106-eval-v2');
const PLAN_BUF = fs.readFileSync(path.join(V2, 'plan.json'));
const PLAN = JSON.parse(PLAN_BUF.toString('utf8'));
const DOC = fs.readFileSync(path.join(ROOT, PLAN.doc), 'utf8');
const GiB = 1024 ** 3;
const SHA = 'a'.repeat(40);
const NOW = Date.parse('2026-12-01T10:00:00Z');
const IDS = Array.from({ length: 12 }, (_, i) => `H${String(i + 1).padStart(2, '0')}`);

function frozenPlan(mut = (n) => n) {
  const p = JSON.parse(PLAN_BUF.toString('utf8'));
  const n = p.normative;
  n.status.frozen = true;
  n.qb_under_test.sha = SHA;
  Object.assign(n.held_out, { order: IDS, spec_manifest_sha256: 's'.repeat(64), packet_manifest_sha256: 'p'.repeat(64), base_shas: Object.fromEntries(IDS.map((id) => [id, 'b'.repeat(40)])) });
  Object.assign(n.profiles['P-Mac'], { host_label: 'TEST-HOST-LABEL', owner_approval: 'TEST-APPROVAL-NOT-REAL', window_start_utc: '2026-12-01T09:00:00Z', window_end_utc: '2026-12-01T12:00:00Z' });
  mut(n);
  return p;
}
const packetInfo = () => ({ manifest_sha256: 'p'.repeat(64), spec_manifest_sha256: 's'.repeat(64), base_shas: Object.fromEntries(IDS.map((id) => [id, 'b'.repeat(40)])) });
const macSnap = (avail, loaded = []) => ({ taken_utc: new Date(NOW).toISOString(), os: { platform: 'darwin', arch: 'arm64' },
  memory: { total_bytes: 18 * GiB, available_bytes: avail, swap_used_bytes: 0, pressure: { kind: 'darwin_level', level: 1 } }, ollama: { loaded } });

function fakes({ snaps } = {}) {
  const f = { fetched: [], spawned: [], released: 0, snapsTaken: 0 };
  f.fetchJson = async (u) => { f.fetched.push(u); return { models: [{ name: PLAN.normative.model.name, digest: PLAN.normative.model.digest }] }; };
  f.takeSnapshot = async () => { const s = snaps ? snaps(f.snapsTaken) : macSnap(14 * GiB); f.snapsTaken++; return s; };
  f.releaseModel = async () => { f.released++; return { status: 'released' }; };
  f.spawnChild = async (cmd, args, opts) => { f.spawned.push({ args, env: opts.env }); return { status: 1, signal: null, stdout: `[RUN] ${'0'.repeat(8)}-0000-0000-0000-${String(f.spawned.length).padStart(12, '0')}\n`, stderr: '', timedOut: false, duration_ms: 5 }; };
  return f;
}
function tmpItems() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kan106-v2-items-'));
  for (const id of IDS) { fs.mkdirSync(path.join(d, id)); fs.writeFileSync(path.join(d, id, 'request.txt'), `TEST REQUEST ${id}\n`); }
  return d;
}
async function batch(o = {}) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'kan106-v2-out-'));
  const f = o.fakes || fakes();
  const itemsRoot = tmpItems();
  try {
    const r = await runBatch({ out, expectedSha: SHA, profile: 'P-Mac', plan: o.plan || frozenPlan(), planProblems: o.planProblems || [], harnessProblems: o.harnessProblems || [],
      packetInfo: o.packetInfo === undefined ? packetInfo() : o.packetInfo, itemsRoot, inherited: o.inherited || { PATH: '/usr/bin', HOME: '/tmp/h', SECRET_TOKEN: 'x', QB_MODEL_CONCURRENCY: '9' },
      fetchJson: f.fetchJson, takeSnapshot: f.takeSnapshot, releaseModel: f.releaseModel, spawnChild: f.spawnChild, dotenvPath: path.join(out, 'no.env'),
      now: () => NOW, log: () => {} });
    return { r, f, out, batchJson: JSON.parse(fs.readFileSync(path.join(out, 'batch.json'), 'utf8')) };
  } finally { fs.rmSync(itemsRoot, { recursive: true, force: true }); }
}

// ── plan document vs plan.json ──
test('the committed plan document and plan.json agree', () => {
  const r = checkFiles();
  assert.deepEqual(r.problems, []);
});
test('any document/JSON disagreement is reported: a changed value, a missing or extra key, a stale hash, the withdrawn rule', () => {
  const changedJson = Buffer.from(PLAN_BUF.toString('utf8').replace('"q1_min_supported": 7', '"q1_min_supported": 6'));
  assert.match(checkPlan({ docText: DOC, planBuf: changedJson }).join('\n'), /names plan\.json sha256 .* but plan\.json is/);
  const docValue = DOC.replace('| `gates.q1_min_supported` | `7` |', '| `gates.q1_min_supported` | `6` |');
  assert.match(checkPlan({ docText: docValue, planBuf: PLAN_BUF }).join('\n'), /gates\.q1_min_supported: document 6 != plan\.json 7/);
  const docMissing = DOC.replace(/^\| `gates\.q4_max_ms` \|.*\n/m, '');
  assert.match(checkPlan({ docText: docMissing, planBuf: PLAN_BUF }).join('\n'), /gates\.q4_max_ms: in plan\.json normative, missing from the document/);
  const docExtra = DOC.replace('| `gates.q4_max_ms` |', '| `gates.q4_secret` | `1` |\n| `gates.q4_max_ms` |');
  assert.match(checkPlan({ docText: docExtra, planBuf: PLAN_BUF }).join('\n'), /gates\.q4_secret: in the document, not in plan\.json/);
  assert.match(checkPlan({ docText: `${DOC}\nIf they disagree, the JSON wins.\n`, planBuf: PLAN_BUF }).join('\n'), /withdrawn "JSON wins"/);
  assert.match(checkPlan({ docText: DOC.replace(/^## Normative values.*$/m, '## Other'), planBuf: PLAN_BUF }).join('\n'), /no "Normative values" section/);
});
test('a disagreement REFUSES launch, before any model-server contact and before any child', async () => {
  const { r, f, batchJson } = await batch({ planProblems: ['gates.q1_min_supported: document 6 != plan.json 7'] });
  assert.equal(r.refused, true);
  assert.match(batchJson.reasons.join('\n'), /^plan: gates\.q1_min_supported/m);
  assert.deepEqual([f.fetched.length, f.spawned.length, f.released], [0, 0, 0]);
});

// ── the committed plan refuses as it stands ──
test('the committed freeze candidate refuses: not frozen, no SHA, no packet, no host approval, no window', async () => {
  const { r, f, batchJson } = await batch({ plan: JSON.parse(PLAN_BUF.toString('utf8')), packetInfo: null });
  assert.equal(r.refused, true);
  const why = batchJson.reasons.join('\n');
  for (const re of [/not frozen/, /is not the frozen qb_under_test\.sha null/, /held-out packet: not computed/, /held-out order has 0 items/, /no owner-named host label/, /no owner approval reference/, /no approved time window/]) assert.match(why, re);
  assert.deepEqual([f.fetched.length, f.spawned.length], [0, 0]);
});
test('each launch precondition refuses on its own', async () => {
  const cases = [
    [{ harnessProblems: ['compiler intent/staged.js: changed'] }, /harness freeze: compiler intent\/staged\.js: changed/],
    [{ packetInfo: { ...packetInfo(), manifest_sha256: 'q'.repeat(64) } }, /held-out packet q+ != frozen p+/],
    [{ packetInfo: { ...packetInfo(), spec_manifest_sha256: 'q'.repeat(64) } }, /held-out specs q+ != frozen s+/],
    [{ packetInfo: { ...packetInfo(), base_shas: { ...packetInfo().base_shas, H03: 'c'.repeat(40) } } }, /base H03: c+ != frozen b+/],
    [{ plan: frozenPlan((n) => { n.profiles['P-Mac'].window_end_utc = '2026-12-01T09:30:00Z'; }) }, /outside the approved window/],
    [{ plan: frozenPlan((n) => { n.profiles['P-Mac'].arch = 'x64'; }) }, /arch arm64, frozen x64/],
    [{ plan: frozenPlan((n) => { n.profiles['P-Mac'].min_total_memory_bytes = 32 * GiB; }) }, /physical memory .* < frozen minimum/],
    [{ plan: frozenPlan((n) => { n.qb_under_test.sha = 'b'.repeat(40); }) }, /is not the frozen qb_under_test\.sha b+/],
  ];
  for (const [o, re] of cases) {
    const { r, f, batchJson } = await batch(o);
    assert.equal(r.refused, true, String(re)); assert.match(batchJson.reasons.join('\n'), re);
    assert.equal(f.spawned.length, 0);
  }
  const f = fakes(); f.fetchJson = async () => ({ models: [{ name: PLAN.normative.model.name, digest: 'd'.repeat(64) }] });
  const { r, batchJson } = await batch({ fakes: f });
  assert.equal(r.refused, true); assert.match(batchJson.reasons.join(), /is not the frozen 9ec8897f/);
  assert.equal(f.spawned.length, 0);
});

// ── a frozen, approved run with fakes ──
test('with everything frozen and approved: 12 items in order, one child each, built env with QB_MODEL_CONCURRENCY=1, nothing inherited', async () => {
  const { r, f, batchJson } = await batch();
  assert.equal(r.refused, false);
  assert.equal(f.released, 1, 'item 1 is cold by design');
  assert.equal(f.spawned.length, 12);
  assert.deepEqual(batchJson.items.map((x) => x.id), IDS);
  assert.deepEqual(f.spawned[0].args.slice(1, 2), ['TEST REQUEST H01']);
  assert.deepEqual(f.spawned[0].args.slice(-PLAN.normative.launch.flags.length), PLAN.normative.launch.flags);
  assert.ok(!f.spawned[0].args.includes('--l1-warmup'));
  const env = f.spawned[0].env;
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'PATH', 'QB_MODEL', 'QB_MODEL_CONCURRENCY', 'QB_OLLAMA_URL', 'QB_RUNS_DIR']);
  assert.equal(env.QB_MODEL_CONCURRENCY, '1');
  assert.equal(env.QB_MODEL, 'qwen2.5-coder:14b');
  assert.equal(batchJson.settings.retries, 0);
  assert.equal(batchJson.model_after.digest_matches, true);
});
test('a gate failure records resource_blocked: not launched, not retried, not replaced; later items still get their own gate', async () => {
  // snapshot 0 = preflight; 1 = item H01 before (cold, enough); 2 = H01 after; 3 = H02 before: unknown capacity
  const f = fakes({ snaps: (i) => (i === 3 ? macSnap(null) : macSnap(14 * GiB)) });
  const { batchJson, out } = await batch({ fakes: f });
  const h2 = batchJson.items.find((x) => x.id === 'H02');
  assert.equal(h2.status, 'resource_blocked'); assert.equal(h2.launched, false);
  assert.match(h2.gate.reasons.join(), /capacity_unknown/);
  assert.equal(f.spawned.length, 11);
  assert.ok(!f.spawned.some((s) => s.args[1] === 'TEST REQUEST H02'));
  assert.equal(batchJson.items.length, 12);
  const runs = JSON.parse(fs.readFileSync(path.join(out, 'runs.json'), 'utf8'));
  assert.deepEqual(runs.H02, { status: 'resource_blocked', run_id: null });
  assert.ok(fs.existsSync(path.join(out, h2.snapshot_before)));
});

// ── POSIX launcher ──
test('run-batch.sh is POSIX sh (no zsh, no bash-only syntax) and refuses on a wrong SHA before anything runs', () => {
  const f = path.join(V2, 'run-batch.sh');
  const text = fs.readFileSync(f, 'utf8');
  assert.match(text.split('\n')[0], /^#!\/bin\/sh$/);
  const code = text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.doesNotMatch(code, /\[\[|\bprint\b|\bzsh\b|\$\{0:A|function |<<<|\bsource\b|^\s*local /m);
  assert.equal(spawnSync('sh', ['-n', f]).status, 0);
  const r = spawnSync('sh', [f, 'P-Mac', '0'.repeat(40)], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: os.tmpdir() } });
  assert.equal(r.status, 2); assert.match(r.stdout, /not 0{40}\. Nothing was run\./);
  assert.equal(spawnSync('sh', [f], { encoding: 'utf8' }).status, 2);
  if (fs.existsSync('/bin/dash')) {   // a strict POSIX shell (Ubuntu's /bin/sh)
    assert.equal(spawnSync('/bin/dash', ['-n', f]).status, 0);
    const d = spawnSync('/bin/dash', [f, 'P-Linux', '0'.repeat(40)], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: os.tmpdir() } });
    assert.equal(d.status, 2); assert.match(d.stdout, /Nothing was run\./);
  }
});

// ── freezes ──
test('the committed harness freeze matches this checkout', () => {
  assert.deepEqual(freeze.checkHarness(), []);
});
test('the harness freeze detects a changed, missing or added compiler/harness file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kan106-v2-freeze-'));
  try {
    fs.mkdirSync(path.join(root, 'intent')); fs.writeFileSync(path.join(root, 'intent', 'staged.js'), 'a');
    fs.mkdirSync(path.join(root, 'bench', 'kan106-eval-v2'), { recursive: true }); fs.writeFileSync(path.join(root, 'bench', 'kan106-eval-v2', 'batch.js'), 'b');
    const ff = path.join(root, 'F.json');
    freeze.writeHarness({ root, freezeFile: ff, compilerSourceRev: 'x' });
    assert.deepEqual(freeze.checkHarness({ root, freezeFile: ff }), []);
    fs.writeFileSync(path.join(root, 'intent', 'staged.js'), 'tuned');
    fs.writeFileSync(path.join(root, 'intent', 'new.js'), 'n');
    fs.rmSync(path.join(root, 'bench', 'kan106-eval-v2', 'batch.js'));
    const p = freeze.checkHarness({ root, freezeFile: ff }).join('\n');
    assert.match(p, /compiler intent\/staged\.js: changed/); assert.match(p, /compiler intent\/new\.js: not in the harness freeze/); assert.match(p, /harness bench\/kan106-eval-v2\/batch\.js: missing/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('packet manifest: the full packet and the owner spec-only manifest; any byte change moves the hash', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kan106-v2-packet-'));
  try {
    fs.mkdirSync(path.join(d, 'H01', 'base'), { recursive: true });
    fs.writeFileSync(path.join(d, 'H01', 'request.txt'), 'r'); fs.writeFileSync(path.join(d, 'H01', 'spec.json'), '{}'); fs.writeFileSync(path.join(d, 'H01', 'base', 'x.js'), 'x');
    const full = freeze.packet(d); const specs = freeze.packet(d, { specsOnly: true });
    assert.deepEqual(Object.keys(full.files).sort(), ['H01/base/x.js', 'H01/request.txt', 'H01/spec.json']);
    assert.deepEqual(Object.keys(specs.files).sort(), ['H01/request.txt', 'H01/spec.json']);
    fs.writeFileSync(path.join(d, 'H01', 'base', 'x.js'), 'y');
    assert.notEqual(freeze.packet(d).manifest_sha256, full.manifest_sha256);
    assert.equal(freeze.packet(d, { specsOnly: true }).manifest_sha256, specs.manifest_sha256);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
test('items.js (control validation, materialize) is independent of QB: Node built-ins only', () => {
  const src = fs.readFileSync(path.join(V2, 'items.js'), 'utf8');
  const reqs = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
  assert.deepEqual(reqs.sort(), ['child_process', 'fs', 'os', 'path']);
});
test('items.js validate: controls are checked against a hand-written reference test (fixture item, no QB)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kan106-v2-val-'));
  try {
    const it = path.join(d, 'H01');
    fs.mkdirSync(path.join(it, 'base', 'lib'), { recursive: true }); fs.mkdirSync(path.join(it, 'base', 'test'));
    fs.writeFileSync(path.join(it, 'base', 'package.json'), '{"name":"x","private":true}');
    fs.writeFileSync(path.join(it, 'base', 'lib', 'm.js'), 'exports.f = () => 1;\n');
    fs.writeFileSync(path.join(it, 'base', 'test', 'own.test.js'), "require('node:test')('own', () => {});\n");
    fs.mkdirSync(path.join(it, 'controls', 'correct', 'lib'), { recursive: true }); fs.writeFileSync(path.join(it, 'controls', 'correct', 'lib', 'm.js'), 'exports.f = () => 2;\n');
    fs.writeFileSync(path.join(it, 'reference.test.js'), "const t=require('node:test');const a=require('node:assert');t('change', () => a.equal(require('../lib/m').f(), 2));\n");
    fs.writeFileSync(path.join(it, 'item.json'), JSON.stringify({ expected: 'finalize', control_expect: { base: { change: 'fail' }, correct: { change: 'pass' } } }));
    const r = items.validate(d);
    assert.equal(r.all_match, true, JSON.stringify(r, null, 1));
    fs.writeFileSync(path.join(it, 'item.json'), JSON.stringify({ expected: 'finalize', control_expect: { base: { change: 'pass' } } }));
    assert.equal(items.validate(d).all_match, false);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
