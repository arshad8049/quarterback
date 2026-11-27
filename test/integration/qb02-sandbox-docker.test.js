/**
 * QB-02 step 1 — Docker integration (T-RES subset). Needs Docker; runs only
 * with QB_INTEGRATION=1 (`npm run test:integration`).
 *
 *   - A child OOM-killed under a main process that exits 0 is reported `oom`.
 *   - A container flooding its logs neither blocks the CLI nor loses its exit state.
 *   - removeRun leaves no containers, networks or volumes for the run.
 */

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');

const D = require('../../lib/sandbox/docker');
const { oomEvidenced } = require('../../lib/sandbox/states');

const ENABLED = process.env.QB_INTEGRATION === '1';
const IMAGE = 'busybox:1.36.1';
const RUN = `qbit-${process.pid}-${Date.now()}`;
const HARDEN = ['--user', '10001:10001', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
  '--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev,size=16m', '--network', 'none', '--init', '--pids-limit', '64'];

describe('sandbox docker foundation', { skip: !ENABLED && 'set QB_INTEGRATION=1 (needs Docker)' }, () => {
  after(async () => { await D.removeRun(RUN); });

  test('docker is available', async () => {
    assert.ok(await D.available(), 'docker daemon not reachable');
    assert.ok((await D.op(['pull', '-q', IMAGE], { timeoutMs: 120_000 })).ok);
  });

  test('OOM-killed child under a main process that exits 0 is classified oom', async () => {
    const r = await D.runStage(`${RUN}-oom`, [...HARDEN, ...D.runLabels(RUN, 'workload'),
      '--memory', '32m', '--memory-swap', '32m', IMAGE,
      // The child volunteers as the OOM victim (raising one's own oom_score_adj needs no
      // privilege), so the kernel cannot pick the main shell instead (flaked in CI at 52714f8).
      // It exhausts ANONYMOUS memory (one 64 MiB read buffer), which is freed when it is
      // killed. It used to fill a tmpfs, whose pages stay charged to the container after
      // the kill — the main shell could then be OOM-killed too (flaked in CI at c8a50cd, cac8e54).
      'sh', '-c', '(echo 1000 > /proc/self/oom_score_adj; exec dd if=/dev/zero of=/dev/null bs=64M count=1 2>/dev/null); echo "child exit $?"; exit 0']);
    const seen = JSON.stringify({ state: r.state, reason: r.reason, exit_code: r.exit_code, oom_killed: r.oom_killed, oom_signal: r.oom_signal,
      oom_unavailable: r.oom_unavailable, oom_evidence: r.oom_evidence, stdout: r.stdout, stderr: r.stderr });
    assert.equal(r.exit_code, 0, `main process exited 0 — ${seen}`);
    // KAN-96 10848: Docker's OOMKilled=true OR validated positive evidence from THIS container's own cgroup (its id
    // read from Docker here, not from the result). Exit code alone, `unavailable`, or knowing that this fixture
    // injects an OOM never satisfies it: a kill both Docker and the observer missed stays a failure.
    const id = (await D.op(['inspect', '-f', '{{.Id}}', `${RUN}-oom`])).stdout.trim();
    assert.ok(oomEvidenced(r, id), `OOM evidenced by Docker or by this container's cgroup — ${seen}`);
    assert.equal(r.state, 'oom', seen);
  });

  test('KAN-96 10848: the gate changes neither the user, capabilities, privileges nor the command, and the task cannot write the gate', async () => {
    const probe = 'id; grep -E "^(CapEff|CapBnd|NoNewPrivs|Seccomp):" /proc/self/status; cat /proc/$$/cmdline | tr "\\0" " "; echo';
    const run = (o) => D.runStage(`${RUN}-perm-${o.enabled === false ? 'off' : 'on'}`, [...HARDEN, ...D.runLabels(RUN, 'workload'), IMAGE, 'sh', '-c', probe],
      { waitTimeoutMs: 60_000, oomObserver: o });
    const off = await run({ enabled: false });
    const on = await run({});
    assert.equal(off.state, 'completed', JSON.stringify(off));
    assert.equal(on.state, 'completed', JSON.stringify(on));
    assert.equal(on.stdout, off.stdout, 'same uid/gid, capabilities, no_new_privs, seccomp and command line with or without the gate');
    if (require('../../lib/sandbox/oom-observer').hostSupport().ok) {
      assert.equal(on.oom_evidence.gate, 'released', JSON.stringify(on.oom_evidence));
      const w = await D.runStage(`${RUN}-perm-write`, [...HARDEN, ...D.runLabels(RUN, 'workload'), IMAGE, 'sh', '-c',
        'stat -c "%a %F" /qb-gate /qb-gate/gate.sh /qb-gate/go; (echo x > /qb-gate/go) 2>/dev/null && echo FIFO-WRITABLE; touch /qb-gate/new 2>/dev/null && echo DIR-WRITABLE; echo end'],
      { waitTimeoutMs: 60_000 });
      assert.equal(w.oom_evidence.gate, 'released');
      assert.equal(w.stdout.trim(), '755 directory\n644 regular file\n644 fifo\nend', w.stdout);
    }
  });

  test('a log flood neither blocks nor loses the exit state', async () => {
    const r = await D.runStage(`${RUN}-flood`, [...HARDEN, ...D.runLabels(RUN, 'workload'), IMAGE,
      'sh', '-c', 'head -c 50000000 /dev/zero | tr "\\0" x; echo; echo LAST-LINE; exit 3'],
      { maxBytes: 64 * 1024, waitTimeoutMs: 120_000 });
    assert.equal(r.state, 'execution_error');
    assert.equal(r.exit_code, 3);
    assert.ok(r.stdout_dropped > 49_000_000);
    assert.match(r.stdout, /LAST-LINE\s*$/);
  });

  test('KAN-96: through the start gate, stdin reaches the command byte for byte, and the evidence is bound to this container', async () => {
    const prompt = Buffer.concat([Buffer.from('go\nfirst line\n'), Buffer.from([0, 1, 2, 255]), Buffer.from('no final newline')]);
    const r = await D.runStage(`${RUN}-stdin`, [...HARDEN, ...D.runLabels(RUN, 'workload'), IMAGE, 'sh', '-c', 'cat | od -An -tx1 | tr -d " \\n"'],
      { input: prompt, waitTimeoutMs: 60_000 });
    assert.equal(r.state, 'completed', JSON.stringify(r));
    assert.equal(r.stdout.trim(), prompt.toString('hex'));
    const linux = require('../../lib/sandbox/oom-observer').hostSupport().ok;
    if (linux) {
      assert.equal(r.oom_evidence.gate, 'released', JSON.stringify(r.oom_evidence));
      assert.equal(r.oom_evidence.observer, 'armed', JSON.stringify(r.oom_evidence));
      assert.ok(r.oom_evidence.cgroup_path.includes(r.oom_evidence.container), JSON.stringify(r.oom_evidence));
      assert.ok(['none', 'unavailable'].includes(r.oom_signal), 'a healthy stage is never positive');
    } else {
      assert.equal(r.oom_signal, 'unavailable');
      assert.match(r.oom_unavailable, /unavailable on this host/);
    }
  });

  test('removeRun leaves nothing behind', async () => {
    await D.op(['volume', 'create', ...D.runLabels(RUN), `${RUN}-vol`]);
    await D.op(['network', 'create', '--internal', ...D.runLabels(RUN), `${RUN}-net`]);
    const left = await D.removeRun(RUN);
    assert.deepEqual(left, { containers: 0, networks: 0, volumes: 0 });
  });
});
