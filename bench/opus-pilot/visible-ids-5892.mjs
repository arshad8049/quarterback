#!/usr/bin/env node
// KAN-112 (senior 10662): the pinned visible suite's test identities on the unchanged base, for the briefing guard
// (QB feedback may name an existing visible test only if its identity is in this set). No model, no agent, no vault.
//   node bench/opus-pilot/visible-ids-5892.mjs --repo=<checkout at base> --store=bench/public/out --images=<dir> --out=<dir>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const arg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
if (process.env.GITHUB_ACTIONS !== 'true' || process.env.KAN117_CI_RUN !== '1') { console.error('refusing: CI only'); process.exit(2); }
for (const k of Object.keys(process.env)) if (/^(ANTHROPIC_|CLAUDE_CODE_OAUTH|CLAUDE_API)/.test(k)) { console.error(`refusing: credential-like variable ${k} is set`); process.exit(2); }
const repo = arg('repo'); const store = arg('store'); const imagesDir = arg('images'); const outDir = arg('out');
fs.mkdirSync(outDir, { recursive: true });

const D = require(path.join(ROOT, 'lib/sandbox/docker.js'));
const { runSandboxed } = require(path.join(ROOT, 'lib/sandbox/pipeline.js'));
const { TOOLS_IMAGE } = require(path.join(ROOT, 'lib/sandbox/workspace.js'));
const { AGENT_IMAGE } = require(path.join(ROOT, 'lib/sandbox/agent.js'));
const { PROXY_IMAGE } = require(path.join(ROOT, 'lib/sandbox/egress.js'));
const { validateTaskEnv } = require(path.join(ROOT, 'lib/research/dataset-env.js'));
const ENV = validateTaskEnv(JSON.parse(fs.readFileSync(path.join(HERE, 'mocha', 'axios-5892.env.json'), 'utf8')));
const ROOT_SCRIPTS = JSON.parse(fs.readFileSync(path.join(HERE, 'mocha', 'root-scripts-allow.json'), 'utf8')).entries.filter((e) => e.key === ENV.root_scripts_key);
if (execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== ENV.base_commit) { console.error('checkout is not the task base'); process.exit(3); }

const prov = JSON.parse(fs.readFileSync(path.join(imagesDir, 'image-provenance.json'), 'utf8'));
const ids = {};
for (const [name, ref] of Object.entries({ agent: AGENT_IMAGE, tools: TOOLS_IMAGE, proxy: PROXY_IMAGE })) {
  const r = await D.op(['image', 'inspect', '-f', '{{.Id}}', ref]);
  if (!r.ok || r.stdout.trim() !== prov.images[name].id) { console.error(`${name}: not the loaded image`); process.exit(3); }
  ids[ref] = r.stdout.trim();
}
const release = D.bindImages(ids);

// the pinned visible suite's identities on the unchanged base: sha256(file + NUL + full title) only, never titles
const r = await runSandboxed({ repoPath: repo, briefing: 'KAN-112 visible-suite identities (no model)', researchEnv: ENV, researchRootScripts: ROOT_SCRIPTS,
  requireMemoryCheck: true, researchDeadlineAtMs: Date.now() + 60 * 60_000, noAgent: true });
release();
const v = (r.sandbox && r.sandbox.verification) || {}; const val = v.validation || {};
const idents = (val.identities || []).map((e) => ({ id: e.id, file: e.file, statuses: e.statuses })).sort((a, b) => (a.id < b.id ? -1 : 1));
const out = { schema: 'qb-visible-identities/1', task: ENV.key, task_id: ENV.task_id, base_commit: ENV.base_commit, qb_commit: process.env.GITHUB_SHA || null,
  rule: 'sha256(file + NUL + full Mocha title) of every test the pinned visible suite executed on the unchanged base (status recorded); no titles',
  test_files: ENV.test_files, verdict: v.verdict, counts: val.counts || null, identity_set_sha256: val.identity_set_sha256 || null, identities: idents };
fs.writeFileSync(path.join(outDir, 'visible-identities-5892.json'), `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify({ verdict: out.verdict, counts: out.counts, n: idents.length, identity_set_sha256: out.identity_set_sha256 }));
