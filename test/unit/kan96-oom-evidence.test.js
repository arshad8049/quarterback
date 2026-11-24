/**
 * KAN-96 (senior 10807): failing unit fixture for a container-specific OOM signal. RED on main: classifyStage knows
 * only Docker's OOMKilled flag. The values are from diagnostic run 45503431684 (ubuntu-24.04, Docker 28.0.4, cgroup v2,
 * systemd driver): iterations 6, 20 and 30 (and 38) were OOM kills that Docker never reported. No Docker needed.
 *
 * Proposed evidence shape (ctx.cgroup), produced by a host-side observer of THIS container's own cgroup:
 *   { container, baseline, last }   memory.events oom_kill at the first and the last successful read
 *   { container, unavailable: why } nothing could be read
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { classifyStage } = require('../../lib/sandbox/states');

const ID = '5954fc89767e71545217e0e859204f0fb9d24c2d918aa18c3d8ac6ee8c9ca8e0';
const exited = (o = {}) => ({ Status: 'exited', Running: false, ExitCode: 0, OOMKilled: false, ...o });
const read = (baseline, last, container = ID) => ({ container, baseline, last });
const run = (state, cgroup, extra = {}) => classifyStage(state, { container: ID, cgroup, ...extra });

describe('KAN-96: a container-specific oom_kill delta is OOM evidence', () => {
  for (const i of [6, 20, 30, 38]) {
    test(`recorded disagreement ${i}: exit 0, OOMKilled=false, oom_kill 0 → 1 is classified oom`, () => {
      const r = run(exited(), read(0, 1));
      assert.equal(r.state, 'oom');
      assert.equal(r.oom_signal, 'cgroup', 'which evidence decided it is recorded');
    });
  }
  test('both signals agree', () => {
    const r = run(exited({ OOMKilled: true }), read(0, 1));
    assert.equal(r.state, 'oom');
    assert.equal(r.oom_signal, 'inspect+cgroup');
  });
  test('inspect alone still decides oom, and is labelled', () => {
    const r = run(exited({ OOMKilled: true }), { container: ID, unavailable: 'cgroup gone before the first read' });
    assert.equal(r.state, 'oom');
    assert.equal(r.oom_signal, 'inspect');
  });
  test('no kill on either signal: completed, and the absence is evidenced', () => {
    const r = run(exited(), read(0, 0));
    assert.equal(r.state, 'completed');
    assert.equal(r.oom_signal, 'none');
  });
  test('unavailable counters are explicit: completed, but never "no OOM"', () => {
    const r = run(exited(), { container: ID, unavailable: 'no cgroup v2 on this host' });
    assert.equal(r.state, 'completed');
    assert.equal(r.oom_signal, 'unavailable');
    assert.match(r.oom_unavailable, /no cgroup v2/);
  });
  test('no observer at all is the same as unavailable', () => {
    assert.equal(classifyStage(exited(), {}).oom_signal, 'unavailable');
  });
  test('exit 137 alone is not OOM evidence', () => {
    const r = run(exited({ ExitCode: 137 }), read(0, 0));
    assert.equal(r.state, 'execution_error');
    assert.equal(r.oom_signal, 'none');
  });
  test('a kill already counted at the first read is not a delta: no pre-workload baseline', () => {
    const r = run(exited(), read(1, 1));
    assert.equal(r.state, 'completed');
    assert.equal(r.oom_signal, 'unavailable');
  });
  test('a counter of another container, or a parent, is never this container\'s evidence', () => {
    const r = run(exited(), read(0, 3, 'f'.repeat(64)));
    assert.equal(r.state, 'completed');
    assert.equal(r.oom_signal, 'unavailable');
  });
  test('malformed counters are unavailable, not zero', () => {
    for (const bad of [read(null, 1), read(0, NaN), read(2, 1), read('0', '1')]) assert.equal(run(exited(), bad).oom_signal, 'unavailable', JSON.stringify(bad));
  });
  test('precedence is unchanged: deadline, cancel and infra errors come before oom', () => {
    assert.equal(run(exited(), read(0, 1), { killedBy: 'deadline' }).state, 'timeout');
    assert.equal(run(exited(), read(0, 1), { killedBy: 'cancel' }).state, 'cancelled');
    assert.equal(run(exited(), read(0, 1), { infraError: 'create failed' }).state, 'infra_error');
  });
});
