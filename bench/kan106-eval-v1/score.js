#!/usr/bin/env node
/**
 * KAN-106 10758, eight-request evaluation v1: score ONE recorded run per item. No model call: it reads the
 * run record (manifest, events, artifacts) and runs the GENERATED checks, unchanged, with the real check
 * runner on the item's base and controls.
 *
 *   node bench/kan106-eval-v1/score.js --runs RUNS.json [--runs-root ~/.qb/runs] [--out FILE]
 *     RUNS.json: { "<item id>": "<run id>", ... }   (written by run-batch.sh)
 *
 * Per item it reports what rubric.md asks for: structural validity, check results on base / correct / every
 * wrong control, incorrect control acceptance, unresolved coverage, scope and protection, L1 time, model
 * identity, repairs. SEMANTIC review against the frozen requirements is left to a person (`semantic: null`):
 * this script never decides it. A refusal item is scored only on whether it refused safely.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const proc = require('../../lib/proc');
const { contractState } = require('../../intent/contract-state');
const { matchesAny } = require('../../verify/policy');

const ITEMS = path.join(__dirname, 'items');
const RUNNER = path.join(__dirname, '..', '..', 'sandbox', 'agent', 'qb-check-runner.mjs');
const LIMITS = { per_item_l1_ms: 180_000, median_l1_ms: 120_000, budget_l1_ms: 420_000 };

function copyTree(src, dst) {
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name); const d = path.join(dst, e.name);
    if (e.isDirectory()) { fs.mkdirSync(d, { recursive: true }); copyTree(s, d); } else fs.copyFileSync(s, d);
  }
}
function filesOf(dir, rel = '') {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesOf(path.join(dir, e.name), path.posix.join(rel, e.name)) : [path.posix.join(rel, e.name)]));
}
/** Run the checks unchanged on base (+ a control overlay). Returns { CHK-n: { status, detail } }. */
function runChecks(itemDir, control, checks) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kan106-score-'));
  try {
    copyTree(path.join(itemDir, 'base'), dir);
    if (control !== 'base') copyTree(path.join(itemDir, 'controls', control), dir);
    const out = path.join(os.tmpdir(), `kan106-score-${process.pid}-${Date.now()}.json`);
    const r = proc.run(process.execPath, [RUNNER], { input: JSON.stringify({ root: dir, checks }),
      env: { ...process.env, QB_CHECK_RESULTS: out, QB_CHECK_TIMEOUT_MS: '5000' }, timeout: 120_000 });
    if (r.status !== 0) throw new Error(`check runner failed: ${r.stderr}`);
    const res = JSON.parse(fs.readFileSync(out, 'utf8')).results; fs.rmSync(out, { force: true });
    return Object.fromEntries(res.map((x) => [x.id, { status: x.status, detail: x.detail }]));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
function loadRun(runDir) {
  const manifest = readJson(path.join(runDir, 'manifest.json'));
  const art = (name) => (manifest.artifacts && manifest.artifacts[name] ? readJson(path.join(runDir, manifest.artifacts[name].path)) : null);
  const events = fs.existsSync(path.join(runDir, 'events.jsonl'))
    ? fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const timings = (events.find((e) => e.type === 'l1.timings') || {}).data || null;
  return { manifest, staged: art('contract-staged'), contract: art('contract'), timings, events };
}

function scoreItem(id, run, { itemsRoot = ITEMS } = {}) {
  const itemDir = path.join(itemsRoot, id);
  const item = readJson(path.join(itemDir, 'item.json'));
  const { manifest, staged, contract, timings } = run;
  const facts = (staged && staged.facts) || [];
  const s = {
    id, category: item.category, expected: item.expected, run_id: manifest.run_id, qb_revision: manifest.qb_revision,
    outcome: manifest.outcome, outcome_reason: manifest.outcome_reason || null,
    model: { configured: manifest.models && manifest.models.intent, replies: [...new Set(facts.flatMap((f) => f.attempts.map((a) => a.model)))] },
    l1_ms: timings ? timings.l1_ms : null, calls: timings ? timings.calls.map((c) => ({ requirement_id: c.requirement_id, ms: c.ms, outcome: c.outcome })) : [],
    repairs: facts.reduce((n, f) => n + Math.max(0, f.attempts.length - 1), 0),
    latency: null,
  };
  if (s.l1_ms !== null) s.latency = { within_item_target: s.l1_ms <= LIMITS.per_item_l1_ms, within_budget: s.l1_ms <= LIMITS.budget_l1_ms };
  const finalized = Boolean(contract) && contractState(contract).state === 'finalized';
  s.structural = finalized ? 'finalized' : 'not_finalized';

  if (item.expected === 'refuse') {
    s.safe_refusal = !finalized;
    s.model_calls = facts.reduce((n, f) => n + f.attempts.length, 0);
    s.agent = manifest.agent ? manifest.agent.type : null;
    return s;
  }
  if (!finalized) { s.supported_result = 'no_checklist'; s.semantic = null; return s; }

  const checks = contract.checks || [];
  const controls = ['base', ...filesOf(path.join(itemDir, 'controls')).map((f) => f.split('/')[0]).filter((v, i, a) => a.indexOf(v) === i)];
  const scopeOnly = new Set(Object.keys(item.scope_controls || {}));
  s.checks = checks.map((k) => ({ id: k.id, ac_id: k.ac_id, adapter: k.adapter, step: k.params && k.params.steps ? k.params.steps[0] : k.params }));
  s.controls = {};
  for (const c of controls) {
    const r = runChecks(itemDir, c, checks);
    const all = checks.every((k) => r[k.id] && r[k.id].status === 'pass');
    s.controls[c] = { results: r, all_checks_pass: all };
  }
  s.correct_passes_all = s.controls.correct ? s.controls.correct.all_checks_pass : null;
  s.base_distinguished = !s.controls.base.all_checks_pass;
  s.incorrect_acceptance = controls.filter((c) => c.startsWith('wrong-') && !scopeOnly.has(c) && s.controls[c].all_checks_pass);

  const allowed = (contract.scope && contract.scope.allowed_changes) || [];
  const prot = (contract.scope && contract.scope.protected_paths) || [];
  s.scope = {
    allowed_changes: allowed, protected_paths: prot,
    missing_allow: item.scope.must_allow.filter((f) => !matchesAny(f, allowed)),
    missing_protect: item.scope.must_protect.filter((f) => !matchesAny(f, prot)),
    scope_controls: Object.fromEntries([...scopeOnly].map((c) => {
      const changed = filesOf(path.join(itemDir, 'controls', c));
      const blocked = changed.filter((f) => matchesAny(f, prot));
      return [c, { changed, refused_by_protected_paths: blocked.length > 0, blocked }];
    })),
  };
  const withCheck = new Set(checks.map((k) => k.ac_id));
  s.unresolved = (contract.acceptance_criteria || []).filter((a) => !withCheck.has(a.id)).map((a) => ({ id: a.id, criterion: a.criterion }));
  s.semantic = null;   // a person reviews each frozen requirement against the checklist (rubric.md)
  s.requirements = item.requirements.map((r) => ({ ...r, represented: null }));
  s.mechanical_pass = s.correct_passes_all && s.base_distinguished && s.incorrect_acceptance.length === 0
    && s.scope.missing_allow.length === 0 && s.scope.missing_protect.length === 0
    && Object.values(s.scope.scope_controls).every((x) => x.refused_by_protected_paths);
  return s;
}

function summarize(scores) {
  const sup = scores.filter((x) => x.expected === 'finalize');
  const ref = scores.filter((x) => x.expected === 'refuse');
  const times = sup.map((x) => x.l1_ms).filter((x) => x !== null).sort((a, b) => a - b);
  const median = times.length ? (times.length % 2 ? times[(times.length - 1) / 2] : (times[times.length / 2 - 1] + times[times.length / 2]) / 2) : null;
  return {
    supported: { total: sup.length, finalized: sup.filter((x) => x.structural === 'finalized').length,
      mechanical_pass: sup.filter((x) => x.mechanical_pass).length,
      semantic_correct: 'pending human review (rubric.md)',
      incorrect_control_acceptance: sup.flatMap((x) => (x.incorrect_acceptance || []).map((c) => `${x.id}:${c}`)),
      protected_scope_weakened: sup.filter((x) => x.scope && (x.scope.missing_protect.length || !Object.values(x.scope.scope_controls).every((y) => y.refused_by_protected_paths))).map((x) => x.id) },
    unsupported: { total: ref.length, safe_refusals: ref.filter((x) => x.safe_refusal).length },
    latency: { median_l1_ms: median, median_target_ms: LIMITS.median_l1_ms, over_item_target: sup.filter((x) => x.l1_ms !== null && x.l1_ms > LIMITS.per_item_l1_ms).map((x) => x.id) },
    note: 'Latency is reported separately from correctness. A safe refusal on a supported item is not semantic success; refusals of the unsupported items are counted separately, never in a combined percentage.',
  };
}

if (require.main === module) {
  const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
  const runs = readJson(arg('--runs'));
  const root = arg('--runs-root', path.join(os.homedir(), '.qb', 'runs'));
  const scores = Object.entries(runs).map(([id, runId]) => (runId ? scoreItem(id, loadRun(path.join(root, runId))) : { id, run_id: null, structural: 'no_run' }));
  const out = { _label: 'KAN-106 eight-request evaluation v1: mechanical scores (semantic review pending)', limits: LIMITS, summary: summarize(scores), items: scores };
  const text = JSON.stringify(out, null, 2) + '\n';
  const f = arg('--out'); if (f) fs.writeFileSync(f, text); else process.stdout.write(text);
}
module.exports = { scoreItem, summarize, loadRun, LIMITS, ITEMS };
