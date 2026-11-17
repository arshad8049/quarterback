/**
 * intent/request-targets.js: the files the request itself asks to change (KAN-106, senior 10674 F-a).
 *
 * A model may "repair" a scope conflict by dropping requested work (Qwen smoke eba7015e: the
 * correction removed test/asNumber.test.js from allowed_changes, so the requested node:test cases
 * could no longer be written, and QB did not notice). This module derives explicit edit/add targets
 * from the ORIGINAL request text, independently of the model's scope, so the validator can require
 * each one to be allowed and unprotected.
 *
 * Deliberately narrow. Only these unambiguous instruction shapes, per request passage
 * (intent/passages.js), make a path a target:
 *   location  a passage that is exactly "In <path>," followed, in the same sentence, by a passage
 *             starting with an edit verb ("In lib/serializer.js, make …")         → action "edit"
 *   tests     "Add|Write|Create … test(s)|test cases|cases|specs … in|to|into <path>" ending the
 *             passage ("Add node:test cases in test/asNumber.test.js.")          → action "add_tests"
 *   verb      a passage starting "Update|Modify|Edit|Change|Fix|Refactor <path>"  → action "edit",
 *             or "Create <path>"                                                  → action "add"
 * Every other mention is NOT a target: a negation ("Do not change x.js", "leave x.js unchanged",
 * "without touching x.js"), a reference ("see x.js", "like in x.js", "based on x.js") or a plain
 * mention. Not being a target only means QB does not require the path; it never grants permission.
 * A location passage whose following clause is a negation ("In lib/a.js, do not …") is ambiguous:
 * the compiler asks a clarifying question instead of guessing (intent/compiler.js).
 * This is a bounded rule for these shapes. It does not establish that arbitrary natural language
 * has been understood completely.
 */
const { splitPassages } = require('./passages');

const EXT = '(?:c|m)?js|jsx|ts|tsx|json|md|py|rb|go|rs|java|css|html|ya?ml|txt|sh';
const PATH = `(?:[A-Za-z0-9_@-][A-Za-z0-9_.@-]*\\/)*[A-Za-z0-9_@-][A-Za-z0-9_.@-]*\\.(?:${EXT})`;
const PATH_RE = new RegExp(`\`?(${PATH})\`?(?![A-Za-z0-9_/])`, 'g');
const EDIT_VERBS = 'make|change|fix|update|add|implement|modify|edit|rename|replace|remove|refactor|handle|ensure|return|throw|export|convert|validate|support|move|delete|create|use|let|have|keep';
const LOCATION = new RegExp(`^in\\s+\`?(${PATH})\`?\\s*,$`, 'i');
const TESTS = new RegExp(`^(?:add|write|create)\\b.*\\b(?:tests?|test\\s+cases?|cases|specs?)\\b.*\\b(?:in|to|into)\\s+\`?(${PATH})\`?\\s*[.!]?$`, 'i');
const VERB = new RegExp(`^(update|modify|edit|change|fix|refactor|create)\\s+(?:the\\s+(?:file\\s+)?)?\`?(${PATH})\`?(?![A-Za-z0-9_/])`, 'i');
const NEGATION = /\b(?:do\s+not|don't|does\s+not|never|must\s+not|should\s+not|shouldn't|without|unchanged|untouched|read[\s-]only|leave|not\s+(?:change|modify|edit|touch))\b/i;
const REFERENCE = /\b(?:see|like|as\s+in|similar\s+to|based\s+on|following|for\s+reference|refer\s+to|look\s+at|read|mirror(?:s|ing)?|copy\s+from)\b/i;
const NEGATED_START = /^(?:but\s+|and\s+)?(?:do\s+not|don't|never|must\s+not|should\s+not|leave|without)\b/i;
const EDIT_START = new RegExp(`^(?:please\\s+)?(?:${EDIT_VERBS})\\b`, 'i');
const SENTENCE_END = /[.!?]["')\]]*$/;

const plain = (p) => !p.startsWith('/') && !p.split('/').some((s) => s === '' || s === '.' || s === '..');

/**
 * @returns {{ targets: Array<{ path, action: 'edit'|'add'|'add_tests', passage_id, passage, rule }>,
 *             ambiguous: Array<{ path, passage_id, passage, reason }>,
 *             ignored: Array<{ path, passage_id, why: 'negated'|'reference'|'mentioned' }> }}
 */
function requestTargets(request) {
  const passages = splitPassages(request);
  const targets = [];
  const ambiguous = [];
  const ignored = [];
  const add = (list, item) => { if (!list.some((x) => x.path === item.path && (x.action || null) === (item.action || null))) list.push(item); };
  passages.forEach((p, i) => {
    const text = p.text.trim();
    const paths = [...text.matchAll(PATH_RE)].map((m) => m[1]).filter(plain);
    if (!paths.length) return;
    const loc = LOCATION.exec(text);
    if (loc) {
      const next = passages[i + 1];
      const sameSentence = next && !SENTENCE_END.test(text) && !/\n/.test(String(request).slice(p.end, next.start));
      if (sameSentence && NEGATED_START.test(next.text)) {
        add(ambiguous, { path: loc[1], passage_id: p.id, passage: p.text, reason: `"${next.text}" follows "${p.text}": it is unclear whether ${loc[1]} may be changed` });
      } else if (sameSentence && EDIT_START.test(next.text)) {
        add(targets, { path: loc[1], action: 'edit', passage_id: p.id, passage: p.text, rule: 'location' });
      } else add(ignored, { path: loc[1], passage_id: p.id, why: 'mentioned' });
      return;
    }
    const tests = TESTS.exec(text);
    if (tests && !NEGATION.test(text)) { add(targets, { path: tests[1], action: 'add_tests', passage_id: p.id, passage: p.text, rule: 'tests' }); return; }
    const verb = VERB.exec(text);
    if (verb && !NEGATION.test(text) && !REFERENCE.test(text.slice(verb[0].length))) {
      add(targets, { path: verb[2], action: /^create$/i.test(verb[1]) ? 'add' : 'edit', passage_id: p.id, passage: p.text, rule: 'verb' });
      return;
    }
    const why = NEGATION.test(text) ? 'negated' : REFERENCE.test(text) ? 'reference' : 'mentioned';
    for (const path of paths) add(ignored, { path, passage_id: p.id, why });
  });
  return { targets, ambiguous, ignored };
}

const normText = (t) => String(t || '').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Validation errors for the request's own targets (used by contractState, policy stage).
 *   - each target must match scope.allowed_changes and no scope.protected_paths glob (the L4 policy's
 *     own glob semantics, verify/policy.js). A correction cannot cure a conflict by dropping the path:
 *     the targets come from the request, not from the draft.
 *   - an "add tests in <file>" target must be covered by a criterion bound to that file with
 *     adds_tests (verify/added-tests.js), through a requirement that cites the passage. Citing the
 *     passage alone, a "context" disposition, or an unrelated passing check is not enough.
 * Applies to contracts that carry the request (raw_request) and declare scope.allowed_changes.
 * `part`: 'scope' (policy stage) or 'tests' (traceability stage); both by default.
 */
function targetErrors(c, part = null) {
  const request = typeof c?.raw_request === 'string' ? c.raw_request : '';
  const allowed = c?.scope?.allowed_changes;
  if (!request.trim() || !Array.isArray(allowed)) return [];
  const { matchesAny } = require('../verify/policy');
  const prot = Array.isArray(c.scope.protected_paths) ? c.scope.protected_paths : [];
  const errors = [];
  const { targets } = requestTargets(request);
  for (const t of part === 'tests' ? [] : targets) {
    const where = `${t.passage_id} ${JSON.stringify(t.passage)}`;
    const by = prot.find((g) => typeof g === 'string' && matchesAny(t.path, [g]));
    if (by) errors.push(`the request asks to change ${t.path} (${where}), but scope.protected_paths ${JSON.stringify(by)} protects it: keep ${t.path} in allowed_changes and narrow the protection (a scope conflict is never resolved by dropping requested work)`);
    else if (!matchesAny(t.path, allowed.filter((g) => typeof g === 'string'))) errors.push(`the request asks to change ${t.path} (${where}), but scope.allowed_changes does not include it: requested work cannot be dropped`);
  }
  const acs = Array.isArray(c.acceptance_criteria) ? c.acceptance_criteria : [];
  const reqs = Array.isArray(c.requirements) ? c.requirements : [];
  for (const t of part === 'scope' ? [] : targets.filter((x) => x.action === 'add_tests')) {
    const citing = reqs.filter((r) => r && typeof r.id === 'string' && (Array.isArray(r.passage_ids) ? r.passage_ids.includes(t.passage_id)
      : typeof r.quote === 'string' && normText(r.quote).includes(normText(t.path))));
    const ids = new Set(citing.map((r) => r.id));
    const ok = acs.some((ac) => ac && Array.isArray(ac.adds_tests?.files) && ac.adds_tests.files.includes(t.path)
      && Array.isArray(ac.requirement_ids) && ac.requirement_ids.some((x) => ids.has(x)));
    if (!ok) errors.push(`${t.passage_id} ${JSON.stringify(t.passage)} asks to add tests in ${t.path}: a criterion covering that requirement must require adding them, bound with "adds_tests": { "files": [${JSON.stringify(t.path)}] } (citing the passage, a "context" disposition or an unrelated check is not enough)`);
  }
  return errors;
}

module.exports = { requestTargets, targetErrors };
