#!/usr/bin/env node
/**
 * KAN-106 10761: the batch loop of the eight-request evaluation v1. Called ONCE by run-batch.sh after its
 * preflight (frozen SHA, clean tree, freeze, materialized base SHAs). No retry: every outcome is kept.
 *
 *   node bench/kan106-eval-v1/batch.js OUT EXPECTED_SHA
 *
 * Pinned for every launched qb.js (10761 fix 2), whatever the caller's environment holds:
 *   - the child environment is BUILT, not inherited: PATH, HOME, TMPDIR and LANG only, plus
 *     QB_OLLAMA_URL = FREEZE.ollama_url (local), QB_MODEL = FREEZE.model and QB_RUNS_DIR = OUT/runs.
 *     An inherited QB_OLLAMA_URL, QB_L1_BUDGET_MS, QB_L1_PROFILE, QB_MODEL_CALL_TIMEOUT_MS, NODE_OPTIONS,
 *     any credential, etc. never reaches it;
 *   - the flags are FREEZE.flags: --l1-budget 420 explicitly (it outranks QB_L1_BUDGET_MS in lib/budget.js),
 *     the staged profile's 240 s per call, and --no-llm-context --no-llm-verify (no later model stage);
 *   - refuses before any launch unless that same endpoint lists FREEZE.model with the FULL frozen digest,
 *     and unless intent/.env is absent (dotenv would add settings this script does not pin). The digest is
 *     checked again after the batch. Nothing is pulled or updated, and there is no fallback endpoint.
 *
 * Writes OUT/batch.json (effective settings, timestamps, digest before/after), OUT/runs.json
 * ({ id: { run_id, exit_code, signal } }, rewritten after every item), OUT/logs/<id>.log and OUT/ollama-tags-*.json.
 * Exit 0 after the batch, 2 when it refused to start.
 *
 * The 56 minutes are the SUM OF THE L1 BUDGETS (8 x 420 s); whole-batch wall time adds setup and scoring.
 */
const fs = require('fs');
const path = require('path');
const proc = require('../../lib/proc');
const { requestOf } = require('./score');

const DIR = __dirname;
const QB_ROOT = path.join(DIR, '..', '..');
const FREEZE = JSON.parse(fs.readFileSync(path.join(DIR, 'FREEZE.json'), 'utf8'));
const KEEP = ['PATH', 'HOME', 'TMPDIR', 'LANG'];
const CHILD_TIMEOUT_MS = 20 * 60_000;   // a backstop above --deadline 15: a hung child is killed and recorded

function childEnv(inherited, runsDir) {
  const env = {};
  for (const k of KEEP) if (typeof inherited[k] === 'string') env[k] = inherited[k];
  return { ...env, ...pinnedEnv(runsDir) };
}
const pinnedEnv = (runsDir) => ({ QB_OLLAMA_URL: FREEZE.ollama_url, QB_MODEL: FREEZE.model, QB_RUNS_DIR: runsDir });

/** Problems with the model server's tag list (null: no server). */
function tagProblems(tags) {
  if (!tags || !Array.isArray(tags.models)) return [`no model list from ${FREEZE.ollama_url}`];
  const m = tags.models.find((x) => x.name === FREEZE.model || x.model === FREEZE.model);
  if (!m) return [`${FREEZE.model} is not listed by ${FREEZE.ollama_url}`];
  if (m.digest !== FREEZE.model_digest) return [`${FREEZE.model} digest ${m.digest} is not the frozen ${FREEZE.model_digest}`];
  return [];
}
async function fetchTagsFrom(url) {
  try {
    const r = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(3000) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}
const writeJson = (f, o) => fs.writeFileSync(f, JSON.stringify(o, null, 2) + '\n');
const utc = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

async function runBatch({ out, expectedSha, inherited = process.env, qbEntry = path.join(QB_ROOT, 'qb.js'), fetchTags = fetchTagsFrom,
  dotenvPath = path.join(QB_ROOT, 'intent', '.env'), items = FREEZE.order, log = (m) => process.stdout.write(m) }) {
  fs.mkdirSync(path.join(out, 'logs'), { recursive: true });
  const runsDir = path.join(out, 'runs');
  const settings = {
    qb_entry: path.relative(QB_ROOT, qbEntry), model: FREEZE.model, model_digest: FREEZE.model_digest, ollama_url: FREEZE.ollama_url,
    profile: FREEZE.profile, flags: FREEZE.flags, child_env: pinnedEnv(runsDir), child_env_inherited: KEEP,
    l1_budget_s: FREEZE.budgets.l1_total_ms / 1000, per_call_s: FREEZE.budgets.per_call_ms / 1000, runs_per_item: 1,
    budget_note: 'at most 56 minutes is the sum of the L1 budgets (8 x 420 s); whole-batch wall time also includes setup and scoring',
  };
  const batch = { format: 'qb-kan106-eval-batch/1', qb_revision: expectedSha, settings, started_utc: utc(), refused: false, items: [] };
  const refuse = (reason) => { Object.assign(batch, { refused: true, reason, finished_utc: utc() }); writeJson(path.join(out, 'batch.json'), batch); log(`✗ ${reason}. Nothing was run.\n`); return { refused: true, reason }; };

  if (fs.existsSync(dotenvPath)) return refuse(`${path.relative(QB_ROOT, dotenvPath)} exists (dotenv would add settings the batch does not pin); move it away first`);
  const before = await fetchTags(FREEZE.ollama_url);
  writeJson(path.join(out, 'ollama-tags-before.json'), before);
  const bad = tagProblems(before);
  if (bad.length) return refuse(bad.join('; '));
  batch.model_before = { digest_matches: true };

  const runs = {};
  log(`Running ${items.length} items once each, in order. Output: ${out}\n`);
  for (const id of items) {
    log(`  ${id} ... `);
    const logFile = path.join(out, 'logs', `${id}.log`);
    const started = utc();
    const r = proc.run(process.execPath, [qbEntry, requestOf(id), '--repo', path.join(out, 'repos', id), ...FREEZE.flags],
      { cwd: QB_ROOT, env: childEnv(inherited, runsDir), timeout: CHILD_TIMEOUT_MS });
    fs.writeFileSync(logFile, `${r.stdout || ''}${r.stderr || ''}`);
    const m = String(r.stdout || '').match(/\[RUN\]\s+([0-9a-f-]{36})/);
    runs[id] = { run_id: m ? m[1] : null, exit_code: r.status, signal: r.signal, timed_out: r.timedOut };
    batch.items.push({ id, ...runs[id], started_utc: started, finished_utc: utc(), duration_ms: r.duration_ms, log: path.relative(out, logFile) });
    writeJson(path.join(out, 'runs.json'), runs);
    writeJson(path.join(out, 'batch.json'), batch);
    log(`exit ${r.status === null ? r.signal : r.status}, run ${runs[id].run_id || 'none'}\n`);
  }
  const after = await fetchTags(FREEZE.ollama_url);
  writeJson(path.join(out, 'ollama-tags-after.json'), after);
  const changed = tagProblems(after);
  batch.model_after = { digest_matches: changed.length === 0, problems: changed };
  batch.finished_utc = utc();
  writeJson(path.join(out, 'batch.json'), batch);
  if (changed.length) log(`✗ after the batch: ${changed.join('; ')} (every row will be scored invalid)\n`);
  return { refused: false, runs };
}

if (require.main === module) {
  const [out, sha] = process.argv.slice(2);
  if (!out || !/^[0-9a-f]{40}$/.test(String(sha))) { console.error('usage: node bench/kan106-eval-v1/batch.js OUT EXPECTED_SHA'); process.exit(2); }
  runBatch({ out, expectedSha: sha }).then((r) => process.exit(r.refused ? 2 : 0), (e) => { console.error(`✗ batch.js: ${e.message}`); process.exit(1); });
}
module.exports = { runBatch, childEnv, tagProblems, pinnedEnv };
