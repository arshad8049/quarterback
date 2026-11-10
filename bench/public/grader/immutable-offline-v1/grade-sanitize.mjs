#!/usr/bin/env node
// KAN-111 grade-result sanitizer (review 10559). Runs BEFORE any upload; the upload step runs only if this exits 0.
//   node grade-sanitize.mjs <raw-out-dir> <publish-dir> <store-dir>
//        --qb-commit=<40 hex> --dataset-revision=<40 hex> --lock-sha256=<64 hex> --install-dir=<dir>
// Builds ONE new document, results.json, from an explicit allowlist of fields in <raw-out-dir>/summary.json:
// no output tails, no failure details, no eval.sh, patch, test output, required list, grade.json or manifests.
// Then refuses (exit 1, publish dir removed) if the document contains ANY required test name of the two tasks
// (read from the vault in <store-dir>), patch/diff text, or a secret-like string. Writes sanitize-report.txt.
// Only results.json and sanitize-report.txt are ever written to <publish-dir>.
// Review 10561: keeps the runner's real fingerprint fields (*_sha256), refuses any that is not a 64-hex SHA, and
// records the experiment identity (executed QB commit, dataset revision, reviewed lock hash, install record hashes).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const pick = (o, keys) => (o && typeof o === 'object' ? Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]])) : o ?? null);
const TREE = ['sha256', 'files', 'marker_count', 'node_modules'];
// Grader reasons are runner-generated; anything not in these shapes is replaced, never passed through
const SAFE_REASON = /^(FAIL_TO_PASS|PASS_TO_PASS)\[\d+\]: expected [a-z]+, got [a-z:]+$|^official (log gate|resolution) .{0,80}$/;
const SECRET = /(ghp_|gho_|ghs_|ghu_|github_pat_|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY|sk-ant-|xox[abprs]-)/;
const PATCHY = /(diff --git|^@@ -|\n@@ -|^\+\+\+ b\/|\n\+\+\+ b\/|^--- a\/|\n--- a\/)/;
const RUN_KEYS = ['task', 'instance_id', 'mode', 'label', 'rep', 'variant', 'image', 'network', 'sys_admin', 'timeout_s', 'outcome', 'infra_step',
  'head', 'eval_kind', 'eval_sha256', 'official_eval_sha256', 'eval_exit', 'timed_out', 'wall_s', 'patch_sha256', 'patch_bytes', 'diff_before_sha256',
  'tamper_marker_before_grading', 'expectation_met', 'expectation_failures'];

const HEX64 = /^[0-9a-f]{64}$/; const HEX40 = /^[0-9a-f]{40}$/;
const SHA_KEYS = ['eval_sha256', 'official_eval_sha256', 'patch_sha256', 'diff_before_sha256'];
export const INSTALL_FILES = ['harness-smoke.txt', 'install-provenance.json', 'installed-harness-files.sha256', 'pip-check.txt', 'pip-freeze.txt', 'swebench-rebuilt-wheel.sha256'];
class Refuse extends Error {}
// Fingerprints must be real SHA-256 values; a malformed one means the record is not what we think it is
function checkShas(r, i) {
  for (const k of SHA_KEYS) if (r[k] !== undefined && r[k] !== null && !HEX64.test(String(r[k]))) throw new Refuse(`run ${i}: ${k} is not a 64-hex SHA-256`);
  for (const t of ['start_tree', 'tested_tree', 'final_tree']) {
    const v = r[t]; if (!v) continue;
    if (v.sha256 !== undefined && !HEX64.test(String(v.sha256))) throw new Refuse(`run ${i}: ${t}.sha256 is not a 64-hex SHA-256`);
    if (v.node_modules !== undefined && v.node_modules !== 'absent' && !HEX64.test(String(v.node_modules))) throw new Refuse(`run ${i}: ${t}.node_modules is not a 64-hex SHA-256`);
  }
}
export function identity(opts) {
  const e = {};
  if (!HEX40.test(opts['qb-commit'] || '')) throw new Refuse('--qb-commit must be the executed 40-hex commit');
  if (!HEX40.test(opts['dataset-revision'] || '')) throw new Refuse('--dataset-revision must be a 40-hex dataset revision');
  if (!HEX64.test(opts['lock-sha256'] || '')) throw new Refuse('--lock-sha256 must be the reviewed 64-hex lock hash');
  const dir = opts['install-dir']; if (!dir || !fs.existsSync(dir)) throw new Refuse('--install-dir is missing');
  const present = fs.readdirSync(dir).sort();
  if (JSON.stringify(present) !== JSON.stringify([...INSTALL_FILES].sort())) throw new Refuse(`install record must be exactly ${INSTALL_FILES.join(', ')} (found ${present.join(', ')})`);
  e.qb_commit = opts['qb-commit']; e.dataset_revision = opts['dataset-revision']; e.lock_sha256 = opts['lock-sha256'];
  e.install_record_sha256 = Object.fromEntries(INSTALL_FILES.map((f) => [f, sha(fs.readFileSync(path.join(dir, f)))]));
  return e;
}

export function sanitize(summary) {
  (summary.runs || []).forEach(checkShas);
  const runs = (summary.runs || []).map((r) => ({
    ...pick(r, RUN_KEYS),
    patch_apply: r.patch_apply ? pick(r.patch_apply, ['ok', 'via', 'skipped']) : null,
    wrapper_env: Array.isArray(r.wrapper_env) ? r.wrapper_env.filter((l) => /^[A-Za-z_][A-Za-z0-9_]*=[^\n]{0,120}$/.test(l)) : null,
    start_tree: pick(r.start_tree, TREE), tested_tree: pick(r.tested_tree, TREE), final_tree: pick(r.final_tree, TREE),
    grade: r.grade ? { ...pick(r.grade, ['mode', 'accepted', 'official']), reasons: (r.grade.reasons || []).map((x) => (SAFE_REASON.test(x) ? x : '<redacted reason>')) } : null,
    steps: Array.isArray(r.steps) ? r.steps.map((s) => pick(s, ['step', 'status', 'signal'])) : null,
  }));
  return {
    schema: 'qb-kan111-results/1', sanitized: true,
    ...pick(summary, ['adaptation', 'variant', 'approved_by', 'execute', 'fixture_mode', 'harness', 'instrumentation_sha256', 'wrapper_sha256', 'gates_passed']),
    plan_sha256: Array.isArray(summary.plan) ? sha(summary.plan.join('\n') + '\n') : null,
    runs,
  };
}

// Every required test name of every task in the controller/vault store (names never leave the vault otherwise)
export function forbiddenNames(store) {
  const f = path.join(store, 'vault', 'swe-bench-multilingual.jsonl');
  const names = new Set();
  for (const line of fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)) {
    const v = JSON.parse(line);
    for (const k of ['FAIL_TO_PASS', 'PASS_TO_PASS']) {
      const a = Array.isArray(v[k]) ? v[k] : JSON.parse(v[k] || '[]');
      for (const n of a) if (typeof n === 'string' && n.trim().length >= 6) names.add(n.trim());
    }
  }
  return [...names];
}

export function scan(text, names) {
  const hits = [];
  names.forEach((n, i) => { if (text.includes(n)) hits.push(`required test name #${i}`); });   // index only, never the name
  if (PATCHY.test(text)) hits.push('patch/diff text');
  if (SECRET.test(text)) hits.push('secret-like string');
  return hits;
}

function main(argv) {
  const pos = argv.filter((a) => !a.startsWith('--')); const opts = Object.fromEntries(argv.filter((a) => a.startsWith('--')).map((a) => { const i = a.indexOf('='); return [a.slice(2, i < 0 ? undefined : i), i < 0 ? '' : a.slice(i + 1)]; }));
  const [raw, pub, store] = pos;
  if (!raw || !pub || !store) { console.error('usage: grade-sanitize.mjs <raw-out-dir> <publish-dir> <store-dir>'); return 2; }
  fs.rmSync(pub, { recursive: true, force: true });
  let summary;
  try { summary = JSON.parse(fs.readFileSync(path.join(raw, 'summary.json'), 'utf8')); } catch (e) { console.error(`sanitize: summary.json unreadable: ${e.message}`); return 1; }
  const names = forbiddenNames(store);
  if (!names.length) { console.error('sanitize: no required test names loaded; refusing (cannot check)'); return 1; }
  let doc;
  try { doc = JSON.stringify({ ...sanitize(summary), experiment: identity(opts) }, null, 2) + '\n'; } catch (e) { if (e instanceof Refuse) { console.error(`sanitize: REFUSED: ${e.message}`); return 1; } throw e; }
  const hits = scan(doc, names);
  if (hits.length) { console.error(`sanitize: REFUSED (${hits.length}): ${hits.join(', ')}`); return 1; }
  fs.mkdirSync(pub, { recursive: true });
  fs.writeFileSync(path.join(pub, 'results.json'), doc);
  fs.writeFileSync(path.join(pub, 'sanitize-report.txt'), `sanitize ok\nresults.json sha256 ${sha(doc)}\nchecked against ${names.length} required test names, patch text and secret patterns\nruns ${summary.runs?.length ?? 0}\n`);
  console.log(`sanitize ok: results.json ${sha(doc)}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) process.exitCode = main(process.argv.slice(2));
