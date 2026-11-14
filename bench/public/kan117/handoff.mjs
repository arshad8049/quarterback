#!/usr/bin/env node
// KAN-117 (review 10609): the narrow handoff run for task 2005, on the LOADED image set (a fresh job,
// not a rebuild). CI only (GITHUB_ACTIONS=true, KAN117_CI_RUN=1). No model, no credential, no sign-in.
//   1. clean agent bundle from the agent store (leak-checked)            → agent-bundle.json (never published)
//   2. baseline (noAgent) on the bound, loaded image ids                  → baseline.json
//   3. agent-input probe: the agent-stage seam receives the EFFECTIVE briefing on stdin inside the agent
//      container; it reports only the stdin sha256 and the /work git shape (commits, refs, remotes)
//   4. arbitrary captured candidates through the real runSandboxed path (scripted via applyPatch):
//        notes      a new NOTES.md (not a fix)                → gradable
//        generated  a new dist/ file                          → real capture-policy refusal, NOT gradable
//        gold       the controller-applied gold patch         → gradable (exposed calibration only)
//      each → candidate-<label>.diff (exact bytes) + candidate-<label>.json (lib/research/candidate.js)
//   5. launch-spec.json (lib/research/launch-spec.js) and handoff-qb.json (raw; sanitized later)
//   node bench/public/kan117/handoff.mjs --repo=<checkout at base> --store=bench/public/out --images=<dir> --out=<dir>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const arg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

if (process.env.GITHUB_ACTIONS !== 'true' || process.env.KAN117_CI_RUN !== '1') { console.error('refusing: CI only'); process.exit(2); }
for (const k of Object.keys(process.env)) if (/^(ANTHROPIC_|CLAUDE_CODE_OAUTH|CLAUDE_API)/.test(k)) { console.error(`refusing: credential-like variable ${k} is set`); process.exit(2); }
const repo = arg('repo'); const store = arg('store'); const imagesDir = arg('images'); const outDir = arg('out');
if (!repo || !store || !imagesDir || !outDir) { console.error('usage: handoff.mjs --repo= --store= --images= --out='); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });

const D = require(path.join(ROOT, 'lib/sandbox/docker.js'));
const { runSandboxed } = require(path.join(ROOT, 'lib/sandbox/pipeline.js'));
const { hardened, TOOLS_IMAGE } = require(path.join(ROOT, 'lib/sandbox/workspace.js'));
const { AGENT_IMAGE } = require(path.join(ROOT, 'lib/sandbox/agent.js'));
const { PROXY_IMAGE } = require(path.join(ROOT, 'lib/sandbox/egress.js'));
const { baselineFrom } = require(path.join(ROOT, 'verify/jest-report.js'));
const { buildAgentBundle, bundleSummary } = require(path.join(ROOT, 'lib/research/agent-bundle.js'));
const { candidateRecord } = require(path.join(ROOT, 'lib/research/candidate.js'));
const { launchSpec } = require(path.join(ROOT, 'lib/research/launch-spec.js'));

const ENV_PATH = path.join(ROOT, 'bench/public/kan117/task-2005.env.json');
const ENV = JSON.parse(fs.readFileSync(ENV_PATH, 'utf8'));
const row = (s) => fs.readFileSync(path.join(store, s, 'swe-bench-multilingual.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((r) => r.task_id === ENV.task_id);
const agentRow = row('agent'); const controllerRow = row('controller'); const vaultRow = row('vault');

// 1. bundle
const { bundle } = buildAgentBundle({ agentRow, controllerRow, vaultRow, env: ENV });
fs.writeFileSync(path.join(outDir, 'agent-bundle.json'), JSON.stringify(bundle, null, 2));

const head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (head !== bundle.repo.base_commit) { console.error(`checkout is ${head}, not the bundle base`); process.exit(3); }

// images: the LOADED set, by id; nothing is built here
const prov = JSON.parse(fs.readFileSync(path.join(imagesDir, 'image-provenance.json'), 'utf8'));
const ids = {};
for (const [name, ref] of Object.entries({ agent: AGENT_IMAGE, tools: TOOLS_IMAGE, proxy: PROXY_IMAGE })) {
  const r = await D.op(['image', 'inspect', '-f', '{{.Id}}', ref]);
  if (!r.ok || r.stdout.trim() !== prov.images[name].id) { console.error(`${name}: ${ref} is not the loaded image ${prov.images[name].id}`); process.exit(3); }
  ids[ref] = r.stdout.trim();
}
const release = D.bindImages(ids);

const TRIAL_TOTAL_MS = 90 * 60_000;
async function one(label, extra) {
  const t0 = Date.now();
  const r = await runSandboxed({ repoPath: repo, briefing: bundle.briefing, researchEnv: ENV, requireMemoryCheck: true, researchDeadlineAtMs: t0 + TRIAL_TOTAL_MS, ...extra });
  return { label, wall_ms: Date.now() - t0, r };
}

// 3. the agent-input probe: only hashes and counts leave the container
let probe = null;
const inputProbe = async (ws, _egress, { waitTimeoutMs, briefing }) => {
  const r = await D.runStage(`${ws.runId}-agent`, [
    ...hardened(ws.runId, 'workload'), '--network', 'none', ...ws.mount('work'),
    '-e', 'HOME=/tmp/home', '--tmpfs', '/tmp/home:rw,size=16m,uid=10001,gid=10001,mode=0700', '-w', '/work', '--entrypoint', 'sh', AGENT_IMAGE, '-c',
    'g() { git -c safe.directory="*" "$@"; }; { echo "stdin_sha256=$(sha256sum | cut -d" " -f1)"; echo "commits=$(g rev-list --all --count)"; echo "refs=$(g for-each-ref | wc -l)"; echo "remotes=$(g remote | wc -l)"; echo "head_tree=$(g rev-parse "HEAD^{tree}")"; echo "status_lines=$(g status --porcelain | wc -l)"; } 1>&2',
  ], { input: Buffer.from(briefing), waitTimeoutMs });
  probe = Object.fromEntries(String(r.stderr || '').split('\n').map((l) => l.trim().match(/^([a-z_0-9]+)=(\S*)$/)).filter(Boolean).map((m) => [m[1], m[2]]));
  probe.briefing_matches_bundle = probe.stdin_sha256 === bundle.effective_briefing_sha256;
  return r;
};

const NOTES = 'diff --git a/NOTES.md b/NOTES.md\nnew file mode 100644\n--- /dev/null\n+++ b/NOTES.md\n@@ -0,0 +1 @@\n+Scripted arbitrary candidate for the KAN-117 handoff (not a fix).\n';
const GENERATED = 'diff --git a/dist/handoff-probe.js b/dist/handoff-probe.js\nnew file mode 100644\n--- /dev/null\n+++ b/dist/handoff-probe.js\n@@ -0,0 +1 @@\n+module.exports = "generated output (must be refused)";\n';

const runs = {};
runs.baseline = await one('baseline', { noAgent: true });
let baseline = null;
try { baseline = baselineFrom(runs.baseline.r.sandbox.verification.validation); } catch { baseline = null; }
fs.writeFileSync(path.join(outDir, 'baseline.json'), JSON.stringify(baseline, null, 2));
if (baseline) {
  runs.input = await one('input', { agentStage: inputProbe, researchBaseline: baseline });
  runs.notes = await one('notes', { applyPatch: NOTES, researchBaseline: baseline });
  runs.generated = await one('generated', { applyPatch: GENERATED, researchBaseline: baseline });
  runs.gold = await one('gold', { applyPatch: vaultRow.patch, researchBaseline: baseline });
}
const launches = release();

// 4. candidate records + exact bytes for the entrypoint
const candidates = {};
for (const label of ['notes', 'generated', 'gold']) {
  if (!runs[label]) continue;
  const raw = runs[label].r.patch_raw ? Buffer.from(runs[label].r.patch_raw) : Buffer.alloc(0);
  fs.writeFileSync(path.join(outDir, `candidate-${label}.diff`), raw);
  candidates[label] = candidateRecord(runs[label].r, { label, env: ENV, qbCommit: process.env.GITHUB_SHA || null });
  fs.writeFileSync(path.join(outDir, `candidate-${label}.json`), JSON.stringify(candidates[label], null, 2));
}

// 5. launch spec
const amendment = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench/opus-pilot/amendments/amendment-1.json'), 'utf8'));
const pilot = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench/opus-pilot/pilot-config.json'), 'utf8'));
const spec = launchSpec({ provenance: prov, env: ENV, envSha256: sha(fs.readFileSync(ENV_PATH)), bundle, amendment, pilot, qbCommit: process.env.GITHUB_SHA || null });
fs.writeFileSync(path.join(outDir, 'launch-spec.json'), JSON.stringify(spec, null, 2));

const left = async (kind) => { const x = await D.op(kind === 'container' ? ['ps', '-aq', '--filter', 'label=qb.run'] : [kind, 'ls', '-q', '--filter', 'label=qb.run']); return x.ok ? x.stdout.split('\n').filter(Boolean).length : null; };
const cleanup = { containers: await left('container'), networks: await left('network'), volumes: await left('volume') };
const pick = (x) => x && { status: x.r.status, reason: x.r.reason, wall_ms: x.wall_ms, credential_mode: x.r.sandbox.credential_mode ?? null,
  stages: x.r.sandbox.stages, capture: x.r.sandbox.capture, verification: x.r.sandbox.verification,
  changes: (x.r.changes || []).map((c) => ({ file: c.file, status: c.status, additions: c.additions, deletions: c.deletions })) };
const out = {
  schema: 'qb-kan117-handoff/1', approved_by: 'KAN-117 10609 (narrow handoff)', task_id: ENV.task_id, exposure: ENV.exposure,
  qb_commit: process.env.GITHUB_SHA || null, repo_head: head, host: { runner: process.env.RUNNER_NAME || null, image_version: process.env.ImageVersion || null, node: process.version },
  bundle: bundleSummary(bundle), agent_input_probe: probe,
  baseline: baseline && { identity_set_sha256: baseline.identity_set_sha256, counts: baseline.counts },
  image_ids: ids, image_launches: launches.map((l) => ({ container: l.container, image: l.image })),
  runs: Object.fromEntries(Object.entries(runs).map(([k, v]) => [k, pick(v)])), candidates, cleanup,
  no_model: { model_calls: 0, credentials: 'none', agent_stage: 'none (baseline), input probe (input), applyPatch (notes, generated, gold)' },
};
fs.writeFileSync(path.join(outDir, 'handoff-qb.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify({ baseline: !!baseline, probe, runs: Object.fromEntries(Object.entries(out.runs).map(([k, v]) => [k, v && `${v.status}/${v.verification && (v.verification.verdict || v.verification.reason)}`])),
  candidates: Object.fromEntries(Object.entries(candidates).map(([k, c]) => [k, `${c.gradable ? 'gradable' : c.not_gradable_reason} ${c.bytes}B`])), cleanup }, null, 1));
const ok = baseline && probe && probe.briefing_matches_bundle && candidates.notes && candidates.notes.gradable && candidates.gold && candidates.gold.gradable
  && candidates.generated && candidates.generated.not_gradable_reason === 'capture_policy_refused';
process.exit(ok ? 0 : 1);
