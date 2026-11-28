/**
 * KAN-107 fixtures: build a raw contract (the shape a model draft or a --contract-file has) from a short
 * request and the checks under test. Requirements are QB's own passages (intent/passages.js), quoted
 * verbatim; a passage no criterion cites is `context` (location only). Every fixture is hand-written for
 * KAN-107: no benchmark test names, gold patches or hidden tests.
 */
const { splitPassages } = require('../../../intent/passages');

/**
 * @param {string} request
 * @param {Array<{ criterion: string, passages: string[], check?: { adapter, params } }>} items
 * @param {{ allowed?: string[], defaults?: Array<{ id, text, reason }>, quotes?: object }} [o]
 */
function draft(request, items, o = {}) {
  const passages = splitPassages(request);
  const rid = (pid) => `R-${passages.findIndex((p) => p.id === pid) + 1}`;
  const cited = new Set(items.flatMap((it) => it.passages));
  const requirements = passages.map((p, i) => ({ id: `R-${i + 1}`, passage_ids: [p.id], quote: (o.quotes && o.quotes[p.id]) || p.text,
    ...(cited.has(p.id) ? {} : { disposition: 'context', reason: 'location only' }) }));
  const acceptance_criteria = items.map((it, i) => ({ id: `AC-${i + 1}`, criterion: it.criterion, kind: 'behavioral',
    requirement_ids: [...it.passages.map(rid), ...(it.defaults || [])] }));
  const checks = items.map((it, i) => (it.check ? { id: `CHK-${i + 1}`, ac_id: `AC-${i + 1}`, adapter: it.check.adapter, params: it.check.params } : null)).filter(Boolean);
  return {
    goal: request, required_behavior: items.map((it) => it.criterion), constraints: [], constraint_policy: [],
    acceptance_criteria, requirements, checks, proposed_defaults: o.defaults || [],
    scope: { allowed_changes: o.allowed || [], protected_paths: [] },
    verification_plan: ['Run the checks.'], relevant_context: o.allowed || [], ambiguity_flags: [], clarifying_question: null,
  };
}

const fn = (module, name, args, expect) => ({ adapter: 'call_returns', params: { module, export: name, args, expect } });
const throwsFn = (module, name, args, message) => ({ adapter: 'call_throws', params: { module, export: name, args, ...(message ? { message_includes: message } : {}) } });
const method = (module, name, steps) => ({ adapter: 'call_sequence', params: { module, export: 'default', instances: { s: { construct: 'new', args: [] } },
  steps: steps.map(([args, expect]) => ({ on: 's', method: name, args, expect })) } });

module.exports = { draft, fn, throwsFn, method, passagesOf: splitPassages };
