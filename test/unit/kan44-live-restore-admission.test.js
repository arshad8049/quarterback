/**
 * KAN-44 (senior 10837 A): Docker live-restore is enforced in the SHARED sandbox entry (lib/sandbox/pipeline.js
 * runSandboxed), so every caller is blocked the same way: the qb CLI pipeline, the agent runner, the benchmark arms
 * and baseline, the grader and qualification, and a direct call. Enabled or unreadable → BLOCKED before anything is
 * created (no volume, no credential copy, no container). Disabled proceeds. Dry run never reaches the sandbox.
 *
 * Docker is a FAKE binary (test only) that logs every command and answers `docker info` from FAKE_LR. Nothing real
 * runs: the fake never creates anything, and QB_OLLAMA_URL points at a remote-looking address so no model is touched.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-k44-lr-'));
const LOG = path.join(dir, 'docker.log');
const bin = path.join(dir, 'docker');
fs.writeFileSync(bin, [
  '#!/bin/sh',
  'printf "%s\\n" "$*" >> "$FAKE_DOCKER_LOG"',
  'case "$1" in',
  '  version) echo 28.0.0-fake; exit 0 ;;',
  '  info) case "$FAKE_LR" in true) echo true ;; false) echo false ;; garbage) echo "<no value>" ;; *) exit 1 ;; esac; exit 0 ;;',
  'esac',
  'exit 0', ''].join('\n'), { mode: 0o755 });
process.env.QB_DOCKER_BIN = bin;          // before any lib/sandbox module is loaded
process.env.FAKE_DOCKER_LOG = LOG;
process.env.QB_OLLAMA_URL = 'http://192.0.2.1:11434';   // TEST-NET: releaseLocalModel skips a remote server
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { approve } = require('../../intent/contract-state');
const { runSandboxed } = require('../../lib/sandbox/pipeline');
const { execute, runAgentSandboxed } = require('../../agent/runner');
const { runBaseline } = require('../../bench/baseline');
const { grade } = require('../../bench/grader');
const { gradingFixture } = require('../helpers/grading-fixture');

const contract = approve({ id: 'c', goal: 'g', acceptance_criteria: [{ id: 'AC-1', criterion: 'x', met: null, kind: 'non_behavioral' }], clarifying_question: null,
  scope: { allowed_changes: ['src/**'] } }, { via: 'test' });
const log = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean) : []);
// Anything that creates or starts something, or mounts a credential.
const LAUNCH = /^(run|create|start|volume create|network create|build)\b|cred/;
const stateDir = () => fs.mkdtempSync(path.join(dir, 'state-'));

beforeEach(() => { fs.rmSync(LOG, { force: true }); });

const CALLERS = {
  'runSandboxed (direct)': () => runSandboxed({ repoPath: dir, briefing: 'x', stateDir: stateDir() }),
  'runSandboxed grading (noAgent + applyPatch)': () => runSandboxed({ repoPath: dir, briefing: '', noAgent: true, applyPatch: 'diff', stateDir: stateDir() }),
  'agent/runner execute (qb CLI, agent CLI, runPipeline)': () => execute('b', contract, null, { agent: 'claude-code', repoPath: dir }),
  'runAgentSandboxed (bench native arms)': () => runAgentSandboxed('b', dir, {}),
  'bench/baseline runBaseline': () => runBaseline('b', dir, { contract }),
};

for (const lr of ['true', 'fail', 'garbage']) {
  const want = lr === 'true' ? 'live_restore_enabled' : 'live_restore_unknown';
  describe(`live-restore ${lr === 'true' ? 'enabled' : `unreadable (${lr})`}: BLOCKED before anything is created`, () => {
    for (const [name, call] of Object.entries(CALLERS)) {
      test(name, async () => {
        process.env.FAKE_LR = lr;
        const r = await call();
        assert.equal(r.status, 'blocked', JSON.stringify(r));
        assert.match(r.error || r.reason, new RegExp(`^${want}:`));
        assert.match(r.error || r.reason, /QB does not change your Docker configuration/);
        assert.deepEqual(log().filter((l) => LAUNCH.test(l)), [], 'nothing was created, started or mounted');
        assert.ok(log().some((l) => l.startsWith('info ')), 'the setting was read');
        assert.ok(!log().some((l) => /daemon\.json|live-restore=|--live-restore/.test(l)), 'read only: Docker configuration is never changed');
      });
    }
    test('bench/grader grade: graded as infra_error, the patch never applied', async () => {
      process.env.FAKE_LR = lr;
      const f = gradingFixture();
      try {
        const g = await grade({ spec: f.spec, patch: f.patch('correct'), suitesRoot: f.suitesRoot, qualifying: true });
        assert.equal(g.outcome || g.status, 'infra_error', JSON.stringify(g));
        assert.match(JSON.stringify(g), new RegExp(want));
        assert.deepEqual(log().filter((l) => LAUNCH.test(l)), []);
      } finally { f.cleanup(); }
    });
  });
}

describe('live-restore disabled: the gate lets the run continue', () => {
  test('runSandboxed goes past the gate and stops at the next one (admission, held by this test)', async () => {
    process.env.FAKE_LR = 'false';
    const sd = stateDir();
    // a live admission lock owned by this process: the run is admitted no further, so nothing is started
    fs.writeFileSync(path.join(sd, 'admission.lock'), JSON.stringify({ ...require('../../lib/sandbox/protocol').identity(process.pid), run_id: 'held-by-test' }));
    const r = await runSandboxed({ repoPath: dir, briefing: 'x', stateDir: sd });
    assert.equal(r.status, 'blocked');
    assert.equal(r.reason, 'run_in_progress', 'blocked by admission, not by live-restore');
    assert.equal(r.sandbox.live_restore, 'disabled');
  });
});

describe('dry run never reaches the sandbox', () => {
  test('execute --agent dry-run with live-restore enabled: dry_run, Docker not asked', async () => {
    process.env.FAKE_LR = 'true';
    const r = await execute('b', contract, null, { agent: 'dry-run', repoPath: dir });
    assert.equal(r.status, 'dry_run');
    assert.deepEqual(log(), []);
  });
});
