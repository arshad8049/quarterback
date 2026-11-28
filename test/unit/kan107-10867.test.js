/**
 * KAN-107 senior ruling 10867.
 *
 *   1. Approval binds every grounding field that affects validation, target selection or executable checks, with
 *      a tamper test per field. Excerpt ranges and default.ctor_stores stay OUT of the binding only while they are
 *      not authoritative inputs to those decisions: the tests below show that changing them changes no decision,
 *      and a tripwire fails if new code starts reading them (then the binding and its tamper tests must change in
 *      the same commit). They are provenance, not authenticated by approval.
 *   2. --agent manual fails closed when the repository changed so that the stored grounding is stale, with a clear
 *      regenerate / review / approve-again path. "Manual" is not permission to reuse an approval against a
 *      different source.
 *   3. The grounding is checked against the approved STARTING state, before the agent runs; it is never recomputed
 *      after the run's candidate edits, so those edits are never reported as pre-run drift.
 *
 * OFFLINE: no model is reachable; every contract is hand-written (test/fixtures/kan107/build.js). No Docker: the
 * sandbox is replaced through the runPipeline test seam.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { makeRepo } = require('../helpers/tmprepo');
const { draft, method } = require('../fixtures/kan107/build');

process.env.QB_OLLAMA_URL = 'http://127.0.0.1:9';
const { contractFromObject } = require('../../intent/compiler');
const { contractState, contractHash, approve, approvalState } = require('../../intent/contract-state');
const { groundApi, contractGrounding, groundingIdentity } = require('../../intent/api-grounding');
const { checkGrounding } = require('../../intent/grounding-binding');
const { exampleMapping } = require('../../intent/request-examples');
const { executionGate } = require('../../agent/runner');
const { proposalForReview } = require('../../intent/contract-file');

const ROOT = path.join(__dirname, '..', '..');
const QB = path.join(ROOT, 'qb.js');
const AGENT_CLI = path.join(ROOT, 'agent', 'cli.js');
const PRELOAD = path.join(__dirname, '..', 'helpers', 'preload-ollama.js');

const FORMATTER = "'use strict'\n\nmodule.exports = class Formatter {\n  constructor (options) {\n    this.separator = (options && options.separator) || ','\n  }\n\n  join (list) {\n    if (list.length === 0) return undefined\n    return list.join(this.separator)\n  }\n}\n";
// the constructor now stores a dependency that join dereferences: ctor_args is required_or_unknown (invalid contract)
const FORMATTER_DRIFT = "'use strict'\n\nmodule.exports = class Formatter {\n  constructor (db) {\n    this.db = db\n  }\n\n  join (list) {\n    if (list.length === 0) return this.db.empty()\n    return list.join(',')\n  }\n}\n";
// the candidate edit a run makes (the task itself): join([]) now returns ""
const FORMATTER_FIXED = FORMATTER.replace('return undefined', "return ''");
const FMT = 'In lib/formatter.js, make Formatter.join([]) return "". Keep Formatter.join(["a", "b"]) returning "a,b".';
const RAW = () => draft(FMT, [
  { criterion: 'Formatter.join([]) returns "".', passages: ['P2'], check: method('lib/formatter.js', 'join', [[[[]], '']]) },
  { criterion: 'Formatter.join(["a", "b"]) still returns "a,b".', passages: ['P3'], check: method('lib/formatter.js', 'join', [[[['a', 'b']], 'a,b']]) }], { allowed: ['lib/formatter.js'] });

const repoWith = (src = FORMATTER) => makeRepo({ 'package.json': '{"name":"k10867","type":"commonjs"}', 'lib/formatter.js': src });
const groundingOf = (dir) => contractGrounding(groundApi(dir, FMT));
function produced(dir) { const c = contractFromObject(RAW(), FMT); c.api_grounding = groundingOf(dir); return c; }
const clone = (x) => JSON.parse(JSON.stringify(x));
/** Every decision QB makes from a contract: validity (state AND errors), the example->target mapping, the gate. */
const decisions = (c) => ({ state: contractState(c), mapping: exampleMapping(c), gate: executionGate(c, { agent: 'manual' }), checks: c.checks });

// ── 1. the field audit ──────────────────────────────────────────────────────────────────────────────────────────

/** Every field of a recorded grounding, and whether approval binds it. A new field fails the first test below. */
const BOUND = {
  schema: (g) => { g.schema = 'qb-api-grounding/999'; },
  'module.path': (g) => { g.modules[0].path = 'lib/other.js'; },
  'module.sha256': (g) => { g.modules[0].sha256 = '0'.repeat(64); },
  'module.bytes': (g) => { g.modules[0].bytes += 1; },
  'module.status': (g) => { g.modules[0].status = 'unknown'; },
  'module.reason': (g) => { g.modules[0].reason = 'edited'; },
  'module.format': (g) => { g.modules[0].format = 'esm'; },
  'module.named[].name': (g) => { g.modules[0].named.push({ name: 'join', kind: 'function' }); },
  'module.named[].kind': (g) => { g.modules[0].named = [{ name: 'x', kind: 'function' }]; g.modules[0].named[0].kind = 'value'; },
  'module.default.kind': (g) => { g.modules[0].default.kind = 'function'; },
  'module.default.name': (g) => { g.modules[0].default.name = 'Other'; },
  'module.default.form': (g) => { g.modules[0].default.form = 'export default class Formatter'; },
  'module.default.methods': (g) => { g.modules[0].default.methods.push('other'); },
  'module.default.accessors': (g) => { g.modules[0].default.accessors.push('size'); },
  'module.default.statics': (g) => { g.modules[0].default.statics.push({ name: 'make', kind: 'function' }); },
  'module.default.ctor_args': (g) => { g.modules[0].default.ctor_args = 'none'; },
  'a module removed': (g) => { g.modules = []; },
};
const PROVENANCE = {
  'module.excerpts[].start_line': (g) => { for (const b of g.modules[0].excerpts) b.start_line += 1; },
  'module.excerpts[].end_line': (g) => { for (const b of g.modules[0].excerpts) b.end_line += 5; },
  'module.excerpts[].block_end_line': (g) => { for (const b of g.modules[0].excerpts) b.block_end_line += 5; },
  'module.excerpts[].truncated': (g) => { for (const b of g.modules[0].excerpts) b.truncated = !b.truncated; },
  'module.excerpts[].symbol / kind': (g) => { for (const b of g.modules[0].excerpts) { b.symbol = 'x'; b.kind = 'definition'; } },
  'module.excerpts[].source': (g) => { for (const b of g.modules[0].excerpts) b.source = 'elsewhere'; },
  'module.excerpts (all removed)': (g) => { g.modules[0].excerpts = []; },
  'module.excerpts (a forged constructor block)': (g) => { g.modules[0].excerpts.push({ symbol: 'constructor', kind: 'constructor', start_line: 1, end_line: 1, truncated: false, block_end_line: 1, source: 'working tree' }); },
  'module.default.ctor_stores (marked safe)': (g) => { g.modules[0].default.ctor_stores = (g.modules[0].default.ctor_stores || []).map((s) => ({ ...s, dereferenced: false })); },
  'module.default.ctor_stores (marked dereferenced)': (g) => { g.modules[0].default.ctor_stores = [{ param: 'options', field: 'separator', dereferenced: true }]; },
  'module.default.ctor_stores (removed)': (g) => { delete g.modules[0].default.ctor_stores; },
};

describe('10867 (1) every grounding field is either bound or shown not to decide anything', () => {
  test('the audit covers every field groundApi records (a new field must be classified here)', () => {
    const repo = repoWith();
    try {
      const g = groundingOf(repo.dir);
      const m = g.modules[0];
      assert.deepEqual(Object.keys(g).sort(), ['modules', 'schema']);
      assert.deepEqual(Object.keys(m).sort(), ['bytes', 'default', 'excerpts', 'format', 'named', 'path', 'sha256', 'status']);   // `reason` appears on unknown modules
      assert.deepEqual(Object.keys(m.default).sort(), ['accessors', 'ctor_args', 'ctor_stores', 'form', 'kind', 'methods', 'name', 'statics']);
      assert.deepEqual(Object.keys(m.excerpts[0]).sort(), ['block_end_line', 'end_line', 'kind', 'source', 'start_line', 'symbol', 'truncated']);
      // the canonical binding holds exactly the bound fields, and none of the provenance ones
      const id = groundingIdentity(g);
      assert.deepEqual(Object.keys(id.modules[0]).sort(), ['bytes', 'default', 'format', 'named', 'path', 'reason', 'sha256', 'status']);
      assert.deepEqual(Object.keys(id.modules[0].default).sort(), ['accessors', 'ctor_args', 'form', 'kind', 'methods', 'name', 'statics']);
    } finally { repo.cleanup(); }
  });

  for (const [field, edit] of Object.entries(BOUND)) {
    test(`tamper (bound): ${field} edited after approval voids the approval, and the recomputation refuses it`, () => {
      const repo = repoWith();
      try {
        const c = approve(produced(repo.dir), { via: 'test' });
        assert.equal(approvalState(c).approved, true);
        const t = clone(c); edit(t.api_grounding);
        assert.equal(approvalState(t).reason, 'changed_after_approval', field);
        const r = checkGrounding(t, repo.dir);
        assert.equal(r.ok, false, `${field}: a carried grounding that differs from the repository is refused`);
      } finally { repo.cleanup(); }
    });
  }

  // Non-authoritative: on a VALID contract and on an INVALID one (the constructor that cannot be cleared), changing
  // excerpts or ctor_stores changes no validation, no target, no gate and no executable check. They are not bound,
  // so they keep the approval, and that is safe only because they decide nothing.
  for (const [field, edit] of Object.entries(PROVENANCE)) {
    test(`provenance (not authenticated by approval): ${field} changes no validation, target or check decision`, () => {
      for (const src of [FORMATTER, FORMATTER_DRIFT]) {
        const repo = repoWith(src);
        try {
          const c = approve(produced(repo.dir), { via: 'test' });
          const before = decisions(c);
          assert.equal(before.state.state, src === FORMATTER ? 'finalized' : 'invalid');
          const t = clone(c); edit(t.api_grounding);
          assert.deepEqual(decisions(t), before, `${field} on ${src === FORMATTER ? 'the valid' : 'the invalid'} contract`);
          assert.equal(contractHash(t), contractHash(c), 'not in the approval binding');
          const r = checkGrounding(t, repo.dir);
          assert.equal(r.ok, true, 'the recomputation compares the bound identity only');
          assert.deepEqual(decisions(r.contract), before);
        } finally { repo.cleanup(); }
      }
    });
  }

  test('tripwire: only the producer reads excerpts or ctor_stores; no validator, target or check code does', () => {
    // If this fails, new code reads a provenance field. Then it is no longer provenance: add it to
    // groundingIdentity (intent/api-grounding.js) and give it a tamper test above, in the same change.
    const files = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else if (e.name.endsWith('.js')) files.push(path.relative(ROOT, p));
    } };
    for (const d of ['intent', 'agent', 'verify', 'lib', 'context', 'bench', 'run', 'memory']) if (fs.existsSync(path.join(ROOT, d))) walk(path.join(ROOT, d));
    files.push('qb.js');
    // code only: comments may name the fields (to document them as provenance)
    const code = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
    const readers = (re) => files.filter((f) => re.test(code(f))).sort();
    assert.deepEqual(readers(/\bctor_stores\b/), ['intent/api-grounding.js', 'intent/ctor-args.js']);
    assert.deepEqual(readers(/\.excerpts\b|\bstart_line\b|\bblock_end_line\b/), ['intent/api-grounding.js', 'intent/ctor-args.js']);
    // ctor-args reads them only when groundApi calls it, on blocks it has just read from the working tree
    assert.deepEqual(readers(/require\(['"]\.\/ctor-args['"]\)|require\(['"][./]*intent\/ctor-args['"]\)/), ['intent/api-grounding.js']);
    // no executable-check code (verify/, the sandbox, the runner) reads the grounding at all
    assert.deepEqual(readers(/api_grounding/).filter((f) => /^(verify|lib)\//.test(f) || f === 'agent/runner.js' || f === 'agent/orchestrator.js'), []);
  });
});

// ── 2. --agent manual fails closed on stale grounding ───────────────────────────────────────────────────────────

function qb(repo, file, agent) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'k10867-qb-'));
  try {
    const r = spawnSync(process.execPath, ['--require', PRELOAD, QB, FMT, '--repo', repo.dir, '--agent', agent, '--no-llm-context', '--no-llm-verify', '--contract-file', file],
      { encoding: 'utf8', timeout: 90_000, env: { ...process.env, QB_RUNS_DIR: path.join(tmp, 'runs'), QB_MEMORY_DIR: path.join(tmp, 'mem'), QB_OLLAMA_URL: 'http://127.0.0.1:9', QB_TEST_FETCH_LOG: path.join(tmp, 'fetch.log') } });
    const runs = fs.existsSync(path.join(tmp, 'runs')) ? fs.readdirSync(path.join(tmp, 'runs')) : [];
    const manifest = runs.length ? JSON.parse(fs.readFileSync(path.join(tmp, 'runs', runs[0], 'manifest.json'), 'utf8')) : null;
    return { ...r, out: r.stdout + r.stderr, manifest };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
function agentCli(repo, contract, extra = []) {
  const file = path.join(repo.dir, '..', `k10867-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(contract));
  try {
    const r = spawnSync(process.execPath, [AGENT_CLI, '--contract', file, '--repo', repo.dir, ...extra], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, QB_OLLAMA_URL: 'http://127.0.0.1:9' } });
    return { ...r, out: r.stdout + r.stderr };
  } finally { fs.rmSync(file, { force: true }); }
}
/** The path out: regenerate from the current repository, review, approve again. */
function assertReapprovePath(out) {
  assert.match(out, /regenerate/i, out);
  assert.match(out, /without --contract-file/, out);
  assert.match(out, /proposed-contract\.json/, out);
  assert.match(out, /review/i, out);
  assert.match(out, /approve it again/, out);
  assert.match(out, /not reused/, out);
}

describe('10867 (2) --agent manual: a stale stored grounding fails closed, with a regenerate/review/approve-again path', () => {
  test('qb --agent manual --contract-file: unchanged repository runs (control)', () => {
    const repo = repoWith();
    const file = path.join(repo.dir, '..', `k10867-${process.pid}-ctl.json`);
    try {
      fs.writeFileSync(file, JSON.stringify(proposalForReview(produced(repo.dir))));
      const r = qb(repo, file, 'manual');
      assert.notEqual(r.manifest.outcome, 'BLOCKED', r.out);
      assert.match(r.out, /Oracle approved \(contract-file\)/);
    } finally { fs.rmSync(file, { force: true }); repo.cleanup(); }
  });
  test('qb --agent manual --contract-file: the repository changed since review -> BLOCKED before approval, no briefing, the path out is stated', () => {
    const repo = repoWith();
    const file = path.join(repo.dir, '..', `k10867-${process.pid}-m.json`);
    try {
      fs.writeFileSync(file, JSON.stringify(proposalForReview(produced(repo.dir))));
      fs.writeFileSync(path.join(repo.dir, 'lib/formatter.js'), FORMATTER_DRIFT);
      const r = qb(repo, file, 'manual');
      assert.equal(r.status, 2, r.out);
      assert.equal(r.manifest.outcome, 'BLOCKED');
      assert.match(r.manifest.reason || JSON.stringify(r.manifest), /grounding_mismatch: lib\/formatter\.js/);
      assert.doesNotMatch(r.out, /Oracle approved|AGENT BRIEFING|L3 Agent/, 'nothing approved, nothing briefed');
      assertReapprovePath(r.out);
    } finally { fs.rmSync(file, { force: true }); repo.cleanup(); }
  });
  test('qb-agent --agent manual: a stored approved contract whose repository changed is refused, even with --approve-contract; the path out is stated', () => {
    const repo = repoWith();
    try {
      const c = approve(produced(repo.dir), { via: 'test' });
      fs.writeFileSync(path.join(repo.dir, 'lib/formatter.js'), FORMATTER_DRIFT);
      for (const extra of [[], ['--approve-contract']]) {
        const r = agentCli(repo, c, ['--agent', 'manual', ...extra]);
        assert.equal(r.status, 2, r.out);
        assert.doesNotMatch(r.out, /AGENT BRIEFING|LAYER 3/, 'no briefing printed');
        assert.match(r.out, /lib\/formatter\.js/);
        assertReapprovePath(r.out);
      }
    } finally { repo.cleanup(); }
  });
  test('qb-agent --agent manual: the untampered stored contract on the unchanged repository runs (control)', () => {
    const repo = repoWith();
    try {
      const r = agentCli(repo, produced(repo.dir), ['--agent', 'manual', '--approve-contract']);
      assert.equal(r.status, 0, r.out);
      assert.match(r.out, /AGENT BRIEFING/);
    } finally { repo.cleanup(); }
  });
});

// ── 3. the approved starting state, not the resulting patch ─────────────────────────────────────────────────────

describe('10867 (3) the grounding is checked against the approved starting state, never after the candidate edits', () => {
  test('a run whose agent edits the target file in place is not refused as drift; verification sees the approved grounding', async () => {
    const { runPipeline } = require('../../lib/qb-pipeline');
    const repo = repoWith();
    try {
      const c = approve(produced(repo.dir), { via: 'test' });
      assert.equal(checkGrounding(c, repo.dir).ok, true, 'the starting state matches the approval');
      const approved = { hash: contractHash(c), grounding: clone(c.api_grounding) };
      const seen = [];
      const run = { event() {}, startAttempt() {}, finishAttempt() {}, artifact() {}, manifest: { run_id: 't', attempts: [] } };
      // worst case for the rule: the candidate edit lands in the host working tree (as a manual agent's would)
      const runSandboxed = async () => {
        fs.writeFileSync(path.join(repo.dir, 'lib/formatter.js'), FORMATTER_FIXED);
        return { status: 'completed', diff: '--- a/lib/formatter.js\n+++ b/lib/formatter.js\n', changes: [{ file: 'lib/formatter.js', status: 'M', additions: 1, deletions: 1 }] };
      };
      const r = await runPipeline({
        contract: c, repoPath: repo.dir, agent: 'claude-code', maxRetries: 1, run, memory: null, noLlmContext: true, noLlmVerify: true, runSandboxed,
        deps: { verify: async (contract) => { seen.push({ hash: contractHash(contract), grounding: clone(contract.api_grounding), approved: approvalState(contract).approved });
          return { verdict: 'pass', criteria_results: [], repair_hints: [], failures: [] }; } },
      });
      assert.equal(r.blocked, undefined, 'the run is not blocked');
      assert.equal(r.execution.status, 'completed');
      assert.deepEqual(seen, [{ hash: approved.hash, grounding: approved.grounding, approved: true }], 'verification judged the approved contract, grounding as approved');
      // the candidate edit is visible to a recomputation, so a recompute here WOULD have called it drift
      assert.equal(checkGrounding(c, repo.dir).ok, false, 'the edit changed the grounding');
    } finally { repo.cleanup(); }
  });
  test('the only grounding checks run before the pipeline starts; nothing after the agent recomputes it', () => {
    const src = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
    const qbSrc = src('qb.js');
    const last = qbSrc.lastIndexOf('checkGrounding(');
    assert.ok(last > 0 && last < qbSrc.indexOf('await runPipeline('), 'qb.js: every checkGrounding precedes runPipeline');
    const cli = src('agent/cli.js');
    assert.ok(cli.indexOf('checkGrounding(') < cli.indexOf('await orchestrate('), 'agent CLI: before orchestrate');
    for (const f of ['lib/qb-pipeline.js', 'agent/orchestrator.js', 'agent/runner.js', 'verify/verifier.js', 'context/builder.js']) {
      assert.doesNotMatch(src(f), /grounding-binding|checkGrounding|groundApi/, `${f} never recomputes the grounding`);
    }
  });
});
