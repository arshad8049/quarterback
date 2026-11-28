/**
 * KAN-107 senior 10847 (a)/(b): api_grounding is not mutable, unhashed, authoritative input.
 *
 * Chosen: BIND + RECOMPUTE.
 *   - bind:      the validator-relevant contents of api_grounding and the source identity (path, sha256, bytes) are
 *                part of the approved content (contractHash) when the field is present; absent -> not hashed, so
 *                contracts and approvals made before KAN-107 keep their hash (pinned below) and are never migrated.
 *   - recompute: before an approval or execution decision on a contract that came from outside this process
 *                (--contract-file, a stored contract given to the agent CLI, any contract right before qb runs the
 *                pipeline), QB recomputes the grounding from the target repository. A carried grounding that differs
 *                (edited, caller-authored, or the repository changed since it was recorded) is refused; it is never
 *                taken as proof and never silently replaced on an approved contract.
 * OFFLINE: no model is reachable; every contract is hand-written (test/fixtures/kan107/build.js).
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
const { groundApi, contractGrounding } = require('../../intent/api-grounding');
const binding = () => require('../../intent/grounding-binding');

const ROOT = path.join(__dirname, '..', '..');
const QB = path.join(ROOT, 'qb.js');
const AGENT_CLI = path.join(ROOT, 'agent', 'cli.js');
const PRELOAD = path.join(__dirname, '..', 'helpers', 'preload-ollama.js');
const K104 = path.join(__dirname, '..', 'fixtures', 'kan104');

const FORMATTER = "'use strict'\n\nmodule.exports = class Formatter {\n  constructor (options) {\n    this.separator = (options && options.separator) || ','\n  }\n\n  join (list) {\n    if (list.length === 0) return undefined\n    return list.join(this.separator)\n  }\n}\n";
// the same class, now needing a dependency it dereferences: ctor_args becomes required_or_unknown
const FORMATTER_DRIFT = "'use strict'\n\nmodule.exports = class Formatter {\n  constructor (db) {\n    this.db = db\n  }\n\n  join (list) {\n    if (list.length === 0) return this.db.empty()\n    return list.join(',')\n  }\n}\n";
const FMT = 'In lib/formatter.js, make Formatter.join([]) return "". Keep Formatter.join(["a", "b"]) returning "a,b".';
const RAW = () => draft(FMT, [
  { criterion: 'Formatter.join([]) returns "".', passages: ['P2'], check: method('lib/formatter.js', 'join', [[[[]], '']]) },
  { criterion: 'Formatter.join(["a", "b"]) still returns "a,b".', passages: ['P3'], check: method('lib/formatter.js', 'join', [[[['a', 'b']], 'a,b']]) }], { allowed: ['lib/formatter.js'] });

const repoWith = (src = FORMATTER) => makeRepo({ 'package.json': '{"name":"k107g","type":"commonjs"}', 'lib/formatter.js': src });
const groundingOf = (dir, request = FMT) => contractGrounding(groundApi(dir, request));
/** A contract as the default producer returns it: normalized, QB's grounding attached. */
function produced(dir) { const c = contractFromObject(RAW(), FMT); c.api_grounding = groundingOf(dir); return c; }
const clone = (x) => JSON.parse(JSON.stringify(x));

describe('(a) bind: validator-relevant grounding is part of the approved content', () => {
  test('a contract without api_grounding keeps its pre-KAN-107 hash (pinned at main ff3585c/59abda9): nothing is migrated', () => {
    const R = fs.readFileSync(path.join(K104, 'request.txt'), 'utf8').trim();
    const c = contractFromObject(JSON.parse(fs.readFileSync(path.join(K104, 'faithful-draft.json'), 'utf8')), R);
    assert.equal(c.api_grounding, undefined);
    assert.equal(contractHash(c), '706bf33c843ec38d7375fc8ec2160b338f4d18292ae7d053dcf391880bcddfcd');
  });
  test('editing the grounding of an APPROVED contract voids the approval (ctor_args, methods, kind, status, sha256, a removed module, the whole field)', () => {
    const repo = repoWith();
    try {
      const c = approve(produced(repo.dir), { via: 'test' });
      assert.equal(contractState(c).state, 'finalized');
      assert.equal(approvalState(c).approved, true);
      const edits = {
        ctor_args: (g) => { g.modules[0].default.ctor_args = 'none'; },
        methods: (g) => { g.modules[0].default.methods.push('other'); },
        kind: (g) => { g.modules[0].default.kind = 'function'; },
        status: (g) => { g.modules[0].status = 'unknown'; },
        sha256: (g) => { g.modules[0].sha256 = '0'.repeat(64); },
        named: (g) => { g.modules[0].named.push({ name: 'join', kind: 'function' }); },
        'module removed': (g) => { g.modules = []; },
      };
      for (const [what, edit] of Object.entries(edits)) {
        const t = clone(c); edit(t.api_grounding);
        assert.equal(approvalState(t).reason, 'changed_after_approval', what);
      }
      const gone = clone(c); delete gone.api_grounding;
      assert.equal(approvalState(gone).reason, 'changed_after_approval', 'removing the field');
    } finally { repo.cleanup(); }
  });
  test('excerpt line ranges are provenance, not validator input: not bound (documented), and they cannot change validity', () => {
    const repo = repoWith();
    try {
      const c = approve(produced(repo.dir), { via: 'test' });
      const t = clone(c);
      for (const b of t.api_grounding.modules[0].excerpts || []) b.start_line += 1;
      assert.equal(approvalState(t).approved, true);
      assert.equal(contractState(t).state, 'finalized');
    } finally { repo.cleanup(); }
  });
});

describe('(a) recompute: the grounding is checked against the repository before an approval or execution decision', () => {
  test('unchanged repository: the carried grounding matches; the contract is returned unchanged', () => {
    const repo = repoWith();
    try {
      const c = approve(produced(repo.dir), { via: 'test' });
      const r = binding().checkGrounding(c, repo.dir);
      assert.equal(r.ok, true, r.reason);
      assert.equal(contractHash(r.contract), contractHash(c));
    } finally { repo.cleanup(); }
  });
  test('repository drift: the target file changed after approval -> refused, naming the file; the approval is not migrated', () => {
    const repo = repoWith();
    try {
      const c = approve(produced(repo.dir), { via: 'test' });
      fs.writeFileSync(path.join(repo.dir, 'lib/formatter.js'), FORMATTER_DRIFT);
      const r = binding().checkGrounding(c, repo.dir);
      assert.equal(r.ok, false);
      assert.match(r.reason, /lib\/formatter\.js/);
      assert.match(r.reason, /does not match the repository/);
      assert.match(r.reason, /approve/);
    } finally { repo.cleanup(); }
  });
  test('tamper: an edited grounding on a stored contract that is not approved yet is refused, never trusted', () => {
    const repo = repoWith(FORMATTER_DRIFT);
    try {
      const c = produced(repo.dir);
      assert.equal(contractState(c).state, 'invalid', 'the real constructor cannot be cleared');
      c.api_grounding.modules[0].default.ctor_args = 'none';   // forged: would make it finalize
      assert.equal(contractState(c).state, 'finalized', 'the validator alone trusts the field (hence this gate)');
      const r = binding().checkGrounding(c, repo.dir);
      assert.equal(r.ok, false);
      assert.match(r.reason, /does not match the repository/);
    } finally { repo.cleanup(); }
  });
  test('no carried grounding, not approved: QB attaches its own recomputed grounding', () => {
    const repo = repoWith();
    try {
      const c = contractFromObject(RAW(), FMT);
      assert.equal(contractState(c).state, 'invalid', 'no grounding: the class-method example cannot be tied (fail-closed)');
      const r = binding().checkGrounding(c, repo.dir);
      assert.equal(r.ok, true);
      assert.deepEqual(r.contract.api_grounding, groundingOf(repo.dir));
      assert.equal(contractState(r.contract).state, 'finalized');
    } finally { repo.cleanup(); }
  });
  test('no carried grounding, already approved (a pre-KAN-107 approval): left as approved, NOT silently migrated', () => {
    const repo = repoWith();
    try {
      const c = approve(contractFromObject(RAW(), FMT), { via: 'test' });
      const r = binding().checkGrounding(c, repo.dir);
      assert.equal(r.ok, true);
      assert.equal(r.contract.api_grounding, undefined);
      assert.equal(approvalState(r.contract).approved, true);
    } finally { repo.cleanup(); }
  });
});

/** qb.js end to end with a contract file, no model reachable. */
function qb(repo, file, request = FMT, agent = 'dry-run') {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kan107g-cli-'));
  try {
    const r = spawnSync(process.execPath, ['--require', PRELOAD, QB, request, '--repo', repo.dir, '--agent', agent, '--no-llm-context', '--no-llm-verify', '--contract-file', file],
      { encoding: 'utf8', timeout: 60_000, env: { ...process.env, QB_RUNS_DIR: path.join(tmp, 'runs'), QB_MEMORY_DIR: path.join(tmp, 'mem'), QB_OLLAMA_URL: 'http://127.0.0.1:9', QB_TEST_FETCH_LOG: path.join(tmp, 'fetch.log') } });
    const runs = fs.existsSync(path.join(tmp, 'runs')) ? fs.readdirSync(path.join(tmp, 'runs')) : [];
    const manifest = runs.length ? JSON.parse(fs.readFileSync(path.join(tmp, 'runs', runs[0], 'manifest.json'), 'utf8')) : null;
    return { ...r, out: r.stdout + r.stderr, manifest, fetched: fs.existsSync(path.join(tmp, 'fetch.log')) };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

describe('(b) --contract-file: trusted repository grounding, never the caller\'s', () => {
  test('a file without api_grounding: QB recomputes it from the target repository, shows the mapping, and the class-method example is checked', () => {
    const repo = repoWith();
    const file = path.join(repo.dir, '..', `kan107g-${process.pid}-a.json`);
    try {
      fs.writeFileSync(file, JSON.stringify(RAW()));
      const r = qb(repo, file);
      assert.equal(r.manifest.outcome, 'DRY_RUN', r.out);
      assert.match(r.out, /Request examples/);
      assert.match(r.out, /lib\/formatter\.js new Formatter\(\)\.join\(\[\[\]\]\) returns "" -> CHK-1 \(checked\)/);
      assert.equal(r.fetched, false, 'no model call');
    } finally { fs.rmSync(file, { force: true }); repo.cleanup(); }
  });
  test('tamper: a caller-authored api_grounding that the repository does not support is refused (BLOCKED), not used as proof', () => {
    const repo = repoWith(FORMATTER_DRIFT);
    const file = path.join(repo.dir, '..', `kan107g-${process.pid}-b.json`);
    try {
      const forged = { ...RAW(), api_grounding: { schema: 'qb-api-grounding/1', modules: [{ path: 'lib/formatter.js', sha256: '0'.repeat(64), bytes: 1, status: 'known', format: 'commonjs', named: [], default: { kind: 'class', name: 'Formatter', form: 'module.exports = class Formatter', methods: ['join'], accessors: [], statics: [], ctor_args: 'none' } }] } };
      fs.writeFileSync(file, JSON.stringify(forged));
      const before = fs.readFileSync(file);
      const r = qb(repo, file);
      assert.equal(r.status, 2, r.out);
      assert.match(r.out, /api_grounding .*does not match the repository/);
      assert.equal(r.manifest.outcome, 'BLOCKED');
      assert.deepEqual(fs.readFileSync(file), before, 'never rewritten');
    } finally { fs.rmSync(file, { force: true }); repo.cleanup(); }
  });
  test('drift: the reviewed proposal carries QB\'s grounding; the target file changed before the run -> BLOCKED, review again', () => {
    const { proposalForReview } = require('../../intent/contract-file');
    const repo = repoWith();
    const file = path.join(repo.dir, '..', `kan107g-${process.pid}-c.json`);
    try {
      const proposal = proposalForReview(produced(repo.dir));
      assert.ok(proposal.api_grounding, 'the reviewable file records QB\'s grounding');
      fs.writeFileSync(file, JSON.stringify(proposal));
      assert.equal(qb(repo, file).manifest.outcome, 'DRY_RUN', 'unchanged repository: accepted');
      fs.writeFileSync(path.join(repo.dir, 'lib/formatter.js'), FORMATTER_DRIFT);
      const r = qb(repo, file);
      assert.equal(r.status, 2, r.out);
      assert.match(r.out, /lib\/formatter\.js/);
      assert.match(r.out, /does not match the repository/);
      assert.equal(r.manifest.outcome, 'BLOCKED');
    } finally { fs.rmSync(file, { force: true }); repo.cleanup(); }
  });
});

describe('(a) a stored contract given to the agent CLI', () => {
  function agentCli(repo, contract, extra = []) {
    const file = path.join(repo.dir, '..', `kan107g-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(file, JSON.stringify(contract));
    try {
      return spawnSync(process.execPath, [AGENT_CLI, '--contract', file, '--repo', repo.dir, '--agent', 'dry-run', ...extra], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, QB_OLLAMA_URL: 'http://127.0.0.1:9' } });
    } finally { fs.rmSync(file, { force: true }); }
  }
  test('an edited api_grounding in a stored contract is refused before anything runs', () => {
    const repo = repoWith(FORMATTER_DRIFT);
    try {
      const c = produced(repo.dir);
      c.api_grounding.modules[0].default.ctor_args = 'none';
      const r = agentCli(repo, c);
      assert.equal(r.status, 2, r.stdout + r.stderr);
      assert.match(r.stdout + r.stderr, /does not match the repository/);
    } finally { repo.cleanup(); }
  });
  test('the untampered stored contract runs (dry run)', () => {
    const repo = repoWith();
    try {
      const r = agentCli(repo, produced(repo.dir));
      assert.equal(r.status, 0, r.stdout + r.stderr);
    } finally { repo.cleanup(); }
  });
});
