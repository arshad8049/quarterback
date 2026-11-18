/**
 * lib/pilot/u2-order.js — KAN-114 10720 item 6: a predeclared, balanced A-first / B-first arm order across the six
 * frozen positions, and ONE first-arm evidence gate that works for either order.
 *
 * Order rule (fixed before any task is frozen or run): positions are taken in pairs (1,2), (3,4), (5,6); for pair p
 * the first bit of sha256(seed + NUL + "pair-" + p) picks [A-first, B-first] (0) or [B-first, A-first] (1). That is
 * exactly 3/3 overall and one of each within every consecutive pair. The order binds to POSITIONS of the frozen six
 * (committed seed order), so it cannot be chosen after seeing which tasks qualified.
 *
 * Gate (between the first and the second arm of a task, either order): the first arm's job succeeded, its serialized
 * readback sidecar verified for THAT arm, cleanup 0/0/0/0; the second arm runs on a fresh runner with a fresh
 * workspace at the task base, downloads only the shared images, no grading has started, and its protected-environment
 * approval is recorded. The second arm never receives first-arm output, history or grade.
 */
const crypto = require('crypto');
const { cleanupProblems } = require('./u2-cleanup');

const ORDER_SEED = 'qb-kan114-u2-arm-order-2026-11-18';
const ORDERS = ['A-first', 'B-first'];
/** The only artifacts a second arm may download: the shared, digest-verified image sets. */
const SHARED_ARTIFACTS = Object.freeze(['kan117-images', 'u2-agent-image']);

function balancedOrder(n = 6, seed = ORDER_SEED) {
  if (!Number.isInteger(n) || n < 2 || n % 2) throw new Error('order: n must be a positive even number');
  const out = [];
  for (let p = 1; p <= n / 2; p += 1) {
    const bit = crypto.createHash('sha256').update(`${seed}\0pair-${p}`).digest()[0] & 1;
    out.push(...(bit ? ['B-first', 'A-first'] : ['A-first', 'B-first']));
  }
  return out;
}

function validateOrder(order) {
  if (!Array.isArray(order) || order.length !== 6) throw new Error('order: six positions required');
  if (!order.every((x) => ORDERS.includes(x))) throw new Error('order: each position is A-first or B-first');
  if (order.filter((x) => x === 'A-first').length !== 3) throw new Error('order: must be balanced 3/3');
  return order;
}

/** Job dependencies for one task position. Graders need both trials; the second trial needs only the gate. */
function jobPlan(position) {
  if (!ORDERS.includes(position)) throw new Error(`order: unknown position order ${position}`);
  const [first, second] = position === 'A-first' ? ['trial-a', 'trial-b'] : ['trial-b', 'trial-a'];
  return {
    first, second,
    needs: { [first]: ['plan'], 'first-arm-gate': ['plan', first], [second]: ['plan', 'first-arm-gate'], 'grade-a': ['plan', 'trial-a', 'trial-b'], 'grade-b': ['plan', 'trial-a', 'trial-b'] },
  };
}

/** Problems ([] = the second arm may start). */
function firstArmGate({ order, position, firstArm, first, second }) {
  const p = [];
  const other = firstArm === 'A' ? 'B' : firstArm === 'B' ? 'A' : null;
  const declared = Array.isArray(order) ? order[position - 1] : null;
  if (!other || declared !== `${firstArm}-first`) p.push(`order: position ${position} is predeclared ${declared}, not ${firstArm}-first`);
  if (!first || first.job_result !== 'success') p.push('first arm job did not succeed');
  const sc = first && first.sidecar;
  if (!sc || sc.schema !== 'qb-pair-readback/1' || sc.arm !== firstArm || sc.verified_artifact !== true || (sc.problems && sc.problems.length)) {
    p.push('first arm readback is not a verified record for that arm');
  }
  for (const c of cleanupProblems(first && first.cleanup)) p.push(`first arm cleanup: ${c}`);
  if (!second || second.arm !== other) p.push(`second arm must be ${other}`);
  for (const d of (second && second.downloads) || []) if (!SHARED_ARTIFACTS.includes(d)) p.push(`cross-arm exposure: second arm downloads ${d}`);
  if (!second || !second.runner_name || second.runner_name === (first && first.runner_name)) p.push('second arm is not on a fresh runner');
  const ws = (second && second.workspace) || {};
  if (ws.fresh !== true || !ws.base_tree || ws.base_tree !== second.expected_base_tree) p.push('second arm is not a fresh workspace at the task base');
  if (!second || second.grades_started !== false) p.push('grading started before both captures');
  if (!second || !/^[0-9]+$/.test(String(second.approval_comment_id || ''))) p.push('second arm approval not recorded');
  return p;
}

module.exports = { ORDER_SEED, ORDERS, SHARED_ARTIFACTS, balancedOrder, validateOrder, jobPlan, firstArmGate };
