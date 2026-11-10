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
  2006: { task_id: 'qbt_00b20b1b0285', instance: 'immutable-js__immutable-js-2006', base: '493afba6ec17d9c999dc5a15ac80c71c6bdba1c3' },
  2005: { task_id: 'qbt_9b9a5da937c9', instance: 'immutable-js__immutable-js-2005', base: '77434b3cbbc8ee21206f4cc6965e1c9b09cc92b6' },
};
const REPO = 'https://github.com/immutable-js/immutable-js.git';
const OUT = path.join(__dirname, 'results');
const tail = (s, n = 6000) => (s || '').slice(-n);
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const summary = (st) => st && { state: st.state, reason: st.reason, exit_code: st.exit_code, oom_killed: st.oom_killed, duration_ms: st.duration_ms };

async function imageId(ref) { const r = await D.op(['image', 'inspect', '--format', '{{.Id}} {{.Architecture}}', ref]); return r.ok ? r.stdout.trim() : null; }

async function stageIn(ws, role, mem, shellCmd, { mountOut = false, timeoutMs = 20 * 60_000 } = {}) {
  // Same shape as QB's verification stage (lib/sandbox/stages.js runVerification): hardened, no network,
  // memory limit, private HOME tmpfs, read-only deps at /scratch/node_modules. Reports cgroup peak memory.
  const cmd = `${shellCmd}; ec=$?; echo "QB_FEAS_MEMORY_PEAK=$(cat /sys/fs/cgroup/memory.peak 2>/dev/null || echo unknown)"; exit $ec`;
  return D.runStage(`${ws.runId}-${role}`, [
    ...hardened(ws.runId, 'workload'), '--network', 'none', '--memory', String(mem), '--memory-swap', String(mem),
    '-e', 'HOME=/tmp/home', '-e', 'CI=1', '-e', 'npm_config_update_notifier=false', '-e', 'npm_config_offline=true',
    '--tmpfs', '/tmp/home:rw,size=256m,uid=10001,gid=10001,mode=0700',
    ...ws.mount('scratch'), '-v', `${ws.runId}-deps:/scratch/node_modules:ro`, ...(mountOut ? ws.mount('out') : []),
    '-w', '/scratch', '--entrypoint', 'sh', AGENT_IMAGE, '-c', cmd,
  ], { waitTimeoutMs: timeoutMs, maxBytes: 512 * 1024 });
}
const peak = (st) => { const m = /QB_FEAS_MEMORY_PEAK=(\d+)/.exec((st && st.stdout) || ''); return m ? Number(m[1]) : null; };

async function run(key) {
  const t = TASKS[key];
  const started = new Date().toISOString();
  const r = { schema: 'qb-feasibility/1', task: key, ...t, started, host: { platform: `${os.platform()}/${os.arch()}`, docker: null },
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
    const probeCmd = [
      'echo "arch=$(uname -m) node=$(node -v) npm=$(npm -v)"',
      'node -p "\'jest=\'+require(\'/scratch/node_modules/jest/package.json\').version"',
      'node -p "\'jest-cli-bin=\'+require(\'fs\').realpathSync(\'/scratch/node_modules/.bin/jest\')"',
      'node -e "try{const m=require(\'/scratch/node_modules/microtime\');console.log(\'microtime=loads now=\'+(typeof m.now()))}catch(e){console.log(\'microtime=FAILS \'+e.message.split(\'\\n\')[0])}"',
      'ls /scratch/node_modules/microtime/build/Release 2>/dev/null | head -3 | sed "s/^/microtime-build:/"; ls /scratch/node_modules/microtime/prebuilds 2>/dev/null | sed "s/^/microtime-prebuilds:/"',
      '[ -e /scratch/node_modules/esbuild ] && (node /scratch/node_modules/esbuild/bin/esbuild --version 2>&1 | sed "s/^/esbuild=/") || echo esbuild=absent',
      'ls /scratch/node_modules/@esbuild 2>/dev/null | sed "s/^/esbuild-platform:/"',
      'command -v cc gcc g++ make python3 2>/dev/null | sed "s/^/toolchain:/"; echo toolchain-check-done',
    ].join('; ');
    const probe = await stageIn(ws, 'probe-versions', r.limits.verify, probeCmd, { timeoutMs: 2 * 60_000 });
    r.stages.probe = { ...summary(probe), output: tail(probe.stdout, 3000) };
    r.commands.push(`probe: ${probeCmd}`);

    const build = await stageIn(ws, 'build', r.limits.verify, 'npm run build');
    r.stages.build = { ...summary(build), memory_peak_bytes: peak(build) };
    fs.writeFileSync(path.join(OUT, `${key}-build.log`), `# exit ${build.exit_code} state ${build.state}\n# stdout (tail)\n${tail(build.stdout, 20000)}\n# stderr (tail)\n${tail(build.stderr, 20000)}\n`);
    r.commands.push('build: npm run build   (explicit pre-test step; same as the grader runs before Jest)');

    const list = await stageIn(ws, 'jest-list', r.limits.verify, 'node_modules/.bin/jest --ci --listTests');
    const files = (list.stdout || '').split('\n').filter((l) => /^\/scratch\//.test(l));
    r.stages.jest_list = { ...summary(list), test_files: files.length, sample: files.slice(0, 5).map((f) => f.replace('/scratch/', '')) };
    r.commands.push('enumerate: node_modules/.bin/jest --ci --listTests');

    const jcmd = 'node_modules/.bin/jest --ci --runInBand --json --outputFile=/out/jest.json';
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
      r.findings.jest_report = {
        success: report.success, numTotalTestSuites: report.numTotalTestSuites, numFailedTestSuites: report.numFailedTestSuites,
        numRuntimeErrorTestSuites: report.numRuntimeErrorTestSuites, numTotalTests: report.numTotalTests, numPassedTests: report.numPassedTests,
        numFailedTests: report.numFailedTests, numPendingTests: report.numPendingTests, numTodoTests: report.numTodoTests,
        assertion_statuses: statuses, duplicate_identities: dupIds, snapshot: report.snapshot && { unchecked: report.snapshot.unchecked, filesRemoved: report.snapshot.filesRemoved, failure: report.snapshot.failure },
        exit_consistent: (jest.exit_code === 0) === Boolean(report.success),
        failed_suites: (report.testResults || []).filter((f) => f.status !== 'passed').map((f) => ({ file: f.name.replace('/scratch/', ''), status: f.status, message: (f.message || '').slice(0, 300) })).slice(0, 10),
      };
    } else r.findings.jest_report = null;
    r.findings.result = deps.status === 'ready' && build.state === 'completed' && jest.state === 'completed' ? 'install+build+jest succeeded' : 'see stages';
    return r;
  } finally {
    r.cleanup = await D.removeRun(runId);
    fs.rmSync(dir, { recursive: true, force: true });
    r.finished = new Date().toISOString();
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, `${key}.json`), JSON.stringify(r, null, 2) + '\n');
  }
}

(async () => {
  const keys = process.argv.slice(2).length ? process.argv.slice(2) : ['2006', '2005'];
  for (const k of keys) {
    const r = await run(k).catch((e) => ({ task: k, error: e.message }));
    console.log(JSON.stringify({ task: k, result: r.findings && r.findings.result, error: r.error, deps: r.stages && r.stages.deps && { status: r.stages.deps.status, reason: r.stages.deps.reason }, build: r.stages && r.stages.build && r.stages.build.state, jest: r.stages && r.stages.jest && r.stages.jest.state }));
  }
})();
