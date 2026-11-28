/**
 * KAN-107 consistency on the DEFAULT path (senior 10835, item 3). OFFLINE: the model is faked, QB_OLLAMA_URL is a
 * dead port, and every reply is a hand-written fixture or a recorded draft (labelled below). Nothing here is a
 * fresh model result.
 *
 * Through the real producer (intent/session.js compileIntent -> intent/compiler.js -> contractState), not only the
 * validator: the static API grounding QB computes is attached by QB to every draft, the KAN-107 example rules read
 * it, the ONE existing correction is the only retry, and the KAN-105 protection rules (correctionProtectionErrors,
 * on main) still apply. These are the default-path counterparts of the staged-prototype tests that stay on
 * kan107-consistency-design.
 *
 * Fixtures:
 *   test/fixtures/kan106/malformed-draft.json, eba7015e-initial.json   OBSERVED Qwen first drafts (unchanged since
 *     0f8849e / dca5df1). They protect lib/**\/*, test/**\/* or test/** for behaviour constraints: negative cases.
 *   test/fixtures/kan106/passage-draft.json, faithful-draft.json       SYNTHETIC corrections (hand-written, KAN-106).
 *   everything built with test/fixtures/kan107/build.js                 hand-written for KAN-107.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { mockFetch, ollamaReply } = require('../helpers/mocks');
const { draft, fn, method } = require('../fixtures/kan107/build');

process.env.QB_OLLAMA_URL = 'http://127.0.0.1:9';   // never a real model, even by accident
const { compileIntent } = require('../../intent/session');
const { contractState } = require('../../intent/contract-state');
const RX = require('../../intent/request-examples');

const ROOT = path.join(__dirname, '..', '..');
const RUNNER = path.join(ROOT, 'sandbox', 'agent', 'qb-check-runner.mjs');
const K106 = path.join(__dirname, '..', 'fixtures', 'kan106');
const read106 = (f) => fs.readFileSync(path.join(K106, f), 'utf8');
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

function makeDir(files, prefix = 'kan107d-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  for (const [rel, body] of Object.entries({ 'package.json': '{"name":"k107","type":"commonjs"}', ...files })) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
/** The real default producer, with the model faked; `files` (if any) is the repository QB surveys and grounds. */
async function produce(request, replies, files = null) {
  const repo = files ? makeDir(files) : null;
  let i = 0;
  const m = mockFetch(() => ollamaReply(typeof replies[0] === 'string' ? replies[Math.min(i++, replies.length - 1)] : JSON.stringify(replies[Math.min(i++, replies.length - 1)])));
  try {
    const s = await compileIntent(request, repo ? { repoPath: repo.dir } : {});
    return { s, calls: m.calls.length, prompts: m.calls.map((c) => JSON.parse(c.init.body).messages.map((x) => x.content).join('\n')) };
  } finally { m.restore(); if (repo) repo.cleanup(); }
}
const why = (s) => (s.errors || []).join('\n');
function runChecks(checks, files) {
  const r = makeDir(files, 'kan107d-run-');
  try {
    const out = path.join(r.dir, 'results.json');
    const p = spawnSync(process.execPath, [RUNNER], { input: JSON.stringify({ root: r.dir, checks }), encoding: 'utf8',
      env: { ...process.env, QB_CHECK_RESULTS: out, QB_CHECK_TIMEOUT_MS: '5000' }, timeout: 60_000 });
    assert.equal(p.status, 0, p.stderr);
    return Object.fromEntries(JSON.parse(fs.readFileSync(out, 'utf8')).results.map((x) => [x.id, x.status]));
  } finally { r.cleanup(); }
}

// Hand-written sources (same as kan107-consistency.test.js).
const SRC = {
  formatter: "'use strict'\n\nmodule.exports = class Formatter {\n  constructor (options) {\n    this.separator = (options && options.separator) || ','\n  }\n\n  setSeparator (s) {\n    this.separator = s\n  }\n\n  join (list) {\n    if (list.length === 0) return ''\n    return list.join(this.separator)\n  }\n}\n",
  formatterBase: "'use strict'\n\nmodule.exports = class Formatter {\n  constructor (options) {\n    this.separator = (options && options.separator) || ','\n  }\n\n  join (list) {\n    if (list.length === 0) return undefined\n    return list.join(this.separator)\n  }\n}\n",
  users: "'use strict'\n\nmodule.exports = class UserRepo {\n  constructor (db) {\n    this.db = db\n  }\n\n  find (id) {\n    const row = this.db.get(id)\n    if (!row) throw new Error('unknown id')\n    return row\n  }\n}\n",
  env: "'use strict'\nconst TRUE = ['true', '1', 'yes']\nfunction parseBool (s) { return TRUE.includes(String(s)) }\nmodule.exports = { parseBool }\n",
  envBase: "'use strict'\nfunction parseBool (s) { return s === 'true' }\nmodule.exports = { parseBool }\n",
  defaults: "'use strict'\nmodule.exports = { debug: 'false' }\n",
};

describe('protection (KAN-105 on main, ruling unchanged): the recorded bad drafts stay bad drafts', () => {
  const REQUEST = read106('request.txt').trim();
  test('the recorded fixtures are byte-for-byte the observed drafts (no edits to make a test pass)', () => {
    assert.equal(sha(read106('malformed-draft.json')), '110f85343ce88ca485448b68d0970772d9c90ee98af1b201f08a626c06ee65ea');
    assert.equal(sha(read106('eba7015e-initial.json')), '4eb7c5282a10cd099cdcd62a60d9831a3f94eb03170bbf59246ae4c1926305dd');
  });
  test('malformed-draft (protects lib/**/* and test/**/* for behaviour constraints): the correction that drops them is refused; ONE correction, then invalid', async () => {
    const { s, calls } = await produce(REQUEST, [read106('malformed-draft.json'), read106('passage-draft.json')]);
    assert.equal(calls, 2, 'one draft plus the one existing correction');
    assert.equal(s.state, 'invalid');
    assert.match(why(s), /protected path "lib\/\*\*\/\*" enforces constraint 0 .*a correction may not remove it/);
    assert.match(why(s), /protected path "test\/\*\*\/\*" enforces constraint 1 .*a correction may not remove it/);
  });
  test('eba7015e-initial (protects test/** for a behaviour constraint): the correction that drops it is refused', async () => {
    const { s, calls } = await produce(REQUEST, [read106('eba7015e-initial.json'), read106('faithful-draft.json')]);
    assert.equal(calls, 2);
    assert.equal(s.state, 'invalid');
    assert.match(why(s), /protected path "test\/\*\*" enforces constraint 0 .*a correction may not remove it/);
  });
});

describe('protection and examples together (S4 shape, hand-written): a genuine "do not change" survives, the examples are enforced', () => {
  const S4 = 'In lib/env.js, make parseBool() also treat "1" and "yes" as true, so parseBool("yes") returns true and parseBool("1") returns true. Keep parseBool("true") returning true. Do not change lib/defaults.js.';
  const FILES = { 'lib/env.js': SRC.envBase, 'lib/defaults.js': SRC.defaults };
  /** A draft for S4; `expectYes` is the value its CHK-1 expects for parseBool("yes"). */
  const s4 = ({ allowed, protectedPaths = ['lib/defaults.js'], expectYes = true, enforced = true }) => {
    const ps = require('../fixtures/kan107/build').passagesOf(S4);
    const pid = (re) => ps.find((p) => re.test(p.text)).id;
    const raw = draft(S4, [
      { criterion: 'parseBool("yes") returns true.', passages: [pid(/^make parseBool/), pid(/^so parseBool/)], check: fn('lib/env.js', 'parseBool', ['yes'], expectYes) },
      { criterion: 'parseBool("1") returns true.', passages: [pid(/parseBool\("1"\) returns true\.$/)], check: fn('lib/env.js', 'parseBool', ['1'], true) },
      { criterion: 'parseBool("true") still returns true.', passages: [pid(/^Keep/)], check: fn('lib/env.js', 'parseBool', ['true'], true) },
    ], { allowed });
    raw.constraints = ['Do not change lib/defaults.js.'];
    raw.constraint_policy = enforced ? [{ constraint: 0, enforced_by: [{ kind: 'protected_paths', ref: 'lib/defaults.js' }] }] : [{ constraint: 0, advisory: true }];
    raw.scope.protected_paths = protectedPaths;
    const dn = raw.requirements.find((r) => r.quote === 'Do not change lib/defaults.js.');
    if (dn) dn.reason = 'a constraint, enforced by scope.protected_paths';
    return raw;
  };
  test('the faithful draft finalizes in ONE call; lib/defaults.js stays protected; every example is the check that runs', async () => {
    const { s, calls } = await produce(S4, [s4({ allowed: ['lib/env.js'] })], FILES);
    assert.equal(s.state, 'finalized', why(s));
    assert.equal(calls, 1);
    assert.deepEqual(s.contract.scope.protected_paths, ['lib/defaults.js']);
    assert.deepEqual(RX.exampleErrors(s.contract), []);
    assert.deepEqual(runChecks(s.contract.checks, { 'lib/env.js': SRC.env }), { 'CHK-1': 'pass', 'CHK-2': 'pass', 'CHK-3': 'pass' });
  });
  test('an invented allowed change on the protected file is resolved by narrowing allowed_changes, never by dropping the protection', async () => {
    const { s, calls, prompts } = await produce(S4, [s4({ allowed: ['lib/env.js', 'lib/defaults.js'] }), s4({ allowed: ['lib/env.js'] })], FILES);
    assert.equal(calls, 2);
    assert.match(prompts[1], /"lib\/defaults\.js" is entirely covered by scope\.protected_paths/);
    assert.equal(s.state, 'finalized', why(s));
    assert.deepEqual(s.contract.scope.protected_paths, ['lib/defaults.js']);
  });
  test('a correction that drops the genuine protection to make room for the change is refused (KAN-105), even with correct examples', async () => {
    const { s, calls } = await produce(S4, [s4({ allowed: ['lib/env.js', 'lib/defaults.js'] }), s4({ allowed: ['lib/env.js', 'lib/defaults.js'], protectedPaths: [], enforced: false })], FILES);
    assert.equal(calls, 2);
    assert.equal(s.state, 'invalid');
    assert.match(why(s), /protected path "lib\/defaults\.js" enforces constraint 0 .*a correction may not remove it/);
  });
  test('a correction that keeps the protection but contradicts a request example is refused (KAN-107); no extra call', async () => {
    const { s, calls } = await produce(S4, [s4({ allowed: ['lib/env.js', 'lib/defaults.js'] }), s4({ allowed: ['lib/env.js'], expectYes: false })], FILES);
    assert.equal(calls, 2);
    assert.equal(s.state, 'invalid');
    assert.match(why(s), /CHK-1 contradicts the request's example parseBool\("yes"\) returns true/);
  });
});

describe('QB-computed grounding on the default path (correction B; ctor_args; KAN-106 S2 as a known regression)', () => {
  const FMT = 'In lib/formatter.js, make Formatter.join([]) return "". Keep Formatter.join(["a", "b"]) returning "a,b".';
  const fmt = (a1, a2) => draft(FMT, [
    { criterion: 'Formatter.join([]) returns "".', passages: ['P2'], check: method('lib/formatter.js', 'join', [[a1, '']]) },
    { criterion: 'Formatter.join(["a", "b"]) still returns "a,b".', passages: ['P3'], check: method('lib/formatter.js', 'join', [[a2, 'a,b']]) }], { allowed: ['lib/formatter.js'] });
  const RIGHT = fmt([[]], [['a', 'b']]);
  const FLAT = fmt([], ['a', 'b']);

  test('the producer attaches QB\'s own grounding (provenance, ctor_args; no source text); the faithful draft finalizes in ONE call and runs', async () => {
    const { s, calls } = await produce(FMT, [RIGHT], { 'lib/formatter.js': SRC.formatterBase });
    assert.equal(s.state, 'finalized', why(s));
    assert.equal(calls, 1);
    const m = s.contract.api_grounding.modules.find((x) => x.path === 'lib/formatter.js');
    assert.equal(m.sha256, sha(SRC.formatterBase));
    assert.equal(m.default.kind, 'class');
    assert.equal(m.default.ctor_args, 'appears_optional');
    assert.equal(JSON.stringify(s.contract.api_grounding).includes('list.join(this.separator)'), false, 'no source text on the contract');
    assert.deepEqual(runChecks(s.contract.checks, { 'lib/formatter.js': SRC.formatter }), { 'CHK-1': 'pass', 'CHK-2': 'pass' });
  });
  test('S2 (known regression): flattened checks are refused, the ONE correction sees the error, and a flattened correction stops invalid', async () => {
    const { s, calls, prompts } = await produce(FMT, [FLAT, FLAT], { 'lib/formatter.js': SRC.formatterBase });
    assert.equal(calls, 2);
    assert.match(prompts[1], /changes the argument shape of the request's example Formatter\.join\(\[\]\)/);
    assert.equal(s.state, 'invalid');
    assert.match(why(s), /changes the argument shape of the request's example Formatter\.join\(\["a", "b"\]\)/);
  });
  test('S2: the correction that restores the request\'s argument shape finalizes', async () => {
    const { s, calls } = await produce(FMT, [FLAT, RIGHT], { 'lib/formatter.js': SRC.formatterBase });
    assert.deepEqual([s.state, calls], ['finalized', 2]);
  });
  test('ctor_args (10758 reading): a constructor that stores a dependency later dereferenced is not constructed with no arguments; QB says why', async () => {
    const R = 'In lib/users.js, make UserRepo.find("x") return null.';
    const raw = draft(R, [{ criterion: 'UserRepo.find("x") returns null.', passages: ['P2'], check: method('lib/users.js', 'find', [[['x'], null]]) }], { allowed: ['lib/users.js'] });
    const { s, calls } = await produce(R, [raw, raw], { 'lib/users.js': SRC.users });
    assert.equal(calls, 2);
    assert.equal(s.state, 'invalid');
    assert.equal(s.contract.api_grounding.modules[0].default.ctor_args, 'required_or_unknown');
    assert.match(why(s), /UserRepo\.find\("x"\).*cannot be tied to one target: the constructor of UserRepo in lib\/users\.js may need arguments QB cannot supply .*not a proof either way/);
  });
  test('a model cannot supply the grounding: an api_grounding field in the reply is dropped; with no repository there is none', async () => {
    const forged = { ...RIGHT, api_grounding: { schema: 'qb-api-grounding/1', modules: [{ path: 'lib/formatter.js', status: 'known', named: [], default: { kind: 'class', name: 'Formatter', methods: ['join'], accessors: [], statics: [], ctor_args: 'none' } }] } };
    const { s } = await produce(FMT, [forged, forged]);
    assert.equal(s.contract.api_grounding, undefined);
    assert.equal(s.state, 'invalid');
    assert.match(why(s), /Formatter\.join\(\[\]\).*cannot be tied to one target: QB has no grounding for Formatter in lib\/formatter\.js/);
  });
});

describe('no-file requests and contradictory user constraints on the default path', () => {
  test('a request that names no file: QB asks which file (the groundApi producer reads request-named modules only); never the check\'s module', async () => {
    const R = 'Make f(1) return 3.';
    const raw = draft(R, [{ criterion: 'f(1) returns 3.', passages: ['P1'], check: fn('lib/x.js', 'f', [1], 3) }], { allowed: ['lib/x.js'] });
    const { s, calls } = await produce(R, [raw, raw], { 'lib/x.js': "'use strict'\nfunction f (n) { return n }\nmodule.exports = { f }\n" });
    assert.equal(calls, 2);
    assert.deepEqual(s.contract.api_grounding.modules, []);
    assert.equal(s.state, 'invalid');
    assert.match(why(s), /f\(1\) returns 3.*cannot be tied to one target.*Which file contains f\?/);
  });
  test('two results asked for the same call: whichever the draft picks, QB stops and asks which one is wanted (no third call)', async () => {
    const R = 'In lib/x.js, make f(1) return 3. Make f(1) return 2.';
    const pick = (v) => draft(R, [{ criterion: `f(1) returns ${v}.`, passages: ['P1', 'P2', 'P3'].filter((p) => require('../fixtures/kan107/build').passagesOf(R).some((x) => x.id === p)), check: fn('lib/x.js', 'f', [1], v) }], { allowed: ['lib/x.js'] });
    for (const [a, b] of [[3, 2], [2, 3]]) {
      const { s, calls } = await produce(R, [pick(a), pick(b)], { 'lib/x.js': "'use strict'\nfunction f (n) { return n }\nmodule.exports = { f }\n" });
      assert.equal(calls, 2);
      assert.equal(s.state, 'invalid');
      assert.match(why(s), /the request states different results for f\(1\): returns 3 and returns 2\. Which one is wanted\? QB does not choose/);
    }
  });
});

describe('the model input is unchanged on this branch (no prompt change)', () => {
  test('neither the system prompt nor the user content carries grounding excerpts or passage listings', async () => {
    const FMT = 'In lib/formatter.js, make Formatter.join([]) return "".';
    const raw = draft(FMT, [{ criterion: 'Formatter.join([]) returns "".', passages: ['P2'], check: method('lib/formatter.js', 'join', [[[[]], '']]) }], { allowed: ['lib/formatter.js'] });
    const { prompts } = await produce(FMT, [raw], { 'lib/formatter.js': SRC.formatterBase });
    // (the repository survey of main may still show file snippets; that is unchanged and not KAN-107's grounding)
    assert.doesNotMatch(prompts[0], /SOURCE API|SOURCE EXCERPTS|REQUEST PASSAGES|ctor_args|qb-api-grounding/);
  });
  test('a contract with no request text has no example errors (older stored contracts are unaffected)', () => {
    assert.deepEqual(RX.exampleErrors({ checks: [] }), []);
    assert.equal(contractState({ goal: 'g', acceptance_criteria: [{ id: 'AC-1', criterion: 'c' }] }).state, 'finalized');
  });
});
