#!/usr/bin/env node
// KAN-117 review 10650: bounded NO-MODEL offline replay of axios-5892 through QB's REAL execute() + verify(), on the
// unchanged base (no agent) and the existing correct reference (controller-applied gold patch, applyPatch seam). The
// sandbox call is QB's real runSandboxed with exactly the frozen research options added (research Mocha env record,
// pinned root-scripts entry, read-only mounted research check runner). No model call: no agent runs, every criterion is
// behavioural (the judge receives none) and verify() runs with noLlm. The independent grader stays the final score
// (its calibration for this task is reused, unchanged inputs). Output: --out/replay-5892.json (statuses and hashes; no
// task text, no gold or hidden-test text).
//   node bench/opus-pilot/replay-5892.mjs --repo=<checkout at base> --store=bench/public/out --images=<dir> --out=<dir>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const arg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
if (process.env.GITHUB_ACTIONS !== 'true' || process.env.KAN117_CI_RUN !== '1') { console.error('refusing: CI only'); process.exit(2); }
for (const k of Object.keys(process.env)) if (/^(ANTHROPIC_|CLAUDE_CODE_OAUTH|CLAUDE_API)/.test(k)) { console.error(`refusing: credential-like variable ${k} is set`); process.exit(2); }
const repo = arg('repo'); const store = arg('store'); const imagesDir = arg('images'); const outDir = arg('out');
fs.mkdirSync(outDir, { recursive: true });

const FREEZE = JSON.parse(fs.readFileSync(path.join(HERE, 'mocha', 'replay-5892-v1.freeze.json'), 'utf8'));
// 1. the frozen configuration: every listed file must hash to its frozen value
const drift = Object.entries(FREEZE.files).filter(([f, h]) => sha(fs.readFileSync(path.join(ROOT, f))) !== h).map(([f]) => f);
if (drift.length) { console.error(`refusing: files differ from replay-5892-v1 freeze: ${drift.join(', ')}`); process.exit(3); }

const D = require(path.join(ROOT, 'lib/sandbox/docker.js'));
const { runSandboxed } = require(path.join(ROOT, 'lib/sandbox/pipeline.js'));
const { TOOLS_IMAGE } = require(path.join(ROOT, 'lib/sandbox/workspace.js'));
const { AGENT_IMAGE } = require(path.join(ROOT, 'lib/sandbox/agent.js'));
const { PROXY_IMAGE } = require(path.join(ROOT, 'lib/sandbox/egress.js'));
const { validateTaskEnv } = require(path.join(ROOT, 'lib/research/dataset-env.js'));
const { validateResearchChecks, researchCheckRunner } = require(path.join(ROOT, 'lib/research/reviewed-checks.js'));
const { rebuildContract } = require(path.join(ROOT, 'lib/research/contract-overlay.js'));
const { approve, contractState } = require(path.join(ROOT, 'intent/contract-state.js'));
const { execute } = require(path.join(ROOT, 'agent/runner.js'));
const { verify } = require(path.join(ROOT, 'verify/verifier.js'));

const ENV = validateTaskEnv(JSON.parse(fs.readFileSync(path.join(HERE, 'mocha', 'axios-5892.env.json'), 'utf8')));
const ROOT_SCRIPTS = JSON.parse(fs.readFileSync(path.join(HERE, 'mocha', 'root-scripts-allow.json'), 'utf8')).entries.filter((e) => e.key === ENV.root_scripts_key);
const runner = researchCheckRunner();
if (runner.sha256 !== FREEZE.research_check_runner.sha256) { console.error('refusing: research check runner differs from the freeze'); process.exit(3); }
const head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (head !== ENV.base_commit) { console.error(`checkout is ${head}, not the task base`); process.exit(3); }

// 2. the exact reviewed contract, rebuilt from the text-free overlay + the hash-verified dataset store
const row = (s) => fs.readFileSync(path.join(store, s, 'swe-bench-multilingual.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((r) => r.task_id === ENV.task_id);
const agentRow = row('agent'); const vaultRow = row('vault');
const overlay = JSON.parse(fs.readFileSync(path.join(HERE, 'mocha', 'contract-5892-v3.overlay.json'), 'utf8'));
const { contract: C0, sha256: contractSha } = rebuildContract(overlay, agentRow.problem_statement, FREEZE.contract_sha256);
const REVIEW = JSON.parse(fs.readFileSync(path.join(HERE, 'mocha', 'contract-5892-v3.review.json'), 'utf8'));
const V = validateResearchChecks(C0.checks, C0.acceptance_criteria, { reviewed: REVIEW.reviewed_scenarios });
if (V.accepted.length !== C0.checks.length) { console.error(`refusing: not every check accepted on the research reviewed path: ${JSON.stringify(V.rejected.map((r) => r.reason))}`); process.exit(3); }
// operations config attached by the controller (10635/10650): the waive policy only; no criterion/check/requirement changes
const contract = approve({ ...C0, checks: V.accepted, checks_registry: 'qb-checks/3', test_policy: REVIEW.operations_config_attached_by_controller.test_policy },
  { via: REVIEW.operations_config_attached_by_controller.approval_via, note: REVIEW.reviewer });
if (contractState(contract).state !== 'finalized') { console.error('refusing: contract not finalized'); process.exit(3); }

// 3. the loaded image set; every container must launch from these ids
const prov = JSON.parse(fs.readFileSync(path.join(imagesDir, 'image-provenance.json'), 'utf8'));
const ids = {};
for (const [name, ref] of Object.entries({ agent: AGENT_IMAGE, tools: TOOLS_IMAGE, proxy: PROXY_IMAGE })) {
  const r = await D.op(['image', 'inspect', '-f', '{{.Id}}', ref]);
  if (!r.ok || r.stdout.trim() !== prov.images[name].id || r.stdout.trim() !== FREEZE.images[name]) { console.error(`${name}: not the frozen loaded image`); process.exit(3); }
  ids[ref] = r.stdout.trim();
}
const nodeV = (await D.op(['run', '--rm', '--network', 'none', '--entrypoint', 'node', AGENT_IMAGE, '--version'])).stdout.trim();
if (nodeV !== FREEZE.node) { console.error(`refusing: agent image Node ${nodeV} != frozen ${FREEZE.node}`); process.exit(3); }
const release = D.bindImages(ids);

// 4. the two runs through execute() → (real runSandboxed + frozen research options) → verify()
const TRIAL_TOTAL_MS = FREEZE.deadlines.trial_total_ms;
async function one(label, extra) {
  const t0 = Date.now();
  const exec = await execute('task', contract, null, { agent: 'claude-code', repoPath: repo,
    runSandboxed: (args) => runSandboxed({ ...args, researchEnv: ENV, researchRootScripts: ROOT_SCRIPTS, researchCheckRunner: runner,
      requireMemoryCheck: true, researchDeadlineAtMs: t0 + TRIAL_TOTAL_MS, ...extra }) });
  const report = await verify(contract, null, exec, { repoPath: repo, noLlm: true });
  return { label, wall_ms: Date.now() - t0, exec, report };
}
const pick = (x) => {
  const s = x.exec.sandbox || {}; const v = s.verification || {}; const k = s.checks || {};
  let results = null; try { results = JSON.parse(k.results_text).results.map((r) => ({ id: r.id, ac_id: r.ac_id, status: r.status, detail: String(r.detail || '').slice(0, 300), duration_ms: r.duration_ms ?? null })); } catch { results = null; }
  return {
    exec_status: x.exec.status, wall_ms: x.wall_ms, candidate_tree: x.exec.candidate_tree, changed_files: (x.exec.changes || []).length,
    deps: s.deps && { status: s.deps.status, check_state: s.deps.check_state || null, root_scripts: s.deps.root_scripts ? { removed: s.deps.root_scripts.removed, install_manifest_sha256: s.deps.root_scripts.install_manifest_sha256 } : null },
    visible: { mode: v.mode, verdict: v.verdict, reasons: v.reasons, counts: v.validation && v.validation.counts, identity_set_sha256: v.validation && v.validation.identity_set_sha256,
      isolation_rechecks: (v.isolation_rechecks || []).map((r) => ({ id: r.id.slice(0, 16), verdict: r.verdict, reasons: r.reasons, duration_ms: r.duration_ms ?? null })),
      reporter_sha256: v.reporter && v.reporter.sha256, probe: v.probe || null, test_step_ms: ((v.steps || []).find((t) => t.name === 'test') || {}).duration_ms ?? null },
    checks: { state: k.state || null, error: k.error || null, runner: k.runner || null, tree: k.tree || null, tree_bound_to_candidate: Boolean(k.tree && k.tree === x.exec.candidate_tree), results },
    qb: { verdict: x.report.verdict, test_outcome: { outcome: x.report.test_outcome.outcome, reason: x.report.test_outcome.reason, trust: x.report.test_outcome.trust || null,
      regressions: (x.report.test_outcome.regressions || []).length, preexisting: (x.report.test_outcome.preexisting || []).length, isolation_qualified: (x.report.test_outcome.isolation_qualified || []).length },
      criteria: x.report.criteria_results.map((c) => ({ id: c.id, met: c.met, method: c.method || null, check_status: c.check_status || null, evidence: String(c.evidence || '').slice(0, 240) })),
      repair_hints: (x.report.repair_hints || []).length },
  };
};
const runs = {};
runs.base = await one('base', { noAgent: true });
runs.gold = await one('gold', { applyPatch: vaultRow.patch });

// 5. evidence controls on the gold result: valid (as recorded) and malformed (must never verify a criterion)
const controls = {};
const g = runs.gold.exec; const sb = g.sandbox && g.sandbox.checks;
if (sb && sb.results_text) {
  const doc = JSON.parse(sb.results_text);
  const variants = {
    valid_as_recorded: sb.results_text,
    dropped_result: JSON.stringify({ ...doc, results: doc.results.slice(0, -1) }),
    unknown_status: JSON.stringify({ ...doc, results: doc.results.map((r) => ({ ...r, status: 'skipped' })) }),
    hash_mismatch: JSON.stringify({ ...doc, check_set_hash: 'f'.repeat(64) }),
    incomplete: JSON.stringify({ ...doc, complete: false }),
    missing: null,
  };
  for (const [name, text] of Object.entries(variants)) {
    const e = { ...g, sandbox: { ...g.sandbox, checks: { ...sb, results_text: text } } };
    const r = await verify(contract, null, e, { repoPath: repo, noLlm: true });
    controls[name] = { verdict: r.verdict, met: Object.fromEntries(r.criteria_results.map((c) => [c.id, c.met])) };
  }
}
const launches = release();
const left = async (kind) => { const x = await D.op(kind === 'container' ? ['ps', '-aq', '--filter', 'label=qb.run'] : [kind, 'ls', '-q', '--filter', 'label=qb.run']); return x.ok ? x.stdout.split('\n').filter(Boolean).length : null; };
const behavioural = ['AC-1', 'AC-2', 'AC-3'];
const out = {
  schema: 'qb-kan117-replay-5892/1', approved_by: 'KAN-117 10650 (bounded no-model offline replay)', freeze: FREEZE.version, qb_commit: process.env.GITHUB_SHA || null,
  contract_sha256: contractSha, review_sha256: sha(fs.readFileSync(path.join(HERE, 'mocha', 'contract-5892-v3.review.json'))),
  environment: { images: ids, node_in_agent_image: nodeV, research_check_runner: { path: runner.path, sha256: runner.sha256 }, env_record_sha256: sha(fs.readFileSync(path.join(HERE, 'mocha', 'axios-5892.env.json'))),
    launches: launches.length, distinct_launch_images: [...new Set(launches.map((l) => l.image))], deadlines: FREEZE.deadlines },
  runs: { base: pick(runs.base), gold: pick(runs.gold) }, controls,
  separation: {
    base_behavioural_met: behavioural.map((id) => (runs.base.report.criteria_results.find((c) => c.id === id) || {}).met),
    gold_behavioural_met: behavioural.map((id) => (runs.gold.report.criteria_results.find((c) => c.id === id) || {}).met),
    malformed_never_meet_behavioural: Object.entries(controls).filter(([k]) => k !== 'valid_as_recorded').every(([, c]) => behavioural.every((id) => c.met[id] !== true)),
    no_pass_from_malformed: Object.entries(controls).filter(([k]) => k !== 'valid_as_recorded').every(([, c]) => c.verdict !== 'pass'),
  },
  independent_grader: 'authoritative; KAN-111 calibration for axios-5892 reused (run 43750792626: 3x empty RESOLVED_NO, 3x gold RESOLVED_FULL, isolation ok; inputs unchanged)',
  cleanup: { containers: await left('container'), networks: await left('network'), volumes: await left('volume') },
  no_model: { model_calls: 0, agent: 'none (base: noAgent; gold: applyPatch seam)', judge: 'not used (no non_behavioral criteria; noLlm)' },
};
fs.writeFileSync(path.join(outDir, 'replay-5892.json'), `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify({ base: out.runs.base.qb.verdict, gold: out.runs.gold.qb.verdict, separation: out.separation }, null, 1));
