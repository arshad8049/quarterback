/**
 * intent/check-fidelity.js: narrow rules against checks that cannot be evidence for their criterion
 * (KAN-106, senior 10690). Demonstrated by the b2416ebc repair: its checks called the exported
 * class `Serializer` with args [] and never called asNumber, the identical call expected 0 and 12.5,
 * and "the behavior for numeric 0 must not change" was "enforced" by allowed_changes. Each rule is
 * deterministic and narrow; none tries to prove that a check is semantically right.
 *
 *   1. A criterion that names a method call (`Serializer.asNumber()`) needs checks that call that
 *      method: the export itself (call_returns / call_throws), or a call_sequence step's method.
 *      module_exports checks (existence only) are exempt.
 *   2. Two call_returns checks making the identical call (module, export, args) must not expect
 *      different results.
 *   3. A constraint about behaviour (behaviour, returns, result, throws, output, value) cannot be
 *      enforced only by allowed_changes / protected_paths: those show where edits are permitted,
 *      not that the behaviour is kept. Enforce it with a check, or mark it advisory.
 */

const METHOD_CALL = /\b[A-Za-z_$][\w$]*\.([A-Za-z_$][\w$]*)\s*\(/g;
const BEHAVIOUR = /\b(behaviou?rs?|returns?|returned|results?|throws?|thrown|outputs?|values?)\b/i;

const namedMethods = (text) => [...String(text || '').matchAll(METHOD_CALL)].map((m) => m[1]);
function calledNames(k) {
  const p = k?.params || {};
  if (k?.adapter === 'call_sequence') {
    const names = (p.steps || []).map((s) => s && s.method).filter(Boolean);
    if (Object.values(p.instances || {}).some((i) => i && i.construct === 'call')) names.push(p.export);
    return names;
  }
  return [p.export];
}
const show = (v) => JSON.stringify(v);

function checkFidelityErrors(c) {
  const errors = [];
  const checks = Array.isArray(c?.checks) ? c.checks : [];
  const acs = new Map((c?.acceptance_criteria || []).map((a) => [a && a.id, a]));
  for (const k of checks) {
    if (!k || k.adapter === 'module_exports') continue;
    const ac = acs.get(k.ac_id);
    if (!ac) continue;
    const methods = [...new Set(namedMethods(ac.criterion))];
    if (!methods.length) continue;
    const called = calledNames(k);
    if (called.some((n) => methods.includes(n))) continue;
    const named = (String(ac.criterion).match(new RegExp(`[A-Za-z_$][\\w$]*\\.(?:${methods.map((m) => m.replace(/\$/g, '\\$')).join('|')})\\s*\\(\\)?`)) || [methods[0]])[0];
    const args = Array.isArray(k.params?.args) ? k.params.args : [];
    const how = k.adapter === 'call_sequence' ? `its steps call ${called.join(', ') || 'nothing'}`
      : `it calls the export ${k.params?.export} directly${args.length ? ` with ${show(args).slice(1, -1)}` : ' with no arguments'}`;
    errors.push(`${k.id} (${ac.id}) never calls ${methods.join(' or ')}, which ${ac.id} names (${named}): ${how}. Call the method on an instance (call_sequence) or the function itself`);
  }
  const returns = checks.filter((k) => k && k.adapter === 'call_returns' && k.params);
  for (let i = 0; i < returns.length; i++) {
    for (let j = i + 1; j < returns.length; j++) {
      const [a, b] = [returns[i].params, returns[j].params];
      if (a.module !== b.module || a.export !== b.export || show(a.args) !== show(b.args) || show(a.expect) === show(b.expect)) continue;
      errors.push(`${returns[i].id} and ${returns[j].id} make the identical call ${a.export}(${show(a.args).slice(1, -1)}) but expect different results (${show(a.expect)} vs ${show(b.expect)}): at most one can be right`);
    }
  }
  const constraints = Array.isArray(c?.constraints) ? c.constraints : [];
  for (const e of Array.isArray(c?.constraint_policy) ? c.constraint_policy : []) {
    if (!e || e.advisory === true || !Array.isArray(e.enforced_by) || !e.enforced_by.length) continue;
    const text = constraints[e.constraint];
    if (typeof text !== 'string' || !BEHAVIOUR.test(text)) continue;
    const kinds = [...new Set(e.enforced_by.map((b) => b && b.kind))];
    if (!kinds.every((x) => x === 'allowed_changes' || x === 'protected_paths')) continue;
    errors.push(`constraint ${e.constraint} (${show(text)}) is about behaviour, but ${kinds.join(' and ')} only shows where edits are permitted, not that the behaviour is kept: enforce it with a check that exercises it, or mark it advisory`);
  }
  return errors;
}

module.exports = { checkFidelityErrors };
