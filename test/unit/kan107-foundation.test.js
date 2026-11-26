/**
 * KAN-107 foundation (senior 10835, item 2): the request-passage, request-target and static API-grounding
 * helpers that the request-to-check consistency fix (intent/request-examples.js) reads, tested as helpers.
 *
 * The modules are the KAN-106 versions at f907d97, unchanged. Nothing here is wired into the default path
 * (no prompt, validator or contract field changes): the compiler, session and contract state do not require
 * them on this branch. The assertions are taken from the KAN-106 tests that covered these helpers
 * (kan106-l1-passage-ids, kan106-10674-scope-evidence F-a, kan106-10706-api-grounding (b),
 * kan106-10710-source-excerpts (2)); the parts of those files that test wiring, prompts, budgets or the
 * staged prototype stay on the combined branch (kan107-consistency-design) and are not claimed here.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FIX = path.join(__dirname, '..', 'fixtures', 'kan106');
const read = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');
const REQUEST = read('request.txt').trim();
const PINNED = read('pinned-fast-json-stringify/serializer-07d7196.js');
const PINNED_SHA = crypto.createHash('sha256').update(PINNED).digest('hex');
const MUT = (f) => read(path.join('export-mutations', f));

const passages = () => require('../../intent/passages');
const targets = () => require('../../intent/request-targets');
const grounding = () => require('../../intent/api-grounding');

function makeRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kan107-foundation-'));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const EXPECTED_PASSAGES = [
  'In lib/serializer.js,',
  'make Serializer.asNumber() throw a number conversion error for an empty string or a string containing only whitespace instead of returning 0.',
  'Keep the behavior for numeric 0,',
  'string "0",',
  'and valid numeric strings.',
  'Add node:test cases in test/asNumber.test.js.',
];

describe('foundation: request passages (intent/passages.js, split rule)', () => {
  test('the smoke request splits into six passages at sentence and clause ends; paths, method calls and node:test stay whole', () => {
    const ps = passages().splitPassages(REQUEST);
    assert.deepEqual(ps.map((p) => p.id), ['P1', 'P2', 'P3', 'P4', 'P5', 'P6']);
    assert.deepEqual(ps.map((p) => p.text), EXPECTED_PASSAGES);
    for (const p of ps) assert.equal(REQUEST.slice(p.start, p.end), p.text, `${p.id} is the exact source text`);
    // The passages tile the request: only whitespace lies between them.
    let at = 0;
    for (const p of ps) { assert.match(REQUEST.slice(at, p.start), /^\s*$/); at = p.end; }
    assert.match(REQUEST.slice(at), /^\s*$/);
  });

  test('no split inside parentheses, brackets or backticks, or at a dot/colon/comma not followed by whitespace; newlines and ;?! end passages', () => {
    const texts = (s) => passages().splitPassages(s).map((p) => p.text);
    assert.deepEqual(texts('Make clamp(5, 0, 3) return 3. Keep `a, b` as is'), ['Make clamp(5, 0, 3) return 3.', 'Keep `a, b` as is']);
    assert.deepEqual(texts('Fix src/a.js; keep 1,000 and v1.2.3 intact? Yes!'), ['Fix src/a.js;', 'keep 1,000 and v1.2.3 intact?', 'Yes!']);
    assert.deepEqual(texts('Say "stop." Then go\n- add tests\n- update docs'), ['Say "stop."', 'Then go', '- add tests', '- update docs']);
    assert.deepEqual(texts('   '), []);
  });

  test('resolveInRequest copies the exact text of adjacent cited passages; unknown or non-adjacent ids are errors', () => {
    const { resolveInRequest } = passages();
    const r = resolveInRequest(REQUEST, ['P3', 'P4', 'P5']);
    assert.equal(r.ok, true);
    assert.equal(r.text, 'Keep the behavior for numeric 0, string "0", and valid numeric strings.');
    assert.equal(resolveInRequest(REQUEST, ['P9']).ok, false);
    assert.equal(resolveInRequest(REQUEST, ['P1', 'P3']).ok, false);
  });
});

describe('foundation: the request\'s own file targets (intent/request-targets.js), derived narrowly from the request text', () => {
  test('the smoke request: lib/serializer.js is an edit target (location + verb), test/asNumber.test.js an add-tests target', () => {
    const r = targets().requestTargets(REQUEST);
    assert.deepEqual(r.targets.map((t) => [t.path, t.action, t.passage_id]), [['lib/serializer.js', 'edit', 'P1'], ['test/asNumber.test.js', 'add_tests', 'P6']]);
    assert.deepEqual(r.ambiguous, []);
  });
  test('references, read-only instructions, negations and plain mentions are NOT targets (and never grant permission)', () => {
    const { requestTargets } = targets();
    const cases = [
      ['See src/c.js for the pattern.', 'reference'],
      ['Update src/cart.js to reject negative quantities, following the style of src/order.js.', 'reference', 'src/order.js'],
      ['Read config/app.json and make clamp work.', 'reference'],
      ['Do not change src/b.js.', 'negated'],
      ['Leave README.md unchanged.', 'negated'],
      ['Add tests to test/x.test.js without editing lib/y.js.', 'negated'],
      ['Treat docs/api.md as read-only.', 'negated'],
      ['Fix the bug in src/a.js.', 'mentioned'],
    ];
    for (const [req, why, p] of cases) {
      const r = requestTargets(req);
      const file = p || r.ignored[0]?.path;
      assert.ok(!r.targets.some((t) => t.path === file), `${req}: ${file} must not be a target`);
      assert.equal(r.ignored.find((x) => x.path === file)?.why, why, req);
    }
    assert.deepEqual(requestTargets('Update src/cart.js to reject negative quantities, following the style of src/order.js.').targets.map((t) => t.path), ['src/cart.js']);
    assert.deepEqual(requestTargets('Leave README.md unchanged. Create src/new.js.').targets.map((t) => [t.path, t.action]), [['src/new.js', 'add']]);
  });
  test('"In <path>, do not …" is reported as ambiguous, never as a target', () => {
    const r = targets().requestTargets('In lib/a.js, do not change the parser.');
    assert.deepEqual(r.targets, []);
    assert.deepEqual(r.ambiguous.map((a) => a.path), ['lib/a.js']);
  });
});

describe('foundation: static API grounding of literal export forms (intent/api-grounding.js)', () => {
  test('the pinned serializer: default class export, its instance methods, its one static member; path + sha256 provenance', () => {
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
    assert.deepEqual(g.named, [{ name: 'restoreFromState', kind: 'function' }]);
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
    const marker = path.join(os.tmpdir(), `qb-kan107-foundation-executed-${process.pid}`);
    const repo = makeRepo({ 'lib/side.js': `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')\nglobalThis.__qb107f = 1\nmodule.exports = { a: 1 }\n` });
    try {
      const g = grounding().groundApi(repo.dir, 'In lib/side.js, change a. Also see lib/missing.js and ../outside.js.');
      const side = g.modules.find((x) => x.path === 'lib/side.js');
      assert.equal(side.status, 'known'); assert.deepEqual(side.named.map((x) => x.name), ['a']);
      assert.equal(fs.existsSync(marker), false, 'the module ran');
      assert.equal(globalThis.__qb107f, undefined);
      assert.equal(g.modules.find((x) => x.path === 'lib/missing.js').status, 'unknown');
      assert.equal(g.modules.some((x) => x.path.includes('..')), false);
    } finally { repo.cleanup(); fs.rmSync(marker, { force: true }); }
  });
  test('the contract form of the grounding carries provenance only: no source text survives serialization', () => {
    const repo = makeRepo({ 'lib/serializer.js': PINNED });
    try {
      const api = grounding().groundApi(repo.dir, REQUEST);
      const m = api.modules.find((x) => x.path === 'lib/serializer.js');
      assert.ok(m.excerpts.length > 0 && m.excerpts.every((b) => typeof b.text === 'string'), 'excerpt text is available to QB in memory');
      const recorded = JSON.parse(JSON.stringify(grounding().contractGrounding(api)));
      const rm = recorded.modules.find((x) => x.path === 'lib/serializer.js');
      assert.equal(rm.sha256, PINNED_SHA);
      assert.ok(rm.excerpts.every((b) => b.text === undefined));
      assert.equal(JSON.stringify(recorded).includes('cannot be converted'), false);
    } finally { repo.cleanup(); }
  });
});

describe('foundation: mutation through an exported binding makes the inventory unknown (synthetic fixtures)', () => {
  const ground = (file, mod = 'lib/m.js') => {
    const repo = makeRepo({ [mod]: MUT(file) });
    try { return grounding().groundApi(repo.dir, `Read ${mod} as it is. In lib/other.js, add a helper.`).modules.find((x) => x.path === mod); } finally { repo.cleanup(); }
  };
  for (const [file, mod] of [['static-assign.js'], ['object-assign.js'], ['reassigned-declaration.js'], ['class-self-mutation.js'], ['esm-default-object.mjs', 'lib/m.mjs'], ['esm-default-class-assign.mjs', 'lib/m.mjs']]) {
    test(`${file}: unknown`, () => { const m = ground(file, mod); assert.equal(m.status, 'unknown', JSON.stringify(m)); });
  }
  test('control: an unmutated exported class stays known', () => {
    assert.equal(ground('plain-class-control.js').status, 'known');
  });
});
