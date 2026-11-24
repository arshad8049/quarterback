require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { TaskContractSchema, ClarifyingResponseSchema } = require('./schema');
const { contractState } = require('./contract-state');
const { detectAmbiguity, resolveClarifications } = require('./dsa');

const OLLAMA_URL = process.env.QB_OLLAMA_URL || 'http://127.0.0.1:11434';
const MODEL      = process.env.QB_MODEL       || 'deepseek-r1:7b';
// Fields the model is allowed to author. Everything else in its output is ignored.
const SEMANTIC_FIELDS = [
  'goal', 'required_behavior', 'constraints', 'acceptance_criteria',
  'verification_plan', 'relevant_context', 'ambiguity_flags', 'clarifying_question',
  'scope', 'constraint_policy',   // QB-09: enforced policy, validated by contractState
  'requirements',                 // QB-14: request clauses with verbatim quotes, validated by contractState
  'test_policy',                  // QB-10: explicit, approved waiver of pre-existing test failures
  'proposed_defaults',            // QB-17: QB's own choices where the request is silent — shown and approved, never silent
];
const { modelCall } = require('../lib/budget');
const { validateChecks } = require('../verify/checks/registry');
const { splitPassages, passageListing, resolveInRequest } = require('./passages');
const { requestTargets } = require('./request-targets');
const { groundingExcerpt, contractGrounding } = require('./api-grounding');

const SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, 'prompts/system.md'), 'utf8');

/**
 * @param {string} request
 * @param {string|null} repoContext   the repository survey text (intent/survey.js, QB-17)
 * @param {string|Array<{question, answer}>|null} clarification  answers so far, round by round
 * @param {object} [o]
 * @param {{ now: Function, onModelCall: Function }} [o.timer]  KAN-106: told the model call's elapsed ms
 */
async function compile(request, repoContext = null, clarification = null, o = {}) {
  const history = Array.isArray(clarification) ? clarification
    : clarification ? [{ question: null, answer: String(clarification) }] : [];
  // DSA pre-pass (QB-17): a vague term blocks until the request or an answer defines it.
  // Each answer is bound to the question it answered (QB-17 re-review 1); a
  // parameterized choice needs its value (re-review 2).
  const bound = history.map((h) => ({ question_id: h.question_id ?? null, answer: h.answer }));
  const ambiguity = detectAmbiguity(request, bound);
  if (ambiguity) return ambiguity;
  // KAN-106 (10674 F-a): QB cannot tell whether a named file may be changed: ask, never guess.
  const scopeQuestion = targetQuestion(request, bound);
  if (scopeQuestion) return scopeQuestion;
  const clar = resolveClarifications(request, bound);
  return draftContract(request, buildUserContent(request, repoContext, history, clar.byEntry, o.apiGrounding), clar, o.timer, o.apiGrounding);
}

/**
 * KAN-103 / KAN-104: the one correction of a draft QB generated. The model gets the same request,
 * survey and clarifications, plus what went wrong, and writes the contract again:
 *   { kind: 'invalid', contract, errors }  the validator rejected a parsed draft: the draft (its
 *                                          model-authored fields) and the errors are sent back;
 *   { kind: 'syntax', diagnostic }         the reply was not JSON: only the parser's diagnostic is
 *                                          sent, and a fresh draft is asked for.
 * The result is normalized exactly like a first draft; the caller validates it from scratch
 * (contractState). Never used for a user-supplied contract file.
 */
async function repair(request, repoContext, clarification, failure, o = {}) {
  const history = Array.isArray(clarification) ? clarification
    : clarification ? [{ question: null, answer: String(clarification) }] : [];
  const clar = resolveClarifications(request, history.map((h) => ({ question_id: h.question_id ?? null, answer: h.answer })));
  const section = failure.kind === 'syntax' ? syntaxSection(failure.diagnostic) : repairSection(failure.contract, failure.errors, failure.later_errors || []);
  return draftContract(request, `${buildUserContent(request, repoContext, history, clar.byEntry, o.apiGrounding)}\n\n${section}`, clar, o.timer, o.apiGrounding);
}

const TARGET_QUESTION = 'scope.target';
/** A clarifying question for the first ambiguous file instruction (intent/request-targets.js), unless already answered. */
function targetQuestion(request, bound) {
  if (bound.some((b) => b.question_id === TARGET_QUESTION)) return null;
  const a = requestTargets(request).ambiguous[0];
  if (!a) return null;
  const question = `May the task change ${a.path}? The request says ${JSON.stringify(a.passage)} and then limits it, so QB cannot tell whether ${a.path} is to be edited.`;
  return { ambiguity_flags: [a.reason], clarifying_question: question, unresolved: [{ id: TARGET_QUESTION, question, choices: [], flag: a.reason }] };
}

function syntaxSection(diagnostic) {
  return [
    'YOUR PREVIOUS REPLY WAS NOT VALID JSON, so QB could not read it.',
    '',
    `JSON SYNTAX ERROR: ${diagnostic}`,
    '',
    'Write a fresh contract for the REQUEST as ONE valid JSON object, in the required format:',
    '- every string value in double quotes; a function or module name used as a value is a string;',
    '- no comments, no trailing commas, no text outside the object;',
    '- set clarifying_question to null.',
  ].join('\n');
}

/**
 * What the model wrote in the rejected draft: its own fields only, not QB's metadata. A quote QB
 * copied from cited passages (KAN-106) is QB's, so it is left out: the model sees its ids.
 */
function modelAuthored(c) {
  const out = {};
  for (const key of [...SEMANTIC_FIELDS, 'checks']) if (c && c[key] !== undefined) out[key] = c[key];
  if (Array.isArray(out.requirements)) {
    out.requirements = out.requirements.map((r) => {
      if (!r || typeof r !== 'object' || r.passage_ids === undefined) return r;
      const { quote, ...rest } = r;   // eslint-disable-line no-unused-vars
      return rest;
    });
  }
  return out;
}

/**
 * KAN-106 (10677): name each criterion that preserves a file the request asks to change, and why it
 * conflicts. Only unrequested claims reach a repair (an explicitly requested one is reported as
 * unsupported before any repair, intent/session.js); the model is told to remove them with their
 * bindings, never to keep the claim in another form. QB does not edit the model's draft itself.
 */
function conflictSection(rejected) {
  const { preservationConflicts } = require('../verify/preservation');
  const conflicts = preservationConflicts(rejected).filter((x) => !x.requested);
  if (!conflicts.length) return [];
  const addTargets = new Map(requestTargets(rejected.raw_request || '').targets.filter((t) => t.action === 'add_tests').map((t) => [t.path, t]));
  const lines = ['CONFLICTING CRITERIA (they preserve a file the request asks to change):'];
  const toCover = new Set();
  for (const x of conflicts) {
    const files = x.files.join(', ');
    const cites = x.cited.length ? x.cited.map((r) => `${r.id} (${r.passage_ids.join(', ')} ${JSON.stringify(r.quote)})`).join(', ') : 'no requirement';
    const adds = x.files.every((f) => addTargets.has(f));
    lines.push(`- ${x.criterion_id} claims that existing tests in ${files} still pass. No request passage asks for that: it cites ${cites}, which ${adds ? `asks to ADD tests to ${x.files.length > 1 ? 'those files' : 'that file'}` : 'does not ask for it'}, and the task changes ${x.files.length > 1 ? 'those files' : 'that file'}. `
      + `Remove ${x.criterion_id}${x.checks.length ? `, the checks bound to it (${x.checks.join(', ')}),` : ''} and the constraints and constraint_policy entries that exist only for it.`);
    for (const r of x.cited) toCover.add(r.id);
  }
  lines.push('- Do not keep the same claim with "preserves" deleted, reworded, or with the criterion marked non_behavioral. QB\'s own regression gate already fails the task on any new test failure, so removing these criteria drops no protection.');
  if (toCover.size) lines.push(`- Then cover ${[...toCover].join(', ')} with the criterion that requires adding the tests ("adds_tests"), or with the behaviour criteria they support.`);
  return [...lines, ''];
}

function repairSection(rejected, errors, laterErrors = []) {
  return [
    'YOUR PREVIOUS DRAFT WAS REJECTED by QB\'s contract validator. Write the whole contract again, in the same JSON format, for the same REQUEST.',
    '',
    'VALIDATION ERRORS:',
    ...errors.map((e) => `- ${e}`),
    '',
    // KAN-106 (10677): later stages run only once earlier ones pass, so their errors (e.g. an
    // uncovered requirement) are sent too; otherwise one repair could never fix both.
    ...(laterErrors.length ? ['ALSO TO FIX (QB checks these after the errors above):', ...laterErrors.map((e) => `- ${e}`), ''] : []),
    ...conflictSection(rejected),
    'REJECTED DRAFT:',
    JSON.stringify(modelAuthored(rejected), null, 2),
    '',
    'When you correct it:',
    '- Fix every validation error above.',
    '- Cite request passages by id in each requirement\'s passage_ids (QB copies their exact text); do not retype the request. Every passage P1…Pn must be cited by at least one requirement; one passage may support several requirements.',
    '- Keep every part of the request. Add nothing the request does not ask for.',
    '- A scope error about a file the request asks to change: keep that file in scope.allowed_changes and remove or narrow the protected_paths glob that covers it. Never fix a scope conflict by dropping requested work or its criterion.',
    '- Keep the criterion that requires adding the requested tests, with "adds_tests": { "files": [<the test file>] }. Do not mark that requirement "context", and do not mark the criterion non_behavioral.',
    '- A passage that only names a file location: list its requirement in requirement_ids of the criteria that test that file, or mark it disposition "context" with a reason "location only".',
    '- A criterion that says tests still pass names literal test files in preserves.tests that the task does not edit, and has no value checks bound to it.',
    '- Remove every proposed default that was "not covered by any acceptance criterion". Do NOT add criteria to justify it, and do not add new or reworded defaults.',
    '- If an allowed change is "entirely covered by scope.protected_paths", remove or narrow that allowed_changes entry. Keep every protected path a constraint is enforced by; never remove a protection to make room for a change.',
    '- Do not ask a clarifying question; set clarifying_question to null.',
  ].join('\n');
}

/**
 * One model call for a contract draft, normalized by the same rules as every contract. KAN-106
 * (10706): QB's static API grounding (intent/api-grounding.js) is attached to the draft by QB, never
 * taken from the model, so the validator can refuse a check naming an export proved absent.
 */
async function draftContract(request, userContent, clar, timer = null, apiGrounding = null) {
  // QB-21: deadline-bound, cancellable, concurrency-bounded (lib/budget.js)
  const t0 = timer ? timer.now() : 0;
  // KAN-106 (10674 F-d): the call's limit is min(per-call cap, what is left of L1, the run deadline).
  let limit = null;
  const lim = { ...(timer && timer.limits ? timer.limits() : {}), onLimit: (ms) => { limit = ms; } };
  let data;
  try {
    data = await modelCall(`${OLLAMA_URL}/api/chat`, {
    model: MODEL,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user',   content: userContent },
    ],
    stream: false,
    options: { temperature: 0.1, num_ctx: 16384 },
    }, lim);
  } finally {
    // KAN-106: the model call's own elapsed time, whether it answered or failed, with its limit and
    // (when Ollama reports it) the model load time: a cold load shows here, never hidden.
    if (timer) timer.onModelCall(timer.now() - t0, { limit_ms: limit, load_ms: loadMs(data) });
  }
  const raw = data.message?.content;
  if (!raw) throw new Error('Empty response from Ollama');

  const result = parseAndValidate(raw, request);
  // The user's resolved selections, with their values, bound to their questions:
  // recorded by QB (never by the model), approved with the contract (QB-17 re-review 2).
  if (result && !result.clarifying_question) {
    if (clar.resolved.length) result.clarifications = clar.resolved;
    else delete result.clarifications;
    if (apiGrounding) result.api_grounding = contractGrounding(apiGrounding);   // provenance only, no source text (10710)
    else delete result.api_grounding;
  }
  return result;
}

/** Ollama's reported model load time (load_duration, ns) in ms, or null when not reported. */
const loadMs = (data) => (data && Number.isFinite(data.load_duration) ? Math.round(data.load_duration / 1e6) : null);

/**
 * KAN-106 (10674 F-d): an optional, explicit warm-up before the first draft (--l1-warmup): one
 * request that loads the model (empty prompt, /api/generate). It is inside L1's wall time and
 * budget, bounded like any L1 call, and recorded as its own call. No keep_alive or other Ollama
 * setting is sent or changed.
 */
async function warmup(timer = null) {
  const t0 = timer ? timer.now() : 0;
  let limit = null;
  const lim = { ...(timer && timer.limits ? timer.limits() : {}), onLimit: (ms) => { limit = ms; } };
  let data;
  try { data = await modelCall(`${OLLAMA_URL}/api/generate`, { model: MODEL, prompt: '', stream: false }, lim); }
  finally { if (timer) timer.onModelCall(timer.now() - t0, { limit_ms: limit, load_ms: loadMs(data) }); }
  return { load_ms: loadMs(data) };
}

/**
 * The compiler input. A clarification bound to a DSA question is labelled with its
 * id, and a resolved selection is given as "<choice> = <value>" (QB-17 re-review 2).
 */
function buildUserContent(request, repoContext, history, byEntry = [], apiGrounding = null) {
  let content = `REQUEST:\n${request}`;
  // KAN-106: the request as numbered passages; requirements cite these ids and QB copies the text.
  const passages = splitPassages(request);
  if (passages.length) content += `\n\nREQUEST PASSAGES (cite these ids in requirements[].passage_ids; QB copies the exact text):\n${passageListing(passages)}`;
  history.forEach((h, i) => {
    const b = byEntry[i];
    const r = b && b.resolved;
    const answer = r && r.choice && r.value ? `${r.choice} = ${r.value}`                       // a parameterized choice with its value
      : r && r.choice ? (h.answer.trim() === `${b.rule_id}=${r.choice}` ? r.choice : `${h.answer} [selected: ${r.choice}]`)
        : h.answer;
    const q = b ? `Q(${b.rule_id}): ${h.question}` : `Q: ${h.question}`;
    content += h.question ? `\n\nCLARIFICATION ${i + 1}:\n${q}\nA: ${answer}` : `\n\nCLARIFICATION:\n${answer}`;
  });
  if (repoContext) content += `\n\nREPOSITORY SURVEY (read-only, for grounding — the request decides what to do):\n${repoContext}`;
  // KAN-106 (10706): the exports and methods of the request-named modules, read statically with path + sha256.
  const api = groundingExcerpt(apiGrounding);
  if (api) content += `\n\n${api}`;
  return content;
}

function parseAndValidate(text, request) {
  return contractFromObject(fillPassageQuotes(parseJSON(text, request), request), request);
}

/**
 * KAN-106: for each requirement that cites request passages, QB copies the exact source text of
 * those passages into `quote` (replacing any text the model typed) and drops `occurrence` (the
 * passages fix the position). Ids that do not resolve are left as cited: the validator
 * (intent/requirements.js) reports them, and the draft can be corrected once.
 */
function fillPassageQuotes(raw, request) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.requirements)) return raw;
  raw.requirements = raw.requirements.map((r) => {
    if (!r || typeof r !== 'object' || Array.isArray(r) || r.passage_ids === undefined || r.implied === true) return r;
    const p = resolveInRequest(request, r.passage_ids);
    if (!p.ok) return r;
    const { occurrence, ...rest } = r;   // eslint-disable-line no-unused-vars
    return { ...rest, passage_ids: p.ids, quote: p.text };
  });
  return raw;
}

/**
 * Normalize a contract object (model output, or a human-reviewed contract file,
 * QB-13) with the same rules: explicit criterion text only, registry-validated
 * checks, trusted metadata assigned by QB. The result is NOT approved.
 */
function contractFromObject(raw, request) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('contract must be a JSON object');

  // clarifying_question (QB-08): every nonempty question is preserved. The model
  // sometimes writes a placeholder instead of null; only an EXACT match of a
  // documented sentinel (NO_QUESTION_SENTINELS) means "no question".
  const cq = raw.clarifying_question;
  const isRealQuestion = typeof cq === 'string' && cq.trim() !== '' && !isNoQuestionSentinel(cq);

  if (isRealQuestion) {
    return ClarifyingResponseSchema.parse({
      ambiguity_flags: (raw.ambiguity_flags || []).filter(f => typeof f === 'string' && f.length > 5),
      clarifying_question: cq.trim(),
    });
  }

  raw.clarifying_question = null;

  // QB-17: incomplete output is recorded, never filled with fallback text. A
  // contract with `incomplete` entries is invalid (intent/contract-state.js).
  const incomplete = [];
  for (const key of ['required_behavior', 'verification_plan']) {
    if (!Array.isArray(raw[key]) || raw[key].length === 0) incomplete.push(`missing ${key}`);
  }

  // Normalize string arrays — the model sometimes returns objects with a text field.
  // An entry with no recognizable text is reported, not stringified.
  for (const key of ['required_behavior', 'constraints', 'verification_plan', 'ambiguity_flags']) {
    if (Array.isArray(raw[key])) {
      raw[key] = raw[key].map((item, i) => {
        // KAN-66: a check-shaped plan step is read only by the strict call_returns reader; when
        // that fails it stays unreadable — a text field beside a malformed check is never used.
        const t = typeof item === 'string' ? item
          : key === 'verification_plan' && isCheckShaped(item) ? checkStepText(item)
            : extractString(item);
        if (t === null) incomplete.push(`unreadable ${key}[${i}]`);
        return t;
      }).filter(Boolean);
    } else {
      raw[key] = raw[key] ? [String(raw[key])] : [];
    }
  }
  for (const key of ['required_behavior', 'verification_plan']) {
    if (!raw[key].length && !incomplete.includes(`missing ${key}`)) incomplete.push(`missing ${key}`);
  }

  // Default missing fields so schema validation doesn't fail on incomplete model output
  if (!Array.isArray(raw.relevant_context))  raw.relevant_context  = [];
  if (!Array.isArray(raw.ambiguity_flags))   raw.ambiguity_flags   = [];
  if (raw.clarifying_question === undefined) raw.clarifying_question = null;

  // Acceptance criteria are never invented (QB-08): if the model gave none, the
  // contract has none and the finalization gate (intent/contract-state) blocks it.
  // The criterion text must be an explicit string in `criterion`: it is never
  // derived from an id, another property or a serialized object, so a malformed
  // entry stays blank and the gate blocks the contract.
  raw.acceptance_criteria = Array.isArray(raw.acceptance_criteria)
    ? raw.acceptance_criteria.map((ac, i) => {
      const obj = ac !== null && typeof ac === 'object' && !Array.isArray(ac);
      return {
        id:        obj && typeof ac.id === 'string' && ac.id.trim() ? ac.id : `AC-${i + 1}`,
        criterion: obj && typeof ac.criterion === 'string' ? ac.criterion : '',
        met:       null,
        // Only an explicit "non_behavioral" opts a criterion out of executed checks (QB-16).
        kind:      obj && ac.kind === 'non_behavioral' ? 'non_behavioral' : 'behavioral',
        // QB-14: which requirements this criterion covers (validated by contractState).
        requirement_ids: obj && Array.isArray(ac.requirement_ids) ? ac.requirement_ids.filter((x) => typeof x === 'string') : [],
        ...(obj && ac.preserves !== undefined ? { preserves: ac.preserves } : {}),   // QB-15: validated by contractState
        ...(obj && ac.adds_tests !== undefined ? { adds_tests: ac.adds_tests } : {}),   // KAN-106: validated by contractState
      };
    })
    : [];

  // Only semantic fields come from the model. Trusted metadata is assigned
  // afterwards by the application and can never be overridden (QB-04).
  const semantic = {};
  for (const key of SEMANTIC_FIELDS) semantic[key] = raw[key];

  // QB-16: proposed checks are data, validated against the versioned registry;
  // rejected ones are recorded and never run. No shell text is accepted.
  const checks = validateChecks(raw.checks, raw.acceptance_criteria);

  const contract = {
    ...semantic,
    checks: checks.accepted,
    checks_rejected: checks.rejected,
    checks_registry: checks.version,
    id: randomUUID(),
    created_at: new Date().toISOString(),
    raw_request: request,
    repo_path: null,
    ...(incomplete.length ? { incomplete } : {}),   // QB-17: set by QB, never by the model
    // QB-17 re-review 2: a reviewed contract file may carry its clarifications (validated
    // by contractState); for model output compile() replaces them with QB's own record.
    ...(raw.clarifications !== undefined ? { clarifications: raw.clarifications } : {}),
  };

  // A contract the gate will reject (no ACs, missing goal, …) is returned as is,
  // so callers report it as invalid_contract instead of crashing on a schema error.
  const parsed = TaskContractSchema.safeParse(contract);
  if (parsed.success) return parsed.data;
  if (contractState(contract).state === 'invalid') return contract;
  throw parsed.error;
}

/**
 * Exact (case-insensitive, trailing "." ignored) placeholders a model writes for
 * "no question". Anything else nonempty is a real question and is preserved.
 */
const NO_QUESTION_SENTINELS = new Set([
  'null', 'none', 'no', 'n/a', 'na', 'not needed', 'none needed', 'not applicable',
  'no clarification', 'no clarification needed', 'no question', 'no questions',
]);
function isNoQuestionSentinel(q) {
  return NO_QUESTION_SENTINELS.has(q.trim().toLowerCase().replace(/\.$/, ''));
}

/**
 * KAN-66: the model sometimes writes a verification_plan step as the call_returns check
 * it executes ({ adapter, params }) instead of a sentence. Only that demonstrated shape is
 * read, and only when every field is present and well-formed and nothing else is supplied
 * (an unrendered field would be approved unseen): it is rendered from its own fields and
 * the human approves that text with the contract. Every other shape, including the other
 * check adapters, returns null and stays "unreadable" (QB-17).
 */
const STEP_KEYS = new Set(['adapter', 'params', 'plan_item', 'id', 'ac_id']);
const isCheckShaped = (o) => !!o && typeof o === 'object' && !Array.isArray(o)
  && (Object.prototype.hasOwnProperty.call(o, 'adapter') || Object.prototype.hasOwnProperty.call(o, 'params'));
const CALL_RETURNS_KEYS = ['module', 'export', 'args', 'expect'];
function checkStepText(step) {
  if (!step || typeof step !== 'object' || Array.isArray(step)) return null;
  if (Object.keys(step).some((k) => !STEP_KEYS.has(k)) || step.adapter !== 'call_returns') return null;
  if ('plan_item' in step && !(Number.isInteger(step.plan_item) && step.plan_item >= 0)) return null;
  for (const k of ['id', 'ac_id']) if (k in step && typeof step[k] !== 'string') return null;
  const p = step.params;
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  const keys = Object.keys(p);
  if (keys.length !== CALL_RETURNS_KEYS.length || !CALL_RETURNS_KEYS.every((k) => keys.includes(k))) return null;
  if (typeof p.module !== 'string' || !p.module || typeof p.export !== 'string' || !p.export || !Array.isArray(p.args)) return null;
  if (p.expect === undefined) return null;
  return `call_returns: ${p.export}(${p.args.map((a) => JSON.stringify(a)).join(', ')}) from ${p.module} returns ${JSON.stringify(p.expect)}`;
}

/** The text of a list entry the model wrote as an object, or null (QB-17: never guessed). */
function extractString(obj) {
  if (typeof obj === 'string') return obj;
  if (typeof obj === 'number' || typeof obj === 'boolean') return String(obj);
  if (typeof obj !== 'object' || obj === null) return null;
  for (const key of ['text', 'description', 'behavior', 'criterion', 'constraint', 'step', 'item', 'value', 'content']) {
    if (typeof obj[key] === 'string' && obj[key].trim()) return obj[key];
  }
  return null;
}

function parseJSON(text, request) {
  // Strip DeepSeek-R1 reasoning blocks first, trim so ^ anchors work, then strip fences
  let stripped = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  stripped = stripped.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '').trim();

  // Try strict parse first
  try { return JSON.parse(stripped); } catch (_) {}

  // Extract the outermost JSON object if there's surrounding text
  const match = stripped.match(/\{[\s\S]*\}/);
  const candidate = match ? match[0] : stripped;

  // Try with unquoted-key fix (model sometimes outputs JS-style object literals)
  try { return JSON.parse(fixUnquotedKeys(candidate)); } catch (_) {}

  // Last resort: try the candidate as-is. Bare values are never guessed (KAN-104): a reply that
  // is still not JSON is a DraftSyntaxError, which the caller may send back for one fresh draft.
  try { return JSON.parse(candidate); } catch (e) { throw new DraftSyntaxError(request, text, e.message); }
}

/** KAN-104: the model's reply could not be read as JSON. `diagnostic` is the parser's message. */
class DraftSyntaxError extends Error {
  constructor(request, raw, diagnostic) {
    super(`Intent compiler returned non-JSON for: "${request.slice(0, 60)}..."\n\nRaw:\n${raw}`);
    this.name = 'DraftSyntaxError';
    this.code = 'DRAFT_SYNTAX';
    this.raw = raw;
    this.diagnostic = diagnostic;
  }
}

function fixUnquotedKeys(str) {
  // Convert JS-style unquoted keys to quoted JSON keys
  // Matches: word characters followed by colon, not inside a string
  return str.replace(/([{,]\s*)([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/g, '$1"$2":');
}

module.exports = { compile, repair, warmup, contractFromObject, DraftSyntaxError, NO_QUESTION_SENTINELS };
