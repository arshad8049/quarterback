#!/usr/bin/env node
// KAN-117 review 10640 step 3: SYNTHETIC, no-model fixtures for the research scenario capability, through QB's REAL
// runSandboxed path: stage ⑥ runs the KAN-99 check runner mounted READ-ONLY from this checkout, on the LOADED kan117 image
// set, network none. The package is a toy (not axios, not any benchmark answer): an ES module with no dependencies.
//   base run (no agent)  SC-PASS    callback "transport" + zlib-compressed body  → pass
//                        SC-ESM     require() of an ES module (Node 24 require(esm))  → pass (or the exact incompatibility)
//                        SC-HTTP    require('http')                            → error
//                        SC-NET     require('net')                             → error
//                        SC-ESCAPE  require() of a file outside the checkout   → error
//                        SC-HANG    never settles                              → error (runner timeout)
//                        SC-NONFN   module.exports is not a function           → error
//   defect run           the same checks on a controller-applied planted defect (no decompression) → SC-PASS fail
// Output: --out/scenario-fixtures.json (statuses, durations, hashes, runner/mount/image/Node evidence, cleanup).
//   node bench/opus-pilot/scenario-fixtures.mjs --images=<dir> --out=<dir>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
if (process.env.GITHUB_ACTIONS !== 'true' || process.env.KAN117_CI_RUN !== '1') { console.error('refusing: CI only'); process.exit(2); }
for (const k of Object.keys(process.env)) if (/^(ANTHROPIC_|CLAUDE_CODE_OAUTH|CLAUDE_API)/.test(k)) { console.error(`refusing: credential-like variable ${k} is set`); process.exit(2); }
const outDir = arg('out'); const imagesDir = arg('images');
fs.mkdirSync(outDir, { recursive: true });

const D = require(path.join(ROOT, 'lib/sandbox/docker.js'));
const { runSandboxed } = require(path.join(ROOT, 'lib/sandbox/pipeline.js'));
const { TOOLS_IMAGE } = require(path.join(ROOT, 'lib/sandbox/workspace.js'));
const { AGENT_IMAGE } = require(path.join(ROOT, 'lib/sandbox/agent.js'));
const { PROXY_IMAGE } = require(path.join(ROOT, 'lib/sandbox/egress.js'));
const { validateResearchChecks, researchCheckRunner } = require(path.join(ROOT, 'lib/research/reviewed-checks.js'));
const { checkSetHash } = require(path.join(ROOT, 'verify/checks/registry.js'));
const { validateCheckResults } = require(path.join(ROOT, 'verify/checks/results.js'));

// the loaded image set; every container must launch from these ids
const prov = JSON.parse(fs.readFileSync(path.join(imagesDir, 'image-provenance.json'), 'utf8'));
const ids = {};
for (const [name, ref] of Object.entries({ agent: AGENT_IMAGE, tools: TOOLS_IMAGE, proxy: PROXY_IMAGE })) {
  const r = await D.op(['image', 'inspect', '-f', '{{.Id}}', ref]);
  if (!r.ok || r.stdout.trim() !== prov.images[name].id) { console.error(`${name}: not the loaded image`); process.exit(3); }
  ids[ref] = r.stdout.trim();
}
const nodeV = (await D.op(['run', '--rm', '--network', 'none', '--entrypoint', 'node', AGENT_IMAGE, '--version'])).stdout.trim();
const release = D.bindImages(ids);

// the toy package (ESM, no dependencies) as a one-commit git repository
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-toy-'));
const w = (f, s) => { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), s); };
w('package.json', `${JSON.stringify({ name: 'qb-toy', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2)}\n`);
w('package-lock.json', `${JSON.stringify({ name: 'qb-toy', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'qb-toy', version: '1.0.0' } } }, null, 2)}\n`);
w('lib/fetch-text.js', [
  "import zlib from 'node:zlib';",
  '// reads a response from a caller-supplied transport (a callback API) and decompresses a gzip body',
  'export function fetchText(transport) {',
  '  return new Promise((resolve, reject) => {',
  '    transport.request({ path: "/" }, (res) => {',
  "      const body = res.headers['content-encoding'] === 'gzip' ? res.pipe(zlib.createGunzip()) : res;",
  "      let data = ''; body.setEncoding('utf8');",
  "      body.on('data', (c) => { data += c; }); body.on('end', () => resolve(data)); body.on('error', reject);",
  '    });',
  '  });',
  '}', ''].join('\n'));
w('lib/esm-only.js', "export const answer = 42;\nexport default function hello() { return 'hello'; }\n");
w('test/fetch.test.js', "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { answer } from '../lib/esm-only.js';\ntest('answer', () => assert.equal(answer, 42));\n");
const g = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=qb', '-c', 'user.email=qb@invalid', ...a], { encoding: 'utf8' });
g('init', '-q'); g('add', '.'); g('commit', '-qm', 'toy base');
// the planted defect: no decompression (generated by git, applied by the controller's applyPatch seam)
const dtmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-toy-defect-'));
execFileSync('git', ['clone', '-q', repo, dtmp]);
const fp = path.join(dtmp, 'lib/fetch-text.js');
fs.writeFileSync(fp, fs.readFileSync(fp, 'utf8').replace("res.headers['content-encoding'] === 'gzip' ? res.pipe(zlib.createGunzip()) : res", 'res'));
const DEFECT = execFileSync('git', ['-C', dtmp, 'diff'], { encoding: 'utf8' });
if (!DEFECT.includes('-      const body')) { console.error('defect patch not generated'); process.exit(3); }

// the scenario sources (each a short CommonJS module) and their "review" (fixture reviewer; exact sha256)
const SRC = {
  'SC-PASS': [
    'module.exports = async ({ require, assert }) => {',
    "  const zlib = require('zlib'); const { PassThrough } = require('stream');",
    "  const { fetchText } = require('./lib/fetch-text.js');",
    '  const transport = { request(opts, cb) { const res = new PassThrough(); res.headers = { "content-encoding": "gzip" };',
    "    setImmediate(() => { cb(res); res.end(zlib.gzipSync(Buffer.from('compressed hello'))); }); return { end() {} }; } };",
    "  assert.equal(await fetchText(transport), 'compressed hello');",
    '};'].join('\n'),
  'SC-ESM': "module.exports = async ({ require, assert }) => { const m = require('./lib/esm-only.js'); assert.equal(m.answer, 42); assert.equal(m.default(), 'hello'); };",
  'SC-HTTP': "module.exports = async ({ require }) => { require('http'); };",
  'SC-NET': "module.exports = async ({ require }) => { require('net'); };",
  'SC-ESCAPE': "module.exports = async ({ require }) => { require('/etc/passwd'); };",
  'SC-HANG': 'module.exports = async () => { await new Promise(() => {}); };',
  'SC-NONFN': 'module.exports = 42;',
};
const ACS = Object.keys(SRC).map((k, i) => ({ id: `AC-${i + 1}`, criterion: `fixture ${k}`, kind: 'behavioral', met: null }));
const proposed = Object.entries(SRC).map(([id, source], i) => ({ id, ac_id: `AC-${i + 1}`, adapter: 'scenario', params: { source } }));
const reviewed = Object.entries(SRC).map(([id, s]) => ({ check_id: id, source_sha256: sha(s), reviewed_by: 'fixture (synthetic)', ref: 'KAN-117 10640 step 3' }));
const v = validateResearchChecks(proposed, ACS, { reviewed });
if (v.accepted.length !== proposed.length) { console.error(`registry rejected fixtures: ${JSON.stringify(v.rejected)}`); process.exit(3); }
const runner = researchCheckRunner();
const expected = { 'SC-PASS': 'pass', 'SC-ESM': 'pass', 'SC-HTTP': 'error', 'SC-NET': 'error', 'SC-ESCAPE': 'error', 'SC-HANG': 'error', 'SC-NONFN': 'error' };

async function one(label, extra) {
  const t0 = Date.now();
  const r = await runSandboxed({ repoPath: repo, briefing: `KAN-117 scenario fixtures ${label} (no model)`, checks: v.accepted, researchCheckRunner: runner,
    requireMemoryCheck: true, ...extra });
  const c = r.sandbox && r.sandbox.checks;
  const vr = c ? validateCheckResults(c.results_text, v.accepted, checkSetHash(v.accepted)) : { ok: false, reason: 'no checks stage' };
  return { label, wall_ms: Date.now() - t0, status: r.status, verification: r.sandbox && r.sandbox.verification && r.sandbox.verification.status,
    checks_state: c && c.state, checks_error: c && c.error, runner: c && c.runner, results_valid: vr.ok, results_reason: vr.ok ? null : vr.reason,
    results: vr.ok ? vr.results.map((x) => ({ id: x.id, status: x.status, duration_ms: x.duration_ms, detail: x.detail.slice(0, 160) })) : null };
}
const runs = { base: await one('base', { noAgent: true }), defect: await one('defect', { applyPatch: DEFECT }) };
const launches = release();
const left = async (kind) => { const x = await D.op(kind === 'container' ? ['ps', '-aq', '--filter', 'label=qb.run'] : [kind, 'ls', '-q', '--filter', 'label=qb.run']); return x.ok ? x.stdout.split('\n').filter(Boolean).length : null; };
const st = (run, id) => (run.results || []).find((x) => x.id === id);
const assertions = {
  base_matches_expected: Object.entries(expected).every(([id, s]) => st(runs.base, id) && st(runs.base, id).status === s),
  defect_fails_pass_check: st(runs.defect, 'SC-PASS') && st(runs.defect, 'SC-PASS').status === 'fail',
  hang_bounded_by_runner_timeout: st(runs.base, 'SC-HANG') && st(runs.base, 'SC-HANG').duration_ms !== null && st(runs.base, 'SC-HANG').duration_ms < 20_000,
  results_validated_fail_closed: runs.base.results_valid && runs.defect.results_valid,
  runner_is_mounted_research_runner: runs.base.runner && runs.base.runner.sha256 === runner.sha256 && runs.base.runner.path === runner.path,
};
const out = {
  schema: 'qb-kan117-scenario-fixtures/1', approved_by: 'KAN-117 10640 (no model; synthetic toy package)', qb_commit: process.env.GITHUB_SHA || null,
  runner: { host_file: 'sandbox/agent/qb-check-runner.mjs', mount: `${runner.path}:ro`, sha256: runner.sha256 },
  images: ids, node_in_agent_image: nodeV, launches: launches.length, distinct_launch_images: [...new Set(launches.map((l) => l.image))],
  check_set_hash: checkSetHash(v.accepted), scenario_sources_sha256: Object.fromEntries(reviewed.map((r) => [r.check_id, r.source_sha256])),
  expected, runs, assertions, all_ok: Object.values(assertions).every(Boolean),
  cleanup: { containers: await left('container'), networks: await left('network'), volumes: await left('volume') },
};
fs.writeFileSync(path.join(outDir, 'scenario-fixtures.json'), `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify({ all_ok: out.all_ok, assertions, node: nodeV, base: runs.base.results, defect: runs.defect.results }, null, 1));
process.exit(out.all_ok ? 0 : 1);
