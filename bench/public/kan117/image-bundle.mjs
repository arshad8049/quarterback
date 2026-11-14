#!/usr/bin/env node
// KAN-117 (review 10609): a retrievable, immutable QB image set with build provenance. CI only.
//   save --out=<dir>   pull + record each base by repo digest, build the three QB images FROM those
//                      bases (layer-chain proof), docker save each to <name>.tar.gz, hash it, and
//                      write image-provenance.json
//   load --in=<dir>    in a FRESH job: hash each tar, docker load it, and require the loaded image id
//                      to equal the recorded id (and QB's ensure*Image to find it without building);
//                      writes load-verification.json; exit 1 on any difference
// No model, no credential, no registry push.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const arg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
const mode = process.argv[2];
if (process.env.GITHUB_ACTIONS !== 'true' || process.env.KAN117_CI_RUN !== '1') { console.error('refusing: CI only'); process.exit(2); }

const D = require(path.join(ROOT, 'lib/sandbox/docker.js'));
const { TOOLS_IMAGE, ensureToolsImage } = require(path.join(ROOT, 'lib/sandbox/workspace.js'));
const { AGENT_IMAGE, ensureAgentImage, CLAUDE_VERSION } = require(path.join(ROOT, 'lib/sandbox/agent.js'));
const { PROXY_IMAGE, ensureProxyImage } = require(path.join(ROOT, 'lib/sandbox/egress.js'));
const P = require(path.join(ROOT, 'lib/research/image-provenance.js'));

const IMAGES = {
  agent: { ref: AGENT_IMAGE, ensure: ensureAgentImage, base: 'node:24-bookworm-slim', dockerfile: 'sandbox/agent/Dockerfile' },
  tools: { ref: TOOLS_IMAGE, ensure: ensureToolsImage, base: 'debian:trixie-slim', dockerfile: 'sandbox/Dockerfile.tools' },
  proxy: { ref: PROXY_IMAGE, ensure: ensureProxyImage, base: 'ubuntu/squid:latest', dockerfile: 'sandbox/proxy/Dockerfile' },
};
const BUILD_STAGE = { tools: 'rust:1-slim-bookworm' };

const fileSha = (f) => { const h = crypto.createHash('sha256'); const fd = fs.openSync(f, 'r'); const b = Buffer.alloc(1 << 20); let n;
  while ((n = fs.readSync(fd, b, 0, b.length, null)) > 0) h.update(b.subarray(0, n)); fs.closeSync(fd); return h.digest('hex'); };
async function inspect(ref) {
  const r = await D.op(['image', 'inspect', '--format', '{{json .}}', ref]);
  if (!r.ok) throw new Error(`image inspect ${ref}: ${r.stderr.trim()}`);
  const i = JSON.parse(r.stdout);
  return { id: i.Id, repo_digests: i.RepoDigests || [], layers: (i.RootFS && i.RootFS.Layers) || [], architecture: i.Architecture, size: i.Size };
}
const repoOf = (ref) => { const s = ref.replace(/:[^/:]+$/, ''); return s.includes('/') ? s : `${s}`; };
async function pullBase(ref) {
  execFileSync('docker', ['pull', '-q', ref], { stdio: ['ignore', 'inherit', 'inherit'], timeout: 15 * 60_000 });
  const i = await inspect(ref);
  const repo = repoOf(ref);
  const digest = i.repo_digests.find((d) => d.split('@')[0].replace(/^docker\.io\/(library\/)?/, '') === repo) || i.repo_digests[0] || null;
  return { ref, digest, id: i.id, layers: i.layers };
}

if (mode === 'save') {
  const out = arg('out'); if (!out) { console.error('usage: save --out=<dir>'); process.exit(2); }
  fs.mkdirSync(out, { recursive: true });
  const bases = {}; const images = {}; const dockerfiles = {}; const buildStages = {};
  for (const [name, im] of Object.entries(IMAGES)) bases[name] = await pullBase(im.base);
  for (const [name, ref] of Object.entries(BUILD_STAGE)) buildStages[name] = await pullBase(ref);
  for (const [name, im] of Object.entries(IMAGES)) {
    const exists = await D.op(['image', 'inspect', '-f', '{{.Id}}', im.ref]);
    if (exists.ok) { console.error(`refusing: ${im.ref} already exists on this host (the build must come from the recorded bases)`); process.exit(1); }
    await im.ensure();
    const i = await inspect(im.ref);
    const tar = `${name}.tar.gz`;
    execFileSync('bash', ['-c', 'set -o pipefail; docker save "$1" | gzip -1 -n > "$2"', 'bash', im.ref, path.join(out, tar)], { stdio: 'inherit', timeout: 20 * 60_000 });
    images[name] = { ref: im.ref, id: i.id, layers: i.layers, tar, tar_sha256: fileSha(path.join(out, tar)), tar_bytes: fs.statSync(path.join(out, tar)).size };
    dockerfiles[name] = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, im.dockerfile))).digest('hex');
  }
  // the tools image's only build-stage product
  const q = await D.op(['run', '--rm', '--network', 'none', '--entrypoint', 'sha256sum', TOOLS_IMAGE, '/usr/local/bin/qb-scan']);
  buildStages.tools = { ref: buildStages.tools.ref, digest: buildStages.tools.digest, id: buildStages.tools.id, product: '/usr/local/bin/qb-scan', product_sha256: q.ok ? q.stdout.split(/\s+/)[0] : null };
  const ver = await D.op(['version', '--format', '{{json .}}']);
  const v = ver.ok ? JSON.parse(ver.stdout) : {};
  const prov = P.provenanceRecord({ qbCommit: process.env.GITHUB_SHA || null, claudeVersion: CLAUDE_VERSION,
    docker: { client: v.Client && v.Client.Version, server: v.Server && v.Server.Version, runner_image: process.env.ImageOS || null, runner_image_version: process.env.ImageVersion || null },
    bases, images, dockerfiles, buildStages });
  fs.writeFileSync(path.join(out, 'image-provenance.json'), `${JSON.stringify(prov, null, 2)}\n`);
  console.log(JSON.stringify(Object.fromEntries(Object.entries(prov.images).map(([k, x]) => [k, { id: x.id, base: x.base_digest, built_from_base: x.built_from_base, mb: Math.round(x.tar_bytes / 1e6) }])), null, 1));
} else if (mode === 'load') {
  const dir = arg('in'); if (!dir) { console.error('usage: load --in=<dir>'); process.exit(2); }
  const prov = JSON.parse(fs.readFileSync(path.join(dir, 'image-provenance.json'), 'utf8'));
  const loaded = {}; const ensured = {};
  for (const [name, im] of Object.entries(prov.images)) {
    const pre = await D.op(['image', 'inspect', '-f', '{{.Id}}', im.ref]);
    if (pre.ok) { console.error(`refusing: ${im.ref} already exists on this host before load`); process.exit(1); }
    const f = path.join(dir, im.tar);
    const tarSha = fileSha(f);
    execFileSync('bash', ['-c', 'set -o pipefail; gunzip -c "$1" | docker load -q', 'bash', f], { stdio: 'inherit', timeout: 20 * 60_000 });
    loaded[name] = { id: (await inspect(im.ref)).id, tar_sha256: tarSha };
  }
  for (const [name, im] of Object.entries(IMAGES)) ensured[name] = await im.ensure();   // must be a no-op inspect, never a build
  const problems = P.verifyLoaded(prov, loaded);
  for (const [name, id] of Object.entries(ensured)) if (prov.images[name] && id !== prov.images[name].id) problems.push(`${name}: QB resolved ${id}, not the loaded image`);
  for (const [name, im] of Object.entries(IMAGES)) if (prov.images[name] && prov.images[name].ref !== im.ref) problems.push(`${name}: this commit's content tag ${im.ref} differs from the saved ${prov.images[name].ref}`);
  const rec = { schema: 'qb-kan117-image-load/1', fresh_host: process.env.RUNNER_NAME || null, qb_commit: process.env.GITHUB_SHA || null, loaded, ensured, problems, ok: problems.length === 0 };
  fs.writeFileSync(path.join(dir, 'load-verification.json'), `${JSON.stringify(rec, null, 2)}\n`);
  console.log(JSON.stringify(rec, null, 1));
  process.exit(rec.ok ? 0 : 1);
} else { console.error('usage: image-bundle.mjs save --out=<dir> | load --in=<dir>'); process.exit(2); }
