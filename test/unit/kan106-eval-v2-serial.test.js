/**
 * KAN-106 10838: serialization is MEASURED, not assumed from QB_MODEL_CONCURRENCY. The real v2 batch.js launches
 * the real qb.js (staged L1, the frozen flags) on three DEVELOPMENT items (v1 S1, S4, S5; never held-out) against
 * an INSTRUMENTED FAKE model server that records every /api/chat and /api/generate call's interval and the peak
 * number in flight. The fake replays the recorded 881a51a fact replies where they fit and otherwise answers "{}".
 * No real model is contacted: the child's endpoint is the fake's ephemeral port.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runBatch } = require('../../bench/kan106-eval-v2/batch');
const items = require('../../bench/kan106-eval-v2/items');
const { startFakeOllama } = require('../fixtures/kan106-eval-v2/fake-ollama');

const ROOT = path.join(__dirname, '..', '..');
const V1 = path.join(ROOT, 'bench', 'kan106-eval-v1', 'items');
const PACK = path.join(ROOT, 'docs', 'research', 'kan106', '2026-11-19-eval-v1-881a51a');
const PLAN = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench', 'kan106-eval-v2', 'plan.json'), 'utf8'));
const DEV = ['S1-slug', 'S4-parsebool', 'S5-clock'];
const GiB = 1024 ** 3;

/** Recorded fact replies by (request, requirement id), from the carried pack. */
function recordedReplies() {
  const runs = JSON.parse(fs.readFileSync(path.join(PACK, 'runs.json'), 'utf8'));
  const map = new Map();
  for (const id of DEV) {
    const dir = path.join(PACK, 'runs', runs[id].run_id);
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    const art = JSON.parse(fs.readFileSync(path.join(dir, m.artifacts['contract-staged'].path), 'utf8'));
    const staged = art.data || art;
    for (const f of staged.facts || []) map.set(`${m.request}\u0000${f.requirement_id}`, (f.attempts || []).map((a) => a.raw));
  }
  return map;
}
function replyFrom(map) {
  const used = new Map();
  return (body) => {
    let rid = null;
    try { rid = body.format.properties.cases.items.properties.requirement.enum[0]; } catch { /* not a fact call */ }
    const user = (body.messages || []).find((x) => x.role === 'user');
    for (const [k, raws] of map) {
      const [req, r] = k.split('\u0000');
      if (r === rid && user && user.content.includes(req)) { const n = used.get(k) || 0; used.set(k, n + 1); return raws[Math.min(n, raws.length - 1)]; }
    }
    return '{}';
  };
}

async function runDev({ concurrency, inherited }) {
  const fake = await startFakeOllama({ model: 'fake-model:1b', delayMs: 40, reply: replyFrom(recordedReplies()) });
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'kan106-v2-serial-'));
  const itemsRoot = path.join(out, 'dev-items');
  fs.mkdirSync(itemsRoot);
  for (const id of DEV) fs.cpSync(path.join(V1, id), path.join(itemsRoot, id), { recursive: true });
  const base = items.materialize(itemsRoot, path.join(out, 'repos'));
  const plan = JSON.parse(JSON.stringify(PLAN));
  const n = plan.normative;
  n.status.frozen = true; n.qb_under_test.sha = 'a'.repeat(40);
  Object.assign(n.model, { name: 'fake-model:1b', digest: 'f'.repeat(64) });
  n.launch.ollama_url = fake.url;
  n.launch.model_concurrency = concurrency;
  n.batch.items_per_profile = DEV.length;
  Object.assign(n.held_out, { order: DEV, spec_manifest_sha256: 's'.repeat(64), packet_manifest_sha256: 'p'.repeat(64), base_shas: base });
  Object.assign(n.profiles['P-Mac'], { platform: process.platform, arch: process.arch, min_total_memory_bytes: 1, host_label: 'TEST', owner_approval: 'TEST-NOT-REAL', window_start_utc: '2000-01-01T00:00:00Z', window_end_utc: '2100-01-01T00:00:00Z' });
  const snap = () => ({ taken_utc: new Date().toISOString(), os: { platform: process.platform, arch: process.arch },
    memory: { total_bytes: 64 * GiB, available_bytes: 64 * GiB, swap_used_bytes: 0, pressure: process.platform === 'linux' ? { kind: 'linux_psi', full_avg10: 0 } : { kind: 'darwin_level', level: 1 } },
    ollama: { loaded: [] } });
  try {
    const r = await runBatch({ out, expectedSha: 'a'.repeat(40), profile: 'P-Mac', plan, packetInfo: { manifest_sha256: 'p'.repeat(64), spec_manifest_sha256: 's'.repeat(64), base_shas: base },
      itemsRoot, inherited, takeSnapshot: async () => snap(), releaseModel: async () => ({ status: 'skipped_in_test' }), dotenvPath: path.join(out, 'no.env'), log: () => {} });
    return { r, fake, out };
  } finally { await fake.close(); }
}

test('instrument self-test: the fake server DOES detect two concurrent model calls', async () => {
  const fake = await startFakeOllama({ delayMs: 80 });
  try {
    const call = () => fetch(`${fake.url}/api/chat`, { method: 'POST', body: '{}' }).then((r) => r.json());
    await Promise.all([call(), call()]);
    assert.equal(fake.stats.maxInFlight, 2);
    assert.equal(fake.noOverlap(), false);
  } finally { await fake.close(); }
});

test('real batch.js + real qb.js (staged L1, frozen flags) on 3 dev items: every model call is serial (peak 1, no overlap)', { timeout: 180_000 }, async () => {
  const { r, fake, out } = await runDev({ concurrency: 1, inherited: { PATH: process.env.PATH, HOME: os.tmpdir(), TMPDIR: os.tmpdir() } });
  try {
    assert.equal(r.refused, false, JSON.stringify(r.reasons));
    const chats = fake.stats.calls.filter((c) => c.url === '/api/chat');
    assert.ok(chats.length >= DEV.length, `at least one L1 call per item (got ${chats.length})`);
    assert.equal(fake.stats.maxInFlight, 1);
    assert.equal(fake.noOverlap(), true);
    assert.deepEqual(r.batch.items.map((x) => x.status), ['launched', 'launched', 'launched']);
    assert.ok(r.batch.items.every((x) => x.run_id), 'each child recorded a QB run');
    for (const x of r.batch.items) {
      const m = JSON.parse(fs.readFileSync(path.join(out, 'runs', x.run_id, 'manifest.json'), 'utf8'));
      assert.equal(m.agent.type, 'dry-run');
    }
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});

test('the variable is not the evidence: with model_concurrency 8 (and 9 inherited, which never reaches the child) calls are STILL serial', { timeout: 180_000 }, async () => {
  const { r, fake, out } = await runDev({ concurrency: 8, inherited: { PATH: process.env.PATH, HOME: os.tmpdir(), TMPDIR: os.tmpdir(), QB_MODEL_CONCURRENCY: '9' } });
  try {
    assert.equal(r.refused, false, JSON.stringify(r.reasons));
    assert.equal(r.batch.settings.child_env.QB_MODEL_CONCURRENCY, '8');
    assert.ok(fake.stats.calls.length >= DEV.length);
    assert.equal(fake.stats.maxInFlight, 1);
    assert.equal(fake.noOverlap(), true);
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});
