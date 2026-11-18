/**
 * KAN-106 10749: the senior's pre-merge gates for the staged L1 prototype (intent/staged.js).
 *
 *   G1  assemble() must not make a readable dependency writable: only request-targeted modules go into
 *       scope.allowed_changes. An explicit do-not-change request is preserved (scope.protected_paths
 *       with a constraint enforced by it) or the request is refused as unsupported.
 *   G2  unsupported or ambiguous call shapes are marked unsupported, never advertised as grounded:
 *       a constructor that needs arguments, an unknown (unreadable) source, a name the module does not
 *       define when the request does not ask to create or export it.
 *   G3  an adds_tests passage that says more than "add tests in <file>" is refused, not silently dropped.
 *   G4  replies already received survive a timeout or cancellation: on the error (error.staged) and in
 *       the run artifact written by qb.js.
 * No model calls: the model is faked (in-process mock, or a local fake HTTP server for the CLI test).
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const { mockFetch, ollamaReply } = require('../helpers/mocks');

const ROOT = path.join(__dirname, '..', '..');
const FIX = path.join(__dirname, '..', 'fixtures', 'kan106');
const read = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');
const REQUEST = read('request.txt').trim();
const PINNED = read('pinned-fast-json-stringify/serializer-07d7196.js');
const GUARD = "    // reject blank strings, which Number() would coerce to 0\n    if (typeof i === 'string' && i.trim() === '') {\n      throw new Error(`The value \"${i}\" cannot be converted to a number.`)\n    }\n";
const BASE = PINNED.replace(GUARD, '');
const RECORDED = JSON.parse(read('b7a4bfe2-replies.json'));
const staged = () => require('../../intent/staged');
const { contractState } = require('../../intent/contract-state');
const { groundSource } = require('../../intent/api-grounding');

function makeRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kan106-gates-'));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const ridOf = (init) => JSON.parse(init.body).format.properties.cases.items.properties.requirement.enum[0];
const userOf = (init) => JSON.parse(init.body).messages[1].content;
const cases = (rid, call, list) => JSON.stringify({ cases: list.map((c) => ({ requirement: rid, call, error_fragment: null, expected: null, ...c })) });

/** compileIntent with the staged profile; `answer(rid, init)` returns the raw reply (or throws). */
async function produce(request, files, answer) {
  const repo = makeRepo(files);
  const sent = [];
  const m = mockFetch(async (url, init) => { const rid = ridOf(init); sent.push(rid); return ollamaReply(await answer(rid, init)); });
  const { l1Budget } = require('../../lib/budget');
  try { return { s: await require('../../intent/session').compileIntent(request, { repoPath: repo.dir, l1Budget: l1Budget({ profile: 'qwen-14b-staged' }) }), sent }; }
  finally { m.restore(); repo.cleanup(); }
}
const A_JS = "function greet () { return 'hello' }\nmodule.exports = { greet }\n";
const UTIL_JS = "function slugify (s) { return s.toLowerCase().replace(/ /g, '-') }\nmodule.exports = { slugify }\n";
const twoFiles = { 'package.json': '{"name":"g"}', 'lib/a.js': A_JS, 'lib/util.js': UTIL_JS };
const greetHi = (rid) => cases(rid, 'greet (lib/a.js)', [{ args: [], outcome: 'returns', expected: 'hi' }]);
const targetsOf = (rel, text, request) => staged().callTargets(request, { modules: [groundSource(rel, text, require('../../intent/api-grounding').requestNames(request))] });

describe('G1: a readable dependency is not made writable; do-not-change requests are preserved or refused', () => {
  test('a kept behaviour of a module the request does not target: its check runs, but the module is NOT in allowed_changes', async () => {
    const request = 'In lib/a.js, make greet() return "hi". Keep slugify() in lib/util.js returning "a-b" for "a b".';
    const { s } = await produce(request, twoFiles, (rid) => (rid === 'R-2' ? greetHi(rid) : cases(rid, 'slugify (lib/util.js)', [{ args: ['a b'], outcome: 'returns', expected: 'a-b' }])));
    assert.equal(s.state, 'finalized', (s.errors || []).join('\n'));
    assert.deepEqual(s.contract.scope.allowed_changes, ['lib/a.js']);
    assert.ok(s.contract.checks.some((k) => k.params.module === 'lib/util.js' && k.params.export === 'slugify'));
  });
  test('"Do not change lib/util.js." becomes scope.protected_paths with a constraint enforced by it; no model call for that passage', async () => {
    const request = 'In lib/a.js, make greet() return "hi". Do not change lib/util.js.';
    const { s, sent } = await produce(request, twoFiles, greetHi);
    assert.deepEqual(sent, ['R-2']);
    assert.equal(s.state, 'finalized', (s.errors || []).join('\n'));
    assert.deepEqual(contractState(s.contract), { state: 'finalized' });
    assert.deepEqual(s.contract.scope, { allowed_changes: ['lib/a.js'], protected_paths: ['lib/util.js'] });
    const i = s.contract.constraints.findIndex((t) => /lib\/util\.js/.test(t));
    assert.ok(i >= 0);
    assert.deepEqual(s.contract.constraint_policy.find((p) => p.constraint === i).enforced_by, [{ kind: 'protected_paths', ref: 'lib/util.js' }]);
    const r3 = s.contract.requirements.find((r) => r.id === 'R-3');
    assert.equal(r3.disposition, 'context');
    assert.match(r3.reason, /protected_paths/);
  });
  test('a do-not-change instruction inside a behavioural passage is refused as unsupported, before any model call', async () => {
    const request = 'In lib/a.js, make greet() return "hi" without touching lib/util.js.';
    const { s, sent } = await produce(request, twoFiles, greetHi);
    assert.deepEqual(sent, []);
    assert.equal(s.state, 'invalid');
    assert.match(s.errors.join('\n'), /unsupported/);
    assert.match(s.errors.join('\n'), /lib\/util\.js/);
  });
});

describe('G2: unsupported or ambiguous call shapes are marked, never advertised as grounded', () => {
  test('a constructor that needs an argument: unsupported (QB constructs with no arguments)', () => {
    const src = 'class Counter {\n  constructor (opts) {\n    this.step = opts.step\n  }\n  next (n) { return n + this.step }\n}\nmodule.exports = Counter\n';
    const t = targetsOf('lib/c.js', src, 'In lib/c.js, make Counter.next() return 2 for 1.');
    assert.equal(t.length, 1);
    assert.equal(t[0].grounding, 'unsupported');
    assert.match(t[0].reason, /constructor/);
  });
  test('constructors whose arguments are optional, defaulted or absent are grounded, and say so', () => {
    const request = 'In lib/c.js, make Counter.next() return 2 for 1.';
    const shapes = {
      none: 'class Counter {\n  next (n) { return n + 1 }\n}\nmodule.exports = Counter\n',
      defaulted: 'class Counter {\n  constructor (opts = {}) { this.step = opts.step || 1 }\n  next (n) { return n + this.step }\n}\nmodule.exports = Counter\n',
      guarded: 'class Counter {\n  constructor (opts) { this.step = (opts && opts.step) || 1; this.o = opts }\n  next (n) { return n + this.step }\n}\nmodule.exports = Counter\n',
    };
    for (const [kind, src] of Object.entries(shapes)) {
      const [t] = targetsOf('lib/c.js', src, request);
      assert.equal(t.grounding, 'grounded', kind);
      assert.equal(t.constructor_args, kind === 'none' ? 'none' : 'optional', kind);
    }
  });
  test('the fixture: Serializer\'s constructor (options) only reads options behind a guard: grounded, optional arguments', () => {
    const [t] = targetsOf('lib/serializer.js', BASE, REQUEST);
    assert.deepEqual([t.label, t.grounding, t.constructor_args], ['Serializer.asNumber (lib/serializer.js)', 'grounded', 'optional']);
  });
  test('an unknown source (exports QB cannot read): unsupported; L1 refuses before any model call', async () => {
    const request = 'In lib/m.js, make run() return 1.';
    const { s, sent } = await produce(request, { 'package.json': '{}', 'lib/m.js': "module.exports = require('./impl')\n", 'lib/impl.js': 'module.exports = { run () { return 0 } }\n' }, () => '{}');
    assert.deepEqual(sent, []);
    assert.equal(s.state, 'invalid');
    assert.match(s.errors.join('\n'), /unsupported/);
    assert.equal(s.staged.unsupported_targets[0].grounding, 'unsupported');
  });
  test('a name the module does not define, with no request to create or export it: ambiguous, unsupported', async () => {
    const request = 'In lib/math.js, make clamp() return 0 for 0.';
    const { s, sent } = await produce(request, { 'package.json': '{}', 'lib/math.js': 'function sum (a, b) { return a + b }\nmodule.exports = { sum }\n' }, () => '{}');
    assert.deepEqual(sent, []);
    assert.equal(s.state, 'invalid');
    assert.match(s.staged.unsupported_targets[0].reason, /does not define clamp/);
  });
  test('a requested new export is labelled requested_new (not grounded) in the record and in the prompt', async () => {
    const request = 'In lib/math.js, export a new function clamp(x, lo, hi) that returns lo when x is below lo.';
    let prompt = '';
    const { s } = await produce(request, { 'package.json': '{}', 'lib/math.js': 'function sum (a, b) { return a + b }\nmodule.exports = { sum }\n' },
      (rid, init) => { prompt = userOf(init); return cases(rid, 'clamp (lib/math.js)', [{ args: [-5, 0, 10], outcome: 'returns', expected: 0 }]); });
    assert.equal(s.state, 'finalized', (s.errors || []).join('\n'));
    assert.equal(s.staged.call_targets[0].grounding, 'requested_new');
    assert.match(prompt, /requested NEW function export clamp of lib\/math\.js/);
  });
});

describe('G3: an adds_tests passage never silently drops behavioural instructions', () => {
  test('"Add … cases that check empty strings throw in <file>." is refused as unsupported, before any model call', async () => {
    const request = 'In lib/serializer.js, make Serializer.asNumber() throw a number conversion error for an empty string. Add node:test cases that check empty strings throw in test/asNumber.test.js.';
    const { s, sent } = await produce(request, { 'package.json': '{}', 'lib/serializer.js': BASE, 'test/asNumber.test.js': '' }, () => '{}');
    assert.deepEqual(sent, []);
    assert.equal(s.state, 'invalid');
    assert.match(s.errors.join('\n'), /P3 .*asks to add tests and says more/);
  });
  test('plain requested-tests passages are still adds_tests', () => {
    const { passageRoles } = staged();
    for (const p of ['Add node:test cases in test/asNumber.test.js.', 'Add tests for asNumber() in test/a.test.js.', 'Write unit tests in test/a.test.js.', 'Add more tests to test/a.test.js']) {
      const roles = passageRoles(`Make f() return 1. ${p}`);
      assert.equal(roles.at(-1).role, 'adds_tests', p);
    }
  });
});

describe('G4: replies already received survive a timeout or cancellation', () => {
  test('an error during the R-4 call: error.staged keeps the R-2 and R-3 replies byte for byte and the failed R-4 call', async () => {
    const replies = Object.fromEntries(Object.entries(RECORDED.replies).map(([rid, r]) => [rid, r.raw]));
    await assert.rejects(produce(REQUEST, { 'package.json': '{}', 'lib/serializer.js': BASE, 'test/asNumber.test.js': '' }, (rid) => {
      if (rid === 'R-4') throw new Error('connection reset by peer');
      return replies[rid];
    }), (e) => {
      assert.ok(e.staged, 'error.staged');
      assert.deepEqual(e.staged.facts.map((f) => f.requirement_id), ['R-2', 'R-3', 'R-4']);
      assert.equal(e.staged.facts[0].attempts[0].raw, replies['R-2']);
      assert.equal(e.staged.facts[1].attempts[0].raw, replies['R-3']);
      assert.equal(e.staged.facts[2].cases, null);
      assert.match(e.staged.facts[2].failed.message, /connection reset/);
      assert.ok(e.l1_timings, 'timings too');
      return true;
    });
  });
  test('CLI (qb.js, local fake server, no model): the L1 budget runs out during R-3; the run is CANCELLED and its contract-staged artifact keeps the R-2 reply and the failed R-3 call', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kan106-g4-'));
    const repo = path.join(tmp, 'repo');
    for (const [rel, body] of Object.entries({ 'package.json': '{"name":"x"}', 'lib/serializer.js': BASE, 'test/asNumber.test.js': "'use strict'\n" })) {
      fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), body);
    }
    spawnSync('git', ['init', '-q'], { cwd: repo });
    const r2 = RECORDED.replies['R-2'].raw;
    const sockets = new Set();
    const server = http.createServer((req, res) => {
      let b = ''; req.on('data', (d) => { b += d; });
      req.on('end', () => {
        const rid = JSON.parse(b).format.properties.cases.items.properties.requirement.enum[0];
        if (rid === 'R-2') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ model: 'fake', message: { content: r2 } })); }
        // R-3: never answered (the L1 budget ends the call)
      });
    });
    server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const env = { ...process.env, QB_OLLAMA_URL: `http://127.0.0.1:${server.address().port}`, QB_MODEL: 'fake', QB_RUNS_DIR: path.join(tmp, 'runs'), QB_MEMORY_DIR: path.join(tmp, 'mem') };
      const code = await new Promise((resolve) => {
        const p = spawn(process.execPath, [path.join(ROOT, 'qb.js'), REQUEST, '--repo', repo, '--agent', 'dry-run', '--no-llm-context', '--no-llm-verify', '--l1-profile', 'qwen-14b-staged', '--l1-budget', '3'], { env, stdio: 'ignore' });
        p.on('exit', resolve);
      });
      assert.equal(code, 3);
      const [id] = fs.readdirSync(path.join(tmp, 'runs'));
      const man = JSON.parse(fs.readFileSync(path.join(tmp, 'runs', id, 'manifest.json'), 'utf8'));
      assert.equal(man.outcome, 'CANCELLED');
      const art = man.artifacts['contract-staged'];
      assert.ok(art, 'contract-staged artifact');
      const data = JSON.parse(fs.readFileSync(path.join(tmp, 'runs', id, art.path), 'utf8'));
      const staged = data.data || data;
      assert.equal(staged.facts[0].attempts[0].raw, r2);
      assert.equal(staged.facts[1].requirement_id, 'R-3');
      assert.equal(staged.facts[1].failed.kind, 'l1_budget');
    } finally {
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(r));
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
