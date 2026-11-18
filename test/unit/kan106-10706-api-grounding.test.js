/**
 * KAN-106, senior decision 10706 (on 10702, the owner's Qwen smoke 0ae9efc9 at ee87b4a: BLOCKED,
 * invalid JSON once, then a repair with 4 errors whose checks called a non-existent export).
 *
 * (a) system.md no longer tells the model to infer generic "no regression" constraints (the
 *     constraints instructions AND the dashboard example); explicit user preservation stays, checked
 *     by behaviour checks, never by protected_paths; adds_tests wording matches the advisory /
 *     human-review semantics.
 * (b) Static API grounding: QB reads the request-named module files (bounded, never require'd,
 *     imported or executed), parses literal export forms, records path + sha256, shows the model an
 *     excerpt in BOTH the first and the repair input, and refuses a check naming an export that is
 *     PROVED absent from an existing API. Unknown (dynamic exports, re-exports, unparseable) and
 *     requested new exports are never refused.
 * (c) Locator passages are NOT turned into context automatically.
 *
 * Fixtures 0ae9efc9-*: GENERATED FAILURES (model output from that run, sanitized), never answers.
 * The source for every grounding test is the vendored pinned serializer (MIT). No model calls.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { mockFetch, ollamaReply } = require('../helpers/mocks');

const FIX = path.join(__dirname, '..', 'fixtures', 'kan106');
const read = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');
const REQUEST = read('request.txt').trim();
const SYNTAX_RAW = read('0ae9efc9-syntax-raw.txt');
const REPAIRED = read('0ae9efc9-repair.json');
const RECORDED = JSON.parse(read('0ae9efc9-errors.json'));
const THROWS = read('pinned-api-throws.json');
const PINNED = read('pinned-fast-json-stringify/serializer-07d7196.js');
const PINNED_SHA = crypto.createHash('sha256').update(PINNED).digest('hex');
const SYSTEM = fs.readFileSync(path.join(__dirname, '..', '..', 'intent', 'prompts', 'system.md'), 'utf8');

const grounding = () => require('../../intent/api-grounding');
const session = () => require('../../intent/session');
const variant = (text, edit) => { const d = JSON.parse(text); edit(d); return JSON.stringify(d); };

function makeRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kan106-10706-'));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const PINNED_REPO = { 'package.json': '{"name":"pinned","type":"commonjs"}', 'lib/serializer.js': PINNED, 'test/asNumber.test.js': "'use strict'\n" };

/** The real producer: compileIntent (survey, compile, validate, one repair) with the model faked. */
async function produce(replies, { request = REQUEST, files = PINNED_REPO } = {}) {
  const repo = makeRepo(files);
  let i = 0;
  const m = mockFetch(async () => ollamaReply(replies[Math.min(i++, replies.length - 1)]));
  try {
    const s = await session().compileIntent(request, { repoPath: repo.dir });
    return { s, calls: m.calls.length, prompts: m.calls.map((c) => JSON.parse(c.init.body).messages.at(-1).content), urls: m.calls.map((c) => c.url) };
  } finally { m.restore(); repo.cleanup(); }
}
const exportErrors = (errors) => errors.filter((e) => /has no (?:named )?export /.test(e));

describe('10706 (a): the prompt no longer asks for inferred no-regression constraints', () => {
  test('the constraints instructions and the dashboard example drop the generic inference', () => {
    assert.doesNotMatch(SYSTEM, /implicit ones you can infer/);
    assert.doesNotMatch(SYSTEM, /Name the implicit ones/);
    assert.doesNotMatch(SYSTEM, /other queries must not regress/);
    assert.doesNotMatch(SYSTEM, /flag the implicit constraint/);
  });
  test('explicit user preservation stays, enforced by behaviour checks, not by protected_paths or package protection', () => {
    const constraints = SYSTEM.slice(SYSTEM.indexOf('**constraints**'), SYSTEM.indexOf('**acceptance_criteria**'));
    assert.match(constraints, /explicit/i);
    assert.match(constraints, /QB already fails the task on any new test failure/);
    assert.match(SYSTEM, /never by protected_paths|not by protected_paths/);
    assert.match(SYSTEM, /behaviou?r the request asks to keep[^\n]*check/i);
  });
  test('adds_tests is described as advisory / human review, not decided by "file changed and tests passed"', () => {
    assert.doesNotMatch(SYSTEM, /It is decided from the test run \(the file changed, its tests ran and passed\)/);
    const adds = SYSTEM.slice(SYSTEM.indexOf('When the request asks to add tests'), SYSTEM.indexOf('**scope**'));
    assert.match(adds, /human review/);
    assert.match(adds, /never (?:passes|met) on its own|does not pass on its own|never decides it on its own/);
    assert.match(adds, /Never mark it non_behavioral/);
  });
  test('(c) no automatic context conversion: a location passage still has to be cited or marked context by the model', () => {
    assert.match(SYSTEM, /A passage that only names a file location/);
    const { contractFromObject } = require('../../intent/compiler');
    const { contractState } = require('../../intent/contract-state');
    const { resolveInRequest } = require('../../intent/passages');
    const d = JSON.parse(THROWS);
    for (const ac of d.acceptance_criteria) ac.requirement_ids = ac.requirement_ids.filter((x) => x !== 'R-1');
    d.requirements = d.requirements.map((r) => (r.passage_ids ? { ...r, quote: resolveInRequest(REQUEST, r.passage_ids).text } : r));
    const s = contractState(contractFromObject(d, REQUEST));
    assert.equal(s.state, 'invalid');
    assert.ok(s.errors.some((e) => /requirement R-1 "In lib\/serializer\.js," is not covered/.test(e)), s.errors.join('\n'));
  });
});

describe('10706 (b): static API grounding of literal export forms', () => {
  test('the pinned serializer: default class export, its instance methods, no named exports; path + sha256 provenance', () => {
    const g = grounding().groundSource('lib/serializer.js', PINNED);
    assert.equal(g.status, 'known');
    assert.equal(g.path, 'lib/serializer.js');
    assert.equal(g.sha256, PINNED_SHA);
    assert.equal(g.format, 'commonjs');
    assert.equal(g.default.kind, 'class');
    assert.equal(g.default.name, 'Serializer');
    assert.equal(g.default.form, 'module.exports = class Serializer');
    for (const m of ['asNumber', 'asInteger', 'asBoolean', 'asString']) assert.ok(g.default.methods.includes(m), m);
    assert.ok(!g.default.methods.includes('constructor'));
    assert.deepEqual(g.named, []);
  });
  test('other literal forms are known', () => {
    const G = (src, file = 'lib/x.js') => grounding().groundSource(file, src);
    let g = G('function a () {}\nconst b = 1\nmodule.exports = { a, b, c: () => 1 }\n');
    assert.equal(g.status, 'known'); assert.deepEqual(g.named.map((x) => x.name), ['a', 'b', 'c']); assert.equal(g.default.kind, 'object');
    g = G('exports.a = function () {}\nexports.b = 2\n');
    assert.equal(g.status, 'known'); assert.deepEqual(g.named.map((x) => x.name), ['a', 'b']);
    g = G('module.exports.a = () => 1\nmodule.exports.b = class B {}\n');
    assert.equal(g.status, 'known'); assert.deepEqual(g.named.map((x) => [x.name, x.kind]), [['a', 'function'], ['b', 'class']]);
    g = G('export function f () {}\nexport const k = 1, j = 2\nexport class C { m () {} }\nexport default class D { run () {} }\n', 'lib/x.mjs');
    assert.equal(g.status, 'known'); assert.equal(g.format, 'esm');
    assert.deepEqual(g.named.map((x) => x.name), ['f', 'k', 'j', 'C']);
    assert.equal(g.default.kind, 'class'); assert.deepEqual(g.default.methods, ['run']);
    g = G('class S { static make () {} go () {} }\nmodule.exports = S\n');
    assert.equal(g.status, 'known'); assert.equal(g.default.kind, 'class'); assert.deepEqual(g.default.methods, ['go']); assert.deepEqual(g.named.map((x) => x.name), ['make']);
  });
  test('dynamic exports, re-exports, spreads, computed names and unparseable source are unknown', () => {
    const G = (src, file = 'lib/x.js') => grounding().groundSource(file, src).status;
    assert.equal(G("module.exports = require('./impl')\n"), 'unknown');
    assert.equal(G('Object.assign(module.exports, { a: 1 })\n'), 'unknown');
    assert.equal(G("const base = require('./b')\nmodule.exports = { ...base, a: 1 }\n"), 'unknown');
    assert.equal(G("const k = 'a'\nmodule.exports = { [k]: 1 }\n"), 'unknown');
    assert.equal(G("for (const n of ['a']) exports[n] = 1\n"), 'unknown');
    assert.equal(G("export * from './y.mjs'\n", 'lib/x.mjs'), 'unknown');
    assert.equal(G("export { a } from './y.mjs'\n", 'lib/x.mjs'), 'unknown');
    assert.equal(G('module.exports = {\n'), 'unknown');
    assert.equal(G("module.exports = class extends require('./base') {}\n"), 'unknown');
  });
  test('grounding reads files statically: module code is never executed; missing and escaping paths are not read', () => {
    const marker = path.join(os.tmpdir(), `qb-10706-executed-${process.pid}`);
    const repo = makeRepo({ 'lib/side.js': `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')\nglobalThis.__qb10706 = 1\nmodule.exports = { a: 1 }\n` });
    try {
      const g = grounding().groundApi(repo.dir, 'In lib/side.js, change a. Also see lib/missing.js and ../outside.js.');
      const side = g.modules.find((x) => x.path === 'lib/side.js');
      assert.equal(side.status, 'known'); assert.deepEqual(side.named.map((x) => x.name), ['a']);
      assert.equal(fs.existsSync(marker), false, 'the module ran');
      assert.equal(globalThis.__qb10706, undefined);
      assert.equal(g.modules.find((x) => x.path === 'lib/missing.js').status, 'unknown');
      assert.equal(g.modules.some((x) => x.path.includes('..')), false);
    } finally { repo.cleanup(); fs.rmSync(marker, { force: true }); }
  });
});

describe('10706 (b): through the producer (compileIntent, model faked), the 0ae9efc9 generated failures', () => {
  test('the excerpt is in the first AND the repair input; the syntax draft is recovered once; the repaired draft is refused with the helpful export message', async () => {
    const { s, calls, prompts, urls } = await produce([SYNTAX_RAW, REPAIRED]);
    assert.equal(calls, 2, 'one repair at most');
    assert.ok(urls.every((u) => /127\.0\.0\.1|localhost/.test(u)), 'only the faked local endpoint');
    for (const p of prompts) {
      assert.match(p, /SOURCE API/);
      assert.ok(p.includes(`lib/serializer.js (sha256 ${PINNED_SHA}`), 'path + full hash');
      assert.match(p, /default export: class Serializer \(module\.exports = class Serializer\)/);
      assert.match(p, /instance methods: [^\n]*\basNumber\b/);
      assert.match(p, /"Serializer" is the class's own name, not an export/);
      assert.match(p, /does not show return types, values or error messages/);
    }
    assert.match(prompts[1], /YOUR PREVIOUS REPLY WAS NOT VALID JSON/);
    assert.equal(s.state, 'invalid');
    assert.equal(s.repair.rejected[0].kind, 'syntax');
    assert.equal(s.repair.rejected[0].diagnostic, RECORDED.syntax.diagnostic);
    // the recorded errors are still there…
    for (const e of RECORDED.repair_errors) assert.ok(s.errors.includes(e), e);
    // …and every check naming export asNumber is refused, explaining the real API
    const ex = exportErrors(s.errors);
    assert.deepEqual(ex.map((e) => e.split(' ')[0]), ['CHK-1', 'CHK-2', 'CHK-3', 'CHK-4', 'CHK-5']);
    const e1 = ex[0];
    assert.match(e1, /lib\/serializer\.js \(sha256 [0-9a-f]{12}…\) has no export asNumber/);
    assert.match(e1, /default export is class Serializer/);
    assert.match(e1, /asNumber is an instance method/);
    assert.match(e1, /"export": "default"/);
    assert.match(e1, /"construct": "new"/);
    assert.match(e1, /"method": "asNumber"/);
    assert.match(e1, /"throws": \{ "message_includes"/);
    assert.match(e1, /does not show return types, values or error messages/);
    assert.doesNotMatch(e1, /cannot be converted to a number|"0"|12\.5/, 'no answer values');
    assert.equal(s.contract.api_grounding.modules[0].sha256, PINNED_SHA);
    assert.deepEqual(s.survey.api.map((m) => [m.path, m.sha256, m.status]), [['lib/serializer.js', PINNED_SHA, 'known'], ['test/asNumber.test.js', crypto.createHash('sha256').update(PINNED_REPO['test/asNumber.test.js']).digest('hex'), 'known']]);
  });
  test('the syntax draft\'s export "Serializer" (the internal class name) is refused, not taken as a named export', async () => {
    const d = variant(REPAIRED, (x) => { for (const k of x.checks) if (k.params.module === 'lib/serializer.js') k.params.export = 'Serializer'; });
    const { s } = await produce([d, d]);
    const ex = exportErrors(s.errors);
    assert.ok(ex.length >= 5, s.errors.join('\n'));
    assert.match(ex[0], /has no export Serializer: "Serializer" is the class's own name, not an export/);
  });
  test('the correct default-class construct:new + call_sequence/throws checks are accepted (one call, no repair)', async () => {
    const { s, calls } = await produce([THROWS]);
    assert.equal(s.state, 'finalized', (s.errors || []).join('\n'));
    assert.equal(calls, 1);
  });
  test('invalid JSON then the correct draft: recovered with exactly one repair', async () => {
    const { s, calls } = await produce([SYNTAX_RAW, THROWS]);
    assert.equal(s.state, 'finalized', (s.errors || []).join('\n'));
    assert.equal(calls, 2);
    assert.equal(s.repair.attempted, true);
  });
  test('the cap holds: the refused draft twice is still two calls, then invalid', async () => {
    const { s, calls } = await produce([REPAIRED, REPAIRED, REPAIRED]);
    assert.equal(calls, 2);
    assert.equal(s.state, 'invalid');
    assert.equal(exportErrors(s.errors).length, 5);
  });
  test('dynamic exports are unknown: no export error, and the excerpt says so', async () => {
    const files = { ...PINNED_REPO, 'lib/serializer.js': "module.exports = require('./impl')\n", 'lib/impl.js': PINNED };
    const { s, prompts } = await produce([REPAIRED, REPAIRED], { files });
    assert.deepEqual(exportErrors(s.errors), []);
    assert.match(prompts[0], /lib\/serializer\.js \(sha256 [0-9a-f]{64}[^\n]*\): exports unknown/);
  });
  test('a requested new export on a module the task changes is not refused; a new file is not refused', async () => {
    const request = 'In lib/math.js, add and export a function clamp(x, lo, hi) that limits x to the range. Add node:test cases in test/math.test.js.';
    const draft = JSON.stringify({
      goal: 'clamp exists', required_behavior: ['clamp(5, 0, 3) returns 3'], constraints: [],
      scope: { allowed_changes: ['lib/math.js', 'test/math.test.js'], protected_paths: [] }, constraint_policy: [],
      acceptance_criteria: [
        { id: 'AC-1', criterion: 'clamp(5, 0, 3) returns 3', kind: 'behavioral', requirement_ids: ['R-1', 'R-2'] },
        { id: 'AC-2', criterion: 'test/math.test.js has new node:test cases for clamp', kind: 'behavioral', requirement_ids: ['R-3'], adds_tests: { files: ['test/math.test.js'] } },
      ],
      requirements: [{ id: 'R-1', passage_ids: ['P1'] }, { id: 'R-2', passage_ids: ['P2'] }, { id: 'R-3', passage_ids: ['P3'] }],
      proposed_defaults: [], verification_plan: ['call clamp'],
      checks: [{ id: 'CHK-1', ac_id: 'AC-1', adapter: 'call_returns', params: { module: 'lib/math.js', export: 'clamp', args: [5, 0, 3], expect: 3 } }],
      relevant_context: [], ambiguity_flags: [], clarifying_question: null,
    });
    const { s } = await produce([draft], { request, files: { 'lib/math.js': 'function add (a, b) { return a + b }\nmodule.exports = { add }\n', 'test/math.test.js': '' } });
    assert.deepEqual(exportErrors(s.errors || []), []);
    assert.equal(s.state, 'finalized', (s.errors || []).join('\n'));
    const created = await produce([draft.replaceAll('lib/math.js', 'lib/clamp.js')], { request: request.replace('In lib/math.js, add and export', 'Create lib/clamp.js, exporting'), files: { 'test/math.test.js': '' } });
    assert.deepEqual(exportErrors(created.s.errors || []), []);
  });
  test('a proved-absent export on an existing module the task does NOT change is refused', async () => {
    const request = 'In lib/math.js, make add() reject non-numbers. Use lib/util.js as it is. Add node:test cases in test/math.test.js.';
    const g = grounding();
    const repo = makeRepo({ 'lib/math.js': 'module.exports = { add: (a, b) => a + b }\n', 'lib/util.js': 'exports.isNum = (x) => typeof x === "number"\n' });
    try {
      const api = g.groundApi(repo.dir, request);
      const c = { scope: { allowed_changes: ['lib/math.js', 'test/math.test.js'] }, raw_request: request, api_grounding: api,
        checks: [{ id: 'CHK-9', ac_id: 'AC-1', adapter: 'call_returns', params: { module: 'lib/util.js', export: 'isNumber', args: [1], expect: true } },
          { id: 'CHK-8', ac_id: 'AC-1', adapter: 'call_returns', params: { module: 'lib/util.js', export: 'isNum', args: [1], expect: true } }] };
      const errs = g.apiGroundingErrors(c);
      assert.equal(errs.length, 1);
      assert.match(errs[0], /^CHK-9 \(AC-1\) names lib\/util\.js export isNumber, but lib\/util\.js \(sha256 [0-9a-f]{12}…\) has no export isNumber: its exports are isNum/);
    } finally { repo.cleanup(); }
  });
});
