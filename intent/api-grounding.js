/**
 * intent/api-grounding.js: static API grounding of the modules a request names (KAN-106, senior 10706).
 *
 * Smoke 0ae9efc9: the repaired draft's checks called `export: "asNumber"` on lib/serializer.js, whose
 * only export is `module.exports = class Serializer` (asNumber is an instance method). The survey had
 * not even shown that file to the model (it picked four test files). This module:
 *   - reads each .js/.cjs/.mjs path the REQUEST names (at most MAX_MODULES, MAX_BYTES each, inside the
 *     repository, regular files only), records path + sha256 + bytes;
 *   - parses it with acorn (static: the file is never require'd, imported or executed) and reads only
 *     these literal forms:
 *       CommonJS  module.exports = class X {…} | function … | { a, b: …, c () {} } | <top-level class/function name>
 *                 module.exports.a = …   exports.a = …
 *       ESM       export function|class|const|let|var …   export { a, b as c }   export default …
 *     Anything else that touches the exports (a require()'d value, Object.assign, spreads, computed
 *     keys, exports[x], re-exports, `export *`, a class that extends another, unparseable or oversized
 *     source) makes the module's exports `unknown`. Unknown never causes a rejection.
 *   - gives the model a short excerpt (names and shape only) in the first and the repair input;
 *   - refuses a check naming an export that is PROVED absent from an existing API (apiGroundingErrors).
 *     When the task may change the module, only the demonstrated confusion is refused (a method of the
 *     default class, or the class's own name, used as an export) and only when the request does not
 *     ask to export that name; any other missing name there may be requested new API and is allowed.
 * Static export facts say nothing about return types, values or error messages.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SCHEMA = 'qb-api-grounding/1';
const MAX_MODULES = 8;
const MAX_BYTES = 256 * 1024;
const JS_PATH = /`?((?:[A-Za-z0-9_@-][A-Za-z0-9_.@-]*\/)*[A-Za-z0-9_@-][A-Za-z0-9_.@-]*\.(?:c|m)?js)`?(?![A-Za-z0-9_/])/g;
const NOT_PROVABLE = new Set([...Object.getOwnPropertyNames(Function.prototype), ...Object.getOwnPropertyNames(Object.prototype), 'name', 'length', 'prototype', '__esModule']);
const NOTE = 'QB read these files statically; nothing was run. This lists export and method NAMES only: it does not show return types, values or error messages.';

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const unknown = (base, reason) => ({ ...base, status: 'unknown', reason });

/** Request-named JS paths, in order, without duplicates; never absolute or with "..". */
function requestModules(request) {
  const out = [];
  for (const m of String(request || '').matchAll(JS_PATH)) {
    const p = m[1];
    const before = String(request).slice(Math.max(0, m.index - 3), m.index);
    if (/\.\.\/?$|\/$/.test(before) || p.split('/').some((s) => s === '' || s === '.' || s === '..')) continue;
    if (!out.includes(p)) out.push(p);
  }
  return out.slice(0, MAX_MODULES);
}

/** Ground every request-named module of the repository at repoPath. */
function groundApi(repoPath, request) {
  const root = fs.realpathSync(path.resolve(repoPath));
  const modules = requestModules(request).map((rel) => {
    let file;
    try { file = fs.realpathSync(path.join(root, rel)); } catch { return unknown({ path: rel, sha256: null, bytes: null }, 'no such file (it may be a file the task creates)'); }
    if (!file.startsWith(root + path.sep)) return unknown({ path: rel, sha256: null, bytes: null }, 'resolves outside the repository');
    try {
      const st = fs.statSync(file);
      if (!st.isFile()) return unknown({ path: rel, sha256: null, bytes: null }, 'not a regular file');
      if (st.size > MAX_BYTES) return unknown({ path: rel, sha256: null, bytes: st.size }, `larger than ${MAX_BYTES} bytes`);
      const buf = fs.readFileSync(file);
      return withForm({ ...groundSource(rel, buf.toString('utf8')), sha256: sha(buf), bytes: buf.length });   // provenance: the file's own bytes
    } catch (e) { return unknown({ path: rel, sha256: null, bytes: null }, `could not be read (${e.code || 'error'})`); }
  });
  return { schema: SCHEMA, modules };
}

/** The exports of one module's source text (see the header for the forms read). */
function groundSource(rel, text) {
  const base = { path: rel, sha256: sha(text), bytes: Buffer.byteLength(text) };
  const acorn = require('acorn');
  const opts = { ecmaVersion: 'latest', allowHashBang: true, allowReturnOutsideFunction: true, locations: false };
  let ast = null;
  let format = null;
  if (!rel.endsWith('.mjs')) { try { ast = acorn.parse(text, { ...opts, sourceType: 'script' }); format = 'commonjs'; } catch { /* try ESM */ } }
  if (!ast && !rel.endsWith('.cjs')) { try { ast = acorn.parse(text, { ...opts, sourceType: 'module', allowReturnOutsideFunction: false }); format = 'esm'; } catch { /* unparseable */ } }
  if (!ast) return unknown(base, 'the source does not parse');
  const isEsm = ast.body.some((n) => /^Export|^ImportDeclaration$/.test(n.type));
  const r = isEsm ? esmExports(ast) : cjsExports(ast);
  if (r.unknown) return unknown({ ...base, format: isEsm ? 'esm' : format }, r.unknown);
  return { ...base, format: isEsm ? 'esm' : 'commonjs', status: 'known', default: r.default, named: r.named };
}

/** Every node of the tree (a plain recursive walk, no evaluation). */
function* nodes(n, parent = null, key = null) {
  if (!n || typeof n.type !== 'string') return;
  yield [n, parent, key];
  for (const [k, v] of Object.entries(n)) {
    if (Array.isArray(v)) for (const c of v) yield* nodes(c, n, k);
    else if (v && typeof v === 'object' && typeof v.type === 'string') yield* nodes(v, n, k);
  }
}
const isId = (n, name) => n && n.type === 'Identifier' && n.name === name;
const isModuleExports = (n) => n && n.type === 'MemberExpression' && !n.computed && isId(n.object, 'module') && isId(n.property, 'exports');
const keyName = (k, computed) => (computed ? null : k.type === 'Identifier' ? k.name : k.type === 'Literal' && typeof k.value === 'string' ? k.value : null);

/** A class node's shape: instance methods, accessors and static members; null when it extends something. */
function classShape(c, name = null) {
  if (c.superClass) return null;
  const methods = []; const accessors = []; const statics = [];
  for (const m of c.body.body) {
    if (m.type === 'StaticBlock') return null;
    const k = keyName(m.key, m.computed);
    if (k === null || m.key.type === 'PrivateIdentifier') { if (m.computed) return null; continue; }
    if (m.static) { statics.push({ name: k, kind: m.type === 'MethodDefinition' && m.kind === 'method' ? 'function' : 'value' }); continue; }
    if (m.type !== 'MethodDefinition' || m.kind === 'constructor') continue;
    (m.kind === 'method' ? methods : accessors).push(k);
  }
  return { kind: 'class', name: name || (c.id && c.id.name) || null, methods, accessors, statics };
}
function valueKind(v, decls) {
  if (!v) return 'value';
  if (/^(?:Arrow)?Function(?:Expression|Declaration)$/.test(v.type)) return 'function';
  if (/^Class/.test(v.type)) return 'class';
  if (v.type === 'Identifier' && decls.has(v.name)) return decls.get(v.name).type === 'ClassDeclaration' ? 'class' : 'function';
  return 'value';
}

function cjsExports(ast) {
  const decls = new Map();
  for (const s of ast.body) if ((s.type === 'FunctionDeclaration' || s.type === 'ClassDeclaration') && s.id) decls.set(s.id.name, s);
  for (const [n] of nodes(ast)) {
    // a local binding called module or exports makes every reference ambiguous
    if (n.type === 'VariableDeclarator' && (isId(n.id, 'module') || isId(n.id, 'exports'))) return { unknown: 'module or exports is redeclared' };
    if (/^(?:Function(?:Declaration|Expression)|ArrowFunctionExpression)$/.test(n.type) && n.params.some((q) => isId(q, 'module') || isId(q, 'exports'))) return { unknown: 'module or exports is shadowed' };
  }
  // every reference to module.exports / exports, and those consumed by a recognized statement
  const refs = new Set();
  for (const [n, parent, key] of nodes(ast)) {
    if (isModuleExports(n)) refs.add(n);
    else if (isId(n, 'exports') && !(parent && parent.type === 'MemberExpression' && key === 'property' && !parent.computed)
      && !(parent && parent.type === 'Property' && key === 'key' && !parent.computed)) refs.add(n);
    else if (isId(n, 'module') && parent && parent.type === 'MemberExpression' && key === 'object' && parent.computed) return { unknown: 'module[…] is used' };
  }
  const used = new Set();
  let def = null; let reassigned = 0; let sawExportsDot = false;
  const named = [];
  const put = (name, kind) => { const i = named.findIndex((x) => x.name === name); if (i >= 0) named.splice(i, 1); named.push({ name, kind }); };
  for (const s of ast.body) {
    if (s.type !== 'ExpressionStatement' || s.expression.type !== 'AssignmentExpression' || s.expression.operator !== '=') continue;
    const { left, right } = s.expression;
    if (isModuleExports(left)) {
      if (sawExportsDot || reassigned++) return { unknown: 'module.exports is assigned more than once' };
      used.add(left);
      if (/^Class/.test(right.type)) { def = classShape(right); if (!def) return { unknown: 'the exported class extends another class (inherited members are not read)' }; continue; }
      if (/^(?:Arrow)?FunctionExpression$/.test(right.type)) { def = { kind: 'function', name: (right.id && right.id.name) || null }; continue; }
      if (right.type === 'Identifier' && decls.has(right.name)) {
        const d = decls.get(right.name);
        def = d.type === 'ClassDeclaration' ? classShape(d) : { kind: 'function', name: d.id.name };
        if (!def) return { unknown: 'the exported class extends another class (inherited members are not read)' };
        continue;
      }
      if (right.type === 'ObjectExpression') {
        def = { kind: 'object' };
        for (const p of right.properties) {
          if (p.type !== 'Property' || p.kind !== 'init') return { unknown: 'module.exports = { … } has a spread or accessor' };
          const k = keyName(p.key, p.computed);
          if (k === null) return { unknown: 'module.exports = { … } has a computed key' };
          put(k, p.method ? 'function' : valueKind(p.value, decls));
        }
        for (const [n] of nodes(right)) if (refs.has(n)) return { unknown: 'module.exports refers to itself' };
        continue;
      }
      return { unknown: `module.exports is assigned a ${right.type} QB does not read statically` };
    }
    if (left.type === 'MemberExpression' && !left.computed && (isModuleExports(left.object) || isId(left.object, 'exports'))) {
      if (isId(left.object, 'exports')) { if (reassigned) return { unknown: 'exports.x is used after module.exports was replaced' }; sawExportsDot = true; }
      used.add(left.object);
      put(left.property.name, valueKind(right, decls));
    }
  }
  for (const r of refs) if (!used.has(r)) return { unknown: 'module.exports or exports is used in a form QB does not read statically' };
  if (!def) def = { kind: 'object' };
  if (def.kind === 'class') for (const st of def.statics) if (!named.some((x) => x.name === st.name)) named.unshift(st);
  return { default: def, named };
}

function esmExports(ast) {
  let def = null;
  const named = [];
  for (const s of ast.body) {
    if (s.type === 'ExportAllDeclaration') return { unknown: 'export * re-exports another module' };
    if (s.type === 'ExportNamedDeclaration') {
      if (s.source) return { unknown: 'export { … } from re-exports another module' };
      const d = s.declaration;
      if (d && (d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration')) named.push({ name: d.id.name, kind: d.type === 'ClassDeclaration' ? 'class' : 'function' });
      else if (d && d.type === 'VariableDeclaration') {
        for (const v of d.declarations) { if (v.id.type !== 'Identifier') return { unknown: 'a destructured export' }; named.push({ name: v.id.name, kind: valueKind(v.init, new Map()) }); }
      }
      for (const sp of s.specifiers || []) {
        const name = keyName(sp.exported, false);
        if (name === 'default') def = { kind: 'value' };
        else if (name) named.push({ name, kind: 'value' });
      }
    }
    if (s.type === 'ExportDefaultDeclaration') {
      const d = s.declaration;
      if (/^Class/.test(d.type)) { def = classShape(d); if (!def) return { unknown: 'the exported class extends another class (inherited members are not read)' }; }
      else def = { kind: /Function/.test(d.type) ? 'function' : 'value', name: (d.id && d.id.name) || null };
    }
  }
  for (const [n] of nodes(ast)) if (isModuleExports(n) || isId(n, 'exports')) return { unknown: 'an ES module that also uses module.exports / exports' };
  return { default: def, named };
}

const short = (h) => (h ? `${h.slice(0, 12)}…` : 'no hash');
const list = (xs) => (xs.length ? xs.join(', ') : 'none');
function defaultForm(m) {
  const d = m.default;
  if (!d) return null;
  if (d.kind === 'class') return m.format === 'esm' ? `export default class${d.name ? ` ${d.name}` : ''}` : `module.exports = class${d.name ? ` ${d.name}` : ''}`;
  return null;
}
function withForm(m) {
  if (m.status === 'known' && m.default && m.default.kind === 'class') m.default.form = defaultForm(m);
  return m;
}

/** A step shape for calling a method of the default class (placeholders only, no values). */
function classCallShape(method) {
  return `a call_sequence check with "export": "default", "instances": { "s": { "construct": "new", "args": [] } } and steps { "on": "s", "method": "${method}", "args": [ … ], "expect": … } or { "on": "s", "method": "${method}", "args": [ … ], "throws": { "message_includes": "…" } }`;
}

/** The excerpt both model inputs carry (first draft and repair). */
function groundingExcerpt(g) {
  const mods = (g && Array.isArray(g.modules) ? g.modules : []);
  if (!mods.length) return '';
  const lines = [`SOURCE API of the files the request names. ${NOTE} "unknown" means QB could not tell, not that something is missing.`];
  for (const raw of mods) {
    const m = withForm({ ...raw });
    const head = `- ${m.path} (sha256 ${m.sha256 || 'none'}${m.bytes !== null && m.bytes !== undefined ? `, ${m.bytes} bytes` : ''}${m.format ? `, ${m.format === 'esm' ? 'ES module' : 'CommonJS'}` : ''})`;
    if (m.status !== 'known') { lines.push(`${head}: exports unknown (${m.reason})`); continue; }
    lines.push(`${head}:`);
    const d = m.default;
    if (d && d.kind === 'class') {
      lines.push(`  default export: class${d.name ? ` ${d.name}` : ''} (${d.form})`);
      lines.push(`  instance methods: ${list(d.methods)}${d.accessors.length ? `; accessors: ${list(d.accessors)}` : ''}`);
      const statics = m.named.map((x) => x.name);
      lines.push(`  named exports: ${statics.length ? `${list(statics)} (static members)` : 'none'}.${d.name && !statics.includes(d.name) ? ` "${d.name}" is the class's own name, not an export.` : ''}`);
      if (d.methods.length) lines.push(`  to call an instance method: ${classCallShape('<method>')}`);
    } else {
      if (d && d.kind !== 'object') lines.push(`  default export: ${d.kind}${d.name ? ` ${d.name}` : ''}`);
      lines.push(`  named exports: ${list(m.named.map((x) => `${x.name} (${x.kind})`))}`);
    }
  }
  return lines.join('\n');
}

/** For run records: what was grounded, without source. */
const apiSummary = (g) => (g && Array.isArray(g.modules) ? g.modules.map((m) => ({ path: m.path, sha256: m.sha256, bytes: m.bytes, status: m.status, ...(m.status === 'known' ? {} : { reason: m.reason }) })) : null);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Does the request explicitly ask to export this name? (conservative: any "export" next to the name in one sentence) */
function requestExports(request, name) {
  const n = escapeRe(name);
  return new RegExp(`\\bexport\\w*\\b[^.!?]*\\b${n}\\b|\\b${n}\\b[^.!?]*\\bexport\\w*\\b`, 'i').test(String(request || ''));
}

/**
 * Checks naming an export proved absent from an existing API. Uses only QB's own api_grounding on
 * the contract (assigned by QB, never by the model). Unknown modules, ungrounded modules and
 * "default" are never refused.
 */
function apiGroundingErrors(c) {
  const g = c && c.api_grounding;
  if (!g || !Array.isArray(g.modules) || !Array.isArray(c.checks)) return [];
  const { matchesAny } = require('../verify/policy');
  const allowed = Array.isArray(c.scope?.allowed_changes) ? c.scope.allowed_changes.filter((x) => typeof x === 'string') : [];
  const byPath = new Map(g.modules.map((m) => [m.path, withForm({ ...m })]));
  const errors = [];
  for (const k of c.checks) {
    const p = k && k.params;
    if (!p || typeof p.module !== 'string' || typeof p.export !== 'string') continue;
    const name = p.export;
    const m = byPath.get(p.module.replace(/^\.\//, ''));
    if (!m || m.status !== 'known' || name === 'default' || NOT_PROVABLE.has(name)) continue;
    if (m.named.some((x) => x.name === name)) continue;
    const d = m.default || null;
    const isMethod = d && d.kind === 'class' && (d.methods.includes(name) || d.accessors.includes(name));
    const isOwnName = d && d.kind === 'class' && d.name === name;
    const changes = matchesAny(m.path, allowed);
    // the task may change this module: a missing name may be requested new API, unless it is the
    // demonstrated confusion (a method of the default class or its own name) and the request does
    // not ask to export it
    if (changes && (!(isMethod || isOwnName) || requestExports(c.raw_request, name))) continue;
    const where = `${k.id} (${k.ac_id}) names ${m.path} export ${name}, but ${m.path} (sha256 ${short(m.sha256)}) has no export ${name}`;
    const shape = 'Static export grounding does not show return types, values or error messages: take those from the request or the source.';
    if (isOwnName) {
      errors.push(`${where}: "${name}" is the class's own name, not an export. Its default export is class ${name} (${d.form}); call its instance methods (${list(d.methods)}) with ${classCallShape('<method>')}. ${shape}`);
    } else if (isMethod) {
      errors.push(`${where}: its default export is class ${d.name || '(anonymous)'} (${d.form}), and ${name} is an instance method of that class, not an export. Use ${classCallShape(name)}. ${shape}`);
    } else {
      const exps = [...(d && d.kind !== 'object' ? [`default (${d.kind}${d.name ? ` ${d.name}` : ''})`] : []), ...m.named.map((x) => x.name)];
      errors.push(`${where}: its exports are ${list(exps)}. ${shape}`);
    }
  }
  return errors;
}

module.exports = { groundApi, groundSource: (rel, text) => withForm(groundSource(rel, text)), groundingExcerpt, apiGroundingErrors, apiSummary, requestModules, SCHEMA };
