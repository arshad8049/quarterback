#!/usr/bin/env node
// KAN-114 10693 (freeze v8): the SIMULATED complete-stream artifact path for the no-environment, no-secret CI rehearsal.
//   --write --out=DIR      run both paired arms through the production assembly (runArmA / runArmB -> pairSummary) with a
//                          SIMULATED fake Claude stream behind the runSandboxed seam, and write each record, its exact
//                          captured bytes and the expected readback outcome (one valid sequence per arm, and B with
//                          missing evidence)
//   --readback --in=DIR    after artifact upload/download: recordProblems on each downloaded record with the downloaded
//                          bytes, and the LIVE gate (readbackGate mode=task) which must refuse every SIMULATED record
// Never a live model or billing check; refuses to run with any live flag or credential variable.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const PAIR = require('../../../lib/pilot/pair.js');
const F = require('./pair-sim-fixture.js');

const die = (code, m) => { console.log(`::error title=pair-sim::${m}`); process.exit(code); };
for (const k of Object.keys(process.env)) if (k === 'PAIR_LIVE' || k === 'ARM_A_LIVE' || k === 'CLAUDE_CODE_OAUTH_TOKEN' || /^(ANTHROPIC_|CLAUDE_API)/.test(k)) die(2, `refusing: ${k} is set (simulation never runs with a live flag or credential)`);
const arg = (n) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };

if (process.argv.includes('--write')) {
  const out = arg('out'); if (!out) die(2, 'need --out');
  fs.mkdirSync(out, { recursive: true });
  const cases = [
    { name: 'a-complete', arm: 'A', expect: 'verified', run: () => PAIR.runArmA(F.baseA({ seam: F.armASeam() })) },
    { name: 'b-complete-2-attempts', arm: 'B', expect: 'verified', run: () => PAIR.runArmB(F.baseB({ seam: F.fakeSandbox([], { passOn: 2 }) })) },
    { name: 'b-missing-evidence', arm: 'B', expect: 'refused', run: () => PAIR.runArmB(F.baseB({ seam: F.fakeSandbox([], { streams: [''] }) })) },
  ];
  for (const c of cases) {
    const res = await c.run();
    const rec = PAIR.pairSummary(res, { ...F.SIM_CTX, arm: c.arm });
    fs.writeFileSync(path.join(out, `${c.name}.json`), `${JSON.stringify(rec, null, 2)}\n`);
    fs.writeFileSync(path.join(out, `${c.name}.diff`), res.patch);
    fs.writeFileSync(path.join(out, `${c.name}.expect`), `${c.expect}\n`);
    console.log(`::notice title=pair-sim-write::${c.name} SIMULATED primary=${rec.primary} attempts=${rec.attempts} evidence.verified=${rec.evidence.verified} cand=${rec.candidate.bytes}B sha=${String(rec.candidate.sha256).slice(0, 12)}`);
  }
  process.exit(0);
}

if (process.argv.includes('--readback')) {
  const dir = arg('in'); if (!dir) die(2, 'need --in');
  const names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
  if (names.length !== 3) die(1, `expected 3 simulated records after download, found ${names.length}`);
  const bad = [];
  for (const n of names) {
    const rec = JSON.parse(fs.readFileSync(path.join(dir, `${n}.json`), 'utf8'));
    const bytes = fs.readFileSync(path.join(dir, `${n}.diff`));
    const expect = fs.readFileSync(path.join(dir, `${n}.expect`), 'utf8').trim();
    const problems = PAIR.recordProblems(rec, { patchBytes: bytes });
    const linkage = PAIR.linkageProblems(rec, bytes);
    const live = PAIR.readbackGate({ mode: 'task', record: rec, patchBytes: bytes, stopBatch: false });
    const got = problems.length === 0 ? 'verified' : 'refused';
    if (!/^SIMULATED/.test(rec.evidence_label)) bad.push(`${n}: not labelled SIMULATED`);
    if (got !== expect) bad.push(`${n}: readback ${got}, expected ${expect}`);
    if (linkage.length) bad.push(`${n}: byte linkage after transfer: ${linkage.join('; ')}`);
    if (live.code !== 8) bad.push(`${n}: the LIVE gate did not refuse a SIMULATED record (code ${live.code})`);
    console.log(`::notice title=pair-sim-readback::${n} SIMULATED readback=${got} (expected ${expect}) linkage=${linkage.length ? 'BROKEN' : 'ok'} sha=${String(rec.candidate.sha256).slice(0, 12)} live_gate=${live.code} problems=${JSON.stringify(problems.slice(0, 4)).replace(/%/g, '%25')}`);
  }
  if (bad.length) die(1, bad.join(' | '));
  process.exit(0);
}
die(2, 'usage: --write --out=DIR | --readback --in=DIR');
