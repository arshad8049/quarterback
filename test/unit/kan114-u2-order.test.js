// KAN-114 10720 item 6: a predeclared, balanced A-first / B-first order across the six positions, and ONE first-arm
// evidence gate that works for either order (fresh state, no cross-arm output exposure). Fake records only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const O = require('../../lib/pilot/u2-order');

test('the order is predeclared from a committed seed, balanced 3/3, and balanced within each consecutive pair', () => {
  const o = O.balancedOrder(6, O.ORDER_SEED);
  assert.equal(o.length, 6);
  assert.equal(o.filter((x) => x === 'A-first').length, 3);
  assert.equal(o.filter((x) => x === 'B-first').length, 3);
  for (let p = 0; p < 3; p += 1) assert.notEqual(o[2 * p], o[2 * p + 1], `pair ${p + 1} has one of each`);
  assert.deepEqual(O.balancedOrder(6, O.ORDER_SEED), o, 'deterministic');
  const committed = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench/opus-pilot/u2/arm-order.json'), 'utf8'));
  assert.equal(committed.seed, O.ORDER_SEED);
  assert.deepEqual(committed.order_by_position, o);
  assert.match(committed.applies_to, /frozen six.*position/i);
  assert.doesNotThrow(() => O.validateOrder(o));
  for (const bad of [['A-first', 'A-first', 'A-first', 'A-first', 'B-first', 'B-first'], o.slice(0, 5), [...o.slice(0, 5), 'C-first']]) {
    assert.throws(() => O.validateOrder(bad), /order/);
  }
  // a different seed gives a (generally) different but still balanced order: the rule, not the outcome, is fixed
  for (const s of ['x', 'y', 'z']) O.validateOrder(O.balancedOrder(6, s));
});

const okFirst = (arm) => ({
  job_result: 'success', runner_name: 'GitHub Actions 101',
  sidecar: { schema: 'qb-pair-readback/1', mode: 'task', arm, verified_artifact: true, grade_eligible: true, problems: [] },
  cleanup: { qb_containers: 0, qb_volumes: 0, qb_networks: 0, qb_claude_auth_volume: 0 },
});
const okSecond = (arm) => ({
  arm, runner_name: 'GitHub Actions 202', downloads: ['kan117-images', 'u2-agent-image'],
  workspace: { fresh: true, base_tree: 't'.repeat(40) }, expected_base_tree: 't'.repeat(40), grades_started: false, approval_comment_id: '20001',
});
const gate = (firstArm, mut = () => {}) => {
  const o = O.balancedOrder(6, O.ORDER_SEED);
  const position = o.indexOf(firstArm === 'A' ? 'A-first' : 'B-first') + 1;
  const x = { order: o, position, firstArm, first: okFirst(firstArm), second: okSecond(firstArm === 'A' ? 'B' : 'A') };
  mut(x);
  return O.firstArmGate(x);
};

test('the same gate passes for an A-first and a B-first position with clean evidence', () => {
  assert.deepEqual(gate('A'), []);
  assert.deepEqual(gate('B'), []);
});

for (const firstArm of ['A', 'B']) {
  test(`${firstArm}-first: every gate condition refuses on its own`, () => {
    const other = firstArm === 'A' ? 'B' : 'A';
    const cases = [
      ['order', (x) => { x.firstArm = other; }],
      ['first arm job', (x) => { x.first.job_result = 'failure'; }],
      ['readback', (x) => { x.first.sidecar.verified_artifact = false; }],
      ['readback', (x) => { x.first.sidecar.arm = other; }],
      ['readback', (x) => { x.first.sidecar = null; }],
      ['cleanup', (x) => { x.first.cleanup.qb_volumes = 1; }],
      ['cleanup', (x) => { delete x.first.cleanup.qb_claude_auth_volume; }],
      ['second arm', (x) => { x.second.arm = firstArm; }],
      ['cross-arm exposure', (x) => { x.second.downloads.push(`pair-trial-public-${firstArm}`); }],
      ['cross-arm exposure', (x) => { x.second.downloads.push(`pair-grading-input-${firstArm}`); }],
      ['cross-arm exposure', (x) => { x.second.downloads.push('anything-else'); }],
      ['fresh runner', (x) => { x.second.runner_name = x.first.runner_name; }],
      ['fresh workspace', (x) => { x.second.workspace.fresh = false; }],
      ['fresh workspace', (x) => { x.second.workspace.base_tree = 'u'.repeat(40); }],
      ['grading', (x) => { x.second.grades_started = true; }],
      ['approval', (x) => { x.second.approval_comment_id = null; }],
    ];
    for (const [what, mut] of cases) {
      const p = gate(firstArm, mut);
      assert.ok(p.length > 0, `${what} must refuse`);
      assert.ok(p.some((s) => s.includes(what)), `${what}: ${p.join(' | ')}`);
    }
  });
}

test('job plan per position: the first job never needs the second, and the second needs only the first-arm gate', () => {
  for (const pos of ['A-first', 'B-first']) {
    const j = O.jobPlan(pos);
    const [f, s] = pos === 'A-first' ? ['trial-a', 'trial-b'] : ['trial-b', 'trial-a'];
    assert.equal(j.first, f); assert.equal(j.second, s);
    assert.deepEqual(j.needs[f], ['plan']);
    assert.deepEqual(j.needs['first-arm-gate'], ['plan', f]);
    assert.deepEqual(j.needs[s], ['plan', 'first-arm-gate']);
    assert.deepEqual(j.needs['grade-a'], ['plan', 'trial-a', 'trial-b']);
    assert.deepEqual(j.needs['grade-b'], ['plan', 'trial-a', 'trial-b']);
  }
  assert.throws(() => O.jobPlan('C-first'), /order/);
});
