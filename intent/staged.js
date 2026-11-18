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

const FORMAT = 'qb-staged-l1/1';
const SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, 'prompts/staged-facts.md'), 'utf8');
const OLLAMA_URL = () => process.env.QB_OLLAMA_URL || 'http://127.0.0.1:11434';
const MODEL = () => process.env.QB_MODEL || 'deepseek-r1:7b';
const MAX_CASES = 6;
const MAX_ARGS = 8;
const MAX_FRAGMENTS = 12;
const MAX_FRAGMENT_CHARS = 200;   // the registry's message_includes limit
const RAW_LIMIT = 16 * 1024;

// ── deterministic parts ─────────────────────────────────────────────────────

const PATH = '(?:[A-Za-z0-9_@-][A-Za-z0-9_.@-]*\\/)*[A-Za-z0-9_@-][A-Za-z0-9_.@-]*\\.[A-Za-z0-9]+';
const LOCATION_ONLY = new RegExp(`^in\\s+(\`?)(${PATH})\\1\\s*,?$`, 'i');
const SENTENCE_END = /[.!?]["')\]]*$/;
const KEEP_START = /^(?:please\s+)?(?:keep|preserve|retain|maintain)\b|^(?:do\s+not|don't|must\s+not|should\s+not|never)\s+(?:change|alter|break)\b/i;

/** Is the passage text exactly a path locator ("In lib/x.js,")? Conservative: nothing else may be in it. */
function isLocationOnly(text) {
  const m = LOCATION_ONLY.exec(String(text || '').trim());
  return !!m && !m[2].split('/').some((s) => s === '' || s === '.' || s === '..');
}

/** Each passage's role: context | adds_tests | keep | change (see the header). */
function passageRoles(request) {
  const passages = splitPassages(request);
  const tests = new Map(requestTargets(request).targets.filter((t) => t.action === 'add_tests').map((t) => [t.passage_id, t.path]));
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
    if (tests.has(p.id)) return { ...base, role: 'adds_tests', file: tests.get(p.id) };
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

/**
 * The call targets: [{ label, module, kind: 'method'|'function', export, method?, display, pieces }].
 * `api` is groundApi's result (with excerpt text); `request` names the calls.
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
      const asMethod = d && d.kind === 'class' && (d.methods.includes(name) || (!definers.length && prefix && prefix === d.name));
      if (asMethod) {
        const display = `${prefix || d.name || 'instance'}.${name}`;
        push({ label: `${display} (${m.path})`, module: m.path, kind: 'method', export: 'default', method: name, display, pieces: literalPieces(excerptOf(m, name)) });
      } else {
        const exp = d && d.kind === 'function' && d.name === name && !m.named.some((x) => x.name === name) ? 'default' : name;
        push({ label: `${name} (${m.path})`, module: m.path, kind: 'function', export: exp, display: name, pieces: literalPieces(excerptOf(m, name)) });
      }
    }
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

const SCALAR = { anyOf: [{ type: 'string', maxLength: 1000 }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }] };

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
            args: { type: 'array', maxItems: MAX_ARGS, items: SCALAR },
            outcome: { type: 'string', enum: ['returns', 'throws'] },
            expected: SCALAR,
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
      ? `- ${JSON.stringify(t.label)}: instance method ${t.method} of the default export class of ${t.module}; QB constructs it with new and no arguments`
      : `- ${JSON.stringify(t.label)}: function export ${t.export} of ${t.module}`)),
    '',
    fragments.length
      ? `ERROR MESSAGE FRAGMENTS (literal pieces of the errors the shown code throws, extracted by QB; "error_fragment" is a number from this list):\n${fragments.map((f, i) => `${i}: ${JSON.stringify(f.text)}`).join('\n')}`
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
async function factsFor(ctx, role, rid, t) {
  const schema = factSchema({ requirementId: rid, calls: ctx.targets.map((x) => x.label), fragments: ctx.fragments.length });
  let messages = [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: factInput({ ...ctx, role, rid }) }];
  const attempts = [];
  for (const kind of ['fact', 'fact_repair']) {
    t.check(`${kind === 'fact' ? 'fact call' : 'fact repair call'} for ${rid}`);
    const reply = await callModel(messages, schema, t.timer(kind, 1, { requirement_id: rid }));
    const { value, errors } = t.validate(() => (reply.text.trim() ? readFacts(reply.text, schema, ctx.fragments) : { value: null, errors: ['empty reply'] }));
    t.outcome(errors.length ? 'invalid' : 'ok');
    attempts.push({ kind, model: reply.model, raw: cut(reply.text), raw_bytes: Buffer.byteLength(reply.text), errors });
    if (!errors.length) return { requirement_id: rid, passage_id: role.passage_id, role: role.role, attempts, cases: value.cases };
    messages = [...messages, { role: 'assistant', content: reply.text || '(empty)' },
      { role: 'user', content: `QB refused your reply:\n${errors.map((e) => `- ${e}`).join('\n')}\n\nReply again with ONE JSON object that matches the required schema exactly, for REQUIREMENT ${rid}.` }];
  }
  return { requirement_id: rid, passage_id: role.passage_id, role: role.role, attempts, cases: null };
}

// ── assembly ────────────────────────────────────────────────────────────────

const argText = (args) => args.map((a) => JSON.stringify(a)).join(', ');

/** The contract object (before contractFromObject) from the roles, the accepted facts and the targets. */
function assemble(request, roles, facts, targets, fragments) {
  const byLabel = new Map(targets.map((x) => [x.label, x]));
  const factsOf = new Map(facts.map((f) => [f.passage_id, f]));
  const requirements = []; const acs = []; const checks = []; const constraints = []; const policy = [];
  const used = new Set();
  roles.forEach((r, i) => {
    const rid = `R-${i + 1}`;
    requirements.push({ id: rid, passage_ids: [r.passage_id], quote: r.text, ...(r.role === 'context' ? { disposition: 'context', reason: 'location only' } : {}) });
    if (r.role === 'adds_tests') {
      acs.push({ id: `AC-${acs.length + 1}`, criterion: `New tests are added in ${r.file} and they pass (requested tests: decided from the test run, for human review).`,
        kind: 'behavioral', requirement_ids: [rid], adds_tests: { files: [r.file] } });
      return;
    }
    if (r.role === 'context') return;
    for (const c of (factsOf.get(r.passage_id) || {}).cases || []) {
      const t = byLabel.get(c.call);
      const n = acs.length + 1;
      const call = `${t.display}(${argText(c.args)})`;
      const frag = c.outcome === 'throws' && c.error_fragment !== null ? fragments[c.error_fragment].text : null;
      const kept = r.role === 'keep';
      const claim = c.outcome === 'throws'
        ? `${kept ? 'still ' : ''}throws an error${frag ? ` whose message includes ${JSON.stringify(frag)}` : ''}`
        : `${kept ? 'still ' : ''}returns ${JSON.stringify(c.expected)}`;
      acs.push({ id: `AC-${n}`, criterion: `${call} ${claim}${kept ? ' (behaviour kept)' : ''}.`, kind: 'behavioral', requirement_ids: [rid] });
      const check = checkFor(t, c, frag, `CHK-${n}`, `AC-${n}`);
      if (check) { checks.push(check); used.add(t.module); }
      if (kept) {
        policy.push(check ? { constraint: constraints.length, enforced_by: [{ kind: 'check', ref: check.id }] } : { constraint: constraints.length, advisory: true });
        constraints.push(`Keep the existing behaviour (${r.passage_id} ${JSON.stringify(r.text)}): ${call} ${claim}.`);
      }
    }
  });
  const rt = requestTargets(request);
  const allowed = [...new Set([...rt.targets.map((t) => t.path), ...[...used].filter((m) => !rt.ignored.some((x) => x.path === m && x.why !== 'mentioned'))])];
  const behaviour = acs.filter((a) => !a.adds_tests).map((a) => a.criterion);
  return {
    goal: request.trim(),
    required_behavior: behaviour.length ? behaviour : acs.map((a) => a.criterion),
    constraints, constraint_policy: policy,
    acceptance_criteria: acs, requirements, checks,
    scope: { allowed_changes: allowed, protected_paths: [] },
    verification_plan: [
      'Run the checks QB assembled for each criterion against the changed code (the model chose only inputs, expected values and fragments).',
      ...(acs.some((a) => a.adds_tests) ? ['Run the requested test files: each must be in the change and pass (human review decides whether they test the change).'] : []),
    ],
    relevant_context: allowed,
    ambiguity_flags: [], clarifying_question: null, proposed_defaults: [],
  };
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
  const targets = callTargets(request, g.api);
  const fragments = fragmentList(targets);
  const staged = { format: FORMAT, roles: roles.map((r) => ({ passage_id: r.passage_id, role: r.role, ...(r.file ? { file: r.file } : {}) })),
    call_targets: targets.map((x) => ({ label: x.label, module: x.module, kind: x.kind, export: x.export, ...(x.method ? { method: x.method } : {}) })),
    fragments: targets.map((x) => ({ call: x.label, pieces: x.pieces })), fragment_list: fragments.map((f) => f.text), facts: [] };
  const done = (state, extra) => ({ format: 'qb-intent-handoff/1', state, round: 1, history: [], survey: g.grounding, staged, ...extra });

  // Not handled by this prototype: a clarification question (it stops instead of guessing).
  const amb = detectAmbiguity(request, []);
  const unclear = requestTargets(request).ambiguous[0];
  if (amb || unclear) return done('invalid', { contract: null, errors: [`the staged L1 prototype does not ask clarification questions: ${amb ? amb.clarifying_question : unclear.reason}`] });
  const asks = roles.map((r, i) => ({ r, rid: `R-${i + 1}` })).filter((x) => x.r.role === 'change' || x.r.role === 'keep');
  if (asks.length && !targets.length) return done('invalid', { contract: null, errors: ['the staged L1 prototype needs a function or method call named in the request (e.g. `name(` or `Class.method(`); none was found'] });

  const ctx = { request, targets, fragments, api: g.api };
  for (const { r, rid } of asks) {
    const f = await factsFor(ctx, r, rid, t);
    staged.facts.push(f);
    if (!f.cases) {
      return done('invalid', { contract: null, errors: [`${rid} (${r.passage_id}): the model's facts were refused after one repair: ${f.attempts.at(-1).errors.join('; ')}`] });
    }
  }
  const raw = assemble(request, roles, staged.facts, targets, fragments);
  const contract = contractFromObject(raw, request);
  if (g.api) contract.api_grounding = contractGrounding(g.api);
  const cs = t.validate(() => contractState(contract));
  return cs.state === 'finalized' ? done('finalized', { contract }) : done('invalid', { contract, errors: cs.errors || [cs.question] });
}

module.exports = { compileStaged, passageRoles, isLocationOnly, literalPieces, callTargets, fragmentList, factSchema, validateFacts, schemaErrors, assemble, apiSummary, FORMAT };
