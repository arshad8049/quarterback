/**
 * intent/staged.js: the STRUCTURED (STAGED) L1 compiler (KAN-106, option B of 10733). OFFLINE PROTOTYPE,
 * used only with the explicit profile --l1-profile qwen-14b-staged (lib/budget.js); the default path
 * (intent/compiler.js, one whole-contract draft plus one repair) is unchanged.
 *
 * Three smokes (0ae9efc9, e578f99b, c5399f25) showed the inputs and expected values were mostly right
 * while ids, links, adapter shapes, constraint_policy and stitched error fragments were wrong. Here the
 * model states only small typed facts and QB assembles everything else:
 *
 *   1. requirements: one per request passage (intent/passages.js), R-n cites Pn. Deterministic.
 *   2. roles, deterministic:
 *        context     the passage text is ONLY a path locator ("In lib/x.js,"); reason "location only"
 *        adds_tests  the passage is a requested-tests target (intent/request-targets.js add_tests):
 *                    an adds_tests criterion, no check, decided from the test run (human review)
 *        keep        a passage of a sentence that starts with Keep / Preserve / Retain / Maintain /
 *                    "Do not change|alter|break"
 *        change      every other passage
 *   3. call targets, from the static API grounding (intent/api-grounding.js) and the request's own
 *      call names: a method of a grounded default class (call_sequence, construct "new", no
 *      constructor arguments), or a function export (call_returns / call_throws). A name the module
 *      does not define (requested new export) or a module that does not exist (requested new file) is
 *      a function export of a module the request targets: never refused for being absent.
 *   4. error fragments: literal pieces QB extracts from `throw new X(…)` messages in the called
 *      definition's grounded excerpt (template literals split at ${…}, string concatenations split at
 *      +, quotes/whitespace trimmed from the ends; a message with a call, a ternary or anything else
 *      gives none). The model picks one BY NUMBER.
 *   5. per change/keep requirement, ONE model call whose reply must match a strict JSON schema
 *      (sent as Ollama's `format`), validated again here (validateFacts): cases of
 *      { requirement, call, args, outcome, expected, error_fragment }. A refused reply gets ONE repair
 *      (the same schema, with the reasons); a second refusal ends L1 as invalid, and no further call
 *      starts. Each call is timed (kind fact / fact_repair, with its requirement id) inside the L1
 *      budget (240 s per call, 420 s total for the profile).
 *   6. assembly: one criterion per case (AC-n), its check CHK-n when an adapter can express it, a
 *      kept case also a constraint whose constraint_policy names that check; the requested-tests
 *      criterion; scope from the request's targets. The result goes through contractFromObject and the
 *      EXISTING contractState unchanged.
 *
 * Not claimed: that the model's facts are right. A wrong input-to-requirement assignment, a wrong
 * expected value, a missed case or a wrong fragment choice remain possible; the validators still catch
 * missing coverage. Clarification questions are not handled by this prototype (it stops instead).
 */
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const { modelCall } = require('../lib/budget');
const { splitPassages, passageListing } = require('./passages');
const { requestTargets } = require('./request-targets');
const { groundingExcerpt, contractGrounding, requestNames, apiSummary } = require('./api-grounding');
const { contractFromObject } = require('./compiler');
const { contractState } = require('./contract-state');
const { detectAmbiguity } = require('./dsa');
const { LIMITS, argsErrors, valueErrors, extractExamples } = require('./request-examples');

const FORMAT = 'qb-staged-l1/1';
const SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, 'prompts/staged-facts.md'), 'utf8');
const OLLAMA_URL = () => process.env.QB_OLLAMA_URL || 'http://127.0.0.1:11434';
const MODEL = () => process.env.QB_MODEL || 'deepseek-r1:7b';
const MAX_CASES = 6;
const MAX_ARGS = LIMITS.args;   // KAN-107 (10771 E): one set of literal limits (intent/request-examples.js)
const MAX_FRAGMENTS = 12;
const MAX_FRAGMENT_CHARS = 200;   // the registry's message_includes limit
const RAW_LIMIT = 16 * 1024;

// ── deterministic parts ─────────────────────────────────────────────────────

const PATH = '(?:[A-Za-z0-9_@-][A-Za-z0-9_.@-]*\\/)*[A-Za-z0-9_@-][A-Za-z0-9_.@-]*\\.[A-Za-z0-9]+';
const LOCATION_ONLY = new RegExp(`^in\\s+(\`?)(${PATH})\\1\\s*,?$`, 'i');
const SENTENCE_END = /[.!?]["')\]]*$/;
const KEEP_START = /^(?:please\s+)?(?:keep|preserve|retain|maintain)\b|^(?:do\s+not|don't|must\s+not|should\s+not|never)\s+(?:change|alter|break)\b/i;
// 10749 G1: a passage that is ONLY "Do not change <file>." / "Leave <file> unchanged." (scope.protected_paths)
const PROTECT_ONLY = [
  new RegExp(`^(?:please\\s+)?(?:do\\s+not|don't|never|must\\s+not)\\s+(?:change|modify|edit|touch)\\s+(\`?)(${PATH})\\1\\s*[.!]?$`, 'i'),
  new RegExp(`^(?:please\\s+)?leave\\s+(\`?)(${PATH})\\1\\s+(?:unchanged|untouched|as\\s+it\\s+is)\\s*[.!]?$`, 'i'),
];
// 10749 G3: a requested-tests passage that says nothing else ("Add node:test cases in <file>.", optionally "for <name>")
const PURE_TESTS = new RegExp(`^(?:please\\s+)?(?:add|write|create)\\s+(?:(?:new|more|some|unit|integration|[a-z]+:[a-z]+)\\s+)*(?:tests?|test\\s+cases?|cases|specs?)(?:\\s+for\\s+[A-Za-z_$][\\w$.]*(?:\\(\\))?)?\\s+(?:in|to|into)\\s+(\`?)(${PATH})\\1\\s*[.!]?$`, 'i');
const plainPath = (p) => !p.startsWith('/') && !p.split('/').some((x) => x === '' || x === '.' || x === '..');
/** The file a passage only protects ("Do not change lib/x.js."), or null. */
function protectOnly(text) {
  for (const re of PROTECT_ONLY) { const m = re.exec(String(text || '').trim()); if (m && plainPath(m[2])) return m[2]; }
  return null;
}

/** Is the passage text exactly a path locator ("In lib/x.js,")? Conservative: nothing else may be in it. */
function isLocationOnly(text) {
  const m = LOCATION_ONLY.exec(String(text || '').trim());
  return !!m && !m[2].split('/').some((s) => s === '' || s === '.' || s === '..');
}

/**
 * Each passage's role: context | protect | adds_tests | keep | change, or unsupported (with a reason):
 * a do-not-change clause inside another passage (10749 G1), or a requested-tests passage that also says
 * something else (10749 G3). An unsupported passage stops the staged prototype before any model call.
 */
function passageRoles(request) {
  const passages = splitPassages(request);
  const rt = requestTargets(request);
  const tests = new Map(rt.targets.filter((t) => t.action === 'add_tests').map((t) => [t.passage_id, t.path]));
  const negated = new Map();
  for (const x of rt.ignored.filter((y) => y.why === 'negated')) negated.set(x.passage_id, [...(negated.get(x.passage_id) || []), x.path]);
  // sentences: runs of passages up to one ending a sentence, or a line break between passages
  const sentenceOf = [];
  let s = 0;
  passages.forEach((p, i) => {
    sentenceOf.push(s);
    const next = passages[i + 1];
    if (SENTENCE_END.test(p.text) || (next && /\n/.test(String(request).slice(p.end, next.start)))) s++;
  });
  const keepSentence = new Set(passages.filter((p, i) => (i === 0 || sentenceOf[i - 1] !== sentenceOf[i]) && KEEP_START.test(p.text)).map((p) => sentenceOf[passages.indexOf(p)]));
  return passages.map((p, i) => {
    const base = { passage_id: p.id, text: p.text, sentence: passages.filter((_, j) => sentenceOf[j] === sentenceOf[i]).map((x) => x.text).join(' ') };
    if (isLocationOnly(p.text)) return { ...base, role: 'context' };
    const prot = protectOnly(p.text);
    if (prot) return { ...base, role: 'protect', file: prot };
    if (negated.has(p.id)) {
      return { ...base, role: 'unsupported', reason: `${p.id} ${JSON.stringify(p.text)} says not to change ${negated.get(p.id).join(', ')} inside another instruction: the staged prototype supports a do-not-change request only as its own sentence ("Do not change <file>.")` };
    }
    if (tests.has(p.id)) {
      if (!PURE_TESTS.test(p.text.trim())) {
        return { ...base, role: 'unsupported', file: tests.get(p.id), reason: `${p.id} ${JSON.stringify(p.text)} asks to add tests and says more: the staged prototype does not split that passage, so its other instructions would be lost; state the behaviour in its own sentence` };
      }
      return { ...base, role: 'adds_tests', file: tests.get(p.id) };
    }
    return { ...base, role: keepSentence.has(sentenceOf[i]) ? 'keep' : 'change' };
  });
}

/** Literal pieces of the messages thrown by `throw new X(…)` in a source excerpt (see the header). */
function literalPieces(text) {
  let toks;
  try { toks = [...acorn.tokenizer(String(text || ''), { ecmaVersion: 'latest', allowHashBang: true })]; } catch { return []; }
  const out = [];
  for (let i = 0; i < toks.length; i++) {
    if (toks[i].type.keyword !== 'throw') continue;
    let j = i + 1;
    if (!toks[j] || toks[j].type.keyword !== 'new') continue;
    j++;
    if (!toks[j] || toks[j].type.label !== 'name') continue;
    j++;
    while (toks[j] && toks[j].type.label === '.' && toks[j + 1] && toks[j + 1].type.label === 'name') j += 2;
    if (!toks[j] || toks[j].type.label !== '(') continue;
    const pieces = [];
    const stack = [];
    let ok = false;
    for (j++; j < toks.length; j++) {
      const t = toks[j]; const l = t.type.label;
      if (stack.length) {
        if (l === '${' || l === '{' || l === '(' || l === '[') stack.push(l);
        else if (l === '}' || l === ')' || l === ']') stack.pop();
        continue;
      }
      if (l === ')' || l === ',') { ok = true; break; }
      if (l === 'template' || l === 'string') { if (typeof t.value === 'string') pieces.push(t.value); continue; }
      if (l === '${' || l === '[') { stack.push(l); continue; }
      if (l === '`' || l === 'name' || l === '.' || l === 'typeof' || (l === '+/-' && t.value === '+')) continue;
      break;   // a call, a ternary, a logical operator…: not a literal message
    }
    if (!ok) continue;
    for (const p of pieces) {
      const c = p.replace(/^[\s"'`]+|[\s"'`]+$/g, '');
      if ((c.match(/[A-Za-z]/g) || []).length >= 3 && c.length <= MAX_FRAGMENT_CHARS && !out.includes(c)) out.push(c);
    }
  }
  return out;
}

const GLOBALS = new Set(Object.getOwnPropertyNames(globalThis));
const EXCERPT_ROOM = 100;   // kept excerpt lines below which a missing constructor block means "no constructor" (a block is ≤ 60 lines, a file ≤ 160)
const escapeRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Does the request ask to create or export this name? (any export/create word next to it in one sentence) */
const asksFor = (request, name) => new RegExp(`\\b(?:export|create)\\w*\\b[^.!?]*\\b${escapeRe(name)}\\b|\\b${escapeRe(name)}\\b[^.!?]*\\b(?:export|create)\\w*\\b`, 'i').test(String(request || ''));

/**
 * 10749 G2: can QB construct the class with `new` and no arguments? 'none' (no constructor parameters),
 * 'appears_optional' (every parameter has an INERT default, is a rest parameter, or is only read behind a guard:
 * `p && …`, `p || …`, `p ?? …`, `p?.x`, `typeof p`, `p == null`, a test of `p`), or 'required_or_unknown'
 * (anything else, or the constructor could not be read).
 * 10758: a static reading is NOT proof that construction succeeds; only running the checks on the controls
 * shows that. So the rule stays conservative and bounded (no general analyser):
 *   - a parameter stored as `this.x = p` counts only when no code in the whole class dereferences `this.x`
 *     (api-grounding ctorStores: returned as is or read behind a guard; if `this` escapes, nothing counts);
 *   - a default counts only when inert (inertDefault): a default that runs code can throw.
 */
function constructorArgs(m) {
  const blocks = m.excerpts || [];
  const b = blocks.find((x) => x.kind === 'constructor');
  if (!b || typeof b.text !== 'string') {
    const kept = blocks.reduce((n, x) => n + (x.end_line - x.start_line + 1), 0);
    return kept <= EXCERPT_ROOM ? 'none' : 'required_or_unknown';
  }
  let ctor;
  try { ctor = acorn.parse(`(class {\n${b.text}\n})`, { ecmaVersion: 'latest' }).body[0].expression.body.body.find((x) => x.kind === 'constructor'); } catch { return 'required_or_unknown'; }
  if (!ctor) return 'required_or_unknown';
  const params = ctor.value.params;
  if (!params.length) return 'none';
  for (const p of params) {
    if (p.type === 'RestElement') continue;
    if (p.type === 'AssignmentPattern') { if (p.left.type === 'Identifier' && inertDefault(p.right)) continue; return 'required_or_unknown'; }
    if (p.type !== 'Identifier') return 'required_or_unknown';
    if (!onlyGuarded(ctor.value.body, p.name, safeStores(m, p.name))) return 'required_or_unknown';
  }
  return 'appears_optional';
}
/** 10758: a default that cannot run code: a literal, `undefined`, a negated number, a template with no
 *  expressions, or an object/array literal (no spread, no computed key) made only of those. */
function inertDefault(n) {
  if (!n) return false;
  switch (n.type) {
    case 'Literal': return true;
    case 'Identifier': return n.name === 'undefined';
    case 'UnaryExpression': return (n.operator === '-' || n.operator === '+') && n.argument.type === 'Literal' && typeof n.argument.value === 'number';
    case 'TemplateLiteral': return n.expressions.length === 0;
    case 'ArrayExpression': return n.elements.every((e) => e && inertDefault(e));
    case 'ObjectExpression': return n.properties.every((q) => q.type === 'Property' && q.kind === 'init' && !q.computed && !q.method && inertDefault(q.value));
    default: return false;
  }
}
/** 10758: the fields that parameter `name` is stored in, where no code in the class dereferences them
 *  (api-grounding ctorStores, computed over the WHOLE class, not the excerpt). Empty when unknown. */
function safeStores(m, name) {
  const d = m && m.default;
  if (!d || d.kind !== 'class' || !Array.isArray(d.ctor_stores)) return new Set();
  const mine = d.ctor_stores.filter((x) => x.param === name);
  return new Set(mine.every((x) => !x.dereferenced) ? mine.map((x) => x.field) : []);
}
function onlyGuarded(body, name, safeFields = new Set()) {
  const isP = (n) => n && n.type === 'Identifier' && n.name === name;
  const nullish = (n) => n && ((n.type === 'Literal' && n.value === null) || (n.type === 'Identifier' && n.name === 'undefined'));
  let ok = true;
  const walk = (n, chain) => {
    if (!ok || !n || typeof n.type !== 'string') return;
    if (isP(n)) {
      const { node: parent, key } = chain.at(-1) || {};
      const guarded = (parent && parent.type === 'LogicalExpression' && key === 'left')
        || (parent && parent.type === 'UnaryExpression' && parent.operator === 'typeof')
        || (parent && parent.type === 'BinaryExpression' && /^[!=]==?$/.test(parent.operator) && (nullish(parent.left) || nullish(parent.right)))
        || (parent && parent.type === 'MemberExpression' && key === 'object' && parent.optional)
        || (parent && /^(?:IfStatement|ConditionalExpression)$/.test(parent.type) && key === 'test')
        || (parent && parent.type === 'AssignmentExpression' && parent.operator === '=' && key === 'right' && parent.left.type === 'MemberExpression'
          && parent.left.object.type === 'ThisExpression' && !parent.left.computed && safeFields.has(parent.left.property.name))
        || chain.some((c) => (c.node.type === 'LogicalExpression' && c.node.operator === '&&' && isP(c.node.left) && c.key === 'right')
          || (/^(?:IfStatement|ConditionalExpression)$/.test(c.node.type) && isP(c.node.test) && c.key === 'consequent'));
      if (!guarded) ok = false;
      return;
    }
    for (const [k, v] of Object.entries(n)) {
      if (k === 'loc' || k === 'start' || k === 'end') continue;
      if (n.type === 'MemberExpression' && k === 'property' && !n.computed) continue;
      if (n.type === 'Property' && k === 'key' && !n.computed) continue;
      const next = [...chain, { node: n, key: k }];
      if (Array.isArray(v)) v.forEach((c) => walk(c, next));
      else if (v && typeof v === 'object') walk(v, next);
    }
  };
  walk(body, []);
  return ok;
}

/**
 * The call targets: [{ label, module, kind: 'method'|'function', export, method?, display, pieces,
 * grounding: 'grounded'|'requested_new'|'unsupported', reason?, constructor_args? }].
 * `api` is groundApi's result (with excerpt text); `request` names the calls. 10749 G2: only a grounded or
 * requested-new target is offered to the model; an unsupported one is recorded with its reason.
 */
function callTargets(request, api) {
  const rt = requestTargets(request);
  const skip = new Set(rt.ignored.filter((x) => x.why !== 'mentioned').map((x) => x.path));
  const targetPaths = new Set(rt.targets.filter((t) => t.action !== 'add_tests').map((t) => t.path));
  const mods = (api && Array.isArray(api.modules) ? api.modules : []).filter((m) => !skip.has(m.path));
  const prefixOf = (name) => { const m = new RegExp(`([A-Za-z_$][\\w$]*)\\.${name.replace(/\$/g, '\\$')}\\s*\\(`).exec(String(request)); return m ? m[1] : null; };
  const excerptOf = (m, name) => { const b = (m.excerpts || []).find((x) => x.kind === 'definition' && x.symbol === name); return b && typeof b.text === 'string' ? b.text : null; };
  const out = [];
  const push = (t) => { if (!out.some((x) => x.label === t.label)) out.push(t); };
  for (const name of requestNames(request)) {
    if (GLOBALS.has(name)) continue;
    const prefix = prefixOf(name);
    const defines = (m) => m.status === 'known' && ((m.default && m.default.kind === 'class' && m.default.methods.includes(name))
      || m.named.some((x) => x.name === name) || (m.default && m.default.kind === 'function' && m.default.name === name));
    const definers = mods.filter(defines);
    const candidates = definers.length ? definers : mods.filter((m) => targetPaths.has(m.path) || m.status !== 'known');
    for (const m of candidates) {
      const d = m.status === 'known' ? m.default : null;
      const isDefiner = definers.includes(m);
      const asMethod = d && d.kind === 'class' && (d.methods.includes(name) || (!isDefiner && prefix && prefix === d.name));
      const asked = asksFor(request, name) && targetPaths.has(m.path);
      let grounding = 'grounded'; let reason = null; let ctorArgs = null;
      if (m.status !== 'known') {
        if (/^no such file/.test(m.reason || '') && asked) grounding = 'requested_new';
        else { grounding = 'unsupported'; reason = `${m.path}: exports unknown (${m.reason}); QB cannot tell how to call ${name}`; }
      } else if (!isDefiner) {
        if (asked && !asMethod) grounding = 'requested_new';
        else { grounding = 'unsupported'; reason = `${m.path} does not define ${name} and the request does not ask to create or export it, so how to call it is ambiguous`; }
      } else if (asMethod) {
        ctorArgs = (d && d.ctor_args) || constructorArgs(m);   // KAN-107: the grounding's own reading of the real constructor, when recorded
        if (ctorArgs === 'required_or_unknown') { grounding = 'unsupported'; reason = `the constructor of ${d.name || 'the default class'} in ${m.path} may need arguments QB cannot supply (QB constructs with new and no arguments)`; }
      }
      const extra = { grounding, ...(reason ? { reason } : {}), ...(ctorArgs ? { constructor_args: ctorArgs } : {}) };
      if (asMethod) {
        const display = `${prefix || d.name || 'instance'}.${name}`;
        push({ label: `${display} (${m.path})`, module: m.path, kind: 'method', export: 'default', method: name, display, pieces: literalPieces(excerptOf(m, name)), ...extra });
      } else {
        const exp = d && d.kind === 'function' && d.name === name && !m.named.some((x) => x.name === name) ? 'default' : name;
        push({ label: `${name} (${m.path})`, module: m.path, kind: 'function', export: exp, display: name, pieces: literalPieces(excerptOf(m, name)), ...extra });
      }
    }
  }
  return out;
}

/**
 * KAN-107 (10766 decision 3, 10771 A): the error-message text the REQUEST quotes, offered EXACTLY (never a longer
 * invented text), bound to the one call target it belongs to (a new export included). Appended after the source
 * pieces so their numbers do not move. The model still picks by number; it never types a message.
 */
function requestFragments(rx, targets) {
  const out = [];
  const items = [...rx.examples.filter((e) => e.message).map((e) => ({ text: e.message.fragment, name: e.name })), ...rx.messages.map((m) => ({ text: m.fragment, name: m.name }))];
  for (const it of items) {
    const ts = targets.filter((t) => t.export === it.name || t.method === it.name);
    if (ts.length !== 1 || !it.text || it.text.length > MAX_FRAGMENT_CHARS) continue;
    const f = out.find((x) => x.text === it.text);
    if (f) { if (!f.calls.includes(ts[0].label)) f.calls.push(ts[0].label); } else out.push({ text: it.text, calls: [ts[0].label], source: 'request' });
  }
  return out;
}

/** The combined fragment list (numbered in the prompt), each piece with the call targets it came from. */
function fragmentList(targets) {
  const list = [];
  for (const t of targets) for (const p of t.pieces) {
    const f = list.find((x) => x.text === p);
    if (f) f.calls.push(t.label); else if (list.length < MAX_FRAGMENTS) list.push({ text: p, calls: [t.label] });
  }
  return list;
}

// ── the fact schema and its validation ──────────────────────────────────────

const SCALAR = { anyOf: [{ type: 'string', maxLength: LIMITS.string }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }] };
/**
 * KAN-107 (10766 decision 2, 10771 E): a BOUNDED literal: a scalar, or an array nested at most LIMITS.depth deep
 * inside ONE argument value, at most LIMITS.items items per array. Written out non-recursively (Ollama `format`).
 * Objects are not allowed (refused, never coerced). Total size is checked in validateFacts (LIMITS.bytes).
 */
const literal = (d) => (d === 0 ? SCALAR : { anyOf: [...SCALAR.anyOf, { type: 'array', maxItems: LIMITS.items, items: literal(d - 1) }] });
const LITERAL = literal(LIMITS.depth);

/** The strict JSON schema for one requirement's facts (also sent to Ollama as `format`). */
function factSchema({ requirementId, calls, fragments }) {
  const frag = fragments > 0 ? { anyOf: [{ type: 'integer', enum: [...Array(fragments).keys()] }, { type: 'null' }] } : { type: 'null' };
  return {
    type: 'object', additionalProperties: false, required: ['cases'],
    properties: {
      cases: {
        type: 'array', minItems: 0, maxItems: MAX_CASES,
        items: {
          type: 'object', additionalProperties: false,
          required: ['requirement', 'call', 'args', 'outcome', 'expected', 'error_fragment'],
          properties: {
            requirement: { type: 'string', enum: [requirementId] },
            call: { type: 'string', enum: [...calls] },
            args: { type: 'array', maxItems: MAX_ARGS, items: LITERAL },
            outcome: { type: 'string', enum: ['returns', 'throws'] },
            expected: LITERAL,
            error_fragment: frag,
          },
        },
      },
    },
  };
}

const typeOk = (t, v) => (t === 'object' ? !!v && typeof v === 'object' && !Array.isArray(v) : t === 'array' ? Array.isArray(v)
  : t === 'integer' ? Number.isInteger(v) : t === 'number' ? typeof v === 'number' && Number.isFinite(v) : t === 'null' ? v === null : typeof v === t);

/** The JSON-schema subset factSchema uses: type, enum, anyOf, properties, required, additionalProperties, items, min/maxItems, maxLength. */
function schemaErrors(s, v, at = '$') {
  if (s.anyOf) return s.anyOf.some((x) => !schemaErrors(x, v, at).length) ? [] : [`${at}: ${JSON.stringify(v)} is not an allowed value here`];
  if (s.type && !typeOk(s.type, v)) return [`${at}: expected ${s.type}, got ${v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v}`];
  if (s.enum && !s.enum.some((e) => JSON.stringify(e) === JSON.stringify(v))) return [`${at}: ${JSON.stringify(v)} is not one of ${s.enum.map((e) => JSON.stringify(e)).join(', ')}`];
  if (s.maxLength !== undefined && v.length > s.maxLength) return [`${at}: longer than ${s.maxLength} characters`];
  const errors = [];
  if (s.type === 'array') {
    if (s.minItems !== undefined && v.length < s.minItems) errors.push(`${at}: fewer than ${s.minItems} items`);
    if (s.maxItems !== undefined && v.length > s.maxItems) errors.push(`${at}: more than ${s.maxItems} items`);
    if (s.items) v.forEach((x, i) => errors.push(...schemaErrors(s.items, x, `${at}[${i}]`)));
  }
  if (s.type === 'object') {
    for (const k of s.required || []) if (!Object.prototype.hasOwnProperty.call(v, k)) errors.push(`${at}: missing "${k}"`);
    if (s.additionalProperties === false) for (const k of Object.keys(v)) if (!s.properties || !Object.prototype.hasOwnProperty.call(s.properties, k)) errors.push(`${at}: unknown key "${k}"`);
    for (const [k, sub] of Object.entries(s.properties || {})) if (Object.prototype.hasOwnProperty.call(v, k)) errors.push(...schemaErrors(sub, v[k], `${at}.${k}`));
  }
  return errors;
}

/**
 * Every reason a parsed reply is refused: the schema, then the rules the schema cannot say (a throw has
 * no expected value; a return has no fragment; a fragment comes from the called target's own source; no
 * repeated call). `fragments` (optional): the numbered list, to check where a picked fragment came from.
 */
function validateFacts(schema, value, fragments = null) {
  const errors = schemaErrors(schema, value);
  if (errors.length) return errors;
  const seen = new Set();
  value.cases.forEach((c, i) => {
    const at = `$.cases[${i}]`;
    if (c.outcome === 'throws' && c.expected !== null) errors.push(`${at}: a "throws" case has "expected": null`);
    if (c.outcome === 'returns' && c.error_fragment !== null) errors.push(`${at}: a "returns" case has "error_fragment": null`);
    if (c.outcome === 'throws' && c.error_fragment !== null && fragments && !fragments[c.error_fragment].calls.includes(c.call)) {
      errors.push(`${at}: fragment ${c.error_fragment} is not from the source of ${c.call}`);
    }
    // KAN-107 (10771 E): the same limits as request parsing (count, per-value depth, total bytes)
    for (const e of argsErrors(c.args)) errors.push(`${at}.args: ${e}`);
    if (c.expected !== null) for (const e of valueErrors(c.expected, 'expected')) errors.push(`${at}: ${e}`);
    const key = JSON.stringify([c.call, c.args]);
    if (seen.has(key)) errors.push(`${at}: the same call and arguments appear twice`);
    seen.add(key);
  });
  return errors;
}

/** Parse and validate one reply: { value, errors }. */
function readFacts(raw, schema, fragments) {
  let value;
  try { value = JSON.parse(String(raw).trim()); } catch (e) { return { value: null, errors: [`not valid JSON: ${e.message}`] }; }
  return { value, errors: validateFacts(schema, value, fragments) };
}

// ── the model calls ─────────────────────────────────────────────────────────

function factInput({ request, role, rid, targets, fragments, api }) {
  const lines = [
    `REQUEST:\n${request}`, '',
    `REQUEST PASSAGES:\n${passageListing(splitPassages(request))}`, '',
    `REQUIREMENT ${rid} cites ${role.passage_id}: ${JSON.stringify(role.text)}`,
    `Its sentence: ${JSON.stringify(role.sentence)}`,
    role.role === 'keep'
      ? 'ROLE: KEEP. The request asks to keep this behaviour: "expected" is what the shown source returns today.'
      : 'ROLE: CHANGE. The request asks for this behaviour: "expected" (or the throw) is what the request asks for.',
    '',
    'CALL TARGETS (copy one exactly into "call"):',
    ...targets.map((t) => (t.kind === 'method'
      ? `- ${JSON.stringify(t.label)}: instance method ${t.method} of the default export class of ${t.module}; QB constructs it with new and no arguments (${t.constructor_args === 'none' ? 'it has no constructor parameters' : 'a static reading found no required constructor parameter'}; not proof that construction succeeds)`
      : t.grounding === 'requested_new'
        ? `- ${JSON.stringify(t.label)}: requested NEW function export ${t.export} of ${t.module} (not in the source yet; the request asks for it)`
        : `- ${JSON.stringify(t.label)}: function export ${t.export} of ${t.module}`)),
    '',
    fragments.length
      ? `ERROR MESSAGE FRAGMENTS (literal pieces of the errors the shown code throws, extracted by QB${fragments.some((f) => f.source === 'request') ? ', and the error-message text the REQUEST quotes (use it exactly where the request requires that message)' : ''}; "error_fragment" is a number from this list):\n${fragments.map((f, i) => `${i}: ${JSON.stringify(f.text)}`).join('\n')}`
      : 'ERROR MESSAGE FRAGMENTS: none. "error_fragment" is null.',
  ];
  const ex = groundingExcerpt(api);
  if (ex) lines.push('', ex);
  return lines.join('\n');
}

/** ONE model call with the schema as Ollama's `format`; returns the reply text ('' when empty). */
async function callModel(messages, schema, timer) {
  const t0 = timer.now();
  let limit = null;
  const lim = { ...timer.limits(), onLimit: (ms) => { limit = ms; } };
  let data;
  try {
    data = await modelCall(`${OLLAMA_URL()}/api/chat`, { model: MODEL(), messages, stream: false, format: schema, options: { temperature: 0, num_ctx: 8192 } }, lim);
  } finally {
    timer.onModelCall(timer.now() - t0, { limit_ms: limit, load_ms: data && Number.isFinite(data.load_duration) ? Math.round(data.load_duration / 1e6) : null });
  }
  return { text: (data && data.message && typeof data.message.content === 'string') ? data.message.content : '', model: data && typeof data.model === 'string' ? data.model : null };
}

const cut = (s) => { const b = Buffer.from(String(s), 'utf8'); return b.length <= RAW_LIMIT ? String(s) : `${b.subarray(0, RAW_LIMIT).toString('utf8')}…`; };

/** One requirement's facts: a call and, if refused, ONE repair. */
/**
 * One requirement's facts: a call and, if refused, ONE repair. `entry` is already in the run record
 * (staged.facts) before the first call, so replies received survive a later timeout or cancellation
 * (10749 G4); a call that fails records `entry.failed` and the error is rethrown.
 */
async function factsFor(ctx, role, rid, t, entry) {
  const schema = factSchema({ requirementId: rid, calls: ctx.targets.map((x) => x.label), fragments: ctx.fragments.length });
  let messages = [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: factInput({ ...ctx, role, rid }) }];
  for (const kind of ['fact', 'fact_repair']) {
    let reply;
    try {
      t.check(`${kind === 'fact' ? 'fact call' : 'fact repair call'} for ${rid}`);
      reply = await callModel(messages, schema, t.timer(kind, 1, { requirement_id: rid }));
    } catch (e) {
      entry.failed = { attempt: kind, kind: e && e.code === 'DEADLINE' ? (e.kind === 'l1' ? 'l1_budget' : e.kind === 'call' ? 'call_timeout' : 'cancelled') : 'error', message: String((e && e.message) || e) };
      throw e;
    }
    const { value, errors } = t.validate(() => (reply.text.trim() ? readFacts(reply.text, schema, ctx.fragments) : { value: null, errors: ['empty reply'] }));
    t.outcome(errors.length ? 'invalid' : 'ok');
    entry.attempts.push({ kind, model: reply.model, raw: cut(reply.text), raw_bytes: Buffer.byteLength(reply.text), errors });
    if (!errors.length) { entry.cases = value.cases; return entry; }
    messages = [...messages, { role: 'assistant', content: reply.text || '(empty)' },
      { role: 'user', content: `QB refused your reply:\n${errors.map((e) => `- ${e}`).join('\n')}\n\nReply again with ONE JSON object that matches the required schema exactly, for REQUIREMENT ${rid}.` }];
  }
  return entry;
}

// ── assembly ────────────────────────────────────────────────────────────────

const argText = (args) => args.map((a) => JSON.stringify(a)).join(', ');

/**
 * The contract object (before contractFromObject) from the roles, the accepted facts and the targets:
 * { errors, raw }. Identical cases (call, args, outcome, expected value or fragment) under several
 * requirements are one criterion and one check citing all of them (10749); a same-input conflict is an error.
 */
function assemble(request, roles, facts, targets, fragments) {
  const byLabel = new Map(targets.map((x) => [x.label, x]));
  const factsOf = new Map(facts.map((f) => [f.passage_id, f]));
  const requirements = []; const acs = []; const checks = []; const constraints = []; const policy = [];
  const used = new Set();
  const protectedPaths = [];
  const errors = [];
  const seen = new Map();   // call + args → { result, ac, check, rid } (10749: one criterion per distinct case)
  roles.forEach((r, i) => {
    const rid = `R-${i + 1}`;
    requirements.push({ id: rid, passage_ids: [r.passage_id], quote: r.text, ...(r.role === 'context' ? { disposition: 'context', reason: 'location only' } : {}),
      ...(r.role === 'protect' ? { disposition: 'context', reason: `do-not-change file ${r.file}: enforced by scope.protected_paths` } : {}) });
    if (r.role === 'protect') {
      if (!protectedPaths.includes(r.file)) protectedPaths.push(r.file);
      policy.push({ constraint: constraints.length, enforced_by: [{ kind: 'protected_paths', ref: r.file }] });
      constraints.push(`Do not change ${r.file} (${r.passage_id} ${JSON.stringify(r.text)}).`);
      return;
    }
    if (r.role === 'adds_tests') {
      acs.push({ id: `AC-${acs.length + 1}`, criterion: `New tests are added in ${r.file} and they pass (requested tests: decided from the test run, for human review).`,
        kind: 'behavioral', requirement_ids: [rid], adds_tests: { files: [r.file] } });
      return;
    }
    if (r.role === 'context') return;
    for (const c of (factsOf.get(r.passage_id) || {}).cases || []) {
      const t = byLabel.get(c.call);
      const call = `${t.display}(${argText(c.args)})`;
      const frag = c.outcome === 'throws' && c.error_fragment !== null ? fragments[c.error_fragment].text : null;
      const kept = r.role === 'keep';
      const claim = c.outcome === 'throws'
        ? `${kept ? 'still ' : ''}throws an error${frag ? ` whose message includes ${JSON.stringify(frag)}` : ''}`
        : `${kept ? 'still ' : ''}returns ${JSON.stringify(c.expected)}`;
      // KAN-106 10749 (run b7a4bfe2): the identical case under another requirement is the SAME criterion
      // and check, citing both requirements; the same call and args with another result is a conflict.
      const callKey = JSON.stringify([c.call, c.args]);
      const result = JSON.stringify(c.outcome === 'throws' ? ['throws', frag] : ['returns', c.expected]);
      const prior = seen.get(callKey);
      let check;
      if (prior && prior.result !== result) {
        errors.push(`${prior.rid} and ${rid} state conflicting results for the same call ${call}: ${prior.text} vs ${claim} (refused, not merged)`);
        continue;
      } else if (prior) {
        if (!prior.ac.requirement_ids.includes(rid)) prior.ac.requirement_ids.push(rid);
        check = prior.check;
      } else {
        const n = acs.length + 1;
        const ac = { id: `AC-${n}`, criterion: `${call} ${claim}${kept ? ' (behaviour kept)' : ''}.`, kind: 'behavioral', requirement_ids: [rid] };
        acs.push(ac);
        check = checkFor(t, c, frag, `CHK-${n}`, `AC-${n}`);
        if (check) { checks.push(check); used.add(t.module); }
        seen.set(callKey, { result, ac, check, rid, text: claim });
      }
      if (kept) {
        policy.push(check ? { constraint: constraints.length, enforced_by: [{ kind: 'check', ref: check.id }] } : { constraint: constraints.length, advisory: true });
        constraints.push(`Keep the existing behaviour (${r.passage_id} ${JSON.stringify(r.text)}): ${call} ${claim}.`);
      }
    }
  });
  // 10749 G1: only what the request itself targets may change; a module a check merely calls stays read-only.
  const allowed = [...new Set(requestTargets(request).targets.map((t) => t.path))];
  const behaviour = acs.filter((a) => !a.adds_tests).map((a) => a.criterion);
  if (errors.length) return { errors, raw: null };
  return { errors, raw: {
    goal: request.trim(),
    required_behavior: behaviour.length ? behaviour : acs.map((a) => a.criterion),
    constraints, constraint_policy: policy,
    acceptance_criteria: acs, requirements, checks,
    scope: { allowed_changes: allowed, protected_paths: protectedPaths },
    verification_plan: [
      'Run the checks QB assembled for each criterion against the changed code (the model chose only inputs, expected values and fragments).',
      ...(acs.some((a) => a.adds_tests) ? ['Run the requested test files: each must be in the change and pass (human review decides whether they test the change).'] : []),
    ],
    relevant_context: [...new Set([...allowed, ...used])],
    ambiguity_flags: [], clarifying_question: null, proposed_defaults: [],
  } };
}

/** The check for one case, or null when no adapter can express it (a method throw with no fragment). */
function checkFor(t, c, frag, id, acId) {
  if (t.kind === 'method') {
    if (c.outcome === 'throws' && !frag) return null;
    const step = { on: 's', method: t.method, args: c.args, ...(c.outcome === 'throws' ? { throws: { message_includes: frag } } : { expect: c.expected }) };
    return { id, ac_id: acId, adapter: 'call_sequence', params: { module: t.module, export: 'default', instances: { s: { construct: 'new', args: [] } }, steps: [step] } };
  }
  if (c.outcome === 'throws') return { id, ac_id: acId, adapter: 'call_throws', params: { module: t.module, export: t.export, args: c.args, ...(frag ? { message_includes: frag } : {}) } };
  return { id, ac_id: acId, adapter: 'call_returns', params: { module: t.module, export: t.export, args: c.args, expect: c.expected } };
}

// ── the entry point (intent/session.js, staged profile) ─────────────────────

/**
 * @param {string} request
 * @param {{ api: object|null, grounding: object|null }} g  QB's static API grounding and the run-record summary
 * @param {object} t  the L1 timer of intent/session.js
 */
async function compileStaged(request, g, t) {
  const roles = passageRoles(request);
  const all = callTargets(request, g.api);
  const targets = all.filter((x) => x.grounding !== 'unsupported');
  const rx = extractExamples(request);
  const fragments = [...fragmentList(targets), ...requestFragments(rx, targets)];
  const rec = (x) => ({ label: x.label, module: x.module, kind: x.kind, export: x.export, ...(x.method ? { method: x.method } : {}), grounding: x.grounding,
    ...(x.constructor_args ? { constructor_args: x.constructor_args } : {}), ...(x.reason ? { reason: x.reason } : {}) });
  const staged = { format: FORMAT, roles: roles.map((r) => ({ passage_id: r.passage_id, role: r.role, ...(r.file ? { file: r.file } : {}), ...(r.reason ? { reason: r.reason } : {}) })),
    call_targets: targets.map(rec), unsupported_targets: all.filter((x) => x.grounding === 'unsupported').map(rec),
    fragments: targets.map((x) => ({ call: x.label, pieces: x.pieces })), fragment_list: fragments.map((f) => f.text), facts: [] };
  const done = (state, extra) => ({ format: 'qb-intent-handoff/1', state, round: 1, history: [], survey: g.grounding, staged, ...extra });

  // Not handled by this prototype: a clarification question (it stops instead of guessing).
  const amb = detectAmbiguity(request, []);
  const unclear = requestTargets(request).ambiguous[0];
  if (amb || unclear) return done('invalid', { contract: null, errors: [`the staged L1 prototype does not ask clarification questions: ${amb ? amb.clarifying_question : unclear.reason}`] });
  const unsupported = roles.filter((r) => r.role === 'unsupported');
  if (unsupported.length) return done('invalid', { contract: null, errors: unsupported.map((r) => `unsupported by the staged prototype: ${r.reason}`) });
  // KAN-107 (10766 decision 4, 10771 D): a change that states no expected behaviour stops before any model call;
  // nothing is invented and labelled as the user's requirement (a small, documented qualifier list).
  if (rx.underspecified.length) {
    return done('invalid', { contract: null, errors: rx.underspecified.map((u) => `${u.passage_id} ${JSON.stringify(u.excerpt)} states no expected behaviour (only "${u.qualifier}"): QB does not invent one. Clarify the request with an example call and its result, e.g. name(…) returns …`) });
  }
  // KAN-107 (Q3, decision 2): an example QB cannot express (object, template, beyond the literal limits) for a call
  // target is refused before generation, never coerced or flattened.
  const named = (u) => all.some((x) => x.export === u.name || x.method === u.name || x.display === u.name);
  const shapeless = rx.unsupported.filter((u) => u.kind === 'literal' && named(u));
  if (shapeless.length) return done('invalid', { contract: null, errors: shapeless.map((u) => `unsupported example shape ${JSON.stringify(u.excerpt)}: ${u.reason} (refused before generation; QB never coerces or flattens it)`) });
  const asks = roles.map((r, i) => ({ r, rid: `R-${i + 1}` })).filter((x) => x.r.role === 'change' || x.r.role === 'keep');
  if (asks.length && !targets.length) {
    return done('invalid', { contract: null, errors: staged.unsupported_targets.length
      ? staged.unsupported_targets.map((x) => `unsupported call shape ${x.label}: ${x.reason}`)
      : ['the staged L1 prototype needs a function or method call named in the request (e.g. `name(` or `Class.method(`); none was found'] });
  }

  const ctx = { request, targets, fragments, api: g.api };
  for (const { r, rid } of asks) {
    const f = { requirement_id: rid, passage_id: r.passage_id, role: r.role, attempts: [], cases: null };
    staged.facts.push(f);   // 10749 G4: in the record before the call
    try { await factsFor(ctx, r, rid, t, f); }
    catch (e) { if (e && typeof e === 'object') e.staged = staged; throw e; }
    if (!f.cases) {
      return done('invalid', { contract: null, errors: [`${rid} (${r.passage_id}): the model's facts were refused after one repair: ${f.attempts.at(-1).errors.join('; ')}`] });
    }
  }
  const assembled = assemble(request, roles, staged.facts, targets, fragments);
  if (assembled.errors.length) return done('invalid', { contract: null, errors: assembled.errors });
  const raw = assembled.raw;
  const contract = contractFromObject(raw, request);
  if (g.api) contract.api_grounding = contractGrounding(g.api);
  const cs = t.validate(() => contractState(contract));
  return cs.state === 'finalized' ? done('finalized', { contract }) : done('invalid', { contract, errors: cs.errors || [cs.question] });
}

module.exports = { compileStaged, passageRoles, isLocationOnly, literalPieces, callTargets, fragmentList, requestFragments, factSchema, validateFacts, schemaErrors, assemble, apiSummary, constructorArgs, FORMAT };
