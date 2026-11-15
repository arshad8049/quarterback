#!/usr/bin/env node
// Arm A, batch 1: the Claude-only exploratory research driver (owner plan 2026-11-14). CI only.
//   --mode=smoke             ONE harmless turn ("Reply with exactly OK.") through this exact driver path: served model and
//                            billing evidence must be acceptable, or the batch does not start (exit 7)
//   --mode=task --task=<k>   ONE task, ONE attempt, the frozen KAN-112 settings (1,800 s coding, 90-min total)
//   --mode=dry-run-timeout   NO model, NO token: the real runSandboxed path with a scripted agent stage that edits a file
//     --task=<k>             and outlives a short coding allowance (labelled dry run, never a result): proves the
//                            timeout keeps the patch and the grade job still runs
// Every mode refuses unless bench/opus-pilot/arm-a-freeze-v1.json matches the files on disk (frozen before results).
// Outputs: --restricted=<dir> (exact candidate.diff + records for the grade job) and --public=<dir> (sanitized summary).
// Every file is scanned HERE, where the token value is available (never printed); on any hit nothing is kept (exit 6).
// Exit: 0 record written (any trial outcome) · 5 stop the batch (usage limit / auth / policy) · 6 evidence refused ·
//       7 smoke not acceptable · 2/3 refused before anything ran.
import fs from 'node:fs';
import os from 'node:os';
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
const die = (code, m) => { console.error(m); process.exit(code); };
const mode = arg('mode');
if (!['smoke', 'task', 'dry-run-timeout'].includes(mode)) die(2, 'usage: arm-a.mjs --mode=smoke|task|dry-run-timeout ...');
if (process.env.GITHUB_ACTIONS !== 'true' || process.env.ARM_A_CI_RUN !== '1') die(2, 'refusing: CI only (GITHUB_ACTIONS=true, ARM_A_CI_RUN=1)');
const live = mode !== 'dry-run-timeout';
if (live && process.env.ARM_A_LIVE !== '1') die(2, 'refusing: live modes run only in the protected live job (ARM_A_LIVE=1)');
if (!live && (process.env.ARM_A_LIVE || process.env.CLAUDE_CODE_OAUTH_TOKEN)) die(2, 'refusing: the dry run never runs with the live flag or a token');
const restricted = arg('restricted'); const pub = arg('public');
if (!restricted || !pub) die(2, 'refusing: --restricted=<dir> and --public=<dir> are required');

const A = require(path.join(ROOT, 'lib/pilot/arm-a.js'));
const TP = require(path.join(ROOT, 'lib/pilot/trial-policy.js'));
const D = require(path.join(ROOT, 'lib/sandbox/docker.js'));
const { TOOLS_IMAGE } = require(path.join(ROOT, 'lib/sandbox/workspace.js'));
const { AGENT_IMAGE } = require(path.join(ROOT, 'lib/sandbox/agent.js'));
const { PROXY_IMAGE } = require(path.join(ROOT, 'lib/sandbox/egress.js'));

// ── the freeze (task list, reserve order, settings, versions) must match before anything runs ──
const freezeFile = path.join(HERE, 'arm-a-freeze-v1.json');
if (!fs.existsSync(freezeFile)) die(3, 'refusing: no freeze file (bench/opus-pilot/arm-a-freeze-v1.json)');
const freeze = JSON.parse(fs.readFileSync(freezeFile, 'utf8'));
for (const [rel, want] of Object.entries(freeze.files || {})) {
  const f = path.join(ROOT, rel);
  if (!fs.existsSync(f) || sha(fs.readFileSync(f)) !== want) die(3, `refusing: ${rel} differs from freeze ${freeze.version} (record a new freeze version; never edit silently)`);
}
const amendBytes = fs.readFileSync(path.join(HERE, 'amendments/amendment-1.json'));
const amendment = JSON.parse(amendBytes);
const ap = TP.checkAmendment(amendment, fs.readFileSync(path.join(HERE, 'pilot-config.json')));
if (ap.length) die(3, `refusing: amendment: ${ap.join('; ')}`);

// ── images: the loaded set, by the frozen ids ──
const ids = {};
for (const [name, ref] of Object.entries({ agent: AGENT_IMAGE, tools: TOOLS_IMAGE, proxy: PROXY_IMAGE })) {
  const r = await D.op(['image', 'inspect', '-f', '{{.Id}}', ref]);
  if (!r.ok || r.stdout.trim() !== freeze.images[name]) die(3, `refusing: ${name} image is not the frozen ${freeze.images[name]}`);
  ids[ref] = r.stdout.trim();
}

const tasksFile = JSON.parse(fs.readFileSync(path.join(HERE, 'arm-a-grader-tasks.json'), 'utf8'));
let taskKey = null; let t = null; let briefing; let repoPath; let names = []; let testPatch = '';
if (mode === 'smoke') {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'arm-a-smoke-'));
  fs.writeFileSync(path.join(repoPath, 'README.md'), 'Arm-A smoke repository (no task).\n');
  execFileSync('git', ['-C', repoPath, 'init', '-q']); execFileSync('git', ['-C', repoPath, 'add', '.']);
  execFileSync('git', ['-C', repoPath, '-c', 'user.name=qb', '-c', 'user.email=qb@invalid', 'commit', '-qm', 'smoke']);
  briefing = 'Reply with exactly OK. Do not create, edit or delete any files and do not run any commands.\n';
} else {
  taskKey = arg('task'); t = tasksFile.tasks[taskKey];
  if (!t) die(2, `refusing: unknown task ${taskKey}`);
  if (!(freeze.qualified_tasks || []).includes(taskKey)) die(3, `refusing: ${taskKey} is not a qualified task in freeze ${freeze.version}`);
  repoPath = arg('repo'); const store = arg('store');
  if (!repoPath || !store) die(2, 'refusing: --repo and --store are required for a task');
  const head = execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const commits = Number(execFileSync('git', ['-C', repoPath, 'rev-list', '--all', '--count'], { encoding: 'utf8' }).trim());
  if (head !== t.base || commits !== 1) die(3, `refusing: checkout ${head} (${commits} commits) is not the task base with one commit`);
  const row = (s) => fs.readFileSync(path.join(store, s, 'swe-bench-multilingual.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((r) => r.task_id === t.task_id);
  const v = row('vault'); const arr = (x) => (Array.isArray(x) ? x : JSON.parse(x));
  names = [...arr(v.FAIL_TO_PASS), ...arr(v.PASS_TO_PASS)]; testPatch = v.test_patch;
  const b = A.armABriefing(row('agent'), v);
  if (b.sha256 !== freeze.briefings[taskKey]) die(3, `refusing: the ${taskKey} briefing differs from the frozen one`);
  briefing = b.briefing;
}

// ── the seam: none for live; a scripted agent stage for the labelled dry run ──
let seam = null; let signInAdapter = A.signInAdapter();
if (!live) {
  const { runSandboxed } = require(path.join(ROOT, 'lib/sandbox/pipeline.js'));
  const { hardened } = require(path.join(ROOT, 'lib/sandbox/workspace.js'));
  const scripted = (ws, _e, { waitTimeoutMs }) => D.runStage(`${ws.runId}-agent`, [
    ...hardened(ws.runId, 'workload'), '--network', 'none', ...ws.mount('work'), '-w', '/work', '--entrypoint', 'sh', AGENT_IMAGE, '-c',
    "printf 'arm-A dry run: scripted edit before the coding allowance expires (not a model output)\\n' > ARM_A_DRY_RUN.md; sleep 600",
  ], { waitTimeoutMs });
  seam = (opts) => runSandboxed({ ...opts, agentStage: scripted });
  signInAdapter = async () => ({ status: 'ok', kind: 'dry run (no token, no sign-in)' });
}

const release = D.bindImages(ids);
const res = await A.runTrial({ briefing, repoPath, amendment, amendmentSha256: sha(amendBytes), seam, signInAdapter,
  codingMsOverride: live ? null : 20_000, label: mode === 'smoke' ? 'smoke' : `trial-${mode === 'task' ? 'live' : 'dry'}`,
  trialId: `${freeze.version}-${mode}-${taskKey || 'smoke'}`, taskId: t ? t.task_id : 'smoke', graderTask: taskKey, qbCommit: process.env.GITHUB_SHA || null });
const launches = release();

// ── records ──
const rep = res.agent_report || {};
const summary = {
  schema: 'qb-arm-a-trial/1', freeze: freeze.version, task_list_id: freeze.task_list_id, mode, dry_run: !live, task: taskKey, task_id: t ? t.task_id : null,
  qb_commit: process.env.GITHUB_SHA || null, run_id: process.env.GITHUB_RUN_ID || null,
  primary: res.pilot.primary, flags: res.pilot.flags, reasons: res.pilot.reasons, cause: res.pilot.cause, patch_use: res.pilot.patch_use,
  valid_completed_trial: res.pilot.valid_completed_trial, execution_evidence: res.pilot.execution_evidence,
  coding_ms: res.pilot.effort ? res.pilot.effort.coding_ms : null, total_elapsed_ms: res.pilot.effort ? res.pilot.effort.total_elapsed_ms : null,
  coding_allowance_ms: res.coding_ms, total_allowance_ms: res.total_ms, attempts: 1,
  model: rep.model || null, billing_route: rep.billing_route || null, usage: rep.usage || null, cli: res.profile.claude_code_version,
  profile: res.profile, credential_mode: res.sandbox ? res.sandbox.credential_mode : null,
  candidate: { sha256: res.candidate.sha256, bytes: res.candidate.bytes, gradable: res.candidate.gradable, not_gradable_reason: res.candidate.not_gradable_reason,
    files: res.candidate.files, base_tree: res.candidate.base_tree, candidate_tree: res.candidate.candidate_tree },
  grade_now: res.grade_now, stop_batch: res.stop_batch,
  images: Object.values(ids), launches: launches.length, distinct_launch_images: [...new Set(launches.map((l) => l.image))],
};
const secret = process.env.CLAUDE_CODE_OAUTH_TOKEN || null;
const files = {
  [path.join(restricted, 'candidate.diff')]: { data: res.patch, kind: 'secret_only' },
  [path.join(restricted, 'candidate.json')]: { data: Buffer.from(`${JSON.stringify(res.candidate, null, 2)}\n`), kind: 'public' },
  [path.join(restricted, 'trial.json')]: { data: Buffer.from(`${JSON.stringify({ ...summary, sandbox: res.sandbox, attempt_outcome: res.attempt_outcome, attempt_reasons: res.attempt_reasons }, null, 2)}\n`), kind: 'public' },
  [path.join(pub, `trial-${taskKey || 'smoke'}.json`)]: { data: Buffer.from(`${JSON.stringify(summary, null, 2)}\n`), kind: 'public' },
};
const problems = []; let overlap = 0;
for (const [f, x] of Object.entries(files)) {
  const s = A.scanText(x.data.toString('utf8'), { secret, names, testPatch, kind: x.kind });
  if (s.refused.length) problems.push(`${path.basename(f)}: ${s.refused.join(', ')}`);
  if (x.kind === 'secret_only') overlap = s.hidden_overlap_lines;
}
if (problems.length) {
  // nothing is kept: no partial upload, and the value is never printed
  for (const d of [restricted, pub]) fs.rmSync(d, { recursive: true, force: true });
  die(6, `evidence refused before upload: ${problems.join('; ')}`);
}
summary.candidate.hidden_test_patch_overlap_lines = overlap;   // counted, never refused: Claude may legitimately write similar tests
files[path.join(pub, `trial-${taskKey || 'smoke'}.json`)].data = Buffer.from(`${JSON.stringify(summary, null, 2)}\n`);
for (const d of [restricted, pub]) fs.mkdirSync(d, { recursive: true });
for (const [f, x] of Object.entries(files)) fs.writeFileSync(f, x.data);
console.log(JSON.stringify({ mode, task: taskKey, primary: summary.primary, flags: summary.flags, coding_ms: summary.coding_ms, model: summary.model,
  candidate: { bytes: summary.candidate.bytes, gradable: summary.candidate.gradable }, grade_now: summary.grade_now, stop_batch: summary.stop_batch }, null, 1));

if (mode === 'smoke') {
  const b = summary.billing_route || {};
  const served = summary.model && summary.model.served;
  const ok = summary.primary === 'execution_verified' && served === 'claude-opus-5-5' && res.candidate.capture_state === 'no_change';
  if (!ok) die(7, `smoke NOT acceptable (primary ${summary.primary}, served ${JSON.stringify(served)}, billing ${JSON.stringify(b)}): stop before the task batch`);
  process.exit(0);
}
process.exit(res.stop_batch ? 5 : 0);
