#!/usr/bin/env node
// KAN-117 stage B (review 10607): ONE no-model vertical slice for immutable-js 2005 through QB's REAL
// runSandboxed path, research Jest channel. CI only (GITHUB_ACTIONS=true, KAN117_CI_RUN=1).
//   1. baseline      no agent (base tree): probe (runtime identity, CI unset → src/), discovery, identity baseline
//   2. empty         no agent: the scripted-empty candidate, compared with the baseline
//   3. gold          controller-applied gold patch (QB-27 applyPatch seam: network none, no credentials,
//                    never a prompt or repair hint), compared with the baseline
//   4. workspace     agent-workspace probe: Jest runs in /work with read-only node_modules (network none,
//                    no credentials, proxy socket NOT mounted); capture must stay no_change
// Then writes candidate-<label>.diff + sha256 for the independent grader (a separate workflow step).
// No model call, no credential, no sign-in. Output: --out/stage-b-qb.json (raw; sanitized later).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const arg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

if (process.env.GITHUB_ACTIONS !== 'true' || process.env.KAN117_CI_RUN !== '1') {
  console.error('refusing: stage B runs only in the approved KAN-117 CI workflow'); process.exit(2);
}
for (const k of Object.keys(process.env)) {
  if (/^(ANTHROPIC_|CLAUDE_CODE_OAUTH|CLAUDE_API)/.test(k)) { console.error(`refusing: credential-like variable ${k} is set`); process.exit(2); }
}
const repo = arg('repo'); const store = arg('store'); const outDir = arg('out');
if (!repo || !store || !outDir) { console.error('usage: stage-b.mjs --repo=<checkout at base> --store=<bench/public/out> --out=<dir>'); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });

const D = require(path.join(ROOT, 'lib/sandbox/docker.js'));
const { runSandboxed } = require(path.join(ROOT, 'lib/sandbox/pipeline.js'));
const { hardened, TOOLS_IMAGE, ensureToolsImage } = require(path.join(ROOT, 'lib/sandbox/workspace.js'));
const { AGENT_IMAGE, ensureAgentImage } = require(path.join(ROOT, 'lib/sandbox/agent.js'));
const { PROXY_IMAGE, ensureProxyImage } = require(path.join(ROOT, 'lib/sandbox/egress.js'));
const { baselineFrom } = require(path.join(ROOT, 'verify/jest-report.js'));
const ENV = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench/public/kan117/task-2005.env.json'), 'utf8'));

const vaultRow = fs.readFileSync(path.join(store, 'vault', 'swe-bench-multilingual.jsonl'), 'utf8').trim().split('\n')
  .map((l) => JSON.parse(l)).find((r) => r.task_id === ENV.task_id);
if (!vaultRow || typeof vaultRow.patch !== 'string' || !vaultRow.patch) { console.error('vault row or gold patch missing'); process.exit(3); }

const head = (await import('node:child_process')).execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (head !== '77434b3cbbc8ee21206f4cc6965e1c9b09cc92b6') { console.error(`checkout is ${head}, not the task base`); process.exit(3); }

await ensureToolsImage(); await ensureProxyImage(); await ensureAgentImage();
const inspect = async (ref) => {
  const r = await D.op(['image', 'inspect', '--format', '{{json .}}', ref]);
  if (!r.ok) throw new Error(`image inspect ${ref}: ${r.stderr.trim()}`);
  const i = JSON.parse(r.stdout);
  if (!/^sha256:[0-9a-f]{64}$/.test(i.Id || '')) throw new Error(`image ${ref} has no immutable id`);
  return { ref, id: i.Id, architecture: i.Architecture, repo_digests: i.RepoDigests || [] };
};
const images = { agent: await inspect(AGENT_IMAGE), tools: await inspect(TOOLS_IMAGE), proxy: await inspect(PROXY_IMAGE) };
try { images.agent_base = await inspect('node:24-bookworm-slim'); } catch (e) { images.agent_base = { error: e.message }; }
// Every container any run creates must launch from these exact image ids (same bound id for every run).
const release = D.bindImages({ [AGENT_IMAGE]: images.agent.id, [TOOLS_IMAGE]: images.tools.id, [PROXY_IMAGE]: images.proxy.id });

const TRIAL_TOTAL_MS = 90 * 60_000;   // KAN-112 amendment 1 trial_total_s, bounding the internal stage
async function one(label, extra) {
  const t0 = Date.now();
  const r = await runSandboxed({ repoPath: repo, briefing: `KAN-117 stage B ${label} (no model)`, researchEnv: ENV,
    requireMemoryCheck: true, researchDeadlineAtMs: t0 + TRIAL_TOTAL_MS, ...extra });
  const wall_ms = Date.now() - t0;
  return { label, wall_ms, r };
}

// G8: the agent workspace can run the visible tests (no credentials; the proxy socket is not mounted)
const workspaceProbe = async (ws, _egress, { waitTimeoutMs }) => D.runStage(`${ws.runId}-agent`, [
  ...hardened(ws.runId, 'workload'), '--network', 'none', ...ws.mount('work'), '-v', `${ws.runId}-deps:/work/node_modules:ro`,
  '-e', 'HOME=/tmp/home', '--tmpfs', '/tmp/home:rw,size=256m,uid=10001,gid=10001,mode=0700',
  '-w', '/work', '--entrypoint', 'sh', AGENT_IMAGE, '-c',
  // only counts and an exit code reach the evidence (stderr tail); never test names
  '{ node node_modules/jest/bin/jest.js --ci --listTests --json > /tmp/list.json; echo "listed=$(node -e "process.stdout.write(String(JSON.parse(require(\'fs\').readFileSync(\'/tmp/list.json\',\'utf8\')).length))")"; node node_modules/jest/bin/jest.js --ci __tests__/Map.ts > /tmp/run.txt 2>&1; echo "map_suite_exit=$?"; echo "ci=${CI:-unset}"; } 1>&2',
], { waitTimeoutMs });

const runs = {};
runs.baseline = await one('baseline', { noAgent: true });
const bv = runs.baseline.r.sandbox && runs.baseline.r.sandbox.verification;
let baseline = null;
try { baseline = baselineFrom(bv && bv.validation); } catch (e) { baseline = null; }
fs.writeFileSync(path.join(outDir, 'baseline.json'), JSON.stringify(baseline, null, 2));
if (baseline) {
  runs.empty = await one('empty', { noAgent: true, researchBaseline: baseline });
  runs.gold = await one('gold', { applyPatch: vaultRow.patch, researchBaseline: baseline });
  runs.workspace = await one('workspace', { agentStage: workspaceProbe, researchBaseline: baseline });
}
const launches = release();

// Candidates for the independent grader: QB's captured bytes, exactly
const candidates = {};
for (const label of ['empty', 'gold']) {
  if (!runs[label]) continue;
  const raw = runs[label].r.patch_raw ? Buffer.from(runs[label].r.patch_raw) : Buffer.alloc(0);
  fs.writeFileSync(path.join(outDir, `candidate-${label}.diff`), raw);
  candidates[label] = { sha256: sha(raw), bytes: raw.length, candidate_tree: runs[label].r.candidate_tree, base_tree: runs[label].r.base_tree };
}

// Cleanup: nothing labelled for these runs may remain
const left = async (kind) => { const x = await D.op(kind === 'container' ? ['ps', '-aq', '--filter', 'label=qb.run'] : [kind, 'ls', '-q', '--filter', 'label=qb.run']); return x.ok ? x.stdout.split('\n').filter(Boolean).length : null; };
const cleanup = { containers: await left('container'), networks: await left('network'), volumes: await left('volume') };
const vols = await D.op(['volume', 'ls', '--format', '{{.Name}}']);

const pick = (x) => x && {
  status: x.r.status, reason: x.r.reason, wall_ms: x.wall_ms, credential_mode: x.r.sandbox.credential_mode ?? null,
  admission: x.r.sandbox.admission, deps: x.r.sandbox.deps, stages: x.r.sandbox.stages, capture: x.r.sandbox.capture,
  verification: x.r.sandbox.verification, agent_stdout_tail: x.label === 'workspace' ? String(x.r.stderr_tail || '') : undefined,
  changes: (x.r.changes || []).map((c) => ({ file: c.file, status: c.status, additions: c.additions, deletions: c.deletions })),
};
const out = {
  schema: 'qb-kan117-stage-b/1', approved_by: 'KAN-117 10607', task_id: ENV.task_id, exposure: ENV.exposure,
  qb_commit: process.env.GITHUB_SHA || null, task_env_sha256: sha(fs.readFileSync(path.join(ROOT, 'bench/public/kan117/task-2005.env.json'))),
  repo_head: head, host: { runner: process.env.RUNNER_NAME || null, image: process.env.ImageOS || null, image_version: process.env.ImageVersion || null, node: process.version },
  images, image_launches: launches.map((l) => ({ container: l.container, image: l.image })),
  baseline: baseline && { identity_set_sha256: baseline.identity_set_sha256, counts: baseline.counts },
  runs: Object.fromEntries(Object.entries(runs).map(([k, v]) => [k, pick(v)])),
  candidates, cleanup, qb_claude_auth_volume_present: vols.ok ? vols.stdout.split('\n').includes('qb-claude-auth') : null,
  no_model: { agent_stage: 'none (baseline, empty), applyPatch (gold), workspace jest probe (workspace)', model_calls: 0, credentials: 'none' },
};
fs.writeFileSync(path.join(outDir, 'stage-b-qb.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify({ baseline: !!baseline, runs: Object.fromEntries(Object.entries(out.runs).map(([k, v]) => [k, v && `${v.status}/${v.verification && (v.verification.verdict || v.verification.reason)}`])), candidates, cleanup }, null, 1));
process.exit(baseline ? 0 : 1);
