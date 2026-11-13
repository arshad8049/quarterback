#!/usr/bin/env node
/**
 * KAN-113 10596: host qualification on a free GitHub-hosted runner. NO model, NO credential, NO secret.
 * The agent image's CLI is replaced by bench/opus-pilot/host/fake-cli (synthetic stream, no network).
 *
 *   node bench/opus-pilot/host/qualify.mjs --out <report.json>
 *
 * Steps, in order: measurements → images → admission → fake-CLI pipeline → cleanup matrix → dummy isolation.
 * A failed gate stops the later *runtime* steps; the report says which gates were not reached.
 * The report holds only sanitized facts (no env dump, no file contents beyond the dummy marker checks).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { evaluateHost } from './gates.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const require = createRequire(import.meta.url);
const sh = (cmd, args, o = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...o }).trim();
const trySh = (cmd, args, o) => { try { return sh(cmd, args, o); } catch (e) { return null; } };
const FAKE_TAG = 'qb-kan113-fake-cli:qualify';
const BWRAP_TAG = 'qb-kan113-bwrap-probe:qualify';

function measure() {
  const mi = fs.existsSync('/proc/meminfo') ? fs.readFileSync('/proc/meminfo', 'utf8') : '';
  const kb = (k) => { const m = mi.match(new RegExp(`^${k}:\\s+(\\d+) kB`, 'm')); return m ? Number(m[1]) * 1024 : null; };
  const df = (p) => { const o = trySh('df', ['-B1', '--output=avail', p]); return o ? Number(o.split('\n').pop().trim()) : null; };
  const dockerRoot = trySh('docker', ['info', '-f', '{{.DockerRootDir}}']) || '/var/lib/docker';
  return {
    arch: os.machine(), kernel: os.release(), os: trySh('sh', ['-c', '. /etc/os-release && echo "$PRETTY_NAME"']),
    runner_image: process.env.ImageOS ? `${process.env.ImageOS} ${process.env.ImageVersion || ''}`.trim() : null,
    cpus: os.cpus().length, mem_total_bytes: kb('MemTotal'), mem_available_bytes: kb('MemAvailable'),
    docker: trySh('docker', ['version', '-f', '{{.Server.Version}}']), docker_root: dockerRoot,
    disk_free_bytes_root: df('/'), disk_free_bytes_docker: df(dockerRoot), node: process.version,
  };
}

async function leftovers() {
  const n = (args) => { const o = trySh('docker', args); return o === null ? null : o.split('\n').filter(Boolean).length; };
  return { containers: n(['ps', '-aq', '--filter', 'label=qb.run']), networks: n(['network', 'ls', '-q', '--filter', 'label=qb.run']),
    volumes: n(['volume', 'ls', '-q', '--filter', 'label=qb.run']) };
}
const clean = (l) => l.containers === 0 && l.networks === 0 && l.volumes === 0;
async function waitClean(ms = 90_000) {
  const t0 = Date.now(); let l;
  do { l = await leftovers(); if (clean(l)) return { clean: true, left: l, waited_ms: Date.now() - t0 }; await new Promise((r) => setTimeout(r, 2000)); }
  while (Date.now() - t0 < ms);
  return { clean: false, left: l, waited_ms: Date.now() - t0 };
}

function fixtureRepo() {
  const { makeRepo } = require(path.join(ROOT, 'test', 'helpers', 'tmprepo.js'));
  const FIX = path.join(ROOT, 'test', 'fixtures', 'npm-app'); const files = {};
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const a = path.join(d, e.name); if (e.isDirectory()) walk(a); else files[path.relative(FIX, a)] = fs.readFileSync(a); } })(FIX);
  return makeRepo(files);
}

async function pipelineRun({ briefing = 'qualification task (fake CLI)\n', agentMs, signal } = {}) {
  const { runSandboxed } = require(path.join(ROOT, 'lib', 'sandbox', 'pipeline.js'));
  const P = require(path.join(ROOT, 'lib', 'sandbox', 'agent-profile.js'));
  const profile = { ...P.profileFromConfig(P.loadReviewed()), auth_route: 'qualification-fake-cli' };
  const repo = fixtureRepo(); const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kan113q-'));
  try {
    const r = await runSandboxed({ repoPath: repo.dir, briefing, stateDir, noCredentials: true, requireMemoryCheck: true,
      agentArgs: P.buildAgentArgs(profile), agentStdoutMaxBytes: P.AGENT_STDOUT_MAX_BYTES,
      ...(agentMs ? { deadlines: { agent: agentMs } } : {}), ...(signal ? { signal } : {}) });
    const c = r.agent_stdout != null ? P.classifyAttempt({ stdout: r.agent_stdout, dropped: r.agent_stdout_dropped || 0,
      sandboxState: r.sandbox && r.sandbox.stages && r.sandbox.stages.agent ? r.sandbox.stages.agent.state : 'completed' }, profile) : null;
    return { status: r.status, reason: r.reason || null, run_id: r.sandbox && r.sandbox.run_id, admission: r.sandbox && r.sandbox.admission,
      credential_mode: r.sandbox && r.sandbox.credential_mode, classification: c ? c.outcome : null, classification_reasons: c ? c.reasons : [],
      fake_marker: /"qb_fake_cli":true/.test(r.agent_stdout || ''), changes: (r.changes || []).map((x) => x.file), duration_ms: r.duration_ms };
  } finally { try { repo.cleanup && repo.cleanup(); } catch {} fs.rmSync(stateDir, { recursive: true, force: true }); }
}

async function buildImages() {
  process.env.QB_SANDBOX_AGENT_IMAGE = '';                         // build the REAL agent image first
  const { ensureToolsImage } = require(path.join(ROOT, 'lib', 'sandbox', 'workspace.js'));
  const { ensureProxyImage } = require(path.join(ROOT, 'lib', 'sandbox', 'egress.js'));
  const D = require(path.join(ROOT, 'lib', 'sandbox', 'docker.js'));
  const agentDir = path.join(ROOT, 'sandbox', 'agent');
  const agentTag = D.contentTag('qb-sandbox-agent', agentDir, ['.']);
  const id = (t) => trySh('docker', ['image', 'inspect', '-f', '{{.Id}}', t]);
  await ensureToolsImage(); await ensureProxyImage(); await D.ensureImage(agentTag, [agentDir], 'agent');
  sh('docker', ['build', '-q', '--build-arg', `BASE=${agentTag}`, '-t', FAKE_TAG, path.join(HERE, 'fake-cli')], { timeout: 20 * 60_000 });
  const real = trySh('docker', ['run', '--rm', '--entrypoint', 'claude', agentTag, '--version']);
  return { tools: id(require(path.join(ROOT, 'lib', 'sandbox', 'workspace.js')).TOOLS_IMAGE), proxy: id(require(path.join(ROOT, 'lib', 'sandbox', 'egress.js')).PROXY_IMAGE),
    agent: id(agentTag), agent_tag: agentTag, agent_cli_version: real, fake_cli: id(FAKE_TAG), fake_cli_tag: FAKE_TAG };
}

/** Dummy credential boundary: bubblewrap NORMAL mode (weaker nesting is not approved) under QB's hardening. */
function isolationProbe(agentTag) {
  const out = { bash_normal_mode_blocks_dummy: false, file_tools_enforced: false,
    file_tools_detail: 'the Read/Edit/Write/Glob/Grep tools run in the CLI process outside the Bash sandbox; their deny rules (incl. symlink-resolved paths) can only be exercised by a model turn, which this approval excludes' };
  const ctx = fs.mkdtempSync(path.join(os.tmpdir(), 'kan113bw-'));
  try {
    fs.writeFileSync(path.join(ctx, 'Dockerfile'), `FROM ${agentTag}\nUSER root\nRUN apt-get update -qq && apt-get install -y -qq --no-install-recommends bubblewrap >/dev/null && rm -rf /var/lib/apt/lists/*\nUSER 10001:10001\n`);
    sh('docker', ['build', '-q', '-t', BWRAP_TAG, ctx], { timeout: 20 * 60_000 });
    const script = 'printf DUMMY-NOT-A-SECRET > /cfg/.credentials.json; chmod 600 /cfg/.credentials.json; '
      + 'bwrap --unshare-all --die-with-parent --ro-bind / / --proc /proc --dev /dev --tmpfs /cfg -- sh -c "cat /cfg/.credentials.json 2>/dev/null || echo BLOCKED" 2>&1; echo "rc=$?"';
    let r; try {
      r = sh('docker', ['run', '--rm', '--user', '10001:10001', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only',
        '--tmpfs', '/tmp', '--tmpfs', '/cfg:rw,size=1m,uid=10001,gid=10001,mode=0700', '--init', '--network', 'none', '--entrypoint', 'sh', BWRAP_TAG, '-c', script]);
    } catch (e) { r = String(e.stdout || '') + String(e.stderr || ''); }
    const leaked = /DUMMY-NOT-A-SECRET/.test(r);
    out.bash_normal_mode_blocks_dummy = !leaked && /BLOCKED/.test(r) && /rc=0/.test(r);
    out.bash_detail = leaked ? 'dummy value readable' : r.split('\n').filter((l) => /bwrap|BLOCKED|rc=/.test(l)).slice(0, 3).join(' | ').slice(0, 300);
  } catch (e) { out.bash_detail = `probe could not run: ${String(e.message).slice(0, 200)}`; }
  finally { fs.rmSync(ctx, { recursive: true, force: true }); trySh('docker', ['image', 'rm', '-f', BWRAP_TAG]); }
  return out;
}

async function crashCase() {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--crash-child'], { env: { ...process.env, QB_SANDBOX_AGENT_IMAGE: FAKE_TAG }, stdio: 'ignore' });
  const t0 = Date.now(); let started = false;
  while (Date.now() - t0 < 300_000) {
    if ((trySh('docker', ['ps', '-q', '--filter', 'label=qb.role=workload']) || '').length) { started = true; break; }
    await new Promise((r) => setTimeout(r, 1000));
  }
  child.kill('SIGKILL');
  const w = await waitClean(120_000);
  return { agent_started_before_kill: started, ...w };
}

async function main() {
  if (process.argv.includes('--crash-child')) { await pipelineRun({ briefing: 'FAKE_SLEEP=600\n' }); return; }
  const outPath = process.argv[process.argv.indexOf('--out') + 1];
  const report = { kan: 'KAN-113', review: '10596', commit: trySh('git', ['-C', ROOT, 'rev-parse', 'HEAD']), at: new Date().toISOString(),
    model_calls: 0, credentials_used: 'none', host: measure(), images: {}, admission: null, pipeline: null, cleanup: {}, cleanup_detail: {}, isolation: {} };
  const save = () => { report.evaluation = evaluateHost(report); fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n'); };
  const stopIfBlocked = () => { const e = evaluateHost(report); return e.first_blocker && !['images', 'pipeline', 'cleanup', 'isolation'].includes(e.first_blocker.gate) ? e : null; };
  save();
  try {
    report.images = await buildImages();
    process.env.QB_SANDBOX_AGENT_IMAGE = FAKE_TAG;
    report.host.disk_free_bytes_after = report.host.disk_free_bytes_docker = (measure().disk_free_bytes_docker);
    const A = require(path.join(ROOT, 'lib', 'sandbox', 'admission.js'));
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kan113adm-')); const a = A.admit(d, { runId: 'kan113-qualify' });
    report.admission = { ok: a.ok, reason: a.reason || null, memory_checked: a.memory_checked, peak_bytes: a.peak, mem_available_bytes: a.mem_available };
    if (a.release) a.release(); fs.rmSync(d, { recursive: true, force: true });
    save(); if (stopIfBlocked()) return;

    const p = await pipelineRun();
    const w = await waitClean();
    report.pipeline = { ...p, fake_change_captured: p.changes.includes('QB_FAKE_AGENT_CHANGE.txt'), leftovers_removed: w.clean };
    report.cleanup.normal = w.clean; report.cleanup_detail.normal = w; save();

    const P = require(path.join(ROOT, 'lib', 'sandbox', 'agent-profile.js'));
    const { runAgentSandboxed } = require(path.join(ROOT, 'agent', 'runner.js'));
    const refused = await runAgentSandboxed('qualification', fixtureRepo().dir, { agentProfile: { ...P.profileFromConfig(P.loadReviewed()) } });
    const wr = await waitClean(10_000);
    report.cleanup.refusal = refused.pilot_outcome === 'preflight_refused' && refused.sandbox === null && wr.clean;
    report.cleanup_detail.refusal = { pilot_outcome: refused.pilot_outcome, error: refused.error, ...wr }; save();

    const t = await pipelineRun({ briefing: 'FAKE_SLEEP=600\n', agentMs: 20_000 }); const wt = await waitClean();
    report.cleanup.timeout = t.status === 'timeout' && wt.clean; report.cleanup_detail.timeout = { status: t.status, reason: t.reason, ...wt }; save();

    const ac = new AbortController(); const timer = setTimeout(() => ac.abort(new Error('qualification cancel')), 45_000);
    const c = await pipelineRun({ briefing: 'FAKE_SLEEP=600\n', signal: ac.signal }); clearTimeout(timer); const wc = await waitClean();
    report.cleanup.cancellation = c.status === 'cancelled' && wc.clean; report.cleanup_detail.cancellation = { status: c.status, reason: c.reason, ...wc }; save();

    const k = await crashCase();
    report.cleanup.crash = k.agent_started_before_kill && k.clean; report.cleanup_detail.crash = k; save();

    report.isolation = isolationProbe(report.images.agent_tag);
  } catch (e) {
    report.error = `${e.code || 'error'}: ${String(e.message).slice(0, 500)}`;
  } finally {
    report.host.disk_free_bytes_end = measure().disk_free_bytes_docker; save();
    const ev = report.evaluation;
    console.log(ev.passed ? 'HOST QUALIFIED' : `BLOCKED at ${ev.first_blocker.gate}: ${ev.first_blocker.problems.join('; ')}`);
    for (const g of ev.gates) console.log(`  ${g.gate}: ${g.status}`);
  }
}
main().catch((e) => { console.error(e.message); process.exit(1); });
