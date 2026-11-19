#!/usr/bin/env node
/**
 * KAN-106 eight-request evaluation v1: score ONE recorded run per item. No model call: it reads the run
 * records (manifest, events, artifacts) and runs the GENERATED checks, unchanged, with the real check runner
 * on the item's base and controls.
 *
 *   node bench/kan106-eval-v1/score.js --batch-dir OUT [--out FILE]
 *     OUT is what batch.js wrote: batch.json (pinned settings), runs.json ({ id: { run_id, exit_code, signal } })
 *     and runs/ (the QB run records).
 *
 * 10761 (senior review of c89ddf2):
 *   - Every row comes from the FROZEN ROSTER, so the denominators are always 6 supported and 2 unsupported.
 *     A missing or corrupt record, a crash, a timeout or a model/transport failure is an explicit
 *     `invalid_record` or `execution_failed` row, never a successful refusal.
 *   - A refusal item passes (`intended_refusal`) only with the task-relevant L1 decision frozen in its
 *     item.json `refusal_evidence`, no finalized checklist and no agent launch. Any other block is
 *     `blocked_other_reason`: execution was safely blocked, but that is not the intended refusal.
 *   - Before any result is assigned, the record must match its frozen item: run id, QB revision, request,
 *     base SHA, model (configured and replying), profile, effective L1 budget and per-call cap, flags,
 *     dry-run agent, local endpoint, and an exit code consistent with the outcome. Artifacts are verified
 *     against their manifest sha256 on read. A mismatch or missing evidence is `invalid_record`.
 *
 * Semantic review against the full original request stays a person's call (`semantic: null`).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const proc = require('../../lib/proc');
const { contractState } = require('../../intent/contract-state');
const { matchesAny } = require('../../verify/policy');

const DIR = __dirname;
const ITEMS = path.join(DIR, 'items');
const FREEZE = JSON.parse(fs.readFileSync(path.join(DIR, 'FREEZE.json'), 'utf8'));
const RUNNER = path.join(DIR, '..', '..', 'sandbox', 'agent', 'qb-check-runner.mjs');
const LIMITS = { per_item_l1_ms: 180_000, median_l1_ms: 120_000, budget_l1_ms: 420_000 };
const EXIT_FOR = { DRY_RUN: 0, BLOCKED: 2, ERROR: 1, CANCELLED: 3 };

class EvidenceError extends Error {}
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
function readEvidence(f, what) {
  let text;
  try { text = fs.readFileSync(f, 'utf8'); } catch { throw new EvidenceError(`${what}: missing`); }
  try { return JSON.parse(text); } catch (e) { throw new EvidenceError(`${what}: not valid JSON (${e.message})`); }
}
/** The request exactly as the batch passes it to qb.js (trailing newlines removed, as $(cat …) did). */
const requestOf = (id, itemsRoot = ITEMS) => fs.readFileSync(path.join(itemsRoot, id, 'request.txt'), 'utf8').replace(/\n+$/, '');

/** What every record of this batch must show, from the freeze and the batch's pinned revision. */
function expectFrom({ qbRevision, freeze = FREEZE }) {
  return {
    qb_revision: qbRevision, model: freeze.model, profile: freeze.profile,
    l1_budget_ms: freeze.budgets.l1_total_ms, per_call_ms: freeze.budgets.per_call_ms,
    base_shas: freeze.base_shas, config: freeze.expected_config, ollama_host: new URL(freeze.ollama_url).host,
  };
}

function copyTree(src, dst) {
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name); const d = path.join(dst, e.name);
    if (e.isDirectory()) { fs.mkdirSync(d, { recursive: true }); copyTree(s, d); } else fs.copyFileSync(s, d);
  }
}
function filesOf(dir, rel = '') {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesOf(path.join(dir, e.name), path.posix.join(rel, e.name)) : [path.posix.join(rel, e.name)]));
}
/** Run the checks unchanged on base (+ a control overlay). Returns { CHK-n: { status, detail } }. */
function runChecks(itemDir, control, checks) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kan106-score-'));
  try {
    copyTree(path.join(itemDir, 'base'), dir);
    if (control !== 'base') copyTree(path.join(itemDir, 'controls', control), dir);
    const out = path.join(os.tmpdir(), `kan106-score-${process.pid}-${Date.now()}.json`);
    const r = proc.run(process.execPath, [RUNNER], { input: JSON.stringify({ root: dir, checks }),
      env: { ...process.env, QB_CHECK_RESULTS: out, QB_CHECK_TIMEOUT_MS: '5000' }, timeout: 120_000 });
    if (r.status !== 0) throw new Error(`check runner failed: ${r.stderr}`);
    const res = JSON.parse(fs.readFileSync(out, 'utf8')).results; fs.rmSync(out, { force: true });
    return Object.fromEntries(res.map((x) => [x.id, { status: x.status, detail: x.detail }]));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/** One run record, with every artifact verified against its manifest sha256 and every event line parsed. */
function loadRun(runDir) {
  const manifest = readEvidence(path.join(runDir, 'manifest.json'), 'manifest.json');
  const art = (name) => {
    const ref = manifest.artifacts && manifest.artifacts[name];
    if (!ref) return null;
    let buf;
    try { buf = fs.readFileSync(path.join(runDir, ref.path)); } catch { throw new EvidenceError(`artifact ${name}: file missing`); }
    if (sha256(buf) !== ref.sha256) throw new EvidenceError(`artifact ${name}: sha256 does not match the manifest`);
    try { return JSON.parse(buf.toString('utf8')); } catch { throw new EvidenceError(`artifact ${name}: not valid JSON`); }
  };
  let lines;
  try { lines = fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean); } catch { throw new EvidenceError('events.jsonl: missing'); }
  const events = lines.map((l, i) => { try { return JSON.parse(l); } catch { throw new EvidenceError(`events.jsonl: line ${i + 1} is not valid JSON`); } });
  const last = (type) => { const e = events.filter((x) => x.type === type).at(-1); return e ? e.data : null; };
  return { manifest, staged: art('contract-staged'), contract: art('contract'), timings: last('l1.timings'), usage: last('run.usage'), events };
}

/** The L1 decision a BLOCKED run recorded, from its outcome reason and the staged artifact. */
function l1Decision(manifest, staged) {
  const reason = String(manifest.outcome_reason || '');
  const kind = /^(needs_clarification|clarification_rounds_exhausted)$/.test(reason) || /does not ask clarification questions/.test(reason) ? 'clarification'
    : /^staged_l1_invalid: unsupported call shape /.test(reason) ? 'unsupported_call_shape'
      : /unsupported by the staged prototype:/.test(reason) ? 'unsupported_passage'
        : /^unsupported_request:/.test(reason) ? 'unsupported_request'
          : /needs a function or method call named in the request/.test(reason) ? 'no_call_named'
            : /facts were refused after one repair|^invalid_contract_after_repair/.test(reason) ? 'invalid_model_output'
              : /^staged_l1_invalid:/.test(reason) ? 'assembly_or_validation' : 'other';
  return { kind, reason, unsupported_targets: (staged && staged.unsupported_targets) || [] };
}
function isIntendedRefusal(spec, decision, modelCalls) {
  if (!spec || decision.kind !== spec.decision) return false;
  if (Number.isInteger(spec.max_model_calls) && modelCalls > spec.max_model_calls) return false;
  if (spec.decision === 'unsupported_call_shape') {
    return decision.unsupported_targets.some((t) => String(t.label || '').includes(spec.target) && String(t.reason || '').includes(spec.reason_includes));
  }
  return true;
}
function executionFailure(manifest, entry) {
  const reason = String(manifest.outcome_reason || '');
  if (entry.signal || manifest.outcome === 'RUNNING' || !(manifest.outcome in EXIT_FOR)) return { kind: 'crash', detail: entry.signal ? `killed by ${entry.signal}` : `outcome ${manifest.outcome}` };
  if (manifest.outcome === 'CANCELLED') return { kind: /deadline|budget .*exhausted|timed out/i.test(reason) ? 'timeout' : 'cancelled', detail: reason };
  if (manifest.outcome === 'ERROR') {
    const kind = /timed out|deadline/i.test(reason) ? 'timeout' : /ollama|fetch failed|ECONNREFUSED|ECONNRESET|socket|network|EAI_AGAIN/i.test(reason) ? 'model_or_transport' : 'crash';
    return { kind, detail: reason };
  }
  return null;
}

/** 10761 fix 3: every way this record could belong to another item, revision, model, budget or agent. */
function identityProblems(id, entry, run, expect, itemsRoot, failed) {
  const { manifest: m, staged, timings, usage } = run;
  const p = [];
  const eq = (what, got, want) => { if (got !== want) p.push(`${what}: ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`); };
  eq('run id', m.run_id, entry.run_id);
  eq('QB revision', m.qb_revision, expect.qb_revision);
  if (m.request !== requestOf(id, itemsRoot)) p.push('request: the recorded request is not this item\'s frozen request.txt');
  eq('base SHA', m.repo && m.repo.base_sha, expect.base_shas[id]);
  eq('configured model', m.models && m.models.intent, expect.model);
  eq('agent', m.agent && m.agent.type, 'dry-run');
  for (const [k, v] of Object.entries(expect.config)) eq(`flag ${k}`, m.config && m.config[k], v);
  for (const f of (staged && staged.facts) || []) for (const a of f.attempts || []) if (a.model !== undefined && a.model !== expect.model) p.push(`reply model: ${f.requirement_id} answered by ${JSON.stringify(a.model)}`);
  const hosts = usage && usage.model && usage.model.endpoints ? Object.keys(usage.model.endpoints) : [];
  for (const h of hosts) if (h !== expect.ollama_host) p.push(`endpoint: a model call went to ${h}, not ${expect.ollama_host}`);
  if (!Number.isInteger(entry.exit_code) && !entry.signal) p.push('exit code: not recorded');
  else if (!entry.signal && m.outcome in EXIT_FOR && entry.exit_code !== EXIT_FOR[m.outcome]) p.push(`exit code ${entry.exit_code} does not match outcome ${m.outcome}`);
  if (timings) {
    const b = timings.l1_budget || {};
    eq('effective L1 budget', b.ms, expect.l1_budget_ms);
    eq('L1 budget source', b.source, '--l1-budget');
    eq('L1 per-call cap', b.per_call_ms, expect.per_call_ms);
    eq('L1 profile', b.profile, expect.profile);
    eq('L1 budget enforced', b.enforced, true);
  } else if (!failed) p.push('l1.timings: missing (the effective L1 budget cannot be verified)');
  return p;
}

/** One frozen item: load, verify, classify, then (for a checklist) run its checks unchanged. */
function scoreItem(id, entry, { runsRoot, itemsRoot = ITEMS, expect }) {
  const itemDir = path.join(itemsRoot, id);
  const item = readJson(path.join(itemDir, 'item.json'));
  const s = { id, category: item.category, expected: item.expected, run_id: (entry && entry.run_id) || null,
    exit_code: entry ? entry.exit_code : null, signal: (entry && entry.signal) || null, result: null, problems: [], semantic: null };
  if (!entry) { s.result = 'invalid_record'; s.problems.push('no batch entry: the item has no recorded launch'); return s; }
  if (!entry.run_id) { s.result = 'invalid_record'; s.problems.push('no run id was recorded (see the item log)'); return s; }
  let run;
  try { run = loadRun(path.join(runsRoot, entry.run_id)); } catch (e) {
    if (!(e instanceof EvidenceError)) throw e;
    s.result = 'invalid_record'; s.problems.push(e.message); return s;
  }
  const { manifest, staged, contract, timings } = run;
  const facts = (staged && staged.facts) || [];
  Object.assign(s, {
    qb_revision: manifest.qb_revision, outcome: manifest.outcome, outcome_reason: manifest.outcome_reason || null,
    model: { configured: manifest.models && manifest.models.intent, replies: [...new Set(facts.flatMap((f) => (f.attempts || []).map((a) => a.model)))] },
    l1_ms: timings ? timings.l1_ms : null, calls: timings && Array.isArray(timings.calls) ? timings.calls.map((c) => ({ requirement_id: c.requirement_id, ms: c.ms, outcome: c.outcome })) : [],
    model_calls: facts.reduce((n, f) => n + (f.attempts || []).length, 0),
    repairs: facts.reduce((n, f) => n + Math.max(0, (f.attempts || []).length - 1), 0),
    agent_launched: Array.isArray(manifest.attempts) && manifest.attempts.length > 0,
    latency: null,
  });
  if (s.l1_ms !== null) s.latency = { within_item_target: s.l1_ms <= LIMITS.per_item_l1_ms, within_budget: s.l1_ms <= LIMITS.budget_l1_ms };
  const failure = executionFailure(manifest, entry);
  s.problems = identityProblems(id, entry, run, expect, itemsRoot, Boolean(failure));
  if (s.problems.length) { s.result = 'invalid_record'; return s; }
  if (failure) { s.result = 'execution_failed'; s.failure = failure; return s; }

  const finalized = Boolean(contract) && contractState(contract).state === 'finalized';
  s.structural = finalized ? 'finalized' : 'not_finalized';
  if (manifest.outcome === 'DRY_RUN' && !finalized) { s.result = 'invalid_record'; s.problems.push('outcome DRY_RUN without a finalized contract artifact'); return s; }

  if (item.expected === 'refuse') {
    if (finalized || manifest.outcome !== 'BLOCKED') { s.result = 'not_refused'; return s; }
    s.decision = l1Decision(manifest, staged);
    s.result = !s.agent_launched && isIntendedRefusal(item.refusal_evidence, s.decision, s.model_calls) ? 'intended_refusal' : 'blocked_other_reason';
    return s;
  }
  if (!finalized) { s.result = 'no_checklist'; s.decision = l1Decision(manifest, staged); return s; }
  s.result = 'checklist';

  const checks = contract.checks || [];
  const controls = ['base', ...filesOf(path.join(itemDir, 'controls')).map((f) => f.split('/')[0]).filter((v, i, a) => a.indexOf(v) === i)];
  const scopeOnly = new Set(Object.keys(item.scope_controls || {}));
  s.checks = checks.map((k) => ({ id: k.id, ac_id: k.ac_id, adapter: k.adapter, step: k.params && k.params.steps ? k.params.steps[0] : k.params }));
  s.controls = {};
  for (const c of controls) {
    const r = runChecks(itemDir, c, checks);
    s.controls[c] = { results: r, all_checks_pass: checks.every((k) => r[k.id] && r[k.id].status === 'pass') };
  }
  s.correct_passes_all = s.controls.correct ? s.controls.correct.all_checks_pass : null;
  s.base_distinguished = !s.controls.base.all_checks_pass;
  s.incorrect_acceptance = controls.filter((c) => c.startsWith('wrong-') && !scopeOnly.has(c) && s.controls[c].all_checks_pass);

  const allowed = (contract.scope && contract.scope.allowed_changes) || [];
  const prot = (contract.scope && contract.scope.protected_paths) || [];
  s.scope = {
    allowed_changes: allowed, protected_paths: prot,
    missing_allow: item.scope.must_allow.filter((f) => !matchesAny(f, allowed)),
    missing_protect: item.scope.must_protect.filter((f) => !matchesAny(f, prot)),
    scope_controls: Object.fromEntries([...scopeOnly].map((c) => {
      const changed = filesOf(path.join(itemDir, 'controls', c));
      const blocked = changed.filter((f) => matchesAny(f, prot));
      return [c, { changed, refused_by_protected_paths: blocked.length > 0, blocked }];
    })),
  };
  const withCheck = new Set(checks.map((k) => k.ac_id));
  s.unresolved = (contract.acceptance_criteria || []).filter((a) => !withCheck.has(a.id)).map((a) => ({ id: a.id, criterion: a.criterion }));
  s.requirements = item.requirements.map((r) => ({ ...r, represented: null }));   // a person reviews each against the FULL request
  s.mechanical_pass = s.correct_passes_all && s.base_distinguished && s.incorrect_acceptance.length === 0
    && s.scope.missing_allow.length === 0 && s.scope.missing_protect.length === 0
    && Object.values(s.scope.scope_controls).every((x) => x.refused_by_protected_paths);
  return s;
}

const count = (rows, result) => rows.filter((x) => x.result === result).length;
function summarize(rows) {
  const sup = rows.filter((x) => x.expected === 'finalize');
  const ref = rows.filter((x) => x.expected === 'refuse');
  const timed = sup.filter((x) => Number.isFinite(x.l1_ms));
  const times = timed.map((x) => x.l1_ms).sort((a, b) => a - b);
  const median = times.length ? (times.length % 2 ? times[(times.length - 1) / 2] : (times[times.length / 2 - 1] + times[times.length / 2]) / 2) : null;
  return {
    supported: {
      total: sup.length,
      by_result: Object.fromEntries(['checklist', 'no_checklist', 'execution_failed', 'invalid_record'].map((r) => [r, count(sup, r)])),
      mechanical_pass: sup.filter((x) => x.mechanical_pass).length,
      semantic_correct: 'pending human review against the full original request (rubric.md)',
      incorrect_control_acceptance: sup.flatMap((x) => (x.incorrect_acceptance || []).map((c) => `${x.id}:${c}`)),
      protected_scope_weakened: sup.filter((x) => x.scope && (x.scope.missing_protect.length || !Object.values(x.scope.scope_controls).every((y) => y.refused_by_protected_paths))).map((x) => x.id),
    },
    unsupported: {
      total: ref.length,
      intended_refusals: count(ref, 'intended_refusal'),
      blocked_other_reason: count(ref, 'blocked_other_reason'),
      not_refused: count(ref, 'not_refused'),
      execution_failed: count(ref, 'execution_failed'),
      invalid_record: count(ref, 'invalid_record'),
      note: '"blocked_other_reason" means execution was safely blocked, NOT that the intended refusal succeeded',
    },
    latency: {
      timings_expected: sup.length, timings_available: timed.length, complete_coverage: timed.length === sup.length,
      missing: sup.filter((x) => !Number.isFinite(x.l1_ms)).map((x) => x.id),
      median_l1_ms: median, median_of: `${timed.length} of ${sup.length} supported items`, median_target_ms: LIMITS.median_l1_ms,
      over_item_target: timed.filter((x) => x.l1_ms > LIMITS.per_item_l1_ms).map((x) => x.id),
    },
    note: 'Latency is reported separately from correctness. A safe refusal on a supported item is not semantic success; refusals of the unsupported items are counted separately, never in a combined percentage.',
  };
}

/** The batch's recorded settings must be the frozen ones. */
function settingsProblems(settings, freeze = FREEZE) {
  const p = [];
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  for (const [k, want] of Object.entries({ model: freeze.model, model_digest: freeze.model_digest, ollama_url: freeze.ollama_url, flags: freeze.flags, profile: freeze.profile })) {
    if (!same(settings[k], want)) p.push(`batch setting ${k}: ${JSON.stringify(settings[k])}, frozen ${JSON.stringify(want)}`);
  }
  return p;
}

/** All eight frozen rows. A corrupt item never stops the others from being reported. */
function scoreBatch({ runs, runsRoot, qbRevision, itemsRoot = ITEMS, roster = FREEZE.order, batchSettings = null, batchProblems = [] }) {
  const expect = expectFrom({ qbRevision });
  const problems = [...batchProblems, ...(batchSettings ? settingsProblems(batchSettings) : [])];
  const items = roster.map((id) => {
    let s;
    try { s = scoreItem(id, runs ? runs[id] : undefined, { runsRoot, itemsRoot, expect }); } catch (e) {
      const item = readJson(path.join(itemsRoot, id, 'item.json'));
      s = { id, category: item.category, expected: item.expected, run_id: runs && runs[id] ? runs[id].run_id : null, result: 'invalid_record', problems: [`scorer error: ${e.message}`], semantic: null };
    }
    if (problems.length && s.result !== 'invalid_record') { s.result_before_batch_check = s.result; s.result = 'invalid_record'; s.problems = [...s.problems, ...problems]; }
    return s;
  });
  return { _label: 'KAN-106 eight-request evaluation v1: mechanical scores (semantic review pending)', limits: LIMITS, batch_problems: problems, summary: summarize(items), items };
}

/** What batch.js wrote under OUT. */
function scoreBatchDir(out) {
  const problems = [];
  let batch = null; let runs = null;
  try { batch = readEvidence(path.join(out, 'batch.json'), 'batch.json'); } catch (e) { problems.push(e.message); }
  try { runs = readEvidence(path.join(out, 'runs.json'), 'runs.json'); } catch (e) { problems.push(e.message); }
  if (batch) {
    if (batch.refused) problems.push(`the batch refused to start: ${batch.reason}`);
    if (!/^[0-9a-f]{40}$/.test(String(batch.qb_revision))) problems.push('batch.json: no pinned QB revision');
    if (!batch.model_after || batch.model_after.digest_matches !== true) problems.push('the model digest after the batch was not confirmed unchanged');
  }
  return scoreBatch({ runs, runsRoot: path.join(out, 'runs'), qbRevision: batch && batch.qb_revision, batchSettings: (batch && batch.settings) || {}, batchProblems: problems });
}

if (require.main === module) {
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
  const dir = arg('--batch-dir');
  if (!dir) { console.error('usage: node bench/kan106-eval-v1/score.js --batch-dir OUT [--out FILE]'); process.exit(2); }
  const text = JSON.stringify(scoreBatchDir(dir), null, 2) + '\n';
  const f = arg('--out'); if (f) fs.writeFileSync(f, text); else process.stdout.write(text);
}
module.exports = { scoreItem, scoreBatch, scoreBatchDir, summarize, loadRun, l1Decision, expectFrom, requestOf, settingsProblems, LIMITS, ITEMS };
