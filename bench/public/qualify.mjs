#!/usr/bin/env node
// KAN-110 qualifier. Usage (from bench/, after import.mjs):  node public/qualify.mjs
//
// For every JS/TS candidate, reads the upstream repository AT ITS base_commit (root tree,
// package.json, package-lock.json, .nvmrc/.node-version, .quarterback.json) plus the dataset's own
// setup/grading material, and judges it against Quarterback's rules at main 784e721 (qb-rules.mjs).
// Also records image references, digests and architecture, and resource needs where published.
//
// Network: read-only GETs to api.github.com / raw.githubusercontent.com (a GitHub token from
// `git credential fill` is sent to GitHub hosts only, if available), and anonymous registry
// HEAD requests to ghcr.io and Docker Hub. Responses are cached in public/cache/ (gitignored).
// Prints counts and reasons only; never prints patches, tests or grading scripts.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as R from './qb-rules.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'out');
const CACHE = path.join(HERE, 'cache');
const MANIFEST = path.join(HERE, 'manifest');
export const PRO_HARNESS = { repo: 'scaleapi/SWE-bench_Pro-os', commit: '66f92766bba642462d4bbe5479e83f91f9211862', license: 'MIT' };
fs.mkdirSync(CACHE, { recursive: true });

let TOKEN = process.env.GITHUB_TOKEN || '';
if (!TOKEN) { try { TOKEN = execFileSync('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).match(/^password=(.*)$/m)?.[1] || ''; } catch { /* anonymous */ } }

const readJsonl = (f) => fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const key = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** Cached GET/HEAD. Returns { status, body, headers }. GitHub token only for GitHub hosts. */
async function get(url, { method = 'GET', headers = {}, json = false } = {}) {
  const cf = path.join(CACHE, key(method + ' ' + url + JSON.stringify(headers)) + '.json');
  if (fs.existsSync(cf)) return JSON.parse(fs.readFileSync(cf, 'utf8'));
  const host = new URL(url).hostname;
  const h = { 'User-Agent': 'quarterback-kan110', ...headers };
  if (TOKEN && (host === 'api.github.com' || host === 'raw.githubusercontent.com')) h.Authorization = `Bearer ${TOKEN}`;
  for (let attempt = 0; ; attempt++) {
    let res;
    try { res = await fetch(url, { method, headers: h }); } catch (e) { if (attempt < 4) { await sleep(1000 * 2 ** attempt); continue; } throw e; }
    if ((res.status === 429 || res.status >= 500 || (res.status === 403 && host === 'api.github.com' && res.headers.get('x-ratelimit-remaining') === '0')) && attempt < 5) {
      const reset = Number(res.headers.get('x-ratelimit-reset') || 0) * 1000 - Date.now();
      await sleep(Math.min(Math.max(reset, 2000 * 2 ** attempt), 15 * 60 * 1000)); continue;
    }
    const body = method === 'HEAD' ? null : await res.text();
    const out = { status: res.status, body: json && body && res.ok ? JSON.parse(body) : body, headers: Object.fromEntries(['docker-content-digest', 'content-type'].map((k) => [k, res.headers.get(k)]).filter(([, v]) => v)) };
    if (res.status === 200 || res.status === 404) fs.writeFileSync(cf, JSON.stringify(out));
    return out;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function pool(items, n, fn) { const out = new Array(items.length); let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } })); return out; }
const raw = (repo, ref, p) => `https://raw.githubusercontent.com/${repo}/${ref}/${p}`;
const parse = (s) => { try { return JSON.parse(s); } catch { return undefined; } };

/** Repository facts at one commit (shared by every task on that commit). */
async function repoFacts(repo, commit) {
  const tree = await get(`https://api.github.com/repos/${repo}/git/trees/${commit}`, { json: true });
  if (tree.status !== 200) return { fetch_error: `root tree HTTP ${tree.status}` };
  const rootFiles = new Set(tree.body.tree.map((e) => e.path));
  const f = { rootFiles, root_dirs: tree.body.tree.filter((e) => e.type === 'tree').map((e) => e.path) };
  const pj = rootFiles.has('package.json') ? await get(raw(repo, commit, 'package.json')) : null;
  f.pkg = pj && pj.status === 200 ? parse(pj.body) : null;
  f.pkg_present = !!f.pkg;
  if (pj && pj.status === 200 && f.pkg === undefined) f.pkg_invalid = true;
  if (rootFiles.has('package-lock.json')) { const l = await get(raw(repo, commit, 'package-lock.json')); f.lock = l.status === 200 ? parse(l.body) : null; f.lock_bytes = l.body ? l.body.length : 0; }
  for (const [file, k] of [['.nvmrc', 'nvmrc'], ['.node-version', 'nodeVersion']]) if (rootFiles.has(file)) { const r = await get(raw(repo, commit, file)); if (r.status === 200) f[k] = r.body; }
  f.quarterback_json = rootFiles.has('.quarterback.json');
  // QB's detector falls back to node:test imports in test/*.js|ts heads; fetch only when it could matter
  f.test_heads = [];
  if (f.pkg && !R.detectTestRunner(f.pkg) && tree.body.tree.some((e) => e.path === 'test' && e.type === 'tree')) {
    const td = await get(`https://api.github.com/repos/${repo}/contents/test?ref=${commit}`, { json: true });
    if (td.status === 200 && Array.isArray(td.body)) {
      for (const e of td.body.filter((x) => x.type === 'file').slice(0, 6)) {
        if (!/\.(js|ts)$/.test(e.name)) continue;
        const r = await get(raw(repo, commit, 'test/' + e.name)); if (r.status === 200) f.test_heads.push(r.body.slice(0, 400));
      }
    }
  }
  return f;
}

/** Dataset-side setup/grading evidence per task. Returns command strings (kept in memory only). */
async function graderEvidence(c, vault) {
  if (c.source === 'swe-bench-pro-v2') {
    const base = `v2/tasks/${c.instance_id}`;
    const [run, toml, dockerfile] = await Promise.all(['tests/run_script.sh', 'task.toml', 'environment/Dockerfile'].map((p) => get(raw(PRO_HARNESS.repo, PRO_HARNESS.commit, `${base}/${p}`))));
    const t = toml.status === 200 ? toml.body : '';
    const num = (k) => { const m = new RegExp(`^\\s*${k}\\s*=\\s*"?([\\w.]+)"?`, 'm').exec(t); return m ? m[1] : null; };
    return { grader_cmd: run.status === 200 ? run.body : null, setup: dockerfile.status === 200 ? dockerfile.body : null, missing: [run, toml, dockerfile].filter((r) => r.status !== 200).length,
      resources: { cpus: num('cpus'), memory: num('memory') || num('memory_mb'), storage: num('storage') || num('storage_mb'), timeout_sec: num('timeout_sec') }, image: c.docker_image };
  }
  if (c.source === 'swe-bench-multilingual') return { grader_cmd: vault.eval_script || null, setup: vault.eval_script || null, resources: {}, image: c.image };
  return { grader_cmd: vault.test_command || null, setup: c.Dockerfile || null, resources: {}, image: null };
}

/** Image digest and architectures for a published image reference (anonymous). */
async function imageInfo(ref) {
  if (!ref) return null;
  let m = /^ghcr\.io\/([^:]+):(.+)$/.exec(ref); let reg, repo, tag, tokUrl;
  if (m) { reg = 'ghcr.io'; repo = m[1]; tag = m[2]; tokUrl = `https://ghcr.io/token?scope=repository:${repo}:pull`; }
  else { m = /^(?:docker\.io\/)?([^:]+):(.+)$/.exec(ref); if (!m) return { ref, error: 'unparsed reference' }; reg = 'registry-1.docker.io'; repo = m[1].includes('/') ? m[1] : `library/${m[1]}`; tag = m[2]; tokUrl = `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repo}:pull`; }
  const tok = await get(tokUrl, { json: true });
  if (tok.status !== 200) return { ref, error: `token HTTP ${tok.status}` };
  const accept = 'application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json';
  const man = await get(`https://${reg}/v2/${repo}/manifests/${tag}`, { headers: { Authorization: `Bearer ${tok.body.token}`, Accept: accept } });
  if (man.status !== 200) return { ref, error: `manifest HTTP ${man.status}` };
  const body = parse(man.body) || {};
  let arch = [];
  if (Array.isArray(body.manifests)) arch = [...new Set(body.manifests.map((x) => x.platform && `${x.platform.os}/${x.platform.architecture}`).filter((x) => x && x !== 'unknown/unknown'))];
  else if (body.config && body.config.digest) {
    const cfg = await get(`https://${reg}/v2/${repo}/blobs/${body.config.digest}`, { headers: { Authorization: `Bearer ${tok.body.token}` } });
    const cj = parse(cfg.body); if (cj && cj.architecture) arch = [`${cj.os}/${cj.architecture}`];
  }
  return { ref, digest: man.headers['docker-content-digest'] || null, architectures: arch };
}

export async function run() {
  const sources = ['swe-bench-pro-v2', 'swe-bench-multilingual', 'swe-polybench'];
  const tasks = [];
  for (const s of sources) {
    const ctl = readJsonl(path.join(OUT, 'controller', `${s}.jsonl`));
    const vault = new Map(readJsonl(path.join(OUT, 'vault', `${s}.jsonl`)).map((v) => [v.task_id, v]));
    ctl.forEach((c) => tasks.push({ c, v: vault.get(c.task_id) }));
  }
  const commits = [...new Set(tasks.map(({ c }) => `${c.repo}@${c.base_commit}`))];
  process.stderr.write(`tasks ${tasks.length}, unique repo@commit ${commits.length}, token ${TOKEN ? 'yes' : 'no'}\n`);
  let done = 0;
  const factsList = await pool(commits, 8, async (k) => {
    const [repo, commit] = k.split('@');
    const f = await repoFacts(repo, commit).catch((e) => ({ fetch_error: e.message }));
    if (++done % 100 === 0) process.stderr.write(`  repo facts ${done}/${commits.length}\n`);
    return [k, f];
  });
  const facts = new Map(factsList);
  const imageCache = new Map();

  const out = await pool(tasks, 8, async ({ c, v }) => {
    const f = facts.get(`${c.repo}@${c.base_commit}`);
    const g = await graderEvidence(c, v || {});
    if (g.image && !imageCache.has(g.image)) imageCache.set(g.image, imageInfo(g.image).catch((e) => ({ ref: g.image, error: e.message })));
    const img = g.image ? await imageCache.get(g.image) : null;
    const row = { task_id: c.task_id, source: c.source, instance_id: c.instance_id, repo: c.repo, base_commit: c.base_commit, language: c.language };
    if (f.fetch_error) { row.facts = { fetch_error: f.fetch_error }; row.classification = R.classify({ fetch_error: f.fetch_error }); return row; }
    const scripts = R.actualRunnerFromScripts(f.pkg);
    const graderRunners = R.frameworksIn(g.grader_cmd || '');
    const qf = {
      pkg_present: f.pkg_present, quarterback_json: f.quarterback_json,
      test_plan: R.testPlan(f.pkg, f.test_heads), deps_plan: R.depsPlan(f.pkg, f.lock),
      runner_from_scripts: scripts, runner_from_grader: graderRunners,
      services: [...new Set([...R.servicesIn(g.setup), ...R.servicesIn(g.grader_cmd)])],
    };
    row.facts = {
      qb_detected_runner: R.detectTestRunner(f.pkg, f.test_heads), qb_test_plan: qf.test_plan, qb_deps_plan: qf.deps_plan,
      runner_from_scripts: scripts, runner_from_grader: graderRunners, grader_evidence: g.grader_cmd ? 'present' : 'missing',
      package_manager: R.packageManager({ rootFiles: f.rootFiles, pkg: f.pkg, commands: [g.setup, g.grader_cmd] }),
      lockfile_version: f.lock ? f.lock.lockfileVersion ?? null : null, workspaces: !!(f.pkg && f.pkg.workspaces),
      node: R.nodeHints({ pkg: f.pkg, nvmrc: f.nvmrc, nodeVersion: f.nodeVersion, dockerfile: g.setup, script: g.grader_cmd }),
      module_type: f.pkg ? f.pkg.type || 'commonjs' : null, services: qf.services,
      image: img || (c.source === 'swe-polybench' ? { ref: null, note: 'no published image: built from the dataset Dockerfile' } : null),
      resources: g.resources, quarterback_json: f.quarterback_json,
    };
    row.classification = R.classify(qf);
    row.dedup = { fix_sha: /-([0-9a-f]{40})(?:-v[0-9a-f]+)?$/.exec(c.instance_id || '')?.[1] || null, pr: c.pull_number ? String(c.pull_number) : (/-(\d+)$/.exec(c.instance_id || '')?.[1] || null), issues: c.issue_numbers || null };
    row.leak = { agent_redactions: c.agent_redactions.length, gold_overlap_lines: c.gold_overlap.found };
    row.prior_exposure_arshad = null; // recorded from Arshad's answer on KAN-110
    return row;
  });

  // Deduplication within and across datasets: same upstream repository AND the same fixing PR or
  // fix commit = duplicate (first by source order kept). Same base commit with a different change =
  // kept, noted as same_base_as (same snapshot, not the same task).
  const order = { 'swe-bench-pro-v2': 0, 'swe-bench-multilingual': 1, 'swe-polybench': 2 };
  out.sort((a, b) => order[a.source] - order[b.source] || a.task_id.localeCompare(b.task_id));
  const byChange = new Map(); const byBase = new Map();
  for (const t of out) {
    const repo = t.repo.toLowerCase();
    const changeKeys = [t.dedup?.pr && `${repo}#pr${t.dedup.pr}`, t.dedup?.fix_sha && `${repo}@fix${t.dedup.fix_sha}`].filter(Boolean);
    const dup = changeKeys.map((k) => byChange.get(k)).find(Boolean);
    if (dup) t.duplicate_of = dup;
    else {
      changeKeys.forEach((k) => byChange.set(k, t.task_id));
      const b = byBase.get(`${repo}@${t.base_commit}`);
      if (b) t.same_base_as = b; else byBase.set(`${repo}@${t.base_commit}`, t.task_id);
    }
  }

  const counts = {};
  for (const t of out) {
    const s = (counts[t.source] ||= { total: 0, compatible: 0, incompatible: 0, unknown: 0, duplicates: 0, by_language: {}, top_reasons: {} });
    s.total++; s[t.classification.status]++; if (t.duplicate_of) s.duplicates++;
    const l = (s.by_language[t.language] ||= { compatible: 0, incompatible: 0, unknown: 0 }); l[t.classification.status]++;
    for (const r of t.classification.reasons) { const k = r.replace(/\(\d+ file.*?\)/, '(n file:/link:/git deps)').replace(/lockfileVersion \d+/, 'lockfileVersion N'); s.top_reasons[k] = (s.top_reasons[k] || 0) + 1; }
  }
  fs.mkdirSync(MANIFEST, { recursive: true });
  const header = { schema: 'qb-public-candidates/1', qb_source: R.QB_SOURCE, pro_harness: PRO_HARNESS, note: 'Static qualification against QB rules. compatible != runnable; KAN-111 validates runs. prior_exposure_arshad is null until Arshad answers.' };
  fs.writeFileSync(path.join(MANIFEST, 'candidates.json'), JSON.stringify(header).slice(0, -1) + ',"tasks":[\n' + out.map((t) => JSON.stringify(t)).join(',\n') + '\n]}\n'); // one task per line: reviewable diffs
  fs.writeFileSync(path.join(MANIFEST, 'counts.json'), JSON.stringify({ ...header, counts }, null, 2) + '\n');
  return { out, counts };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { counts } = await run();
  for (const [s, c] of Object.entries(counts)) {
    console.log(`${s}: total ${c.total} | compatible ${c.compatible} | incompatible ${c.incompatible} | unknown ${c.unknown} | duplicates ${c.duplicates} | ${JSON.stringify(c.by_language)}`);
    Object.entries(c.top_reasons).sort((a, b) => b[1] - a[1]).slice(0, 8).forEach(([r, n]) => console.log(`   ${n}  ${r}`));
  }
}
