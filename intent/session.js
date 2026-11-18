/**
 * intent/session.js — grounded compilation with bounded clarification (QB-17).
 *
 * The one entry point root (qb.js) and standalone (intent/cli.js) compilation
 * share:
 *   1. survey the repository (intent/survey.js) BEFORE semantic compilation;
 *   2. compile with the survey and every answer so far (round by round);
 *   3. while the compiler (DSA rule or model) still has an open question, use the
 *      next answer — from `answers`, or `ask(handoff)` — for at most `maxRounds`
 *      rounds; an answer that does not resolve the choice keeps it open.
 *
 * Returns a machine-readable handoff state a caller or UI can store and resume:
 *   { state: 'finalized', contract, round, history, survey }
 *   { state: 'needs_clarification', round, max_rounds, unresolved: [{ id, question, choices, flag }], history, survey }
 *   { state: 'blocked', reason: 'clarification_rounds_exhausted', round, max_rounds, unresolved, history, survey }
 *   { state: 'invalid', errors, contract, history, survey }
 * Only 'finalized' carries an executable contract.
 *
 * KAN-103 / KAN-104: a draft the compiler generated gets ONE correction in total (intent/compiler.js
 * repair) before the state is 'invalid', whether the validator rejected it or the reply was not JSON
 * at all. The correction is parsed and validated from scratch by the same code, and is never
 * corrected again. A correction may not bring in a proposed default the rejected draft had not
 * already justified (same id and text, covered there). When a correction was attempted, the result carries
 *   repair: { attempted: true, rejected: [{ kind: 'invalid', contract, errors }
 *                                         | { kind: 'syntax', contract: null, diagnostic, errors, raw, raw_bytes, raw_truncated }, …] }
 * (every rejected draft, in order; `raw` is at most 16 KiB of UTF-8 of an unreadable reply).
 * If the corrective call itself fails (empty reply, network error, cancellation), the error is
 * rethrown with `error.recovery = { attempted: true, rejected, failed: { kind, message } }`.
 * The contract is never approved here; approval stays with the caller (QB-13).
 *
 * KAN-106: every result carries `timings` (qb-l1-timings/1; also `error.l1_timings` when L1 throws):
 *   survey_ms         the repository survey;
 *   initial_call_ms   the first draft's model call (null when no model call was made, e.g. a DSA question);
 *   validation_ms     total time in the contract validator (all drafts);
 *   repair_call_ms    each corrective model call (at most one today);
 *   l1_ms             compileIntent overall;
 *   calls             every model call in order: { kind: 'initial' | 'repair', round, ms, outcome }.
 * Times are ms from `now` (default: a monotonic clock, lib/budget.js monotonicMs; tests inject a fake clock).
 *
 * KAN-106 (senior 10674 F-d): `o.l1Budget` (lib/budget.js l1Budget) bounds ALL of L1 when it is
 * enforced (an explicit --l1-budget / QB_L1_BUDGET_MS / --l1-profile): a monotonic deadline from the
 * start of compileIntent; each model call gets min(per-call cap, what is left of L1, the run
 * deadline). Once it is spent no further call starts (in particular no repair): a DeadlineError of
 * kind 'l1' is thrown with the timings kept (error.l1_timings) and, after a rejected draft,
 * error.recovery = { attempted: false, rejected, failed: { kind: 'l1_budget', message } }. One repair
 * at most, as before. `o.warmup` makes one explicit warm-up call first (intent/compiler.js warmup),
 * recorded as its own call and inside L1's time and budget. Each call records limit_ms and, when
 * Ollama reports it, load_ms (cold model load).
 */

const { compile, repair, warmup } = require('./compiler');
const { l1Deadline, monotonicMs, L1_PROFILES } = require('../lib/budget');
const { contractState, laterStageErrors, requirementDispositions } = require('./contract-state');
const { preservationConflicts } = require('../verify/preservation');
const { surveyRepository, surveySummary } = require('./survey');
const { groundApi, apiSummary } = require('./api-grounding');
const { parseSelection, answerText } = require('./dsa');
const { validateDefaults } = require('./requirements');

const MAX_ROUNDS = 3;
const FORMAT = 'qb-intent-handoff/1';

/**
 * @param {string} request
 * @param {object} [o]
 * @param {string|null} [o.repoPath]   repository to survey (null: no grounding)
 * @param {Array<string|{question, choice}>} [o.answers]  answers for rounds 1..n, in order: free text
 *                                     (bound to the question asked that round) or a structured selection
 *                                     "<question id>=<choice id>" / { question, choice } (bound to that question)
 * @param {Function} [o.ask]           async (handoff) => answer|null, when answers run out
 * @param {number} [o.maxRounds]
 */
async function compileIntent(request, o = {}) {
  const t = l1Timer(o.now || monotonicMs, o.l1Budget || null);
  try {
    if (o.warmup) await warmupStep(t);
    // KAN-106 (owner priority after 10733): only the explicit staged profile takes the staged path.
    const s = isStaged(o.l1Budget) ? await stagedRounds(request, o, t) : await compileRounds(request, o, t);
    return { ...s, timings: t.result() };
  } catch (e) {
    t.failed(e && e.code === 'DEADLINE' && e.kind === 'l1' ? 'l1_budget_exhausted' : 'error');
    if (e && typeof e === 'object') e.l1_timings = t.result();
    throw e;
  }
}

/** KAN-106 (10674 F-d): the optional warm-up call; its failure is recorded, an exhausted L1 budget ends L1. */
async function warmupStep(t) {
  t.check('warm-up');
  try { await warmup(t.timer('warmup', 0)); t.outcome('ok'); }
  catch (e) { if (e && e.code === 'DEADLINE' && e.kind === 'l1') throw e; t.outcome('error'); }
}

const STEP = { warmup: 'warm-up call', initial: 'first draft call', repair: 'repair call', fact: 'fact call', fact_repair: 'fact repair call' };

/** KAN-106: is this L1 budget the explicit STAGED profile (intent/staged.js)? Nothing else is. */
const isStaged = (b) => Boolean(b && b.profile && L1_PROFILES[b.profile] && L1_PROFILES[b.profile].staged === true);

/** KAN-106 (option B of 10733, offline prototype): the staged compiler, with the same grounding and timer. */
async function stagedRounds(request, { repoPath = null } = {}, t) {
  const [survey, api] = repoPath ? t.survey(() => [surveyRepository(repoPath, request), groundApi(repoPath, request)]) : [null, null];
  const grounding = survey ? { ...surveySummary(survey), api: apiSummary(api) } : null;
  return require('./staged').compileStaged(request, { api, grounding }, t);
}

/** KAN-106: elapsed time of each L1 step, on one clock, and (10674) the L1 deadline on that clock. */
function l1Timer(clock, budget = null) {
  // Whole milliseconds on one clock (the monotonic default is fractional).
  const now = () => Math.round(clock());
  const start = now();
  const deadline = l1Deadline(budget, now);
  const calls = [];
  let validation = 0;
  let survey = 0;
  return {
    now,
    timer: (kind, round, extra = {}) => ({ now, limits: () => deadline.limits(STEP[kind] || kind),
      onModelCall: (ms, info = {}) => calls.push({ kind, round, ...extra, ms, outcome: null, limit_ms: info.limit_ms ?? null, load_ms: info.load_ms ?? null }) }),
    check: (step) => deadline.check(step),
    /** The outcome of the latest model call, once its draft has been read and validated. */
    outcome(kind) { const c = calls.at(-1); if (c && c.outcome === null) c.outcome = kind; },
    failed(kind = 'error') { const c = calls.at(-1); if (c && c.outcome === null) c.outcome = kind; },
    validate(fn) { const t0 = now(); try { return fn(); } finally { validation += now() - t0; } },
    survey(fn) { const t0 = now(); try { return fn(); } finally { survey = now() - t0; } },
    result: () => {
      const first = calls.find((c) => c.kind === 'initial');
      const warm = calls.find((c) => c.kind === 'warmup');
      const l1 = now() - start;
      return { schema: 'qb-l1-timings/1', survey_ms: survey, warmup_ms: warm ? warm.ms : null, initial_call_ms: first ? first.ms : null, validation_ms: validation,
        repair_call_ms: calls.filter((c) => c.kind === 'repair').map((c) => c.ms), l1_ms: l1, calls: calls.map((c) => ({ ...c })),
        l1_budget: budget ? { ...budget, exhausted: Boolean(budget.enforced) && l1 >= budget.ms } : null,
        // KAN-106 (staged profile only): the per-requirement fact calls and their repairs
        ...(calls.some((c) => c.kind === 'fact') ? { fact_call_ms: calls.filter((c) => c.kind === 'fact').map((c) => c.ms), fact_repair_call_ms: calls.filter((c) => c.kind === 'fact_repair').map((c) => c.ms) } : {}) };
    },
  };
}

async function compileRounds(request, { repoPath = null, answers = [], ask = null, maxRounds = MAX_ROUNDS } = {}, t) {
  // KAN-106 (10706): with the survey, the static API grounding of the request-named modules (never executed).
  const [survey, api] = repoPath ? t.survey(() => [surveyRepository(repoPath, request), groundApi(repoPath, request)]) : [null, null];
  const grounding = survey ? { ...surveySummary(survey), api: apiSummary(api) } : null;
  const history = [];
  for (let round = 1; ; round++) {
    const context = survey ? survey.text : null;
    t.check('first draft call');
    const first = await draft(() => compile(request, context, history, { timer: t.timer('initial', round), apiGrounding: api }));
    const result = first.contract;
    const cs = first.syntax ? { state: 'invalid' } : t.validate(() => contractState(result));
    t.outcome(first.syntax ? 'syntax' : cs.state);
    if (cs.state === 'finalized') return { format: FORMAT, state: 'finalized', contract: result, round, history, survey: grounding };
    if (cs.state === 'invalid') {
      // KAN-103 / KAN-104: ONE corrective call in total for QB's own draft, whether it was
      // unreadable or invalid; the correction is parsed and validated from scratch.
      const later = first.syntax ? [] : laterStageErrors(result).filter((e) => !cs.errors.includes(e));
      const rejected = [first.syntax ? syntaxEntry(first.syntax) : invalidEntry(result, cs.errors, later)];
      // KAN-106 (10677): the user explicitly asked to keep a file's tests passing AND to change that
      // file. No draft can verify that as written without deleting the user's requirement, so it is
      // reported as unsupported; no repair call is made.
      const unsupported = first.syntax ? [] : unsupportedPreservation(result);
      if (unsupported.length) {
        return { format: FORMAT, state: 'invalid', errors: cs.errors, unsupported, contract: result, round, history, survey: grounding, repair: { attempted: false, reason: 'unsupported_request', rejected } };
      }
      const failure = first.syntax ? { kind: 'syntax', diagnostic: first.syntax.diagnostic } : { kind: 'invalid', contract: result, errors: cs.errors, later_errors: later };
      try { t.check('repair call'); }
      catch (e) {
        // 10674: no repair once the L1 budget is spent; the rejected draft stays in the run record.
        e.recovery = { attempted: false, rejected, failed: { kind: 'l1_budget', message: e.message } };
        throw e;
      }
      let second;
      try { second = await draft(() => repair(request, context, history, failure, { timer: t.timer('repair', round), apiGrounding: api })); }
      catch (e) {
        // Re-review 1: the correction itself failed (empty reply, network, cancellation). The first
        // draft and its errors travel with the error so the caller can keep them in the run record.
        if (e && typeof e === 'object') e.recovery = { attempted: true, rejected, failed: { kind: e.code === 'DEADLINE' ? (e.kind === 'l1' ? 'l1_budget' : 'cancelled') : 'error', message: String(e.message || e) } };
        throw e;
      }
      if (second.syntax) {
        t.outcome('syntax');
        const errors = [`the corrected draft was not valid JSON either: ${second.syntax.diagnostic}`];
        rejected.push(syntaxEntry(second.syntax));
        return { format: FORMAT, state: 'invalid', errors, contract: null, round, history, survey: grounding, repair: { attempted: true, rejected } };
      }
      const fixed = second.contract;
      let fixedLater = [];
      const errors = t.validate(() => {
        const fixedState = contractState(fixed);
        if (fixedState.state === 'invalid') fixedLater = laterStageErrors(fixed).filter((e) => !fixedState.errors.includes(e));
        return [
          ...(fixedState.state === 'invalid' ? fixedState.errors : []),
          ...fixedLater,   // KAN-106 (10677): what the earlier stage masked, so the final reasons are complete
          ...(fixedState.state === 'needs_clarification' ? [`the correction asked a question instead of correcting the draft: ${fixedState.question}`] : []),
          ...(first.syntax ? [] : correctionDefaultErrors(result, fixed)),
        ];
      });
      t.outcome(errors.length ? 'invalid' : 'finalized');
      if (!errors.length) return { format: FORMAT, state: 'finalized', contract: fixed, round, history, survey: grounding, repair: { attempted: true, rejected } };
      rejected.push(invalidEntry(fixed, errors, fixedLater));
      return { format: FORMAT, state: 'invalid', errors, contract: fixed, round, history, survey: grounding, repair: { attempted: true, rejected } };
    }

    const unresolved = Array.isArray(result.unresolved) && result.unresolved.length ? result.unresolved
      : [{ id: `Q-${round}`, question: cs.question, choices: [], flag: (result.ambiguity_flags || [])[0] || null }];
    const open = { format: FORMAT, round, max_rounds: maxRounds, unresolved, ambiguity_flags: result.ambiguity_flags || [], history: [...history], survey: grounding };
    if (round > maxRounds) return { ...open, state: 'blocked', reason: 'clarification_rounds_exhausted', round: maxRounds };
    let answer = answers[round - 1];
    const empty = (a) => a === undefined || a === null || !answerText(a).trim();
    if (empty(answer) && ask) answer = await ask({ ...open, state: 'needs_clarification' });
    if (empty(answer)) return { ...open, state: 'needs_clarification' };
    // Bind the answer to its question: a structured selection names it; free text
    // answers the question asked this round (the first open one).
    const sel = parseSelection(answer);
    // (a follow-up "<rule>.target" belongs to its rule: a selection naming the rule answers it)
    const asked = (sel && unresolved.find((u) => u.id === sel.question || u.parent === sel.question)) || unresolved[0];
    history.push({ round, question_id: asked.id, question: asked.question, answer: answerText(answer).trim() });
  }
}

const RAW_LIMIT = 16 * 1024;   // bytes of UTF-8

/** A model call for a draft: { contract } or, when the reply was not JSON, { syntax } (KAN-104). */
async function draft(call) {
  try { return { contract: await call() }; } catch (e) { if (e && e.code === 'DRAFT_SYNTAX') return { syntax: e }; throw e; }
}

/** An unreadable draft as run evidence: the diagnostic and at most 16 KiB of the reply. */
/** A rejected, readable draft for the run record, with every requirement's disposition (10677). */
function invalidEntry(contract, errors, laterErrors = []) {
  return { kind: 'invalid', contract, errors, later_errors: laterErrors, trace: requirementDispositions(contract) };
}

/** KAN-106 (10677): explicitly requested preservations of a file the request also asks to change. */
function unsupportedPreservation(contract) {
  return preservationConflicts(contract).filter((x) => x.requested).map((x) => ({
    criterion_id: x.criterion_id, files: x.files, passages: x.passages,
    reason: `The request asks both to change ${x.files.join(', ')} and to keep its existing tests passing (${x.passages.join(', ')}). `
      + `QB can only show that preserved tests still pass for a file the task does not edit, so it cannot verify this request as written. `
      + `Name the existing tests to keep in another file, or say whether the existing tests in ${x.files.join(', ')} may change.`,
  }));
}

function syntaxEntry(e) {
  const buf = Buffer.from(String(e.raw ?? ''), 'utf8');
  // Re-review 3: the limit is in UTF-8 bytes, and a cut never splits a character (back off to
  // the start of the character the limit falls in: continuation bytes are 0b10xxxxxx).
  let end = Math.min(buf.length, RAW_LIMIT);
  if (end < buf.length) while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return { kind: 'syntax', contract: null, diagnostic: e.diagnostic, errors: [`not valid JSON: ${e.diagnostic}`],
    raw: buf.subarray(0, end).toString('utf8'), raw_bytes: buf.length, raw_truncated: end < buf.length };
}

/**
 * KAN-103 (re-review 2): a correction fixes the listed errors; it does not make new choices. Its
 * proposed defaults must each be one the rejected draft had already justified — same id, same text,
 * covered by a criterion there. Anything else is refused, however it is worded: a default the
 * rejected draft left uncovered was never justified, so a correction must drop it rather than cite
 * it with new criteria, and a reworded or new default is a new choice. (This says nothing about
 * whether the request needs that choice; it limits what a correction may decide on its own.)
 */
function correctionDefaultErrors(rejected, fixed) {
  if (!Array.isArray(fixed?.proposed_defaults) || !fixed.proposed_defaults.length) return [];
  const norm = (t) => String(t || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const before = validateDefaults(rejected).defaults;
  const justified = new Set(before.filter((d) => d.covered_by.length).map((d) => `${d.id}\u0000${norm(d.text)}`));
  const flagged = new Set(before.filter((d) => !d.covered_by.length).map((d) => norm(d.text)));
  return fixed.proposed_defaults.filter((d) => !(d && justified.has(`${d.id}\u0000${norm(d.text)}`))).map((d) => (flagged.has(norm(d?.text))
    ? `proposed default ${d.id} ${JSON.stringify(d.text)} was flagged as uncovered in the rejected draft; a correction must remove it, not add criteria to cite it`
    : `proposed default ${d?.id} ${JSON.stringify(d?.text)} is new in the correction; a correction may not add a choice the rejected draft had not already justified (remove it)`));
}

module.exports = { compileIntent, MAX_ROUNDS, FORMAT };
