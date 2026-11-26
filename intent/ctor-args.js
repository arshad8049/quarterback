/**
 * intent/ctor-args.js: may QB construct a default-export class with `new` and no arguments? (KAN-106 10749 G2 /
 * 10758; used by KAN-107 through intent/api-grounding.js `default.ctor_args`).
 *
 * KAN-107 10835 split: these functions are copied VERBATIM from intent/staged.js at 2150ab6 (constructorArgs,
 * inertDefault, safeStores, onlyGuarded and EXCERPT_ROOM), so the consistency fix does not load the staged
 * compiler prototype (intent/staged.js requires lib/budget, the compiler and the staged prompt). The staged
 * prototype keeps its own copy on kan107-consistency-design; if it is merged later it should require this
 * module instead of keeping a second copy.
 */
const acorn = require('acorn');

const EXCERPT_ROOM = 100;   // kept excerpt lines below which a missing constructor block means "no constructor" (a block is ≤ 60 lines, a file ≤ 160)

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

module.exports = { constructorArgs, inertDefault, EXCERPT_ROOM };
