#!/usr/bin/env node
// KAN-111 exact offline grader, adaptation `immutable-offline-v1`, for immutable-js tasks 2005 and 2006.
// Usage (from bench/, after `node public/import.mjs --download`):
//   node public/grader/immutable-offline-v1/grade.mjs                      # PLAN ONLY: prints every command, runs nothing
//   node public/grader/immutable-offline-v1/grade.mjs --execute --approved-by=<KAN-111 review comment id> [--variant=A0|A1] [--reps=3]
// Replicates the pinned SWE-bench harness (SWE-bench @ 02e7a74ffd0b707aab73d203fe87bdc7c76afc8e,
// swebench/harness/run_evaluation.py) step by step, with ONE disclosed difference: the container has
// --network none (and, pending review, no added SYS_ADMIN capability). Grading uses the harness's own
// parser and report functions (grade_report.py). Inputs come only from the grader vault/controller stores.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(HERE, '..', '..');
const arg = (k, d = null) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : (process.argv.includes(`--${k}`) ? true : d); };
const EXECUTE = arg('execute') === true; const APPROVAL = arg('approved-by'); const VARIANT = arg('variant', 'A0'); const REPS = Number(arg('reps', 3));
const KEEP_SYS_ADMIN = arg('keep-sys-admin') === true; const TIMEOUT_S = Number(arg('timeout', 1800));
if (EXECUTE && !APPROVAL) { console.error('refusing to execute: --approved-by=<KAN-111 review comment id> is required (no grader run before review)'); process.exit(2); }

// Pinned task inputs (KAN-110 handoff 6de3039; image digests from the Docker Hub registry, 2026-11-10)
export const TASKS = {
  2006: { task_id: 'qbt_00b20b1b0285', instance_id: 'immutable-js__immutable-js-2006', base: '493afba6ec17d9c999dc5a15ac80c71c6bdba1c3',
    image: 'swebench/sweb.eval.x86_64.immutable-js_1776_immutable-js-2006@sha256:ecf16bc4835839696fac8f3eed1ec36473306d5277a641f2e05254f9a552608d',
    eval_sha256: '5ce0993702c9cb23375cd0bf35aced243bb51a2074ac637eb9ebc4972ff9f647', test_files: ['__tests__/Range.ts'],
    a1_build: 'npm run build:clean && npm run build:dist && npm run build:esm && npm run build:copy && npm run build:prepare' },
  2005: { task_id: 'qbt_9b9a5da937c9', instance_id: 'immutable-js__immutable-js-2005', base: '77434b3cbbc8ee21206f4cc6965e1c9b09cc92b6',
    image: 'swebench/sweb.eval.x86_64.immutable-js_1776_immutable-js-2005@sha256:d038a276cb975ddfbb1a6b13fe9c8260fb22a0145c8605bb2a477a4d75ee5549',
    eval_sha256: '70da858d49b4dc2bb8f8223f44d409c4e52296d001a24396353cdaa021f66caa', test_files: ['__tests__/OrderedMap.ts', '__tests__/OrderedSet.ts'],
    a1_build: 'npm run build:clean && npm run build:dist && npm run build:types && npm run build:prepare' },
};
// Harness constants @ 02e7a74 (swebench/harness/constants, swebench/image_builder/constants)
export const H = { user: 'root', workdir: '/testbed', patchFile: '/tmp/patch.diff',
  applyCmds: ['git apply --verbose', 'git apply --verbose --3way', 'git apply --verbose --reject', 'patch --batch --forward --fuzz=5 -p1 -i'],
  reset: 'git checkout -- . ; git clean -fd', APPLY_PATCH_FAIL: '>>>>> Patch Apply Failed', APPLY_PATCH_PASS: '>>>>> Applied Patch' };

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const jl = (f) => new Map(fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => { const x = JSON.parse(l); return [x.task_id, x]; }));
const plan = [];
const run = (argv, opts = {}) => {
  const sym = (a) => String(a).split(HERE).join('<grader>').split(PUB).join('<bench/public>').split(os.tmpdir()).join('<run-dir>');
  plan.push(argv.map((a) => sym(/\s/.test(a) ? JSON.stringify(a) : a)).join(' '));
  if (!EXECUTE) return { status: 0, stdout: '', stderr: '' };
  const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  return { status: r.status, signal: r.signal, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error && r.error.message };
};

/** The eval script for the chosen variant. A0 = official verbatim; A1 = only the `npm run build` line replaced. */
export function evalScript(official, t, variant) {
  if (variant === 'A0') return official;
  if (variant !== 'A1') throw new Error(`unknown variant ${variant}`);
  const lines = official.split('\n'); const idx = lines.map((l, i) => (l.trim() === 'npm run build' ? i : -1)).filter((i) => i >= 0);
  if (idx.length !== 1) throw new Error(`A1 expects exactly one 'npm run build' line, found ${idx.length}`);
  lines[idx[0]] = t.a1_build; return lines.join('\n');
}

function gradeOne({ key, t, official, required, mode, rep, outDir, patchText = null, label = mode, timeoutS = TIMEOUT_S }) {
  const name = `kan111-${key}-${label}-${rep}-${EXECUTE ? crypto.randomBytes(3).toString('hex') : 'plan'}`;
  const dir = path.join(outDir, `${key}-${label}-${rep}`); if (EXECUTE) fs.mkdirSync(dir, { recursive: true });
  const rec = { task: key, instance_id: t.instance_id, mode, label, rep, variant: VARIANT, container: name, image: t.image, network: 'none', sys_admin: KEEP_SYS_ADMIN, timeout_s: timeoutS };
  const evalText = evalScript(official, t, VARIANT); rec.eval_sha256 = sha(evalText); rec.official_eval_sha256 = sha(official);
  run(['docker', 'create', '--name', name, '--network', 'none', '--user', H.user, '--workdir', H.workdir, ...(KEEP_SYS_ADMIN ? ['--cap-add', 'SYS_ADMIN'] : []), t.image, 'tail', '-f', '/dev/null']);
  run(['docker', 'start', name]);
  const ex = (cmd, o) => run(['docker', 'exec', '-w', H.workdir, '-u', H.user, name, '/bin/bash', '-c', cmd], o);
  rec.base_head = ex('git rev-parse HEAD').stdout.trim() || null;
  try {
    if (patchText !== null) {
      const pf = path.join(EXECUTE ? dir : os.tmpdir(), 'patch.diff'); if (EXECUTE) fs.writeFileSync(pf, patchText);
      rec.patch_sha256 = sha(patchText); rec.patch_bytes = Buffer.byteLength(patchText);
      run(['docker', 'cp', pf, `${name}:${H.patchFile}`]);
      let applied = false, used = null;
      for (let i = 0; i < H.applyCmds.length && !applied; i++) {
        if (i) ex(H.reset);
        const r = ex(`${H.applyCmds[i]} ${H.patchFile}`); if (r.status === 0) { applied = true; used = H.applyCmds[i]; }
      }
      if (!applied && ex(`git apply --check --reverse ${H.patchFile}`).status === 0) { applied = true; used = 'verified already applied'; }
      rec.patch_apply = applied ? { ok: true, via: used } : { ok: false, marker: H.APPLY_PATCH_FAIL };
      if (!applied) { rec.outcome = 'patch_apply_failed'; return rec; }   // the harness raises here; nothing is graded
    } else rec.patch_apply = { skipped: 'empty candidate: base + official test patch only (harness --no-patch path)' };
    rec.diff_before_sha256 = sha(ex('git -c core.fileMode=false diff').stdout);
    const ef = path.join(EXECUTE ? dir : os.tmpdir(), 'eval.sh'); if (EXECUTE) fs.writeFileSync(ef, evalText);
    run(['docker', 'cp', ef, `${name}:/eval.sh`]);
    run(['docker', 'cp', path.join(HERE, 'grade-wrapper.sh'), `${name}:/grade-wrapper.sh`]);
    const t0 = Date.now();
    const r = run(['docker', 'exec', '-w', H.workdir, '-u', H.user, name, '/bin/bash', '/grade-wrapper.sh', '/eval.sh'], { timeout: timeoutS * 1000, killSignal: 'SIGKILL' });
    rec.wall_s = (Date.now() - t0) / 1000; rec.exec_exit = r.status; rec.timed_out = r.signal === 'SIGKILL' || /ETIMEDOUT/.test(r.error || '');
    if (EXECUTE) fs.writeFileSync(path.join(dir, 'test_output.txt'), r.stdout + (r.stderr ? `\n${r.stderr}` : '') + (rec.timed_out ? `\n\nTimeout error: ${timeoutS} seconds exceeded.` : ''));
    rec.diff_after_sha256 = sha(ex('git -c core.fileMode=false diff').stdout);
    const env = /QBX_ENV_BEGIN([\s\S]*?)QBX_ENV_END/.exec(r.stdout || ''); rec.wrapper_env = env ? env[1].trim().split('\n') : null;
    if (rec.timed_out) { rec.outcome = 'timeout'; return rec; }
    if (EXECUTE) fs.writeFileSync(path.join(dir, 'required.json'), JSON.stringify(required));
    const g = run([process.env.SWEBENCH_PYTHON || 'python3', path.join(HERE, 'grade_report.py'), t.instance_id, path.join(dir, 'test_output.txt'), path.join(dir, 'required.json'), path.join(dir, 'grade.json')]);
    rec.grade_summary = g.stdout.trim() || null; rec.grade_exit = g.status;
    rec.outcome = 'graded';
    return rec;
  } finally {
    run(['docker', 'rm', '-f', name]);
    if (EXECUTE) { fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(rec, null, 2)); fs.rmSync(path.join(dir, 'required.json'), { force: true }); }
  }
}

function main() {
  const ctl = jl(path.join(PUB, 'out', 'controller', 'swe-bench-multilingual.jsonl'));
  const vault = jl(path.join(PUB, 'out', 'vault', 'swe-bench-multilingual.jsonl'));
  const arr = (x) => (Array.isArray(x) ? x : JSON.parse(x));
  const outDir = path.join(HERE, 'results', `${os.platform()}-${os.arch()}`, `${VARIANT}-${new Date().toISOString().slice(0, 10)}`);
  const all = { schema: 'qb-kan111-grade/1', adaptation: 'immutable-offline-v1', variant: VARIANT, approved_by: APPROVAL, execute: EXECUTE, harness: 'SWE-bench@02e7a74ffd0b707aab73d203fe87bdc7c76afc8e', runs: [] };
  for (const [key, t] of Object.entries(TASKS)) {
    const c = ctl.get(t.task_id); const v = vault.get(t.task_id);
    if (!c || !v || c.instance_id !== t.instance_id) throw new Error(`vault/controller row for ${key} missing or mismatched`);
    if (sha(v.eval_script) !== t.eval_sha256) throw new Error(`official eval script hash changed for ${key}`);
    const required = { FAIL_TO_PASS: arr(v.FAIL_TO_PASS), PASS_TO_PASS: arr(v.PASS_TO_PASS) };
    run(['docker', 'pull', t.image]);
    for (let rep = 1; rep <= REPS; rep++) {
      all.runs.push(gradeOne({ key, t, official: v.eval_script, required, mode: 'empty', rep, outDir }));
      all.runs.push(gradeOne({ key, t, official: v.eval_script, required, mode: 'gold', rep, outDir, patchText: v.patch }));
    }
    // Grader isolation tests (once per task)
    const tamper = `diff --git a/${t.test_files[0]} b/${t.test_files[0]}\n--- a/${t.test_files[0]}\n+++ b/${t.test_files[0]}\n@@ -1,1 +1,2 @@\n+// KAN-111 isolation test: a candidate edit to a hidden test file must be reverted by the grader\n`;
    all.runs.push(gradeOne({ key, t, official: v.eval_script, required, mode: 'isolation', label: 'iso-test-file-tamper', rep: 1, outDir, patchText: v.patch + tamper }));
    all.runs.push(gradeOne({ key, t, official: v.eval_script, required, mode: 'isolation', label: 'iso-patch-conflict', rep: 1, outDir, patchText: 'diff --git a/src/Immutable.js b/src/Immutable.js\n--- a/src/Immutable.js\n+++ b/src/Immutable.js\n@@ -1,1 +1,1 @@\n-THIS LINE DOES NOT EXIST IN THE BASE\n+conflict\n' }));
    all.runs.push(gradeOne({ key, t, official: v.eval_script, required, mode: 'isolation', label: 'iso-empty-patch-file', rep: 1, outDir, patchText: '' }));
    all.runs.push(gradeOne({ key, t, official: v.eval_script, required, mode: 'isolation', label: 'iso-timeout', rep: 1, outDir, patchText: v.patch, timeoutS: 5 }));
  }
  all.plan = plan;
  if (EXECUTE) { fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(all, null, 2)); }
  else {
    const po = arg('plan-out'); if (typeof po === 'string') fs.writeFileSync(po, `# KAN-111 immutable-offline-v1, variant ${VARIANT}: PLAN ONLY (nothing executed)\n# ${plan.length} commands, ${all.runs.length} runs\n` + plan.join('\n') + '\n');
    console.log(JSON.stringify({ execute: false, note: 'PLAN ONLY. Nothing was run.', variant: VARIANT, commands: plan.length, runs: all.runs.map((r) => `${r.task}/${r.label}/${r.rep}`) }, null, 1));
  }
  return all;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
