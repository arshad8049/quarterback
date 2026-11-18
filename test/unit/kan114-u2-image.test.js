// KAN-114 10720 (U2): the versioned, browser-capable agent image shared by both arms, and its token-free, no-model
// build workflow. Static checks only: nothing here builds, pulls or runs an image.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const U2_DOCKERFILE = 'sandbox/agent-u2/Dockerfile';
const V8_BASE = 'node@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54';

test('the U2 Dockerfile is FROM the digest-pinned base the v8 image set was built from (no floating tag)', () => {
  const d = read(U2_DOCKERFILE);
  const froms = d.split('\n').filter((l) => /^FROM\s/.test(l));
  assert.deepEqual(froms, [`FROM ${V8_BASE}`]);
  const spec = JSON.parse(read('bench/opus-pilot/u2/image.json'));
  assert.equal(spec.base.ref, V8_BASE);
  assert.match(spec.base.source, /kan117/);
});

test('U2 keeps the v8 Claude Code version and the same agent entry files; the v8 agent image inputs are untouched', () => {
  const d = read(U2_DOCKERFILE);
  const v8 = read('sandbox/agent/Dockerfile');
  const ver = (s) => (s.match(/^ARG CLAUDE_VERSION=(\S+)$/m) || [])[1];
  assert.equal(ver(d), '2.1.322');
  assert.equal(ver(d), ver(v8));
  for (const f of ['managed-settings.json', 'entry.sh', 'agent-run.sh', 'deps-install.sh', 'qb-test-reporter.mjs', 'qb-check-runner.mjs']) {
    assert.match(d, new RegExp(`COPY agent/${f.replace('.', '\\.')} `), `copies sandbox/agent/${f}`);
  }
  // sandbox/agent/ itself (the v8 content-tagged image input) must not gain files: U2 lives in its own directory
  assert.deepEqual(fs.readdirSync(path.join(ROOT, 'sandbox/agent')).sort(),
    ['Dockerfile', 'agent-run.sh', 'deps-install.sh', 'entry.sh', 'managed-settings.json', 'qb-check-runner.mjs', 'qb-test-reporter.mjs']);
  const spec = JSON.parse(read('bench/opus-pilot/u2/image.json'));
  const D = require('../../lib/sandbox/docker.js');
  assert.equal(D.contentTag('qb-sandbox-agent', path.join(ROOT, 'sandbox', 'agent'), ['.']), spec.v8_agent_content_tag,
    'the v8 agent image content tag is unchanged');
});

test('Chromium comes from a pinned Debian snapshot; the image never disables the browser sandbox', () => {
  const d = read(U2_DOCKERFILE);
  assert.match(d, /snapshot\.debian\.org\/archive\/debian\/\$\{DEBIAN_SNAPSHOT\}/);
  assert.match(d, /^ARG DEBIAN_SNAPSHOT=\d{8}T\d{6}Z$/m);
  assert.match(d, /\bchromium\b/);
  assert.match(d, /^ENV CHROME_BIN=\/usr\/bin\/chromium$/m);
  for (const bad of ['--no-sandbox', 'disable-setuid-sandbox', 'CHROMIUM_FLAGS', 'chrome-sandbox', 'chmod 4755', 'chmod u+s', 'seccomp']) {
    assert.ok(!d.includes(bad), `Dockerfile must not contain ${bad}`);
  }
  assert.ok(!/^USER\s+root/m.test(d));
  const spec = JSON.parse(read('bench/opus-pilot/u2/image.json'));
  assert.equal(spec.debian_snapshot, (d.match(/^ARG DEBIAN_SNAPSHOT=(\S+)$/m) || [])[1]);
  assert.equal(spec.browser_sandbox, 'on (no image-level exception)');
});

test('the image digest is honestly PENDING a build approval (no invented digest)', () => {
  const spec = JSON.parse(read('bench/opus-pilot/u2/image.json'));
  assert.equal(spec.schema, 'qb-kan114-u2-image/1');
  assert.equal(spec.image_digest, null);
  assert.equal(spec.status, 'pending_build_approval');
  assert.deepEqual(spec.used_by, ['arm_a', 'arm_b']);
});

test('the build workflow is token-free, no-model, and triggers only on manual dispatch or its own request file', () => {
  const y = read('.github/workflows/u2-image-build.yml');
  assert.match(y, /^on:\n  push:\n    branches: \[kan114-u2\]\n    paths: \[bench\/opus-pilot\/u2\/build-request\.txt\]\n  workflow_dispatch:\n/m);
  assert.ok(!fs.existsSync(path.join(ROOT, 'bench/opus-pilot/u2/build-request.txt')), 'the request file is NOT created');
  for (const bad of ['secrets.', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_', 'environment:', 'pull_request', 'schedule:', 'workflow_run', 'docker push', 'docker login']) {
    assert.ok(!y.includes(bad), `build workflow must not contain ${bad}`);
  }
  assert.match(y, /permissions:\n  contents: read\n/);
  assert.match(y, /persist-credentials: false/);
  assert.match(y, /timeout-minutes: \d+/);
  assert.match(y, /concurrency:\n  group: u2-image-build\n  cancel-in-progress: false/);
  assert.match(y, /bench\/opus-pilot\/u2\/cleanup-gate\.sh/);
  assert.match(y, /bench\/opus-pilot\/u2\/u2-image\.mjs save/);
});

test('u2-image.mjs refuses outside CI and with any credential-like variable', () => {
  const { spawnSync } = require('node:child_process');
  const f = path.join(ROOT, 'bench/opus-pilot/u2/u2-image.mjs');
  let r = spawnSync(process.execPath, [f, 'save', '--out=/nonexistent'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(r.status, 2); assert.match(r.stderr, /CI only/);
  r = spawnSync(process.execPath, [f, 'save', '--out=/nonexistent'], { encoding: 'utf8',
    env: { PATH: process.env.PATH, GITHUB_ACTIONS: 'true', U2_CI_RUN: '1', CLAUDE_CODE_OAUTH_TOKEN: 'fake-not-a-token' } });
  assert.equal(r.status, 2); assert.match(r.stderr, /credential-like variable CLAUDE_CODE_OAUTH_TOKEN/);
  assert.ok(!r.stderr.includes('fake-not-a-token'));
});
