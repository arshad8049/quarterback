#!/usr/bin/env node
/**
 * KAN-106 10838: the evaluation v2 batch for ONE profile (one machine). Called once by run-batch.sh after its
 * preflight. NOT AUTHORIZED until the plan is frozen, the held-out packet is frozen and the owner has named and
 * approved this host and its local-model time window; until then it refuses (and that refusal is tested).
 *
 *   node bench/kan106-eval-v2/batch.js OUT EXPECTED_SHA PROFILE
 *
 * Refuses BEFORE any model contact (exit 2) on any of:
 *   - the plan document and plan.json disagree (plan-check.js; never "the JSON wins");
 *   - plan.json is not marked frozen, or EXPECTED_SHA is not its qb_under_test.sha;
 *   - the compiler or harness differs from HARNESS-FREEZE.json (freeze.js);
 *   - the held-out packet or its spec manifest differs from the frozen hashes, or the materialized base SHAs differ;
 *   - PROFILE is unknown, has no owner-named host label, no owner approval reference, or now is outside its window;
 *   - this host does not match the profile (platform, arch, minimum RAM);
 *   - intent/.env exists; the endpoint does not list the pinned model with the FULL frozen digest.
 * Then, strictly one item at a time (each child awaited before the next starts; proven with an instrumented fake
 * model server in test/unit/kan106-eval-v2-serial.test.js):
 *   unload the pinned model once (item 1 is cold by design; --l1-warmup is never used), and for each frozen item:
 *   read-only host snapshot -> residency-aware resource gate -> launch qb.js, or record resource_blocked (never
 *   launched, never retried, never replaced) -> snapshot after. No retry of anything.
 * The child environment is BUILT (PATH, HOME, TMPDIR, LANG only) plus QB_OLLAMA_URL, QB_MODEL, QB_RUNS_DIR and
 * QB_MODEL_CONCURRENCY=1 (defence in depth; NOT the evidence of serialization).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const proc = require('../../lib/proc');
const { gate } = require('./resource-gate');

const DIR = __dirname;
const QB_ROOT = path.join(DIR, '..', '..');
const KEEP = ['PATH', 'HOME', 'TMPDIR', 'LANG'];
const CHILD_TIMEOUT_MS = 20 * 60_000;
const writeJson = (f, o) => fs.writeFileSync(f, JSON.stringify(o, null, 2) + '\n');
const utc = (d = new Date()) => d.toISOString().replace(/\.\d+Z$/, 'Z');
const requestText = (itemsRoot, id) => fs.readFileSync(path.join(itemsRoot, id, 'request.txt'), 'utf8').replace(/\n+$/, '');

function pinnedEnv(n, runsDir) {
  return { QB_OLLAMA_URL: n.launch.ollama_url, QB_MODEL: n.model.name, QB_RUNS_DIR: runsDir, QB_MODEL_CONCURRENCY: String(n.launch.model_concurrency) };
}
function childEnv(inherited, n, runsDir) {
  const env = {};
  for (const k of KEEP) if (typeof inherited[k] === 'string') env[k] = inherited[k];
  return { ...env, ...pinnedEnv(n, runsDir) };
}
function tagProblems(tags, n) {
  if (!tags || !Array.isArray(tags.models)) return [`no model list from ${n.launch.ollama_url}`];
  const m = tags.models.find((x) => x.name === n.model.name || x.model === n.model.name);
  if (!m) return [`${n.model.name} is not listed by ${n.launch.ollama_url}`];
  if (m.digest !== n.model.digest) return [`${n.model.name} digest ${m.digest} is not the frozen ${n.model.digest}`];
  return [];
}
/** Host approval and hardware match for this profile. */
function profileProblems(n, profile, snap, now) {
  const p = [];
  const prof = n.profiles && n.profiles[profile];
  if (!prof) return [`unknown profile ${JSON.stringify(profile)} (frozen: ${Object.keys(n.profiles || {}).join(', ')})`];
  if (!prof.host_label) p.push(`${profile}: no owner-named host label`);
  if (!prof.owner_approval) p.push(`${profile}: no owner approval reference for this host and its local-model time`);
  const s = Date.parse(prof.window_start_utc); const e = Date.parse(prof.window_end_utc);
  if (!Number.isFinite(s) || !Number.isFinite(e)) p.push(`${profile}: no approved time window`);
  else if (now < s || now > e) p.push(`${profile}: now (${utc(new Date(now))}) is outside the approved window ${prof.window_start_utc} .. ${prof.window_end_utc}`);
  if (!snap || !snap.os) p.push('host snapshot unavailable');
  else {
    if (snap.os.platform !== prof.platform) p.push(`${profile}: platform ${snap.os.platform}, frozen ${prof.platform}`);
    if (snap.os.arch !== prof.arch) p.push(`${profile}: arch ${snap.os.arch}, frozen ${prof.arch}`);
    const t = snap.memory && snap.memory.total_bytes;
    if (!Number.isFinite(t)) p.push(`${profile}: physical memory unknown`);
    else if (t < prof.min_total_memory_bytes) p.push(`${profile}: physical memory ${t} B < frozen minimum ${prof.min_total_memory_bytes} B`);
  }
  return p;
}

/** lib/proc.runBounded (QB-01: argv, shell:false; own process group, the whole tree killed on timeout). Awaited by the loop. */
function defaultSpawnChild(cmd, args, { cwd, env, timeout }) {
  return proc.runBounded(cmd, args, { cwd, env, timeoutMs: timeout, maxBytes: 8 * 1024 * 1024 });
}
async function defaultFetchJson(url) {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(3000) }); return r.ok ? await r.json() : null; } catch { return null; }
}

/**
 * @param {object} o
 * @param {object} o.plan             parsed plan.json (its `normative` object is used)
 * @param {string[]} o.planProblems   plan-check.js problems (any -> refuse)
 * @param {string[]} o.harnessProblems freeze.js checkHarness problems (any -> refuse)
 * @param {object} o.packetInfo       { manifest_sha256, spec_manifest_sha256, base_shas } as computed now
 */
async function runBatch({ out, expectedSha, profile, plan, planProblems = [], harnessProblems = [], packetInfo, itemsRoot,
  inherited = process.env, qbEntry = path.join(QB_ROOT, 'qb.js'), fetchJson = defaultFetchJson, takeSnapshot, releaseModel,
  spawnChild = defaultSpawnChild, dotenvPath = path.join(QB_ROOT, 'intent', '.env'), now = () => Date.now(), log = (m) => process.stdout.write(m),
  childTimeoutMs = CHILD_TIMEOUT_MS }) {
  fs.mkdirSync(path.join(out, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(out, 'snapshots'), { recursive: true });
  const runsDir = path.join(out, 'runs');
  const n = (plan && plan.normative) || {};
  const batch = { format: 'qb-kan106-eval-v2-batch/1', profile, qb_revision: expectedSha, started_utc: utc(new Date(now())), refused: false, preflight: [], items: [] };
  const refuse = (reasons) => {
    Object.assign(batch, { refused: true, reasons, finished_utc: utc(new Date(now())) });
    writeJson(path.join(out, 'batch.json'), batch);
    log(`✗ refused before any model contact:\n  ${reasons.join('\n  ')}\nNothing was run.\n`);
    return { refused: true, reasons };
  };

  // ── preflight: everything that does not touch the model server ──
  const pre = [];
  pre.push(...planProblems.map((x) => `plan: ${x}`));
  if (!n.status || n.status.frozen !== true) pre.push('plan: not frozen (normative.status.frozen is not true); no run is authorized');
  pre.push(...harnessProblems.map((x) => `harness freeze: ${x}`));
  if (!n.qb_under_test || expectedSha !== n.qb_under_test.sha) pre.push(`QB revision ${expectedSha} is not the frozen qb_under_test.sha ${n.qb_under_test ? n.qb_under_test.sha : null}`);
  const h = n.held_out || {};
  if (!packetInfo) pre.push('held-out packet: not computed');
  else {
    if (!h.packet_manifest_sha256) pre.push('held-out packet: no frozen packet hash');
    else if (packetInfo.manifest_sha256 !== h.packet_manifest_sha256) pre.push(`held-out packet ${packetInfo.manifest_sha256} != frozen ${h.packet_manifest_sha256}`);
    if (!h.spec_manifest_sha256) pre.push('held-out specs: no owner-posted spec manifest hash');
    else if (packetInfo.spec_manifest_sha256 !== h.spec_manifest_sha256) pre.push(`held-out specs ${packetInfo.spec_manifest_sha256} != frozen ${h.spec_manifest_sha256}`);
    for (const id of h.order || []) if (!h.base_shas || packetInfo.base_shas[id] !== h.base_shas[id]) pre.push(`base ${id}: ${packetInfo.base_shas[id]} != frozen ${h.base_shas ? h.base_shas[id] : null}`);
  }
  const order = h.order || [];
  if (order.length !== (n.batch ? n.batch.items_per_profile : 12)) pre.push(`held-out order has ${order.length} items, frozen ${n.batch ? n.batch.items_per_profile : 12}`);
  if (fs.existsSync(dotenvPath)) pre.push(`${path.relative(QB_ROOT, dotenvPath)} exists (dotenv would add settings the batch does not pin)`);
  let first = null;
  try { first = await takeSnapshot(); } catch { first = null; }
  pre.push(...profileProblems(n, profile, first, now()));
  batch.preflight = pre;
  if (pre.length) return refuse(pre);

  // ── model server checks (listing only) ──
  const before = await fetchJson(`${n.launch.ollama_url}/api/tags`);
  writeJson(path.join(out, 'ollama-tags-before.json'), before);
  const bad = tagProblems(before, n);
  if (bad.length) return refuse(bad);
  const settings = { model: n.model.name, model_digest: n.model.digest, ollama_url: n.launch.ollama_url, profile_l1: n.launch.l1_profile, flags: n.launch.flags,
    child_env: pinnedEnv(n, runsDir), child_env_inherited: KEEP, runs_per_item: 1, retries: 0, warmup: false, launch_mode: 'sequential: each child is awaited before the next starts' };
  Object.assign(batch, { settings, model_before: { digest_matches: true } });

  // item 1 cold by design
  try { batch.model_release = await releaseModel(); } catch (e) { batch.model_release = { released: false, error: String(e && e.message) }; }

  const runs = {};
  let previous = null;
  log(`Profile ${profile}: ${order.length} items once each, in the frozen order. Output: ${out}\n`);
  for (const [i, id] of order.entries()) {
    log(`  ${id} ... `);
    let snap = null;
    try { snap = await takeSnapshot(); } catch { snap = null; }
    const snapFile = path.join('snapshots', `${String(i + 1).padStart(2, '0')}-${id}-before.json`);
    writeJson(path.join(out, snapFile), snap);
    const g = gate({ snapshot: snap, previous, policy: n.resource_gate, model: { name: n.model.name, digest: n.model.digest } });
    previous = snap;
    const item = { id, position: i + 1, snapshot_before: snapFile, gate: g };
    if (!g.admit) {
      Object.assign(item, { status: 'resource_blocked', launched: false });
      runs[id] = { status: 'resource_blocked', run_id: null };
      batch.items.push(item);
      writeJson(path.join(out, 'runs.json'), runs); writeJson(path.join(out, 'batch.json'), batch);
      log(`resource_blocked (${g.reasons.join('; ')}); not launched, not retried\n`);
      continue;
    }
    const started = utc(new Date(now()));
    const r = await spawnChild(process.execPath, [qbEntry, requestText(itemsRoot, id), '--repo', path.join(out, 'repos', id), ...n.launch.flags],
      { cwd: QB_ROOT, env: childEnv(inherited, n, runsDir), timeout: childTimeoutMs });
    fs.writeFileSync(path.join(out, 'logs', `${id}.log`), `${r.stdout || ''}${r.stderr || ''}`);
    const m = String(r.stdout || '').match(/\[RUN\]\s+([0-9a-f-]{36})/);
    runs[id] = { status: 'launched', run_id: m ? m[1] : null, exit_code: r.status, signal: r.signal, timed_out: r.timedOut };
    let after = null;
    try { after = await takeSnapshot(); } catch { after = null; }
    const afterFile = path.join('snapshots', `${String(i + 1).padStart(2, '0')}-${id}-after.json`);
    writeJson(path.join(out, afterFile), after);
    Object.assign(item, { status: 'launched', launched: true, ...runs[id], started_utc: started, finished_utc: utc(new Date(now())), wall_ms: r.duration_ms,
      log: path.join('logs', `${id}.log`), snapshot_after: afterFile });
    batch.items.push(item);
    writeJson(path.join(out, 'runs.json'), runs); writeJson(path.join(out, 'batch.json'), batch);
    log(`exit ${r.status === null ? r.signal : r.status}, run ${runs[id].run_id || 'none'}\n`);
  }
  const afterTags = await fetchJson(`${n.launch.ollama_url}/api/tags`);
  writeJson(path.join(out, 'ollama-tags-after.json'), afterTags);
  const changed = tagProblems(afterTags, n);
  batch.model_after = { digest_matches: changed.length === 0, problems: changed };
  batch.finished_utc = utc(new Date(now()));
  writeJson(path.join(out, 'batch.json'), batch);
  return { refused: false, runs, batch };
}

if (require.main === module) {
  const [out, sha, profile] = process.argv.slice(2);
  if (!out || !/^[0-9a-f]{40}$/.test(String(sha)) || !profile) { console.error('usage: node bench/kan106-eval-v2/batch.js OUT EXPECTED_SHA PROFILE'); process.exit(2); }
  const { checkFiles } = require('./plan-check');
  const { checkHarness, packet } = require('./freeze');
  const { snapshot } = require('./host-snapshot');
  const { releaseLocalModel } = require('../../lib/model-release');
  const pc = checkFiles();
  const plan = pc.plan || {};
  const n = plan.normative || {};
  const itemsRoot = path.join(QB_ROOT, (n.held_out && n.held_out.items_dir) || 'bench/kan106-eval-v2/held-out');
  let packetInfo = null;
  try {
    const baseShas = JSON.parse(fs.readFileSync(path.join(out, 'base-shas.json'), 'utf8'));
    packetInfo = { manifest_sha256: packet(itemsRoot).manifest_sha256, spec_manifest_sha256: packet(itemsRoot, { specsOnly: true }).manifest_sha256, base_shas: baseShas };
  } catch { packetInfo = null; }
  const url = n.launch ? n.launch.ollama_url : 'http://127.0.0.1:11434';
  runBatch({ out, expectedSha: sha, profile, plan, planProblems: pc.problems, harnessProblems: checkHarness(), packetInfo, itemsRoot,
    takeSnapshot: () => snapshot({ ollamaUrl: url }),
    releaseModel: () => releaseLocalModel({ url, model: n.model && n.model.name }) })
    .then((r) => process.exit(r.refused ? 2 : 0), (e) => { console.error(`✗ batch.js: ${e.message}`); process.exit(1); });
}
module.exports = { runBatch, childEnv, pinnedEnv, tagProblems, profileProblems, defaultSpawnChild };
