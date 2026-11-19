/**
 * KAN-106 10758: constructorArgs must not claim safe zero-argument construction.
 *
 * At 95f9d58 a parameter stored as `this.x = p` counted as "guarded", so a class whose constructor stores a
 * REQUIRED dependency that a later method dereferences was grounded as "optional" and offered to the model;
 * any check would then throw a TypeError inside the method, not test the requested behaviour. A default
 * expression that runs code (`opts = load()`) can also throw. The fix stays bounded (no general analyser):
 *   - a parameter stored as `this.x = p` counts only when no code in the WHOLE class dereferences `this.x`
 *     (returned as is, or read behind a guard); passing it on, aliasing it, calling it, a computed this[...]
 *     or `this` escaping is refused. `this.x && this.x.y` is refused too (not followed: conservative);
 *   - a default is accepted only when it is inert (a literal, `undefined`, or an object/array/template
 *     literal made only of those); anything that runs code is required_or_unknown;
 *   - the grounded label is 'appears_optional', and the record and prompt say a static reading is not
 *     proof that construction succeeds (only running the checks on the controls shows that).
 * No model calls: the model is faked in-process.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { mockFetch, ollamaReply } = require('../helpers/mocks');
const { groundSource, requestNames } = require('../../intent/api-grounding');
const staged = () => require('../../intent/staged');

const FIX = path.join(__dirname, '..', 'fixtures', 'kan106');
const REQUEST_ASNUMBER = fs.readFileSync(path.join(FIX, 'request.txt'), 'utf8').trim();
const PINNED = fs.readFileSync(path.join(FIX, 'pinned-fast-json-stringify/serializer-07d7196.js'), 'utf8');
const targetsOf = (rel, text, request) => staged().callTargets(request, { modules: [groundSource(rel, text, requestNames(request))] });
const REQUEST = 'In lib/store.js, make Store.get() return null for a missing id.';
const cls = (ctor, method = 'get (id) { return this.db.find(id) || null }') => `class Store {\n  ${ctor}\n  ${method}\n}\nmodule.exports = Store\n`;

describe('a constructor that stores a required dependency later dereferenced is refused', () => {
  test('constructor (db) { this.db = db } + get() dereferences this.db: unsupported, reason names the constructor', () => {
    const [t] = targetsOf('lib/store.js', cls('constructor (db) { this.db = db }'), REQUEST);
    assert.equal(t.grounding, 'unsupported');
    assert.match(t.reason, /constructor/);
    assert.equal(t.constructor_args, 'required_or_unknown');
  });
  for (const [name, method] of Object.entries({
    'passed on': 'get (id) { return find(this.db, id) }',
    'aliased': 'get (id) { const d = this.db; return d.find(id) }',
    'called': 'get (id) { return this.db(id) }',
    'read behind a guard, then dereferenced (not followed: conservative)': 'get (id) { return this.db && this.db.find(id) }',
    '`this` escapes': 'get (id) { return lookup(this, id) }',
    'a computed this[...] read': "get (id) { return this['db'].find(id) }",
  })) {
    test(`the stored field is ${name}: unsupported`, () => {
      const [t] = targetsOf('lib/store.js', cls('constructor (db) { this.db = db }', method), REQUEST);
      assert.equal(t.grounding, 'unsupported', name);
    });
  }
  test('the store is followed over the WHOLE class, not only the excerpt: a dereference in an unrelated method is refused', () => {
    const filler = Array.from({ length: 80 }, (_, i) => `  m${i} () { return ${i} }`).join('\n');
    const src = `class Store {\n  constructor (db) { this.db = db }\n  get (id) { return null }\n${filler}\n  close () { return this.db.close() }\n}\nmodule.exports = Store\n`;
    const [t] = targetsOf('lib/store.js', src, REQUEST);
    assert.equal(t.grounding, 'unsupported');
  });
  test('L1 refuses before any model call, naming the unsupported call shape', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kan106-ctor-'));
    fs.mkdirSync(path.join(dir, 'lib'));
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"s"}');
    fs.writeFileSync(path.join(dir, 'lib/store.js'), cls('constructor (db) { this.db = db }'));
    const sent = [];
    const m = mockFetch(async (url, init) => { sent.push(url); return ollamaReply('{}'); });
    const { l1Budget } = require('../../lib/budget');
    try {
      const s = await require('../../intent/session').compileIntent(REQUEST, { repoPath: dir, l1Budget: l1Budget({ profile: 'qwen-14b-staged' }) });
      assert.deepEqual(sent, []);
      assert.equal(s.state, 'invalid');
      assert.match(s.errors.join('\n'), /unsupported call shape .*constructor/);
    } finally { m.restore(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('default parameter expressions: only inert defaults count', () => {
  for (const [name, ctor] of Object.entries({
    'a call': 'constructor (opts = loadConfig()) { this.n = 1 }',
    'a new': 'constructor (opts = new Options()) { this.n = 1 }',
    'an identifier': 'constructor (opts = DEFAULTS) { this.n = 1 }',
    'an object holding a call': 'constructor (opts = { db: connect() }) { this.n = 1 }',
    'an object spread': 'constructor (opts = { ...BASE }) { this.n = 1 }',
    'a template with an expression': 'constructor (opts = `${x}`) { this.n = 1 }',
  })) {
    test(`a default that runs code (${name}): required_or_unknown`, () => {
      const [t] = targetsOf('lib/store.js', cls(ctor, 'get (id) { return null }'), REQUEST);
      assert.equal(t.grounding, 'unsupported', name);
      assert.equal(t.constructor_args, 'required_or_unknown', name);
    });
  }
  for (const [name, ctor] of Object.entries({
    'an empty object': 'constructor (opts = {}) { this.n = 1 }',
    'an object of literals': "constructor (opts = { step: 1, name: 'a', on: true, x: null, y: undefined, z: -1 }) { this.n = 1 }",
    'an array of literals': 'constructor (xs = [1, 2]) { this.n = 1 }',
    'a plain template': 'constructor (s = `a`) { this.n = 1 }',
  })) {
    test(`an inert default (${name}): grounded, appears_optional`, () => {
      const [t] = targetsOf('lib/store.js', cls(ctor, 'get (id) { return null }'), REQUEST);
      assert.equal(t.grounding, 'grounded', name);
      assert.equal(t.constructor_args, 'appears_optional', name);
    });
  }
});

describe('the label and wording claim no proof', () => {
  test('a parameter read only behind a guard stays grounded, labelled appears_optional (not "optional")', () => {
    const [t] = targetsOf('lib/store.js', cls('constructor (opts) { this.step = (opts && opts.step) || 1 }', 'get (id) { return null }'), REQUEST);
    assert.deepEqual([t.grounding, t.constructor_args], ['grounded', 'appears_optional']);
  });
  for (const [name, method] of Object.entries({
    'never read': 'get (id) { return null }',
    'returned as is': 'state () { return this.db }',
    'tested behind a guard only': 'ready () { return this.db ? 1 : 0 }',
  })) {
    test(`a stored field that is ${name}: grounded, appears_optional`, () => {
      const [t] = targetsOf('lib/store.js', cls('constructor (db) { this.db = db }', `get (id) { return null }\n  ${method}`), REQUEST);
      assert.deepEqual([t.grounding, t.constructor_args], ['grounded', 'appears_optional'], name);
    });
  }
  test('the pinned Serializer (options read behind a guard; stored as this._options, only returned as is by getState()) stays grounded: appears_optional', () => {
    const [t] = targetsOf('lib/serializer.js', PINNED, REQUEST_ASNUMBER);
    assert.deepEqual([t.label, t.grounding, t.constructor_args], ['Serializer.asNumber (lib/serializer.js)', 'grounded', 'appears_optional']);
  });
  test('the prompt actually sent to the (faked) model says a static reading is not proof that construction succeeds', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kan106-ctor-'));
    fs.mkdirSync(path.join(dir, 'lib'));
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"s"}');
    fs.writeFileSync(path.join(dir, 'lib/store.js'), cls('constructor (opts = {}) { this.n = 1 }', 'get (id) { return null }'));
    const prompts = [];
    const m = mockFetch(async (url, init) => { prompts.push(JSON.parse(init.body).messages[1].content); return ollamaReply('{"cases":[]}'); });
    const { l1Budget } = require('../../lib/budget');
    try {
      await require('../../intent/session').compileIntent(REQUEST, { repoPath: dir, l1Budget: l1Budget({ profile: 'qwen-14b-staged' }) });
    } finally { m.restore(); fs.rmSync(dir, { recursive: true, force: true }); }
    assert.ok(prompts.length >= 1);
    const line = prompts[0].split('\n').find((l) => l.includes('Store.get'));
    assert.ok(line, prompts[0]);
    assert.doesNotMatch(line, /arguments are optional/);
    assert.match(line, /not proof that construction succeeds/);
  });
});
