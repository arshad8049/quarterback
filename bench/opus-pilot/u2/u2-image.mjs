#!/usr/bin/env node
// KAN-114 10720 (U2): build, probe, save and load the versioned browser-capable agent image. CI only, no model, no
// credential, no registry push.
//   save --out=<dir>  pull the digest-pinned base, refuse if the U2 tag already exists, build sandbox/agent-u2/Dockerfile
//                     (context sandbox/), probe it with QB's hardening flags and NO network (versions + whether the
//                     Chromium sandbox starts WITHOUT any sandbox-disabling flag), docker save + hash, and write
//                     u2-image-provenance.json
//   load --in=<dir>   on a fresh runner: hash the tar, refuse a pre-existing tag, docker load, require the recorded id;
//                     prints the ref to use as QB_SANDBOX_AGENT_IMAGE (both arms)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const arg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
if (process.env.GITHUB_ACTIONS !== 'true' || process.env.U2_CI_RUN !== '1') { console.error('refusing: CI only'); process.exit(2); }
for (const k of Object.keys(process.env)) {
  if (/^(ANTHROPIC_|CLAUDE_CODE_OAUTH|CLAUDE_API|GH_TOKEN$|GITHUB_TOKEN$)/.test(k)) { console.error(`refusing: credential-like variable ${k} is set`); process.exit(2); }
}
const mode = process.argv[2];

const D = require(path.join(ROOT, 'lib/sandbox/docker.js'));
const SPEC = JSON.parse(fs.readFileSync(path.join(HERE, 'image.json'), 'utf8'));
const SANDBOX = path.join(ROOT, 'sandbox');
const REF = D.contentTag('qb-sandbox-agent-u2', SANDBOX, ['agent-u2', 'agent']);
const fileSha = (f) => { const h = crypto.createHash('sha256'); const fd = fs.openSync(f, 'r'); const b = Buffer.alloc(1 << 20); let n;
  while ((n = fs.readSync(fd, b, 0, b.length, null)) > 0) h.update(b.subarray(0, n)); fs.closeSync(fd); return h.digest('hex'); };
const dk = (args, o = {}) => spawnSync('docker', args, { encoding: 'utf8', timeout: o.timeout || 120_000, maxBuffer: 16 << 20 });
const inspect = (ref) => { const r = dk(['image', 'inspect', '--format', '{{json .}}', ref]); if (r.status !== 0) return null; const i = JSON.parse(r.stdout);
  return { id: i.Id, repo_digests: i.RepoDigests || [], layers: (i.RootFS && i.RootFS.Layers) || [], architecture: i.Architecture, size: i.Size }; };
// QB's hardening (lib/sandbox/workspace.js hardened) + no network: the probe sees what a task workspace sees
const HARD = ['--network', 'none', '--user', '10001:10001', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only',
  '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m', '--init', '--pids-limit', '256', '-e', 'HOME=/tmp'];

if (mode === 'save') {
  const out = arg('out'); if (!out) { console.error('usage: save --out=<dir>'); process.exit(2); }
  fs.mkdirSync(out, { recursive: true });
  const [, digest] = SPEC.base.ref.split('@');
  execFileSync('docker', ['pull', '-q', SPEC.base.ref], { stdio: ['ignore', 'inherit', 'inherit'], timeout: 15 * 60_000 });
  const base = inspect(SPEC.base.ref);
  if (!base || !base.repo_digests.some((d) => d.endsWith(`@${digest}`))) { console.error('refusing: the pulled base does not carry the pinned digest'); process.exit(1); }
  if (inspect(REF)) { console.error(`refusing: ${REF} already exists on this host (the build must come from the pinned base)`); process.exit(1); }
  execFileSync('docker', ['build', '-q', '-f', path.join(SANDBOX, 'agent-u2', 'Dockerfile'), '-t', REF, SANDBOX], { stdio: ['ignore', 'inherit', 'inherit'], timeout: 40 * 60_000 });
  const img = inspect(REF);
  const layerChain = base.layers.every((l, i) => img.layers[i] === l);
  // probe: versions, and whether Chromium starts with its sandbox (no sandbox-disabling flag is passed)
  const ver = dk(['run', '--rm', ...HARD, '--entrypoint', 'sh', REF, '-c',
    'echo "node=$(node --version)"; echo "claude=$(claude --version 2>/dev/null | head -n1 | cut -d" " -f1)"; echo "chromium_pkg=$(dpkg-query -W -f="\\${Version}" chromium)"; echo "chrome_bin=$CHROME_BIN"'], { timeout: 120_000 });
  const versions = Object.fromEntries(String(ver.stdout).split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  const sb = dk(['run', '--rm', ...HARD, '--entrypoint', 'sh', REF, '-c',
    'timeout 60 chromium --headless=new --disable-gpu --disable-dev-shm-usage --dump-dom "data:text/html,<p>qb</p>" > /tmp/dom 2> /tmp/err; ec=$?; echo "exit=$ec dom_ok=$(grep -c "<p>qb</p>" /tmp/dom) no_usable_sandbox=$(grep -ciE "no usable sandbox|sandbox.*(fail|unavailable)" /tmp/err)"'], { timeout: 120_000 });
  const kv = Object.fromEntries([...String(sb.stdout).matchAll(/([a-z_]+)=(\S+)/g)].map((m) => [m[1], m[2]]));
  const sandboxProbe = { flags: ['--headless=new', '--disable-gpu', '--disable-dev-shm-usage'], sandbox_disabled: false, exit: Number(kv.exit), rendered: kv.dom_ok === '1',
    no_usable_sandbox_message: Number(kv.no_usable_sandbox || 0) > 0, started_with_sandbox: kv.exit === '0' && kv.dom_ok === '1' };
  const tar = 'agent-u2.tar.gz';
  execFileSync('bash', ['-c', 'set -o pipefail; docker save "$1" | gzip -1 -n > "$2"', 'bash', REF, path.join(out, tar)], { stdio: 'inherit', timeout: 20 * 60_000 });
  const dv = dk(['version', '--format', '{{json .}}']); const v = dv.status === 0 ? JSON.parse(dv.stdout) : {};
  const prov = {
    schema: 'qb-kan114-u2-image-provenance/1', qb_commit: process.env.GITHUB_SHA || null, spec_version: SPEC.version,
    base: { ref: SPEC.base.ref, id: base.id, layers: base.layers.length }, debian_snapshot: SPEC.debian_snapshot,
    image: { ref: REF, id: img.id, built_from_base: layerChain, layers: img.layers.length, architecture: img.architecture, tar, tar_sha256: fileSha(path.join(out, tar)), tar_bytes: fs.statSync(path.join(out, tar)).size },
    dockerfile_sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(SANDBOX, 'agent-u2', 'Dockerfile'))).digest('hex'),
    versions, sandbox_probe: sandboxProbe,
    docker: { client: v.Client && v.Client.Version, server: v.Server && v.Server.Version, runner_image: process.env.ImageOS || null, runner_image_version: process.env.ImageVersion || null },
  };
  const problems = [];
  if (!layerChain) problems.push('image is not built on the pinned base layers');
  if (versions.claude !== SPEC.claude_code_version) problems.push(`claude ${versions.claude} != ${SPEC.claude_code_version}`);
  if (versions.chrome_bin !== '/usr/bin/chromium' || !versions.chromium_pkg) problems.push('chromium missing');
  prov.problems = problems;
  fs.writeFileSync(path.join(out, 'u2-image-provenance.json'), `${JSON.stringify(prov, null, 2)}\n`);
  console.log(JSON.stringify({ ref: REF, id: img.id, built_from_base: layerChain, versions, sandbox_probe: sandboxProbe, problems }, null, 1));
  process.exit(problems.length ? 1 : 0);
} else if (mode === 'load') {
  const dir = arg('in'); if (!dir) { console.error('usage: load --in=<dir>'); process.exit(2); }
  const prov = JSON.parse(fs.readFileSync(path.join(dir, 'u2-image-provenance.json'), 'utf8'));
  if (prov.image.ref !== REF) { console.error(`refusing: this commit's U2 content tag ${REF} differs from the saved ${prov.image.ref}`); process.exit(1); }
  if (inspect(REF)) { console.error(`refusing: ${REF} already exists on this host before load`); process.exit(1); }
  const f = path.join(dir, prov.image.tar);
  const tarSha = fileSha(f);
  if (tarSha !== prov.image.tar_sha256) { console.error('refusing: tar hash differs from the provenance record'); process.exit(1); }
  execFileSync('bash', ['-c', 'set -o pipefail; gunzip -c "$1" | docker load -q', 'bash', f], { stdio: 'inherit', timeout: 20 * 60_000 });
  const got = inspect(REF);
  const ok = Boolean(got && got.id === prov.image.id);
  fs.writeFileSync(path.join(dir, 'u2-load-verification.json'), `${JSON.stringify({ schema: 'qb-kan114-u2-image-load/1', ref: REF, id: got && got.id, expected: prov.image.id, tar_sha256: tarSha, ok }, null, 2)}\n`);
  if (!ok) { console.error('refusing: loaded image id differs from the recorded id'); process.exit(1); }
  console.log(REF);
} else { console.error('usage: u2-image.mjs save --out=<dir> | load --in=<dir>'); process.exit(2); }
