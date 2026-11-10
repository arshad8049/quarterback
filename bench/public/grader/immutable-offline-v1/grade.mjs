#!/usr/bin/env node
// KAN-111 exact offline grader, adaptation `immutable-offline-v1`, for immutable-js tasks 2005 and 2006.
//   node public/grader/immutable-offline-v1/grade.mjs [--variant=A1] [--plan-out=<file>]   # PLAN ONLY (default): runs nothing
//   node public/grader/immutable-offline-v1/grade.mjs --execute --approved-by=<KAN-111 review comment id> [--reps=3]
// Replicates the pinned SWE-bench harness run path (SWE-bench @ 02e7a74ffd0b707aab73d203fe87bdc7c76afc8e,
// swebench/harness/run_evaluation.py) with disclosed differences: --network none, no added SYS_ADMIN,
// variant A1 (build-gated, stats omitted) and a separately hashed test-boundary instrumentation line.
// Every step is checked; outcomes are infra_error | patch_apply_failed | timeout | build_failed | graded;
// every run has an expectation, and the process exits 1 if ANY expectation is not met (review 10551).
// Test-only: QB_KAN111_FIXTURE (+ --approved-by=FIXTURE), QB_KAN111_DOCKER, QB_KAN111_GRADER, SWEBENCH_PYTHON.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(HERE, '..', '..');
const arg = (k, d = null) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : (process.argv.includes(`--${k}`) ? true : d); };

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
  reset: 'git checkout -- . ; git clean -fd', APPLY_PATCH_FAIL: '>>>>> Patch Apply Failed' };
export const TAMPER_MARKER = '// KAN-111 tamper marker: a candidate edit to a hidden test file must be reverted by the grader';
export const BUILD_GATE_EXIT = 97;

/** Eval script per variant. A0 = official verbatim. A1 = only the `npm run build` line replaced by the gated
 *  offline steps. `instrument` separately inserts one test-boundary line before the official Start marker. */
export function evalScript(official, t, variant, { instrument = false } = {}) {
  let lines = official.split('\n');
  if (variant === 'A1') {
    const idx = lines.map((l, i) => (l.trim() === 'npm run build' ? i : -1)).filter((i) => i >= 0);
    if (idx.length !== 1) throw new Error(`A1 expects exactly one 'npm run build' line, found ${idx.length}`);
    lines[idx[0]] = `if ! ( ${t.a1_build} ); then echo '>>>>> QBX Build Failed'; exit ${BUILD_GATE_EXIT}; fi`;
  } else if (variant !== 'A0') throw new Error(`unknown variant ${variant}`);
  if (instrument) {
    const at = lines.findIndex((l) => l.includes('>>>>> Start Test Output'));
    if (at < 0) throw new Error('instrumentation needs the official Start Test Output marker');
    lines = [...lines.slice(0, at), 'bash /qbx-boundary.sh tested', ...lines.slice(at)];
  }
  return lines.join('\n');
}

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const jl = (f) => new Map(fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => { const x = JSON.parse(l); return [x.task_id, x]; }));
const kv = (text, k) => { const m = new RegExp(`^${k}=(.*)$`, 'm').exec(text || ''); return m ? m[1].trim() : null; };
const manifest = (f) => (fs.existsSync(f) ? Object.fromEntries(fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => { const [h, ...p] = l.split(/\s+/); return [p.join(' ').replace(/^\.\//, ''), h]; })) : null);

class Infra extends Error { constructor(step, r) { super(`${step} failed`); this.step = step; this.detail = `${(r && (r.stderr || r.error)) || ''}`.slice(-1200); } }

export function main() {
  const EXECUTE = arg('execute') === true; const APPROVAL = arg('approved-by'); const VARIANT = arg('variant', 'A1');
  const REPS = Number(arg('reps', 3)); const TIMEOUT_S = Number(arg('timeout', 1800)); const FIX_TIMEOUT_S = Number(arg('fixture-timeout', 5));
  const DOCKER = process.env.QB_KAN111_DOCKER || 'docker'; const PY = process.env.SWEBENCH_PYTHON || 'python3';
  const GRADER = process.env.QB_KAN111_GRADER || path.join(HERE, 'grade_report.py');
  const FIXTURE = process.env.QB_KAN111_FIXTURE ? JSON.parse(fs.readFileSync(process.env.QB_KAN111_FIXTURE, 'utf8')) : null;
  if (EXECUTE && !APPROVAL) { console.error('refusing to execute: --approved-by=<KAN-111 review comment id> is required (no grader run before review)'); return 2; }
  if (FIXTURE && APPROVAL !== 'FIXTURE') { console.error('refusing: QB_KAN111_FIXTURE is test-only and requires --approved-by=FIXTURE'); return 2; }
  if (!FIXTURE && APPROVAL === 'FIXTURE') { console.error('refusing: --approved-by=FIXTURE is only valid with QB_KAN111_FIXTURE'); return 2; }
  const tasks = FIXTURE ? FIXTURE.tasks : TASKS; const store = FIXTURE ? FIXTURE.store : path.join(PUB, 'out');
  const outDir = typeof arg('out') === 'string' ? arg('out') : path.join(HERE, 'results', `${os.platform()}-${os.arch()}`, `${VARIANT}-${new Date().toISOString().slice(0, 10)}`);
  const plan = [];
  const sym = (a) => String(a).split(HERE).join('<grader>').split(PUB).join('<bench/public>').split(os.tmpdir()).join('<run-dir>');
  const run = (argv, opts = {}) => {
    plan.push(argv.map((a) => sym(/\s/.test(a) ? JSON.stringify(a) : a)).join(' '));
    if (!EXECUTE) return { status: 0, stdout: '', stderr: '' };
    const bin = argv[0] === 'docker' ? DOCKER : argv[0];
    const r = spawnSync(bin, argv.slice(1), { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
    return { status: r.status, signal: r.signal, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error && r.error.message };
  };
  const must = (step, argv, opts) => { const r = run(argv, opts); if (r.status !== 0) throw new Infra(step, r); return r; };

  function gradeOne({ key, t, official, required, mode, label = mode, rep, patchText = null, tamper = false, fixtureEval = null, timeoutS = TIMEOUT_S }) {
    const name = `kan111-${key}-${label}-${rep}-${EXECUTE ? crypto.randomBytes(3).toString('hex') : 'plan'}`;
    const dir = path.join(outDir, `${key}-${label}-${rep}`); if (EXECUTE) fs.mkdirSync(dir, { recursive: true });
    const rec = { task: key, instance_id: t.instance_id, mode, label, rep, variant: VARIANT, container: name, image: t.image, network: 'none', sys_admin: false, timeout_s: timeoutS };
    const evalText = fixtureEval || evalScript(official, t, VARIANT, { instrument: true });
    rec.eval_sha256 = sha(evalText); rec.official_eval_sha256 = sha(official); rec.eval_kind = fixtureEval ? 'timeout-fixture (not the task eval)' : `${VARIANT} + test-boundary instrumentation`;
    const ex = (cmd, o) => run(['docker', 'exec', '-w', H.workdir, '-u', H.user, name, '/bin/bash', '-c', cmd], o);
    const applyPatch = (text, file) => {
      if (EXECUTE) fs.writeFileSync(file, text);
      must('copy patch', ['docker', 'cp', file, `${name}:${H.patchFile}`]);
      for (let i = 0; i < H.applyCmds.length; i++) {
        if (i) must('reset between apply attempts', ['docker', 'exec', '-w', H.workdir, '-u', H.user, name, '/bin/bash', '-c', H.reset]);
        if (ex(`${H.applyCmds[i]} ${H.patchFile}`).status === 0) return { ok: true, via: H.applyCmds[i] };
      }
      if (ex(`git apply --check --reverse ${H.patchFile}`).status === 0) return { ok: true, via: 'verified already applied' };
      return { ok: false, marker: H.APPLY_PATCH_FAIL };
    };
    try {
      must('create container', ['docker', 'create', '--name', name, '--network', 'none', '--user', H.user, '--workdir', H.workdir, t.image, 'tail', '-f', '/dev/null']);
      must('start container', ['docker', 'start', name]);
      rec.head = must('read HEAD', ['docker', 'exec', '-w', H.workdir, '-u', H.user, name, '/bin/bash', '-c', 'git rev-parse HEAD']).stdout.trim() || null;
      must('base check', ['docker', 'exec', '-w', H.workdir, '-u', H.user, name, '/bin/bash', '-c', `test "$(git rev-parse HEAD)" = ${t.base} || git diff --quiet ${t.base} HEAD`]);
      if (tamper) {
        // A VALID tamper built against the exact base inside this container: gold + one appended line in the first
        // official test file, captured with git diff, then the tree reset and the candidate applied the normal way.
        const g = applyPatch(patchText, path.join(EXECUTE ? dir : os.tmpdir(), 'gold.diff'));
        if (!g.ok) throw new Infra('build tamper: gold apply', { stderr: 'gold patch did not apply' });
        must('build tamper: edit test file', ['docker', 'exec', '-w', H.workdir, '-u', H.user, name, '/bin/bash', '-c', `printf '\\n%s\\n' '${TAMPER_MARKER}' >> ${t.test_files[0]}`]);
        must('build tamper: capture diff', ['docker', 'exec', '-w', H.workdir, '-u', H.user, name, '/bin/bash', '-c', 'git -c core.fileMode=false diff > /tmp/candidate.diff']);
        must('build tamper: copy out', ['docker', 'cp', `${name}:/tmp/candidate.diff`, path.join(EXECUTE ? dir : os.tmpdir(), 'candidate.diff')]);
        must('build tamper: reset tree', ['docker', 'exec', '-w', H.workdir, '-u', H.user, name, '/bin/bash', '-c', H.reset]);
        patchText = EXECUTE ? fs.readFileSync(path.join(dir, 'candidate.diff'), 'utf8') : '<candidate.diff>';
      }
      if (patchText !== null) {
        rec.patch_sha256 = sha(patchText); rec.patch_bytes = Buffer.byteLength(patchText);
        rec.patch_apply = applyPatch(patchText, path.join(EXECUTE ? dir : os.tmpdir(), 'patch.diff'));
        if (!rec.patch_apply.ok) { rec.outcome = 'patch_apply_failed'; return rec; }   // the harness raises here; nothing is graded
        if (tamper) rec.tamper_marker_before_grading = Number(ex(`grep -c 'KAN-111 tamper marker' ${t.test_files[0]}`).stdout.trim() || 0);
      } else rec.patch_apply = { skipped: 'empty candidate: base + official test patch only (harness --no-patch path)' };
      rec.diff_before_sha256 = sha(must('diff before', ['docker', 'exec', '-w', H.workdir, '-u', H.user, name, '/bin/bash', '-c', 'git -c core.fileMode=false diff']).stdout);
      const ef = path.join(EXECUTE ? dir : os.tmpdir(), 'eval.sh'); if (EXECUTE) fs.writeFileSync(ef, evalText);
      must('copy eval script', ['docker', 'cp', ef, `${name}:/eval.sh`]);
      must('copy wrapper', ['docker', 'cp', path.join(HERE, 'grade-wrapper.sh'), `${name}:/grade-wrapper.sh`]);
      must('copy boundary helper', ['docker', 'cp', path.join(HERE, 'qbx-boundary.sh'), `${name}:/qbx-boundary.sh`]);
      const t0 = Date.now();
      const r = run(['docker', 'exec', '-w', H.workdir, '-u', H.user, name, '/bin/bash', '/grade-wrapper.sh', '/eval.sh'], { timeout: timeoutS * 1000, killSignal: 'SIGKILL' });
      rec.wall_s = (Date.now() - t0) / 1000; rec.eval_exit = r.status; rec.timed_out = r.signal === 'SIGKILL' || /ETIMEDOUT/.test(r.error || '');
      if (EXECUTE) fs.writeFileSync(path.join(dir, 'test_output.txt'), r.stdout + (r.stderr ? `\n${r.stderr}` : '') + (rec.timed_out ? `\n\nTimeout error: ${timeoutS} seconds exceeded.` : ''));
      const env = /QBX_ENV_BEGIN([\s\S]*?)QBX_ENV_END/.exec(r.stdout || ''); rec.wrapper_env = env ? env[1].trim().split('\n') : null;
      if (rec.timed_out) { rec.outcome = 'timeout'; return rec; }
      if (r.status === BUILD_GATE_EXIT || /^>>>>> QBX Build Failed$/m.test(r.stdout)) { rec.outcome = 'build_failed'; return rec; }   // never a qualified replay
      if (EXECUTE && kv(r.stdout, 'QBX_EVAL_EXIT') === null) throw new Infra('eval wrapper (no exit status recorded)', r);
      rec.tested_tree = { sha256: kv(r.stdout, 'QBX_TESTED_SHA256'), files: kv(r.stdout, 'QBX_TESTED_FILES'), marker_count: Number(kv(r.stdout, 'QBX_TESTED_MARKER_COUNT') ?? NaN) };
      must('copy tested-tree manifest', ['docker', 'cp', `${name}:/tmp/qbx-tested.txt`, path.join(EXECUTE ? dir : os.tmpdir(), 'tested-tree.txt')]);
      const fin = must('final-state manifest', ['docker', 'exec', '-w', H.workdir, '-u', H.user, name, '/bin/bash', '-c', 'bash /qbx-boundary.sh final']);
      rec.final_tree_sha256 = kv(fin.stdout, 'QBX_FINAL_SHA256');
      must('copy final manifest', ['docker', 'cp', `${name}:/tmp/qbx-final.txt`, path.join(EXECUTE ? dir : os.tmpdir(), 'final-tree.txt')]);
      if (EXECUTE) fs.writeFileSync(path.join(dir, 'required.json'), JSON.stringify(required));
      const gmode = mode === 'empty' ? 'empty' : 'gold';
      const g = run([PY, GRADER, t.instance_id, path.join(dir, 'test_output.txt'), path.join(dir, 'required.json'), path.join(dir, 'grade.json'), gmode]);
      if (!EXECUTE) { rec.outcome = 'planned'; return rec; }
      if (g.status !== 0) throw new Infra(`grader exit ${g.status}`, g);
      let grade; try { grade = JSON.parse(fs.readFileSync(path.join(dir, 'grade.json'), 'utf8')); } catch (e) { throw new Infra('grader output unreadable', { stderr: e.message }); }
      if (!grade.acceptance || typeof grade.acceptance.accepted !== 'boolean') throw new Infra('grader output has no acceptance decision', { stderr: JSON.stringify(grade).slice(0, 400) });
      rec.grade = { mode: gmode, accepted: grade.acceptance.accepted, reasons: grade.acceptance.reasons, official: grade.official && grade.official.resolution };
      rec.outcome = 'graded';
      return rec;
    } catch (e) {
      if (!(e instanceof Infra)) throw e;
      rec.outcome = 'infra_error'; rec.infra_step = e.step; rec.infra_detail = e.detail; return rec;
    } finally {
      run(['docker', 'rm', '-f', name]);
      if (EXECUTE) { fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(rec, null, 2)); fs.rmSync(path.join(dir, 'required.json'), { force: true }); }
    }
  }

  const all = { schema: 'qb-kan111-grade/2', adaptation: 'immutable-offline-v1', variant: VARIANT, approved_by: APPROVAL, execute: EXECUTE, fixture_mode: !!FIXTURE,
    harness: 'SWE-bench@02e7a74ffd0b707aab73d203fe87bdc7c76afc8e', instrumentation_sha256: sha(fs.readFileSync(path.join(HERE, 'qbx-boundary.sh'))),
    wrapper_sha256: sha(fs.readFileSync(path.join(HERE, 'grade-wrapper.sh'))), runs: [] };
  const ctl = jl(path.join(store, 'controller', 'swe-bench-multilingual.jsonl')); const vault = jl(path.join(store, 'vault', 'swe-bench-multilingual.jsonl'));
  const arr = (x) => (Array.isArray(x) ? x : JSON.parse(x));
  for (const [key, t] of Object.entries(tasks)) {
    const c = ctl.get(t.task_id); const v = vault.get(t.task_id);
    if (!c || !v || c.instance_id !== t.instance_id) throw new Error(`vault/controller row for ${key} missing or mismatched`);
    if (sha(v.eval_script) !== t.eval_sha256) throw new Error(`official eval script hash changed for ${key}`);
    const required = { FAIL_TO_PASS: arr(v.FAIL_TO_PASS), PASS_TO_PASS: arr(v.PASS_TO_PASS) };
    const pull = run(['docker', 'pull', t.image]);
    const base = { key, t, official: v.eval_script, required };
    const runs = [];
    if (pull.status !== 0) runs.push({ task: key, label: 'pull', outcome: 'infra_error', infra_step: 'pull image', infra_detail: (pull.stderr || '').slice(-600) });
    else {
      for (let rep = 1; rep <= REPS; rep++) {
        runs.push(gradeOne({ ...base, mode: 'empty', rep }));
        runs.push(gradeOne({ ...base, mode: 'gold', rep, patchText: v.patch }));
      }
      runs.push(gradeOne({ ...base, mode: 'gold', label: 'iso-test-file-tamper', rep: 1, patchText: v.patch, tamper: true }));
      runs.push(gradeOne({ ...base, mode: 'isolation', label: 'iso-patch-conflict', rep: 1, patchText: 'diff --git a/src/Immutable.js b/src/Immutable.js\n--- a/src/Immutable.js\n+++ b/src/Immutable.js\n@@ -1,1 +1,1 @@\n-THIS LINE DOES NOT EXIST IN THE BASE\n+conflict\n' }));
      runs.push(gradeOne({ ...base, mode: 'isolation', label: 'iso-empty-patch-file', rep: 1, patchText: '' }));
      runs.push(gradeOne({ ...base, mode: 'isolation', label: 'iso-timeout-fixture', rep: 1, fixtureEval: '#!/bin/bash\n# KAN-111 deterministic timeout fixture (not the task eval)\nsleep 600\n', timeoutS: FIX_TIMEOUT_S }));
    }
    // Expectations (review 10551): every replay must be accepted for its mode; isolation controls must behave as designed.
    const goldRef = runs.find((x) => x.label === 'gold' && x.outcome === 'graded');
    const refTree = goldRef && EXECUTE ? manifest(path.join(outDir, `${key}-gold-${goldRef.rep}`, 'tested-tree.txt')) : null;
    for (const x of runs) {
      const why = [];
      if (x.label === 'empty' || x.label === 'gold') {
        if (x.outcome !== 'graded') why.push(`outcome ${x.outcome}`); else if (!x.grade.accepted) why.push(`not accepted: ${(x.grade.reasons || []).slice(0, 3).join('; ')}`);
      } else if (x.label === 'iso-test-file-tamper') {
        if (x.outcome !== 'graded') why.push(`outcome ${x.outcome}`);
        else {
          if (!x.grade.accepted) why.push('tampered gold run not accepted as gold');
          if (!(x.tamper_marker_before_grading >= 1)) why.push('the tamper never applied, so it proves nothing');
          if (x.tested_tree.marker_count !== 0) why.push('tamper marker still present at the test boundary');
          const tr = EXECUTE ? manifest(path.join(outDir, `${key}-iso-test-file-tamper-1`, 'tested-tree.txt')) : null;
          if (!refTree || !tr) why.push('no reference tested tree to compare');
          else for (const f of t.test_files) if (refTree[f] !== tr[f]) why.push(`tested ${f} differs from the gold run's`);
        }
      } else if (x.label === 'iso-patch-conflict' || x.label === 'iso-empty-patch-file') {
        if (x.outcome !== 'patch_apply_failed') why.push(`outcome ${x.outcome}, expected patch_apply_failed`);
        if (x.grade) why.push('a rejected patch was graded');
      } else if (x.label === 'iso-timeout-fixture') {
        if (x.outcome !== 'timeout') why.push(`outcome ${x.outcome}, expected timeout`);
      } else why.push(`outcome ${x.outcome}`);
      x.expectation_met = EXECUTE ? why.length === 0 : null; x.expectation_failures = why;
    }
    all.runs.push(...runs);
  }
  all.gates_passed = EXECUTE ? all.runs.every((x) => x.expectation_met) : null;
  all.plan = plan;
  if (EXECUTE) { fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(all, null, 2)); }
  else {
    const po = arg('plan-out'); if (typeof po === 'string') fs.writeFileSync(po, `# KAN-111 immutable-offline-v1, variant ${VARIANT}: PLAN ONLY (nothing executed)\n# ${plan.length} commands, ${all.runs.length} runs\n` + plan.join('\n') + '\n');
    console.log(JSON.stringify({ execute: false, note: 'PLAN ONLY. Nothing was run.', variant: VARIANT, commands: plan.length, runs: all.runs.map((r) => `${r.task}/${r.label}/${r.rep}`) }, null, 1));
  }
  if (EXECUTE) console.log(JSON.stringify({ gates_passed: all.gates_passed, failed: all.runs.filter((x) => !x.expectation_met).map((x) => `${x.task}/${x.label}/${x.rep}: ${x.expectation_failures.join('; ')}`) }, null, 1));
  return EXECUTE ? (all.gates_passed ? 0 : 1) : 0;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main();
