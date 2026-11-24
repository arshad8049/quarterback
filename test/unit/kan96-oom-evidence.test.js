/**
 * KAN-96 (senior 10807, decision approved in 10813): a container-specific OOM signal. At 0cf27f2 these failed:
 * classifyStage knew only Docker's OOMKilled flag. The values are from diagnostic run 45503431684 (ubuntu-24.04, Docker 28.0.4, cgroup v2,
 * systemd driver): in iterations 6, 20, 30 and 38 Docker had not reported the kill within the observed five seconds. No Docker needed.
 *
 * Proposed evidence shape (ctx.cgroup), produced by a host-side observer of THIS container's own cgroup:
 *   { container, baseline, last, final }   memory.events oom_kill before the workload and at the last successful read;
 *                                   final: that read came after the cgroup reported it was empty (10813 item 2)
 *   { container, unavailable: why } nothing could be read
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { classifyStage } = require('../../lib/sandbox/states');

const ID = '5954fc89767e71545217e0e859204f0fb9d24c2d918aa18c3d8ac6ee8c9ca8e0';
const exited = (o = {}) => ({ Status: 'exited', Running: false, ExitCode: 0, OOMKilled: false, ...o });
const read = (baseline, last, container = ID, final = true) => ({ container, baseline, last, final });
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
  test('10813: zero at an early sample is not proof of no later kill: without a final observation it is unavailable', () => {
    const r = run(exited(), read(0, 0, ID, false));
    assert.equal(r.state, 'completed');
    assert.equal(r.oom_signal, 'unavailable');
    assert.match(r.oom_unavailable, /final/);
    assert.equal(run(exited(), { container: ID, baseline: 0, last: 0 }).oom_signal, 'unavailable', 'a missing final flag is not true');
    assert.equal(run(exited(), { ...read(0, 0), final: 'yes' }).oom_signal, 'unavailable');
  });
  test('10813: positive evidence stays, although the cgroup disappeared before a final observation or the observer failed later', () => {
    assert.equal(run(exited(), read(0, 1, ID, false)).oom_signal, 'cgroup');
    assert.equal(run(exited(), { ...read(0, 1, ID, false), unavailable: 'cgroup gone' }).state, 'oom');
  });
  test('no kill on either signal, with a final observation: completed, and the absence is evidenced', () => {
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
  test('10813: the OOM evidence is kept beside an outcome that takes precedence', () => {
    for (const extra of [{ killedBy: 'deadline' }, { killedBy: 'cancel' }, { infraError: 'x' }]) {
      const r = run(exited(), read(0, 1), extra);
      assert.notEqual(r.state, 'oom');
      assert.equal(r.oom_signal, 'cgroup');
    }
    assert.equal(classifyStage(null, { container: ID, cgroup: read(0, 1) }).oom_signal, 'cgroup');
  });
  test('oom_killed keeps its meaning: Docker\'s own flag', () => {
    assert.equal(run(exited(), read(0, 1)).oom_killed, false);
    assert.equal(run(exited({ OOMKilled: true }), read(0, 0)).oom_killed, true);
  });
});
