#!/usr/bin/env node
// KAN-112 (senior 10660): the PAIRED axios-5892 driver. CI only. One arm per invocation.
//   --arm=A   Claude only: lib/pilot/pair.js runArmA (the arm-A trial), ONE attempt
//   --arm=B   QB: lib/pilot/pair.js runArmB (QB's real repair loop), up to 3 attempts sharing the same coding allowance
//   --mode=dry-run   NO model, NO token: QB's real runSandboxed with a scripted agent stage that (1) probes, from inside
//                    the coding container, for answer/grader files, credential variables and network, (2) makes a
//                    harmless edit (different on every attempt). Labelled dry run, never a result.
//   --mode=task      the live trial: refused unless the paired route is confirmed (lib/pilot/pair.js routeProblems)
//   --mode=smoke     live, arm A path only: ONE harmless turn ("Reply with exactly OK.") on a throwaway repository through the
//                    paired route; acceptable only with complete served-model and subscription/billing evidence and no
//                    overage (lib/pilot/pair.js smokeProblems), else exit 7 and the pair does not start
//   --mode=smoke-dry NO model, NO token: the same smoke path with the scripted stage; it MUST be rejected (exit 7)
// Every mode refuses unless the frozen file set (FREEZE below) matches the files on disk (frozen before results).
// Outputs: --restricted=<dir> (exact candidate.diff + records for the grade job) and --public=<dir> (sanitized summary).
// Exit: 0 record written · 5 stop (usage limit / auth / policy) · 6 evidence refused · 7 smoke not acceptable · 2/3 refused before anything ran.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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
// an uncaught error is reported as a public annotation (message and first stack frames only; the dry run holds no secret)
const crash = (e) => { const m = String((e && e.stack) || e).split('\n').slice(0, 6).join(' | ').replace(/%/g, '%25').slice(0, 1500); console.log(`::error title=pair-crash::${m}`); process.exit(1); };
process.on('uncaughtException', crash); process.on('unhandledRejection', crash);
const arm = arg('arm'); const mode = arg('mode');
if (!['A', 'B'].includes(arm) || !['dry-run', 'task', 'smoke', 'smoke-dry'].includes(mode)) die(2, 'usage: pair.mjs --arm=A|B --mode=dry-run|task|smoke|smoke-dry ...');
const smoke = mode === 'smoke' || mode === 'smoke-dry';
if (smoke && arm !== 'A') die(2, 'refusing: the smoke runs on the arm-A path only');
if (process.env.GITHUB_ACTIONS !== 'true' || process.env.PAIR_CI_RUN !== '1') die(2, 'refusing: CI only (GITHUB_ACTIONS=true, PAIR_CI_RUN=1)');
const live = mode === 'task' || mode === 'smoke';
if (live && process.env.PAIR_LIVE !== '1') die(2, 'refusing: the live mode runs only in the protected paired live job (PAIR_LIVE=1)');
if (!live && (process.env.PAIR_LIVE || process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ARM_A_LIVE)) die(2, 'refusing: the dry run never runs with a live flag or a token');
for (const k of Object.keys(process.env)) if (!live && /^(ANTHROPIC_|CLAUDE_API)/.test(k)) die(2, `refusing: credential-like variable ${k} is set`);
const restricted = arg('restricted'); const pub = arg('public'); let repoPath = arg('repo'); const store = arg('store'); const imagesDir = arg('images');
if (!restricted || !pub || !store || !imagesDir || (!smoke && !repoPath)) die(2, 'refusing: --store, --images, --restricted, --public (and --repo for a task) are required');

// ── the freeze must match before anything runs ──
const FREEZE = JSON.parse(fs.readFileSync(path.join(HERE, 'mocha', 'pair-5892-freeze-v8.json'), 'utf8'));
const drift = Object.entries(FREEZE.files).filter(([f, h]) => !fs.existsSync(path.join(ROOT, f)) || sha(fs.readFileSync(path.join(ROOT, f))) !== h).map(([f]) => f);
if (drift.length) die(3, `refusing: files differ from ${FREEZE.version}: ${drift.join(', ')} (record a new freeze version; never edit silently)`);

const PAIR = require(path.join(ROOT, 'lib/pilot/pair.js'));
const A = require(path.join(ROOT, 'lib/pilot/arm-a.js'));
const TP = require(path.join(ROOT, 'lib/pilot/trial-policy.js'));
const D = require(path.join(ROOT, 'lib/sandbox/docker.js'));
const { TOOLS_IMAGE, hardened } = require(path.join(ROOT, 'lib/sandbox/workspace.js'));
const { AGENT_IMAGE } = require(path.join(ROOT, 'lib/sandbox/agent.js'));
const { PROXY_IMAGE } = require(path.join(ROOT, 'lib/sandbox/egress.js'));
const { validateTaskEnv } = require(path.join(ROOT, 'lib/research/dataset-env.js'));
const { validateResearchChecks, researchCheckRunner } = require(path.join(ROOT, 'lib/research/reviewed-checks.js'));
const { rebuildContract } = require(path.join(ROOT, 'lib/research/contract-overlay.js'));
const { approve, contractState } = require(path.join(ROOT, 'intent/contract-state.js'));

const amendBytes = fs.readFileSync(path.join(HERE, 'amendments/amendment-1.json'));
const amendment = JSON.parse(amendBytes);
const ap = TP.checkAmendment(amendment, fs.readFileSync(path.join(HERE, 'pilot-config.json')));
if (ap.length) die(3, `refusing: amendment: ${ap.join('; ')}`);

const ENV = validateTaskEnv(JSON.parse(fs.readFileSync(path.join(HERE, 'mocha', 'axios-5892.env.json'), 'utf8')));
// the pinned visible suite's identities (hashes only), for the briefing guard (10662): bound to the base and the freeze
const VISIBLE = JSON.parse(fs.readFileSync(path.join(HERE, 'mocha', 'visible-identities-5892.json'), 'utf8'));
if (VISIBLE.base_commit !== ENV.base_commit || sha(JSON.stringify(VISIBLE.identities)) !== FREEZE.shared.visible_identities_sha256) die(3, 'refusing: visible-suite identity record differs from the freeze');
if (smoke) {
  repoPath = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pair-smoke-'));
  fs.writeFileSync(path.join(repoPath, 'README.md'), 'Paired smoke repository (no task).\n');
  execFileSync('git', ['-C', repoPath, 'init', '-q']); execFileSync('git', ['-C', repoPath, 'add', '.']);
  execFileSync('git', ['-C', repoPath, '-c', 'user.name=qb', '-c', 'user.email=qb@invalid', 'commit', '-qm', 'smoke']);
}
const head = execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const commits = Number(execFileSync('git', ['-C', repoPath, 'rev-list', '--all', '--count'], { encoding: 'utf8' }).trim());
if (!smoke && (head !== FREEZE.shared.base_commit || head !== ENV.base_commit || commits !== 1)) die(3, `refusing: checkout ${head} (${commits} commits) is not the task base with one commit`);
const row = (s) => fs.readFileSync(path.join(store, s, 'swe-bench-multilingual.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((r) => r.task_id === ENV.task_id);
const agentRow = row('agent'); const vaultRow = row('vault');   // the vault is read HERE only (guard + scan); it never enters a sandbox
const arr = (x) => (Array.isArray(x) ? x : JSON.parse(x));
const names = [...arr(vaultRow.FAIL_TO_PASS), ...arr(vaultRow.PASS_TO_PASS)];   // scan only (never printed)

// ── images: the loaded set, by the frozen ids ──
const ids = {};
for (const [name, ref] of Object.entries({ agent: AGENT_IMAGE, tools: TOOLS_IMAGE, proxy: PROXY_IMAGE })) {
  const r = await D.op(['image', 'inspect', '-f', '{{.Id}}', ref]);
  if (!r.ok || r.stdout.trim() !== FREEZE.shared.images[name]) die(3, `refusing: ${name} image is not the frozen ${FREEZE.shared.images[name]}`);
  ids[ref] = r.stdout.trim();
}

// ── per-arm inputs (the reviewed root-scripts entry is SHARED: both arms install dependencies the same way) ──
const ROOT_SCRIPTS = JSON.parse(fs.readFileSync(path.join(HERE, 'mocha', 'root-scripts-allow.json'), 'utf8')).entries.filter((e) => e.key === ENV.root_scripts_key);
let armInput = {};
if (smoke) {
  armInput = { briefing: 'Reply with exactly OK. Do not create, edit or delete any files and do not run any commands.\n' };
} else if (arm === 'A') {
  const b = A.armABriefing(agentRow, vaultRow);
  if (b.sha256 !== FREEZE.arm_a.briefing_sha256) die(3, 'refusing: the arm-A briefing differs from the frozen one');
  armInput = { briefing: b.briefing, research: { rootScripts: ROOT_SCRIPTS } };   // shared dependency handling; no QB verification
} else {
  const overlay = JSON.parse(fs.readFileSync(path.join(HERE, 'mocha', 'contract-5892-v4.overlay.json'), 'utf8'));
  const { contract: C0 } = rebuildContract(overlay, agentRow.problem_statement, FREEZE.arm_b.contract_sha256);
  const REVIEW = JSON.parse(fs.readFileSync(path.join(HERE, 'mocha', 'contract-5892-v4.review-10657.json'), 'utf8'));
  const V = validateResearchChecks(C0.checks, C0.acceptance_criteria, { reviewed: REVIEW.reviewed_scenarios });
  if (V.accepted.length !== C0.checks.length) die(3, 'refusing: not every check accepted on the research reviewed path');
  const MAPS = REVIEW.preservation_maps;
  if (!Array.isArray(MAPS) || MAPS.length !== 1 || MAPS[0].sha256 !== FREEZE.arm_b.ac4_map_sha256 || sha(JSON.stringify(MAPS[0].map)) !== FREEZE.arm_b.ac4_map_sha256) die(3, 'refusing: AC-4 map differs from the freeze');
  const contract = approve({ ...C0, checks: V.accepted, checks_registry: 'qb-checks/3', test_policy: REVIEW.operations_config_attached_by_controller.test_policy },
    { via: REVIEW.operations_config_attached_by_controller.approval_via, note: REVIEW.reviewer });
  if (contractState(contract).state !== 'finalized') die(3, 'refusing: contract not finalized');
  const runner = researchCheckRunner();
  if (runner.sha256 !== FREEZE.arm_b.research_check_runner_sha256) die(3, 'refusing: research check runner differs from the freeze');
  armInput = { contract, research: { env: ENV, rootScripts: ROOT_SCRIPTS, checkRunner: runner }, preservationMaps: MAPS };
}

// ── the seam: none for live; a scripted, probing agent stage for the labelled dry run ──
let seam = null; let signInAdapter = PAIR.signInAdapter();
if (!live) {
  const { runSandboxed } = require(path.join(ROOT, 'lib/sandbox/pipeline.js'));
  const PROBE = [
    "n=$(find / -xdev \\( -name 'swe-bench-multilingual.jsonl' -o -name 'candidate.diff' -o -name 'grade.mjs' -o -name 'test_patch*' -o -name '.credentials.json' \\) 2>/dev/null | wc -l)",
    "t=$(env | grep -cE '^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|GITHUB_TOKEN|ACTIONS_RUNTIME_TOKEN)=' || true)",
    "d=$(node -e \"require('dns').lookup('github.com',(e)=>{process.stdout.write(e?'none':'reachable')})\" 2>/dev/null || echo none)",
    "k=$(ls -A /work/.git 2>/dev/null | wc -l)",
    // an IN-SCOPE edit (lib/utils.js, allowed by contract v4), different on every attempt (no QB no-progress stop)
    "printf '\\n// pair dry run (scripted, not a model output) attempt-at %s: probe answer_files=%s credential_vars=%s dns=%s\\n' \"$(date +%s%N)\" \"$n\" \"$t\" \"$d\" >> lib/utils.js",
  ].join('; ');
  // smoke-dry: change nothing and print nothing a model would (so it must be rejected for missing model/billing evidence only)
  const SCRIPT = smoke ? "printf 'pair smoke dry run (scripted, not a model output)\\n' >&2" : PROBE;
  const scripted = (ws, _e, { waitTimeoutMs }) => D.runStage(`${ws.runId}-agent`, [
    ...hardened(ws.runId, 'workload'), '--network', 'none', ...ws.mount('work'), '-w', '/work', '--entrypoint', 'sh', AGENT_IMAGE, '-c', SCRIPT,
  ], { waitTimeoutMs });
  seam = (opts) => runSandboxed({ ...opts, agentStage: scripted });
  signInAdapter = async () => ({ status: 'ok', kind: 'dry run (no token, no sign-in)' });
}

const release = D.bindImages(ids);
const common = { repoPath, amendment, amendmentSha256: sha(amendBytes), seam, signInAdapter, ...(smoke ? {} : { vaultRow, visible: VISIBLE }), trialId: `${FREEZE.version}-${arm}-${mode}`,
  taskId: ENV.task_id, graderTask: FREEZE.shared.grader_task, qbCommit: process.env.GITHUB_SHA || null, label: `pair-${smoke ? 'smoke' : arm.toLowerCase()}-${live ? 'live' : 'dry'}`,
  ...(seam ? { approvedAuthRoutes: [PAIR.ROUTE] } : {}) };
const res = arm === 'A' ? await PAIR.runArmA({ ...common, ...armInput }) : await PAIR.runArmB({ ...common, ...armInput, runsDir: path.join(restricted, '..', 'pair-runs') });
const launches = release();

// ── records ──
const patchText = res.patch.toString('utf8');
const probes = [...patchText.matchAll(/probe answer_files=(\d+) credential_vars=(\d+) dns=(\w+)/g)].map((m) => ({ answer_files: Number(m[1]), credential_vars: Number(m[2]), dns: m[3] }));
// KAN-114 10689 (v7): the record is assembled by lib/pilot/pair.js pairSummary (tested), with per-attempt evidence
const summary = PAIR.pairSummary(res, { arm, mode, live, freeze: FREEZE.version, task: FREEZE.shared.grader_task, taskId: ENV.task_id,
  qbCommit: process.env.GITHUB_SHA || null, runId: process.env.GITHUB_RUN_ID || null, probes, images: Object.values(ids), launches: launches.length,
  distinctImages: [...new Set(launches.map((l) => l.image))] });
const secret = process.env.CLAUDE_CODE_OAUTH_TOKEN || null;
const files = {
  [path.join(restricted, 'candidate.diff')]: { data: res.patch, kind: 'secret_only' },
  [path.join(restricted, 'candidate.json')]: { data: Buffer.from(`${JSON.stringify(res.candidate, null, 2)}\n`), kind: 'public' },
  [path.join(restricted, 'trial.json')]: { data: Buffer.from(`${JSON.stringify(summary, null, 2)}\n`), kind: 'public' },
  [path.join(pub, `pair-${arm}.json`)]: { data: Buffer.from(`${JSON.stringify(summary, null, 2)}\n`), kind: 'public' },
};
const problems = [];
for (const [f, x] of Object.entries(files)) {
  const s = A.scanText(x.data.toString('utf8'), { secret, names, testPatch: vaultRow.test_patch, kind: x.kind });
  if (s.refused.length) problems.push(`${path.basename(f)}: ${s.refused.join(', ')}`);
}
if (problems.length) { for (const d of [restricted, pub]) fs.rmSync(d, { recursive: true, force: true }); die(6, `evidence refused before upload: ${problems.join('; ')}`); }
for (const d of [restricted, pub]) fs.mkdirSync(d, { recursive: true });
for (const [f, x] of Object.entries(files)) fs.writeFileSync(f, x.data);
// KAN-114 10689/10693 (v7, v8): read the PUBLISHED record back; the exit decision is made on IT and on the actual
// captured bytes (lib/pilot/pair.js readbackGate), never on the earlier in-memory summary
const back = JSON.parse(fs.readFileSync(path.join(pub, `pair-${arm}.json`), 'utf8'));
const gate = PAIR.readbackGate({ mode, record: back, patchBytes: res.patch, stopBatch: res.stop_batch });
fs.writeFileSync(path.join(pub, `readback-${arm}.json`), `${JSON.stringify(gate.sidecar, null, 2)}\n`);   // diagnostic; never a verified artifact when refused
const evLine = (back.attempt_evidence || []).map((e) => `a${e.attempt}:${e.outcome}/${e.served_model}/${e.cli}/${e.provider}/${e.api_key_source}/overage=${e.is_using_overage}/${e.agent_stage_ms}ms/${String(e.patch_sha256).slice(0, 12)}`).join(' ');
console.log(`::notice title=pair-evidence-${arm}::verified=${gate.verified} expectation=${gate.expectation} label=${back.evidence_label} attempts=${back.attempts} ${evLine} problems=${JSON.stringify(gate.problems.slice(0, 6)).replace(/%/g, '%25')}`);
console.log(JSON.stringify({ arm, mode, primary: back.primary, attempts: back.attempts, attempt_verdicts: back.attempt_verdicts, coding_ms: back.coding_ms,
  candidate: { bytes: back.candidate.bytes, gradable: back.candidate.gradable }, probe: probes, grade_now: back.grade_now }, null, 1));
if (gate.code === 8) die(8, `readback refused: ${gate.problems.slice(0, 6).join('; ')} (not grade-eligible; the pair stops)`);
if (gate.code === 9) die(9, `dry-run expectation violated: ${gate.problems.slice(0, 6).join('; ')}`);
if (smoke) {
  const probs = PAIR.smokeProblems({ primary: back.primary, capture_state: res.candidate.capture_state, model: back.model, billing_route: back.billing_route });
  console.log(`::notice title=pair-smoke::acceptable=${probs.length === 0} mode=${mode} problems=${JSON.stringify(probs).replace(/%/g, '%25')}`);
  if (probs.length) die(7, `smoke NOT acceptable: ${probs.join('; ')} (the pair does not start)`);
  process.exit(0);
}
process.exit(gate.code);
