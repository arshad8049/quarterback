#!/usr/bin/env node
// KAN-114 10693 (freeze v8): after artifact transfer, check the REAL Docker dry-run records of both arms:
// candidate.diff bytes = candidate.json = trial.json = published pair-<arm>.json hashes; the readback sidecar says
// "unverified as expected" and never verified_artifact; the cleanup counters are all zero. Usage: --dir=DIR --arms=A,B
// (DIR/<arm>/restricted and DIR/<arm>/public as downloaded).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const arg = (n) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };
const dir = arg('dir'); const arms = (arg('arms') || 'A,B').split(',');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const bad = [];
for (const arm of arms) {
  const r = path.join(dir, arm, 'restricted'); const p = path.join(dir, arm, 'public');
  const diff = fs.readFileSync(path.join(r, 'candidate.diff'));
  const cand = JSON.parse(fs.readFileSync(path.join(r, 'candidate.json'), 'utf8'));
  const trial = JSON.parse(fs.readFileSync(path.join(r, 'trial.json'), 'utf8'));
  const pub = JSON.parse(fs.readFileSync(path.join(p, `pair-${arm}.json`), 'utf8'));
  const side = JSON.parse(fs.readFileSync(path.join(p, `readback-${arm}.json`), 'utf8'));
  const clean = fs.readFileSync(path.join(p, 'cleanup-trial.txt'), 'utf8').trim().split('\n').map((l) => l.split('='));
  const h = sha(diff);
  const hashes = { bytes: h, candidate_json: cand.sha256, trial_json: trial.candidate.sha256, public_json: pub.candidate.sha256 };
  if (new Set(Object.values(hashes)).size !== 1) bad.push(`${arm}: candidate hashes differ after transfer ${JSON.stringify(hashes)}`);
  if (diff.length !== trial.candidate.bytes) bad.push(`${arm}: byte count differs`);
  if (!/^DRY RUN/.test(pub.evidence_label)) bad.push(`${arm}: not labelled DRY RUN`);
  if (side.verified_artifact !== false || !/unverified as expected/.test(side.expectation)) bad.push(`${arm}: readback sidecar ${JSON.stringify(side.expectation)} verified_artifact=${side.verified_artifact}`);
  if (pub.evidence.verified !== false) bad.push(`${arm}: a scripted record claims verified evidence`);
  for (const [k, v] of clean) if (Number(v) !== 0) bad.push(`${arm}: cleanup ${k}=${v}`);
  console.log(`::notice title=rehearsal-${arm}::DRY RUN (real Docker entrypoint, scripted stage) hashes_equal=${new Set(Object.values(hashes)).size === 1} sha=${h.slice(0, 12)} bytes=${diff.length} primary=${pub.primary} evidence.verified=${pub.evidence.verified} expectation=${side.expectation} cleanup=${clean.map(([k, v]) => `${k}=${v}`).join(',')}`);
}
if (bad.length) { console.log(`::error title=rehearsal::${bad.join(' | ')}`); process.exit(1); }
