// KAN-114 10720 item 8: in the generalized (U2) workflows, cleanup leftovers FAIL the job instead of only printing
// counts. Real sh on the gate script with a fake docker; no Docker daemon, no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const C = require('../../lib/pilot/u2-cleanup');
const GATE = path.join(ROOT, 'bench/opus-pilot/u2/cleanup-gate.sh');
const FAKE = path.join(__dirname, '..', 'fixtures', 'kan114-u2', 'fake-docker.sh');

function gate(env = {}) {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qbclean-')), 'cleanup.txt');
  const r = spawnSync('sh', [GATE, out], { encoding: 'utf8', env: { PATH: process.env.PATH, DOCKER: FAKE, ...env } });
  return { r, text: fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : null };
}

test('zero leftovers: the gate passes and records 0/0/0/0', () => {
  const { r, text } = gate();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(C.parseCleanup(text), { qb_containers: 0, qb_volumes: 0, qb_networks: 0, qb_claude_auth_volume: 0 });
});

for (const [kind, key] of [['containers', 'qb_containers'], ['volumes', 'qb_volumes'], ['networks', 'qb_networks'], ['auth', 'qb_claude_auth_volume']]) {
  test(`a leftover ${kind} FAILS the job (nonzero exit), with the count still recorded`, () => {
    const { r, text } = gate({ [`FAKE_DOCKER_IDS_${kind}`]: '2' });
    assert.notEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, new RegExp(`${key}=2`));
    assert.match(r.stdout + r.stderr, /::error/);
    assert.equal(C.parseCleanup(text)[key], 2);
  });
}

test('fail closed: a docker failure (counts unknown) fails the job; it is never read as zero', () => {
  const { r } = gate({ FAKE_DOCKER_FAIL: '1' });
  assert.notEqual(r.status, 0);
});

test('parse/decide helper: missing, non-integer or nonzero counts are problems', () => {
  assert.deepEqual(C.cleanupProblems({ qb_containers: 0, qb_volumes: 0, qb_networks: 0, qb_claude_auth_volume: 0 }), []);
  assert.ok(C.cleanupProblems({ qb_containers: 0, qb_volumes: 0, qb_networks: 0 }).some((p) => /qb_claude_auth_volume/.test(p)));
  assert.ok(C.cleanupProblems({ qb_containers: 1, qb_volumes: 0, qb_networks: 0, qb_claude_auth_volume: 0 }).some((p) => /qb_containers=1/.test(p)));
  assert.ok(C.cleanupProblems(C.parseCleanup('qb_containers=x\nqb_volumes=0\nqb_networks=0\nqb_claude_auth_volume=0\n')).length > 0);
  assert.ok(C.cleanupProblems(null).length > 0);
});

test('every new U2 workflow runs the failing gate after each docker-using job, never with continue-on-error', () => {
  const dir = path.join(ROOT, '.github/workflows');
  const files = fs.readdirSync(dir).filter((f) => /^u2-.*\.yml$/.test(f));
  assert.deepEqual(files.sort(), ['u2-image-build.yml', 'u2-qualify.yml']);
  for (const f of files) {
    const y = fs.readFileSync(path.join(dir, f), 'utf8');
    const steps = y.split(/\n      - /);
    const gates = steps.filter((s) => s.includes('bench/opus-pilot/u2/cleanup-gate.sh'));
    assert.ok(gates.length >= 1, `${f} runs the gate`);
    for (const s of gates) {
      assert.ok(!/continue-on-error:\s*true/.test(s), `${f}: the gate step must not continue on error`);
      assert.match(s, /if: \$\{\{ always\(\) \}\}/, `${f}: the gate runs even after a failed step`);
    }
    assert.ok(!/qb_containers=\$\(docker ps/.test(y), `${f}: no print-only cleanup check`);
  }
  // the live v8 workflow is left byte-for-byte alone (it is not the generalized workflow)
  const sha = (f) => require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(ROOT, f))).digest('hex');
  assert.equal(sha('.github/workflows/pair-5892-live.yml'), '7154baf7835274cd8dd752fb11b31ac5574ba796f9d8830cb131420fa156144e');
  assert.equal(sha('bench/opus-pilot/mocha/pair-live-request.txt'), 'a908e9eeb37ba1db1d4c845f47d9aaf73ad3b9603b46f4f2f107a1a33fa1ca30');
});
