#!/usr/bin/env node
/**
 * KAN-110 review 10541: no-agent feasibility for the two immutable-js tasks.
 * Usage (repository root):  node bench/public/feasibility/immutable-feasibility.cjs [2006|2005]
 *
 * Uses QB's sandbox code UNCHANGED (lib/sandbox at this commit):
 *   createWorkspace → seed (trusted snapshot of the checkout) → prepareDeps (deps-plan.sh,
 *   untrusted `npm ci` behind the DEPS egress proxy = registry.npmjs.org only, deps-check.sh)
 * then, in the same hardened containers QB uses (no network, per-stage memory limit, deps
 * read-only, no credentials), separately:
 *   base-prep.sh (fresh verified base checkout) → probe (versions, native modules)
 *   → `npm run build` → pinned `node_modules/.bin/jest --listTests` → pinned Jest run with --json.
 * No agent, no model, no hidden tests or gold patches, no npx (no download fallback), no new
 * egress, no image change. The host only runs `git fetch` of the pinned commit.
 * Writes bench/public/feasibility/results/<task>.json and log tails.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const D = require(path.join(ROOT, 'lib/sandbox/docker'));
const { createWorkspace, hardened } = require(path.join(ROOT, 'lib/sandbox/workspace'));
const { AGENT_IMAGE, ensureAgentImage } = require(path.join(ROOT, 'lib/sandbox/agent'));
const { prepareDeps } = require(path.join(ROOT, 'lib/sandbox/stages'));
const { stageMemoryLimit } = require(path.join(ROOT, 'lib/sandbox/admission'));

const TASKS = {
  2006: { task_id: 'qbt_00b20b1b0285', instance: 'immutable-js__immutable-js-2006', base: '493afba6ec17d9c999dc5a15ac80c71c6bdba1c3',
    // review 10544: `npm run build` = run-s build:* in definition order, no pre/post hooks; build:stats is last and only
    // reads dist/ and fetches bundlephobia.com. The approved offline build runs every other step, in order.
    build_scripts: ['build:clean', 'build:dist', 'build:esm', 'build:copy', 'build:prepare'], omitted: ['build:stats'] },
  2005: { task_id: 'qbt_9b9a5da937c9', instance: 'immutable-js__immutable-js-2005', base: '77434b3cbbc8ee21206f4cc6965e1c9b09cc92b6',
    build_scripts: ['build:clean', 'build:dist', 'build:types', 'build:prepare'], omitted: ['build:stats'] },
};
const REPO = 'https://github.com/immutable-js/immutable-js.git';
// Results are kept per platform (e.g. results/darwin-arm64, results/linux-x64); a run never overwrites another platform's.
const PLATFORM = `${os.platform()}-${os.arch()}`;
const LABEL = ((process.argv.find((a) => a.startsWith('--label=')) || '').slice(8)) || null;
const BUILD_MODE = ((process.argv.find((a) => a.startsWith('--build=')) || '--build=npm-run-build').slice(8));
const OUT = path.join(__dirname, 'results', PLATFORM, ...(LABEL ? [LABEL] : []));
const tail = (s, n = 6000) => (s || '').slice(-n);
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const summary = (st) => st && { state: st.state, reason: st.reason, exit_code: st.exit_code, oom_killed: st.oom_killed, duration_ms: st.duration_ms };

async function imageId(ref) { const r = await D.op(['image', 'inspect', '--format', '{{.Id}} {{.Architecture}}', ref]); return r.ok ? r.stdout.trim() : null; }

async function stageIn(ws, role, mem, shellCmd, { mountOut = false, timeoutMs = 20 * 60_000, env = {} } = {}) {
  // Same shape as QB's verification stage (lib/sandbox/stages.js runVerification): hardened, no network,
  // memory limit, private HOME tmpfs, read-only deps at /scratch/node_modules. Reports cgroup peak memory.
  const cmd = `${shellCmd}; ec=$?; echo "QB_FEAS_MEMORY_PEAK=$(cat /sys/fs/cgroup/memory.peak 2>/dev/null || echo unknown)"; exit $ec`;
  return D.runStage(`${ws.runId}-${role}`, [
    ...hardened(ws.runId, 'workload'), '--network', 'none', '--memory', String(mem), '--memory-swap', String(mem),
    '-e', 'HOME=/tmp/home', '-e', 'CI=1', '-e', 'npm_config_update_notifier=false', '-e', 'npm_config_offline=true',
    '--tmpfs', '/tmp/home:rw,size=256m,uid=10001,gid=10001,mode=0700', ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
    ...ws.mount('scratch'), '-v', `${ws.runId}-deps:/scratch/node_modules:ro`, ...(mountOut ? ws.mount('out') : []),
    '-w', '/scratch', '--entrypoint', 'sh', AGENT_IMAGE, '-c', cmd,
  ], { waitTimeoutMs: timeoutMs, maxBytes: 512 * 1024 });
}
const peak = (st) => { const m = /QB_FEAS_MEMORY_PEAK=(\d+)/.exec((st && st.stdout) || ''); return m ? Number(m[1]) : null; };

async function run(key) {
  const t = TASKS[key];
  const started = new Date().toISOString();
  const r = { schema: 'qb-feasibility/1', task: key, ...t, label: LABEL, build_mode: BUILD_MODE, started, host: { platform: `${os.platform()}/${os.arch()}`, docker: null },
    qb_source: git(ROOT, 'rev-parse', 'HEAD'), commands: [], stages: {}, findings: {} };
  const dv = await D.op(['info', '--format', '{{.ServerVersion}} {{.Architecture}} cgroup{{.CgroupVersion}} mem={{.MemTotal}}']);
  r.host.docker = dv.ok ? dv.stdout.trim() : null;

  // Host: git only (no repository scripts). Shallow fetch of the pinned base commit.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `kan110-immutable-${key}-`));
  git(dir, 'init', '-q'); git(dir, 'remote', 'add', 'origin', REPO);
  git(dir, 'fetch', '-q', '--depth', '1', 'origin', t.base); git(dir, 'checkout', '-q', '--detach', 'FETCH_HEAD');
  r.checkout = { head: git(dir, 'rev-parse', 'HEAD'), tree: git(dir, 'rev-parse', 'HEAD^{tree}') };
  if (r.checkout.head !== t.base) throw new Error(`checkout ${r.checkout.head} != ${t.base}`);
  r.commands.push(`git fetch --depth 1 ${REPO} ${t.base} && git checkout --detach FETCH_HEAD`);

  const runId = `qb-feas${key}-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`;
  r.run_id = runId;
  await ensureAgentImage();
  const ws = await createWorkspace(runId);
  r.images = { tools: { ref: ws.image, id: await imageId(ws.image) }, agent: { ref: AGENT_IMAGE, id: await imageId(AGENT_IMAGE) } };
  r.limits = { seed: stageMemoryLimit('seed'), deps: stageMemoryLimit('deps'), verify: stageMemoryLimit('verify') };
  try {
    const seeded = await ws.seed(dir, { memoryBytes: r.limits.seed });
    r.stages.seed = summary(seeded.stage);
    if (seeded.stage.state !== 'completed') { r.findings.result = 'seed_failed'; r.findings.seed_stderr = tail(seeded.stage.stderr, 2000); return r; }

    r.commands.push('QB prepareDeps: deps-plan.sh → npm ci --no-audit --no-fund --registry=https://registry.npmjs.org/ (DEPS proxy, registry.npmjs.org only) → deps-check.sh');
    const t0 = Date.now();
    const deps = await prepareDeps(ws, { memoryBytes: r.limits.deps });
    r.stages.deps = { status: deps.status, reason: deps.reason || null, detail: deps.detail || null, wall_ms: Date.now() - t0,
      plan: summary(deps.stages && deps.stages.plan), install: summary(deps.stages && deps.stages.install), check: summary(deps.stages && deps.stages.check) };
    const inst = deps.stages && deps.stages.install;
    if (inst) { fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, `${key}-npm-ci.log`), `# exit ${inst.exit_code} state ${inst.state}\n# stdout (tail)\n${tail(inst.stdout, 20000)}\n# stderr (tail)\n${tail(inst.stderr, 20000)}\n`); }
    if (deps.status !== 'ready') { r.findings.result = 'install_failed'; r.findings.install_error = tail((inst && inst.stderr) || deps.log || '', 3000); return r; }
    const du = await D.op(['run', '--rm', ...hardened(runId, 'probe'), '--network', 'none', ...ws.mount('deps', true), '--entrypoint', 'du', ws.image, '-sk', '/deps']);
    r.stages.deps.node_modules_kib = du.ok ? Number(du.stdout.trim().split(/\s+/)[0]) : null;

    const prep = await D.runStage(`${runId}-base-prep`, [...hardened(runId, 'base-prep'), '--network', 'none', ...ws.mount('git', true), ...ws.mount('scratch'), ws.image, '/usr/local/lib/qb/base-prep.sh']);
    r.stages.base_prep = summary(prep);
    if (prep.state !== 'completed') { r.findings.result = 'base_prep_failed'; return r; }

    // Probe: versions and native modules (no network)
    // Probe as a small script passed through an environment variable (review 10545: no nested shell quoting).
    // It prints one JSON object and exits 3 if a REQUIRED check fails; a later echo can't hide that.
    const PROBE = `
      const fs = require('fs'); const cp = require('child_process'); const r = { required_failed: [] };
      const req = (k, f) => { try { r[k] = f(); } catch (e) { r[k] = 'ERROR ' + String(e.message).split('\\n')[0]; r.required_failed.push(k); } };
      const opt = (k, f) => { try { r[k] = f(); } catch (e) { r[k] = 'ERROR ' + String(e.message).split('\\n')[0]; } };
      r.arch = process.arch; r.node = process.version;
      req('npm', () => cp.execFileSync('npm', ['-v'], { encoding: 'utf8' }).trim());
      req('jest', () => require('/scratch/node_modules/jest/package.json').version);
      req('jest_bin', () => fs.realpathSync('/scratch/node_modules/.bin/jest'));
      req('microtime', () => typeof require('/scratch/node_modules/microtime').now());
      opt('microtime_prebuilds', () => fs.readdirSync('/scratch/node_modules/microtime/prebuilds'));
      if (fs.existsSync('/scratch/node_modules/esbuild')) {
        req('esbuild_bin_magic', () => fs.readFileSync('/scratch/node_modules/esbuild/bin/esbuild').subarray(0, 4).toString('latin1').replace(/[^ -~]/g, '.'));
        req('esbuild_exec_version', () => cp.execFileSync('/scratch/node_modules/esbuild/bin/esbuild', ['--version'], { encoding: 'utf8' }).trim());
        req('esbuild_js_api_version', () => require('/scratch/node_modules/esbuild').version);
        opt('esbuild_platform_pkgs', () => fs.readdirSync('/scratch/node_modules/@esbuild'));
      } else r.esbuild = 'absent';
      req('npm_ignore_scripts', () => cp.execFileSync('npm', ['config', 'get', 'ignore-scripts'], { encoding: 'utf8' }).trim());
      opt('npm_script_config', () => cp.execFileSync('npm', ['config', 'ls', '-l'], { encoding: 'utf8' }).split('\\n').filter((l) => /script/i.test(l)));
      opt('toolchain', () => ['cc', 'gcc', 'g++', 'make', 'python3'].filter((t) => { try { cp.execFileSync('sh', ['-c', 'command -v ' + t]); return true; } catch { return false; } }));
      console.log('QB_PROBE_JSON=' + JSON.stringify(r)); process.exit(r.required_failed.length ? 3 : 0);`;
    const probeCmd = 'node -e "$QB_PROBE"';
    const probe = await stageIn(ws, 'probe-versions', r.limits.verify, probeCmd, { timeoutMs: 2 * 60_000, env: { QB_PROBE: PROBE } });
    const pj = /QB_PROBE_JSON=(\{.*\})/.exec(probe.stdout || '');
    r.stages.probe = { ...summary(probe), result: pj ? JSON.parse(pj[1]) : null, stderr_tail: tail(probe.stderr, 1500) };
    r.commands.push('probe: node -e "$QB_PROBE" (script text recorded in the runner source; exits 3 on a required failure)');
    if (probe.state !== 'completed') { r.findings.result = 'probe_failed'; return r; }

    let buildCmd = 'npm run build';
    if (BUILD_MODE === 'approved-offline') {
      // Bind the approval to the exact inspected sources: package.json build:* order and the omitted stats script must match.
      const expect = JSON.stringify(t.build_scripts.concat(t.omitted));
      const guard = `node -e 'const p=require("/scratch/package.json");const k=Object.keys(p.scripts).filter(x=>x.startsWith("build:"));const pre=Object.keys(p.scripts).filter(x=>/^(pre|post)build/.test(x));if(JSON.stringify(k)!==${JSON.stringify(expect)}||p.scripts.build!=="run-s build:*"||pre.length){console.error("approved build plan does not match package.json: "+JSON.stringify({k,build:p.scripts.build,pre}));process.exit(9)}'`;
      buildCmd = [guard, ...t.build_scripts.map((x) => `npm run ${x}`)].join(' && ') + ' && echo "--- dist outputs" && find dist -type f | sort | while read f; do echo "$(sha256sum "$f" | cut -c1-16) $(wc -c < "$f") $f"; done';
      r.build_plan = { mode: 'approved-offline (review 10544)', scripts: t.build_scripts, omitted: t.omitted, guard: 'package.json build:* order, build = run-s build:*, no pre/post build hooks' };
    }
    const build = await stageIn(ws, 'build', r.limits.verify, buildCmd);
    r.stages.build = { ...summary(build), memory_peak_bytes: peak(build) };
    fs.writeFileSync(path.join(OUT, `${key}-build.log`), `# exit ${build.exit_code} state ${build.state}\n# stdout (tail)\n${tail(build.stdout, 20000)}\n# stderr (tail)\n${tail(build.stderr, 20000)}\n`);
    r.commands.push(BUILD_MODE === 'approved-offline' ? `build (approved offline, review 10544): ${t.build_scripts.map((x) => 'npm run ' + x).join(' && ')}  (omitted: ${t.omitted.join(', ')})` : 'build: npm run build   (explicit pre-test step; same as the grader runs before Jest)');
    r.stages.build.dist_outputs = ((build.stdout || '').split('--- dist outputs')[1] || '').trim().split('\n').filter(Boolean).slice(0, 60);
    if (build.state !== 'completed') { r.findings.result = 'build_failed'; r.findings.build_error = tail(build.stderr || build.stdout, 3000); return r; } // stop at the first failure

    const list = await stageIn(ws, 'jest-list', r.limits.verify, 'node_modules/.bin/jest --ci --listTests; echo "--- __tests__ tree"; find __tests__ -type f | sort');
    const files = (list.stdout || '').split('--- __tests__ tree')[0].split('\n').filter((l) => /^\/scratch\//.test(l));
    r.enumeration = { listed: files.map((f) => f.replace('/scratch/', '')).sort(), tests_dir: ((list.stdout || '').split('--- __tests__ tree')[1] || '').split('\n').filter((l) => /^__tests__\//.test(l)) };
    r.enumeration.in_dir_not_listed = r.enumeration.tests_dir.filter((f) => !r.enumeration.listed.includes(f));
    r.stages.jest_list = { ...summary(list), test_files: files.length, sample: files.slice(0, 5).map((f) => f.replace('/scratch/', '')) };
    r.commands.push('enumerate: node_modules/.bin/jest --ci --listTests');
    if (list.state !== 'completed' || !files.length) { r.findings.result = list.state !== 'completed' ? 'jest_list_failed' : 'jest_found_no_tests'; r.findings.list_error = tail(list.stderr || list.stdout, 3000); return r; }

    const jcmd = 'node_modules/.bin/jest --ci --runInBand --json --testLocationInResults --outputFile=/out/jest.json';
    const jest = await stageIn(ws, 'jest', r.limits.verify, jcmd, { mountOut: true, timeoutMs: 30 * 60_000 });
    r.stages.jest = { ...summary(jest), memory_peak_bytes: peak(jest) };
    r.commands.push(`jest: ${jcmd}   (pinned local binary; no npx, no download fallback; repository tests at base only)`);
    fs.writeFileSync(path.join(OUT, `${key}-jest.log`), `# exit ${jest.exit_code} state ${jest.state}\n# stdout (tail)\n${tail(jest.stdout, 12000)}\n# stderr (tail)\n${tail(jest.stderr, 20000)}\n`);
    const cp = await D.op(['cp', `${ws.runId}-keeper:/out/jest.json`, '-'], { raw: true, maxBytes: 32 * 1024 * 1024 });
    let report = null;
    if (cp.ok && cp.stdout_buffer) { const { readTar } = require(path.join(ROOT, 'lib/sandbox/tar')); const b = readTar(cp.stdout_buffer).get('jest.json'); try { report = b ? JSON.parse(b.toString('utf8')) : null; } catch { report = null; } }
    if (report) {
      const statuses = {}; let dupIds = 0; const ids = new Set();
      for (const f of report.testResults || []) for (const a of f.assertionResults || []) {
        statuses[a.status] = (statuses[a.status] || 0) + 1;
        const id = `${f.name}::${(a.ancestorTitles || []).join(' > ')}::${a.title}`; if (ids.has(id)) dupIds++; ids.add(id);
      }
      const san = JSON.parse(JSON.stringify(report).split('/scratch/').join(''));
      fs.writeFileSync(path.join(OUT, `${key}-jest-report.json`), JSON.stringify(san, null, 1) + '\n');
      const executed = (report.testResults || []).map((f) => f.name.replace('/scratch/', '')).sort();
      r.enumeration.executed = executed.length;
      r.enumeration.listed_not_executed = r.enumeration.listed.filter((f) => !executed.includes(f));
      r.enumeration.executed_not_listed = executed.filter((f) => !r.enumeration.listed.includes(f));
      const seen = new Map(); const dups = [];
      for (const f of report.testResults || []) for (const a of f.assertionResults || []) {
        const id = `${f.name.replace('/scratch/', '')} :: ${(a.ancestorTitles || []).join(' > ')} :: ${a.title}`;
        const loc = a.location ? `${a.location.line}:${a.location.column}` : 'no-location';
        if (seen.has(id)) dups.push({ identity: id, first: seen.get(id), again: { location: loc, status: a.status } }); else seen.set(id, { location: loc, status: a.status });
      }
      r.findings.duplicate_identities = dups;
      r.findings.non_passed_suites = (report.testResults || []).filter((f) => f.status !== 'passed').map((f) => ({ file: f.name.replace('/scratch/', ''), status: f.status, message: f.message,
        assertions: (f.assertionResults || []).map((a) => ({ title: [...(a.ancestorTitles || []), a.title].join(' > '), status: a.status, location: a.location || null })) }));
      r.findings.jest_report = {
        success: report.success, numTotalTestSuites: report.numTotalTestSuites, numFailedTestSuites: report.numFailedTestSuites,
        numRuntimeErrorTestSuites: report.numRuntimeErrorTestSuites, numTotalTests: report.numTotalTests, numPassedTests: report.numPassedTests,
        numFailedTests: report.numFailedTests, numPendingTests: report.numPendingTests, numTodoTests: report.numTodoTests,
        assertion_statuses: statuses, duplicate_identities: dupIds, snapshot: report.snapshot && { unchecked: report.snapshot.unchecked, filesRemoved: report.snapshot.filesRemoved, failure: report.snapshot.failure },
        exit_consistent: (jest.exit_code === 0) === Boolean(report.success),
        failed_suites: (report.testResults || []).filter((f) => f.status !== 'passed').map((f) => ({ file: f.name.replace('/scratch/', ''), status: f.status, message: (f.message || '').slice(0, 300) })).slice(0, 10),
      };
    } else r.findings.jest_report = null;
    r.findings.result = jest.state === 'completed' && r.findings.jest_report && r.findings.jest_report.success && r.findings.jest_report.exit_consistent ? 'install+build+jest succeeded' : `jest_${jest.state}`;
    return r;
  } finally {
    r.cleanup = await D.removeRun(runId);
    fs.rmSync(dir, { recursive: true, force: true });
    r.finished = new Date().toISOString();
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, `${key}.json`), JSON.stringify(r, null, 2) + '\n');
  }
}

async function preflight() {
  const sh = (c, a) => { try { return execFileSync(c, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch (e) { return `unavailable (${e.message.split('\n')[0]})`; } };
  const mem = (() => { try { const m = fs.readFileSync('/proc/meminfo', 'utf8'); const g = (k) => Number((new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(m) || [])[1]) * 1024; return { total: g('MemTotal'), available: g('MemAvailable') }; } catch { return { total: os.totalmem(), available: null, note: 'no /proc/meminfo (not Linux)' }; } })();
  const dv = await D.op(['info', '--format', '{{.ServerVersion}} {{.Architecture}} {{.OperatingSystem}} cgroup{{.CgroupVersion}} mem={{.MemTotal}} cpus={{.NCPU}}']);
  await ensureAgentImage();
  const { ensureToolsImage } = require(path.join(ROOT, 'lib/sandbox/workspace'));
  const tools = await ensureToolsImage();
  const base = await D.op(['image', 'inspect', '--format', '{{json .RepoDigests}}', 'node:24-bookworm-slim']);
  const { admit } = require(path.join(ROOT, 'lib/sandbox/admission'));
  let admission; try { admission = admit(fs.mkdtempSync(path.join(os.tmpdir(), 'qb-feas-adm-')), { runId: 'preflight' }); } catch (e) { admission = { error: e.message }; }
  const out = { platform: PLATFORM, host: { uname: sh('uname', ['-srm']), hostname: os.hostname(), cpus: os.cpus().length, memory_bytes: mem }, docker: dv.ok ? dv.stdout.trim() : dv.stderr.trim(),
    qb_source: git(ROOT, 'rev-parse', 'HEAD'), qb_sandbox_matches_main_784e721: git(ROOT, 'diff', '--stat', '784e721', 'HEAD', '--', 'lib', 'sandbox', 'agent', 'verify', 'context') === '',
    images: { agent: { ref: AGENT_IMAGE, id: await imageId(AGENT_IMAGE) }, tools: { ref: tools, id: await imageId(tools) }, node_base_repo_digests: base.ok ? base.stdout.trim() : null },
    stage_memory_limits: { seed: stageMemoryLimit('seed'), deps: stageMemoryLimit('deps'), verify: stageMemoryLimit('verify') },
    admission: admission && (admission.ok !== undefined ? { ok: admission.ok, reason: admission.reason || null, peak: admission.peak, mem_available: admission.mem_available } : admission) };
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'preflight.json'), JSON.stringify(out, null, 2) + '\n');
  console.log(JSON.stringify(out, null, 2));
}

(async () => {
  if (process.argv.includes('--preflight')) return preflight();
  const keys = process.argv.slice(2).filter((a) => !a.startsWith('--')).length ? process.argv.slice(2).filter((a) => !a.startsWith('--')) : ['2006', '2005'];
  for (const k of keys) {
    const r = await run(k).catch((e) => ({ task: k, error: e.message }));
    console.log(JSON.stringify({ task: k, result: r.findings && r.findings.result, error: r.error, deps: r.stages && r.stages.deps && { status: r.stages.deps.status, reason: r.stages.deps.reason }, build: r.stages && r.stages.build && r.stages.build.state, jest: r.stages && r.stages.jest && r.stages.jest.state }));
  }
})();
