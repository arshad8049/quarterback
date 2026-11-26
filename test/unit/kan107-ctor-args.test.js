/**
 * KAN-107 (10771 B) on the 10835 split: `default.ctor_args` on QB's grounding, i.e. may QB construct the default
 * class with `new` and no arguments? intent/ctor-args.js is copied verbatim from intent/staged.js (2150ab6), so
 * these are the KAN-106 10758 cases (test/unit/kan106-10758-constructor.test.js on kan107-consistency-design),
 * asserted through the producer that writes ctor_args (intent/api-grounding.js groundApi -> withCtorArgs) instead
 * of through the staged compiler's callTargets. A static reading is NOT proof that construction succeeds.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { groundApi } = require('../../intent/api-grounding');

const FIX = path.join(__dirname, '..', 'fixtures', 'kan106');
const REQUEST_ASNUMBER = fs.readFileSync(path.join(FIX, 'request.txt'), 'utf8').trim();
const PINNED = fs.readFileSync(path.join(FIX, 'pinned-fast-json-stringify/serializer-07d7196.js'), 'utf8');
const REQUEST = 'In lib/store.js, make Store.get() return null for a missing id.';
const cls = (ctor, method = 'get (id) { return this.db.find(id) || null }') => `class Store {\n  ${ctor}\n  ${method}\n}\nmodule.exports = Store\n`;

/** The ctor_args QB records for `rel` holding `text`, read by the real groundApi from a temporary repository. */
function ctorArgs(rel, text, request = REQUEST) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kan107-ctor-'));
  try {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
    const m = groundApi(dir, request).modules.find((x) => x.path === rel);
    assert.equal(m.status, 'known', JSON.stringify(m));
    return m.default.ctor_args;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

describe('a constructor that stores a required dependency later dereferenced: required_or_unknown', () => {
  test('constructor (db) { this.db = db } + get() dereferences this.db', () => {
    assert.equal(ctorArgs('lib/store.js', cls('constructor (db) { this.db = db }')), 'required_or_unknown');
  });
  for (const [name, method] of Object.entries({
    'passed on': 'get (id) { return find(this.db, id) }',
    'aliased': 'get (id) { const d = this.db; return d.find(id) }',
    'called': 'get (id) { return this.db(id) }',
    'read behind a guard, then dereferenced (not followed: conservative)': 'get (id) { return this.db && this.db.find(id) }',
    '`this` escapes': 'get (id) { return lookup(this, id) }',
    'a computed this[...] read': "get (id) { return this['db'].find(id) }",
  })) {
    test(`the stored field is ${name}`, () => {
      assert.equal(ctorArgs('lib/store.js', cls('constructor (db) { this.db = db }', method)), 'required_or_unknown', name);
    });
  }
  test('the store is followed over the WHOLE class: a dereference in an unrelated method far from the constructor', () => {
    const filler = Array.from({ length: 80 }, (_, i) => `  m${i} () { return ${i} }`).join('\n');
    const src = `class Store {\n  constructor (db) { this.db = db }\n  get (id) { return null }\n${filler}\n  close () { return this.db.close() }\n}\nmodule.exports = Store\n`;
    assert.equal(ctorArgs('lib/store.js', src), 'required_or_unknown');
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
      assert.equal(ctorArgs('lib/store.js', cls(ctor, 'get (id) { return null }')), 'required_or_unknown', name);
    });
  }
  for (const [name, ctor] of Object.entries({
    'an empty object': 'constructor (opts = {}) { this.n = 1 }',
    'an object of literals': "constructor (opts = { step: 1, name: 'a', on: true, x: null, y: undefined, z: -1 }) { this.n = 1 }",
    'an array of literals': 'constructor (xs = [1, 2]) { this.n = 1 }',
    'a plain template': 'constructor (s = `a`) { this.n = 1 }',
  })) {
    test(`an inert default (${name}): appears_optional`, () => {
      assert.equal(ctorArgs('lib/store.js', cls(ctor, 'get (id) { return null }')), 'appears_optional', name);
    });
  }
});

describe('the label claims no proof; none / appears_optional only', () => {
  test('no constructor at all: none', () => {
    assert.equal(ctorArgs('lib/store.js', 'class Store {\n  get (id) { return null }\n}\nmodule.exports = Store\n'), 'none');
  });
  test('a parameter read only behind a guard: appears_optional (not "optional")', () => {
    assert.equal(ctorArgs('lib/store.js', cls('constructor (opts) { this.step = (opts && opts.step) || 1 }', 'get (id) { return null }')), 'appears_optional');
  });
  for (const [name, method] of Object.entries({
    'never read': 'get (id) { return null }',
    'returned as is': 'state () { return this.db }',
    'tested behind a guard only': 'ready () { return this.db ? 1 : 0 }',
  })) {
    test(`a stored field that is ${name}: appears_optional`, () => {
      assert.equal(ctorArgs('lib/store.js', cls('constructor (db) { this.db = db }', `get (id) { return null }\n  ${method}`)), 'appears_optional', name);
    });
  }
  test('the pinned Serializer (options read behind a guard; stored as this._options, only returned as is): appears_optional', () => {
    assert.equal(ctorArgs('lib/serializer.js', PINNED, REQUEST_ASNUMBER), 'appears_optional');
  });
  test('only a default-export CLASS gets ctor_args; functions and objects do not', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kan107-ctor-'));
    try {
      fs.mkdirSync(path.join(dir, 'lib'));
      fs.writeFileSync(path.join(dir, 'lib/f.js'), 'function f () { return 1 }\nmodule.exports = { f }\n');
      const m = groundApi(dir, 'In lib/f.js, make f() return 2.').modules[0];
      assert.equal(m.status, 'known');
      assert.equal(m.default && m.default.ctor_args, undefined);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
