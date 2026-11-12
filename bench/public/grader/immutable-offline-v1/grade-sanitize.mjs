#!/usr/bin/env node
// KAN-111 grade-result sanitizer (review 10559). Runs BEFORE any upload; the upload step runs only if this exits 0.
//   node grade-sanitize.mjs <raw-out-dir> <publish-dir> <store-dir>
//        --qb-commit=<40 hex> --dataset-revision=<40 hex> --lock-sha256=<64 hex> --install-dir=<dir>
// Builds ONE new document, results.json, from an explicit allowlist of fields in <raw-out-dir>/summary.json:
// no output tails, no failure details, no eval.sh, patch, test output, required list, grade.json or manifests.
// Then refuses (exit 1, publish dir removed) if the document contains ANY required test name of the two tasks
// (read from the vault in <store-dir>), patch/diff text, or a secret-like string. Writes sanitize-report.txt.
// Only results.json and sanitize-report.txt (exit 0), or fallback.json and sanitize-report.txt (exit 3), are ever
// written to <publish-dir>; exit 1 publishes nothing.
// Review 10561: keeps the runner's real fingerprint fields (*_sha256), refuses any that is not a 64-hex SHA, and
// records the experiment identity (executed QB commit, dataset revision, reviewed lock hash, install record hashes).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { TASKS } from './grade.mjs';

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
// Review 10568: a content refusal carries a code (published in the fallback); a configuration error publishes nothing
class Refuse extends Error { constructor(code, msg) { super(msg); this.code = code; } }
class ConfigError extends Error {}
// Fingerprints must be real SHA-256 values; a malformed one means the record is not what we think it is
function checkShas(r, i) {
  for (const k of SHA_KEYS) if (r[k] !== undefined && r[k] !== null && !HEX64.test(String(r[k]))) throw new Refuse('invalid_fingerprint', `run ${i}: ${k} is not a 64-hex SHA-256`);
  for (const t of ['start_tree', 'tested_tree', 'final_tree']) {
    const v = r[t]; if (!v) continue;
    if (v.sha256 !== undefined && !HEX64.test(String(v.sha256))) throw new Refuse('invalid_fingerprint', `run ${i}: ${t}.sha256 is not a 64-hex SHA-256`);
    if (v.node_modules !== undefined && v.node_modules !== 'absent' && !HEX64.test(String(v.node_modules))) throw new Refuse('invalid_fingerprint', `run ${i}: ${t}.node_modules is not a 64-hex SHA-256`);
  }
}
// Review 10568 diagnostics: exactly these keys, booleans and non-negative integers only
const DIAG_BOOL = ['jq_available', 'start_marker', 'end_marker', 'command_not_found', 'jq_error'];
const DIAG_INT = ['section_result_lines', 'whole_log_result_lines'];
const isCount = (v) => Number.isInteger(v) && v >= 0;
function checkDiag(r, i) {
  const d = r.log_diag;
  if (d !== undefined && d !== null) {
    const keys = Object.keys(d).sort(); const want = [...DIAG_BOOL, ...DIAG_INT, 'output_capture'].sort();
    if (JSON.stringify(keys) !== JSON.stringify(want) || !DIAG_BOOL.every((k) => typeof d[k] === 'boolean') || !DIAG_INT.every((k) => isCount(d[k])) || d.output_capture !== 'combined_in_container')
      throw new Refuse('invalid_diagnostics', `run ${i}: log_diag is not the expected counts and booleans`);
  }
  const g = r.grade;
  if (g) {
    if (g.log_gate !== undefined && !['ok', 'failed'].includes(g.log_gate)) throw new Refuse('invalid_diagnostics', `run ${i}: grade.log_gate`);
    for (const k of ['official_status_map_entries', 'strict_raw_result_lines']) if (g[k] !== undefined && g[k] !== null && !isCount(g[k])) throw new Refuse('invalid_diagnostics', `run ${i}: grade.${k}`);
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
  (summary.runs || []).forEach(checkDiag);
  const runs = (summary.runs || []).map((r) => ({
    ...pick(r, RUN_KEYS),
    patch_apply: r.patch_apply ? pick(r.patch_apply, ['ok', 'via', 'skipped']) : null,
    wrapper_env: Array.isArray(r.wrapper_env) ? r.wrapper_env.filter((l) => /^[A-Za-z_][A-Za-z0-9_]*=[^\n]{0,120}$/.test(l)) : null,
    start_tree: pick(r.start_tree, TREE), tested_tree: pick(r.tested_tree, TREE), final_tree: pick(r.final_tree, TREE),
    log_diag: r.log_diag ? pick(r.log_diag, [...DIAG_BOOL, ...DIAG_INT, 'output_capture']) : null,
    grade: r.grade ? { ...pick(r.grade, ['mode', 'accepted', 'official', 'log_gate', 'official_status_map_entries', 'strict_raw_result_lines']), reasons: (r.grade.reasons || []).map((x) => (SAFE_REASON.test(x) ? x : '<redacted reason>')) } : null,
    steps: Array.isArray(r.steps) ? r.steps.map((s) => pick(s, ['step', 'status', 'signal'])) : null,
  }));
  return {
    schema: 'qb-kan111-results/1', sanitized: true,
    ...pick(summary, ['adaptation', 'variant', 'approved_by', 'execute', 'fixture_mode', 'harness', 'instrumentation_sha256', 'wrapper_sha256', 'gates_passed']),
    plan_sha256: Array.isArray(summary.plan) ? sha(summary.plan.join('\n') + '\n') : null,
    runs,
  };
}

// Review 10568: the required test names of exactly the given tasks, in vault order. Fails closed if any task's vault
// row or required list is missing or empty, or a name is too short to scan for reliably.
export function forbiddenNames(store, taskIds) {
  const f = path.join(store, 'vault', 'swe-bench-multilingual.jsonl');
  if (!fs.existsSync(f)) throw new ConfigError('vault file missing');
  const names = []; const seen = new Set(); const found = new Set();
  for (const line of fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)) {
    const v = JSON.parse(line);
    if (!taskIds.includes(v.task_id)) continue;
    found.add(v.task_id);
    for (const k of ['FAIL_TO_PASS', 'PASS_TO_PASS']) {
      const a = Array.isArray(v[k]) ? v[k] : JSON.parse(v[k] || '[]');
      if (!Array.isArray(a) || !a.length) throw new ConfigError(`${v.task_id}: ${k} missing or empty`);
      for (const n of a) {
        if (typeof n !== 'string' || n.trim().length < 6) throw new ConfigError(`${v.task_id}: a required name is too short to scan for`);
        if (!seen.has(n.trim())) { seen.add(n.trim()); names.push(n.trim()); }
      }
    }
  }
  const missing = taskIds.filter((t) => !found.has(t));
  if (missing.length) throw new ConfigError(`vault rows missing for ${missing.join(', ')}`);
  return names;
}

export function scan(text, names) {
  const hits = [];
  names.forEach((n, i) => { if (text.includes(n)) hits.push({ code: 'required_test_name', index: i }); });   // index only, never the name
  if (PATCHY.test(text)) hits.push({ code: 'patch_text' });
  if (SECRET.test(text)) hits.push({ code: 'secret' });
  return hits;
}

// Review 10568 fallback: built independently from strictly validated enums, integers and booleans only. Any value that
// does not validate blocks the fallback entirely. It never sets anything green: the sanitizer exits 3 when it is used.
const LABELS = ['empty', 'gold', 'iso-test-file-tamper', 'iso-patch-conflict', 'iso-empty-patch-file', 'iso-timeout-fixture'];
const OUTCOMES = ['graded', 'infra_error', 'patch_apply_failed', 'timeout', 'build_failed', 'empty_patch_excluded'];
const CODES = ['required_test_name', 'patch_text', 'secret', 'invalid_fingerprint', 'invalid_diagnostics'];
export function fallback(summary, refusal, experiment) {
  if (typeof summary.gates_passed !== 'boolean') throw new ConfigError('fallback: gates_passed is not a boolean');
  const runs = (summary.runs || []).map((r, i) => {
    const ok = typeof r.task === 'string' && /^\d{4}$/.test(r.task) && LABELS.includes(r.label) && Number.isInteger(r.rep) && r.rep >= 1 && r.rep <= 100
      && OUTCOMES.includes(r.outcome) && typeof r.expectation_met === 'boolean' && (r.grade == null || typeof r.grade.accepted === 'boolean');
    if (!ok) throw new ConfigError(`fallback: run ${i} does not validate`);
    return { task: r.task, label: r.label, rep: r.rep, outcome: r.outcome, expectation_met: r.expectation_met, accepted: r.grade ? r.grade.accepted : null };
  });
  for (const x of refusal) if (!CODES.includes(x.code) || (x.index !== undefined && !Number.isInteger(x.index))) throw new ConfigError('fallback: invalid refusal code');
  return { schema: 'qb-kan111-fallback/1', fallback: true, full_report_refused: true, gates_passed: summary.gates_passed,
    refusal: refusal.map((x) => (x.index !== undefined ? { code: x.code, index: x.index } : { code: x.code })), experiment, runs };
}

function main(argv) {
  const pos = argv.filter((a) => !a.startsWith('--')); const opts = Object.fromEntries(argv.filter((a) => a.startsWith('--')).map((a) => { const i = a.indexOf('='); return [a.slice(2, i < 0 ? undefined : i), i < 0 ? '' : a.slice(i + 1)]; }));
  const [raw, pub, store] = pos;
  if (!raw || !pub || !store) { console.error('usage: grade-sanitize.mjs <raw-out-dir> <publish-dir> <store-dir> --qb-commit= --dataset-revision= --lock-sha256= --install-dir= [--fixture-task-ids= (fixture summaries only)]'); return 2; }
  fs.rmSync(pub, { recursive: true, force: true });
  // ── Configuration: any problem here publishes NOTHING (exit 1) ──
  let summary, names, experiment, scope;
  try {
    try { summary = JSON.parse(fs.readFileSync(path.join(raw, 'summary.json'), 'utf8')); } catch (e) { throw new ConfigError(`summary.json unreadable: ${e.message}`); }
    let taskIds;
    if (summary.fixture_mode === true) {
      taskIds = (opts['fixture-task-ids'] || '').split(',').filter(Boolean);
      if (!taskIds.length) throw new ConfigError('a fixture summary needs --fixture-task-ids');
      scope = 'fixture';
    } else {
      if (opts['fixture-task-ids'] !== undefined) throw new ConfigError('--fixture-task-ids is refused for a real summary');
      taskIds = Object.values(TASKS).map((t) => t.task_id);
      scope = 'pinned';
    }
    names = forbiddenNames(store, taskIds);
    try { experiment = identity(opts); } catch (e) { throw new ConfigError(e.message); }
    scope = `${taskIds.length} ${scope} tasks`;
  } catch (e) { if (e instanceof ConfigError) { console.error(`sanitize: REFUSED (nothing published): ${e.message}`); return 1; } throw e; }

  // ── Full report ──
  let refusal = [], doc = null;
  try { doc = JSON.stringify({ ...sanitize(summary), experiment }, null, 2) + '\n'; refusal = scan(doc, names); }
  catch (e) { if (!(e instanceof Refuse)) throw e; console.error(`sanitize: full report refused: ${e.message}`); refusal = [{ code: e.code }]; }
  if (!refusal.length) {
    fs.mkdirSync(pub, { recursive: true });
    fs.writeFileSync(path.join(pub, 'results.json'), doc);
    fs.writeFileSync(path.join(pub, 'sanitize-report.txt'), `sanitize ok\nresults.json sha256 ${sha(doc)}\nchecked against ${names.length} required test names of ${scope}, patch text and secret patterns\nruns ${summary.runs?.length ?? 0}\n`);
    console.log(`sanitize ok: results.json ${sha(doc)}`);
    return 0;
  }
  console.error(`sanitize: REFUSED full report (${refusal.length}): ${refusal.map((x) => x.code + (x.index !== undefined ? ` #${x.index}` : '')).join(', ')}`);

  // ── Fallback: independently built, separately scanned; never green (exit 3) ──
  let fb;
  try { fb = JSON.stringify(fallback(summary, refusal, experiment), null, 2) + '\n'; }
  catch (e) { if (e instanceof ConfigError) { console.error(`sanitize: fallback blocked (nothing published): ${e.message}`); return 1; } throw e; }
  const fbHits = scan(fb, names);
  if (fbHits.length) { console.error(`sanitize: fallback blocked (nothing published): ${fbHits.map((x) => x.code + (x.index !== undefined ? ` #${x.index}` : '')).join(', ')}`); return 1; }
  fs.mkdirSync(pub, { recursive: true });
  fs.writeFileSync(path.join(pub, 'fallback.json'), fb);
  fs.writeFileSync(path.join(pub, 'sanitize-report.txt'), `FULL REPORT REFUSED; fallback published\nfallback.json sha256 ${sha(fb)}\nrefusal ${refusal.map((x) => x.code + (x.index !== undefined ? ` #${x.index}` : '')).join(', ')}\nchecked against ${names.length} required test names of ${scope}, patch text and secret patterns\n`);
  console.log(`sanitize: fallback published (full report refused): fallback.json ${sha(fb)}`);
  return 3;
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) process.exitCode = main(process.argv.slice(2));
