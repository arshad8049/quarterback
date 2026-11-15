#!/usr/bin/env node
// Arm A, batch 1: write the freeze BEFORE the first research trial (owner correction 4). It records the task list and
// reserve order, which tasks qualified (and why the others did not), the frozen settings, the image ids, and the sha256 of
// every file that defines the experiment. arm-a.mjs refuses to run if any of them differs: a necessary change means a new
// freeze version, the earlier results are kept, and incompatible versions are never combined.
//   node bench/opus-pilot/arm-a-freeze.mjs --qualification=<dir of qualification-<key>.json> --handoff=<kan117 results.json> [--write]
//   node bench/opus-pilot/arm-a-freeze.mjs --annotations=<file of collector notice lines> [--write]   (the public QUAL/IMAGES/ZIP lines)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const arg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
export const VERSION = 'arm-a-freeze-v1';
export const FROZEN_FILES = [
  'bench/opus-pilot/arm-a-batch-1.json', 'bench/opus-pilot/arm-a-grader-tasks.json', 'bench/opus-pilot/arm-a.mjs',
  'bench/opus-pilot/amendments/amendment-1.json', 'bench/opus-pilot/pilot-config.json', 'bench/opus-pilot/arm-a-grade-sanitize.mjs',
  'lib/pilot/arm-a.js', 'lib/pilot/trial-policy.js', 'agent/runner.js', 'bench/arms.js', 'bench/experiment-run.js',
  'lib/sandbox/agent-profile.js', 'lib/sandbox/pipeline.js', 'lib/sandbox/auth.js', 'lib/sandbox/agent.js', 'lib/sandbox/stream-json.js',
  'lib/research/candidate.js', 'lib/research/agent-bundle.js', 'bench/public/kan117/grade-candidate.mjs',
  'bench/public/grader/immutable-offline-v1/grade.mjs', 'bench/public/grader/immutable-offline-v1/grade_report.py',
  'bench/public/grader/immutable-offline-v1/grade-wrapper-a0.sh', 'bench/public/grader/immutable-offline-v1/qbx-boundary-a0.sh',
  '.github/workflows/arm-a-live.yml',
];

/** Selected tasks in order; a setup failure is replaced by the next QUALIFIED reserve in reserve order. */
export function chooseQualified(batch, keyOf, quals) {
  const q = (b) => quals[keyOf(b.instance_id)];
  const reserves = batch.reserve.filter((b) => q(b));
  const chosen = []; const excluded = []; let ri = 0;
  for (const s of batch.selected) {
    const k = keyOf(s.instance_id);
    if (q(s) && q(s).qualified) { chosen.push({ key: k, role: 'selected' }); continue; }
    excluded.push({ key: k, reason: q(s) ? q(s).failure : { where: 'qualification', why: 'not evaluated' } });
    while (ri < reserves.length && !(q(reserves[ri]) && q(reserves[ri]).qualified)) {
      const rk = keyOf(reserves[ri].instance_id); excluded.push({ key: rk, reason: q(reserves[ri]).failure, reserve: true }); ri++;
    }
    if (ri < reserves.length) { chosen.push({ key: keyOf(reserves[ri].instance_id), role: `replaces ${k}` }); ri++; }
  }
  return { chosen, excluded };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const qDir = arg('qualification'); const handoff = arg('handoff'); const ann = arg('annotations');
  if (!(qDir && handoff) && !ann) { console.error('usage: arm-a-freeze.mjs --qualification=<dir> --handoff=<results.json> | --annotations=<file> [--write]'); process.exit(2); }
  const { keyOf } = await import('./arm-a-tasks.mjs');
  const batch = JSON.parse(fs.readFileSync(path.join(HERE, 'arm-a-batch-1.json'), 'utf8'));
  const quals = {}; let prov; const zips = {};
  if (ann) {
    // the collector's public lines: QUAL <key> qualified=<bool> failure=<where:why> ... briefing=<sha> ...; IMAGES agent= tools= proxy=; ZIP <name> sha256=
    for (const l of fs.readFileSync(ann, 'utf8').split('\n')) {
      const q = /^QUAL (\S+) qualified=(true|false) failure=(.*?) deps=.* briefing=(\S+) calib_gates=(\S+)/.exec(l);
      if (q) {
        const [where, ...why] = q[3] === 'none' ? [null] : q[3].split(':');
        quals[q[1]] = { task: q[1], qualified: q[2] === 'true', failure: where ? { where, why: why.join(':') } : null, calib_gates: q[5],
          setup: { agent_input: { briefing_sha256: /^[0-9a-f]{64}$/.test(q[4]) ? q[4] : null } }, source_line: l };
      }
      const im = /^IMAGES agent=(\S+) tools=(\S+) proxy=(\S+) provenance_commit=(\S+)/.exec(l);
      if (im) prov = { qb_commit: im[4], images: { agent: { id: im[1] }, tools: { id: im[2] }, proxy: { id: im[3] } } };
      const z = /^ZIP (\S+) sha256=([0-9a-f]{64})/.exec(l); if (z) zips[z[1]] = z[2];
    }
    if (!prov) { console.error('no IMAGES line in the annotations'); process.exit(2); }
  } else {
    for (const f of fs.readdirSync(qDir, { recursive: true }).filter((x) => /qualification-[^/]+\.json$/.test(x))) {
      const j = JSON.parse(fs.readFileSync(path.join(qDir, f), 'utf8')); quals[j.task] = j;
    }
    prov = JSON.parse(fs.readFileSync(handoff, 'utf8')).image_provenance;
  }
  const { chosen, excluded } = chooseQualified(batch, keyOf, quals);
  const P = require(path.join(ROOT, 'lib/sandbox/agent-profile.js'));
  const A = require(path.join(ROOT, 'lib/pilot/arm-a.js'));
  const amend = JSON.parse(fs.readFileSync(path.join(HERE, 'amendments/amendment-1.json'), 'utf8'));
  const freeze = {
    schema: 'qb-arm-a-freeze/1', version: VERSION, task_list_id: batch.task_list_id, seed: batch.seed,
    exposure: 'fresh tasks; exploratory Claude-only arm; NOT a paired comparison (no frozen QB checklists)',
    qualified_tasks: chosen.map((c) => c.key), choice: chosen, excluded,
    reserve_order: batch.reserve.map((b) => keyOf(b.instance_id)),
    briefings: Object.fromEntries(chosen.map((c) => [c.key, quals[c.key].setup.agent_input.briefing_sha256])),
    qualification_sha256: Object.fromEntries(Object.entries(quals).map(([k, j]) => [k, sha(JSON.stringify(j))])),
    qualification_artifact_zips_sha256: zips,
    images: { agent: prov.images.agent.id, tools: prov.images.tools.id, proxy: prov.images.proxy.id },
    image_provenance: { qb_commit: prov.qb_commit, artifact: 'kan117-images of run 43610841280 (zip digest sha256:b53ac72aff4d7fc7a733d3429fa4f5db90299f171d0671dd30d0cd2179470151)',
      bases: Object.fromEntries(Object.entries(prov.images).map(([k, v]) => [k, v.base_digest || null])) },
    settings: { profile: { ...A.armAProfile() }, attempts: 1, coding_s: amend.time.coding_s, trial_total_s: amend.time.trial_total_s,
      briefing: 'agent-store problem_statement + bench/arms.js NATIVE_NOTE (arm A)', model_requested: P.profileFromConfig(P.loadReviewed()).model,
      run_order: 'sequential, one task per push; stop on usage limit or any auth problem; no reruns; no retry of an unsuccessful answer' },
    grading: { adaptation: 'arm-a-multilingual-a0-v1', harness: 'SWE-bench@02e7a74ffd0b707aab73d203fe87bdc7c76afc8e',
      harness_lock_sha256: '3ff9e5ec290027e4925964a8eb537af39f676a588aa81d9da2f429619e7de1ba', calibration_approval: 10610 },
    files: Object.fromEntries(FROZEN_FILES.map((f) => [f, sha(fs.readFileSync(path.join(ROOT, f)))])),
  };
  const text = `${JSON.stringify(freeze, null, 2)}\n`;
  if (process.argv.includes('--write')) fs.writeFileSync(path.join(HERE, `${VERSION}.json`), text);
  console.log(JSON.stringify({ version: VERSION, qualified: freeze.qualified_tasks, excluded: excluded.map((e) => `${e.key}: ${e.reason && e.reason.why}`), sha256: sha(text) }, null, 1));
}
