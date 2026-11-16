#!/usr/bin/env node
// KAN-117 (senior, after 10651): map AC-4's preservation requirements to the EXACT existing visible tests in
// test/unit/adapters/http.js and report, per test, passing / failing / excluded (approved exception or isolation re-check)
// / missing (no such test executed), on the unchanged base and the correct reference. No model, no agent, no checks:
// QB's research-Mocha channel only (same env record, root-scripts entry, images). Identities are sha256(file + NUL + full
// Mocha title); the mapping below is written from the base test source (visible tests), not from hidden tests or gold.
//   node bench/opus-pilot/ac4-map-5892.mjs --repo=<checkout at base> --store=bench/public/out --images=<dir> --out=<dir>
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
const vault = fs.readFileSync(path.join(store, 'vault', 'swe-bench-multilingual.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((r) => r.task_id === ENV.task_id);

// AC-4's clauses → the exact visible tests (base test/unit/adapters/http.js, describe 'supports http with nodejs' > 'compression')
const FILE = 'test/unit/adapters/http.js';
const P = 'supports http with nodejs compression';
const ALG = ['gzip', 'compress', 'deflate', 'deflate-raw', 'br'];
const algTests = (t) => [
  [`${P} algorithms ${t} decompression should support decompression`, 'decompress'],
  [`${P} algorithms ${t} decompression should not fail if response content-length header is missing (${t.split('-')[0]})`, 'no content-length'],
  [`${P} algorithms ${t} decompression should not fail with chunked responses (without Content-Length header)`, 'chunked'],
  [`${P} algorithms ${t} decompression should not fail with an empty response without content-length header (Z_BUF_ERROR)`, 'empty, no content-length'],
  [`${P} algorithms ${t} decompression should not fail with an empty response with content-length header (Z_BUF_ERROR)`, 'empty, with content-length'],
];
const MAP = [
  { clause: 'lowercase gzip still decompresses', tests: [[`${P} should support transparent gunzip`, 'transparent gunzip'], ...algTests('gzip')] },
  ...ALG.slice(1).map((t) => ({ clause: `lowercase ${t} still decompresses (with and without content-length, chunked, empty bodies)`, tests: algTests(t) })),
  { clause: 'decompress: false still returns the raw compressed bytes', tests: [[`${P} should support disabling automatic decompression of response data`, 'raw bytes']] },
  { clause: 'HEAD/204 with a content-encoding header still succeed', tests: [], note: 'no existing visible test sends HEAD or a 204 with Content-Encoding (the only HEAD test, "should preserve the HTTP verb on redirect", is about redirects)' },
  { clause: '(related, not required by AC-4) gunzip error handling', tests: [[`${P} should support gunzip error handling`, 'error path']] },
];
const idOf = (title) => sha(`${FILE}\0${title}`);

const prov = JSON.parse(fs.readFileSync(path.join(imagesDir, 'image-provenance.json'), 'utf8'));
const ids = {};
for (const [name, ref] of Object.entries({ agent: AGENT_IMAGE, tools: TOOLS_IMAGE, proxy: PROXY_IMAGE })) {
  const r = await D.op(['image', 'inspect', '-f', '{{.Id}}', ref]);
  if (!r.ok || r.stdout.trim() !== prov.images[name].id) { console.error(`${name}: not the loaded image`); process.exit(3); }
  ids[ref] = r.stdout.trim();
}
const release = D.bindImages(ids);
const exc = new Map(ENV.known_base_failures.entries.map((e) => [e.id, 'approved exact exception']));
for (const r of ENV.known_base_failures.isolation_rechecks) exc.set(r.id, 'isolation re-check');

async function one(label, extra) {
  const r = await runSandboxed({ repoPath: repo, briefing: `KAN-117 AC-4 map ${label} (no model)`, researchEnv: ENV, researchRootScripts: ROOT_SCRIPTS,
    requireMemoryCheck: true, researchDeadlineAtMs: Date.now() + 90 * 60_000, ...extra });
  const v = (r.sandbox && r.sandbox.verification) || {}; const val = v.validation || {};
  const byId = new Map((val.identities || []).map((e) => [e.id, e]));
  const status = (id) => { const e = byId.get(id); if (!e) return 'MISSING (not executed)'; const s = e.statuses.join('/'); return exc.has(id) ? `${s} (EXCLUDED: ${exc.get(id)})` : s; };
  const fileIds = (val.identities || []).filter((e) => e.file === FILE);
  return {
    label, verdict: v.verdict, counts: val.counts || null, isolation_rechecks: (v.isolation_rechecks || []).map((x) => ({ id: x.id.slice(0, 16), verdict: x.verdict })),
    clauses: MAP.map((m) => ({ clause: m.clause, note: m.note || null, tests: m.tests.map(([t, what]) => ({ title: t, what, id: idOf(t).slice(0, 16), status: status(idOf(t)) })) })),
    file_summary: { file: FILE, executed: fileIds.length,
      passed: fileIds.filter((e) => e.statuses.every((s) => s === 'passed')).length,
      failed: fileIds.filter((e) => e.statuses.includes('failed')).map((e) => ({ id: e.id.slice(0, 16), excluded_as: exc.get(e.id) || 'NOT excluded', kinds: e.kinds, codes: e.codes })),
      pending: fileIds.filter((e) => e.statuses.includes('pending')).length,
      mapped_to_ac4: MAP.flatMap((m) => m.tests).length, other_tests_in_file: fileIds.length - MAP.flatMap((m) => m.tests).filter(([t]) => byId.has(idOf(t))).length },
  };
}
const out = { schema: 'qb-kan117-ac4-map/1', qb_commit: process.env.GITHUB_SHA || null, images: ids, runs: [await one('base', { noAgent: true }), await one('gold', { applyPatch: vault.patch })] };
release();
fs.writeFileSync(path.join(outDir, 'ac4-map-5892.json'), `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify(out.runs.map((r) => ({ label: r.label, file_summary: r.file_summary })), null, 1));
