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
    const r = await runSandboxed({ repoPath: repo.dir, briefing, stateDir, noCredentials: true, qualificationOnly: true, requireMemoryCheck: true,
      agentArgs: P.buildAgentArgs(profile), agentStdoutMaxBytes: P.AGENT_STDOUT_MAX_BYTES,
      ...(agentMs ? { deadlines: { agent: agentMs } } : {}), ...(signal ? { signal } : {}) });
    const c = r.agent_stdout != null ? P.classifyAttempt({ stdout: r.agent_stdout, dropped: r.agent_stdout_dropped || 0,
      sandboxState: r.sandbox && r.sandbox.stages && r.sandbox.stages.agent ? r.sandbox.stages.agent.state : 'completed' }, profile, { allowSynthetic: true }) : null;
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
    file_tools_detail: 'not run' };
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
  try { out.container_diagnostics_bwrap_image = containerDiagnostics(BWRAP_TAG, { bwrap: true }); } catch {}
  finally { fs.rmSync(ctx, { recursive: true, force: true }); trySh('docker', ['image', 'rm', '-f', BWRAP_TAG]); }
  return out;
}

/** 10600 §1: read-only userns diagnostics, plus kernel-log lines (AppArmor/seccomp) emitted during the bwrap probe. */
function usernsDiagnostics(sinceIso) {
  const out = {};
  for (const l of (trySh('sh', [path.join(HERE, 'userns-diag.sh')]) || '').split('\n')) { const i = l.indexOf('='); if (i > 0) out[l.slice(0, i)] = l.slice(i + 1); }
  const j = trySh('sudo', ['-n', 'journalctl', '-k', '--since', sinceIso, '--no-pager', '-o', 'short-iso']);
  const dm = j === null ? trySh('sudo', ['-n', 'dmesg']) : null;
  const log = j !== null ? j : (dm || '');
  out.kernel_log_read = j !== null ? 'journalctl' : dm !== null ? 'dmesg' : 'failed';
  out.kernel_log_lines = log ? log.split('\n').length : 0;
  out.kernel_log_apparmor_userns_denials = log.split('\n').filter((l) => /apparmor="DENIED"/.test(l) && /userns/.test(l)).map((l) => l.replace(/\s+/g, ' ').slice(0, 300)).slice(0, 5);
  out.kernel_log_seccomp_lines = log.split('\n').filter((l) => /seccomp|type=1326/i.test(l)).map((l) => l.slice(0, 300)).slice(0, 5);
  return out;
}

/** 10604 §1: read-only, inside QB's hardened container (exact flags, nothing relaxed): LSM/seccomp/caps and namespace errno. */
function containerDiagnostics(image, { bwrap = false } = {}) {
  const script = 'grep -E "^(Seccomp|Seccomp_filters|NoNewPrivs|CapEff|CapBnd|CapPrm):" /proc/self/status; '
    + 'printf "apparmor_profile="; cat /proc/self/attr/current 2>/dev/null || echo unavailable; '
    + 'printf "unshare_user="; unshare -U true 2>&1 && echo ok; echo "unshare_rc=$?"; '
    + (bwrap ? 'printf "bwrap_unshare_user="; bwrap --unshare-user --ro-bind / / true 2>&1 && echo ok; echo "bwrap_rc=$?"; ' : '');
  let r; try {
    r = sh('docker', ['run', '--rm', '--user', '10001:10001', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only', '--tmpfs', '/tmp', '--init', '--network', 'none',
      '--entrypoint', 'sh', image, '-c', script]);
  } catch (e) { r = String(e.stdout || '') + String(e.stderr || ''); }
  const out = {};
  for (const l of r.split('\n')) { const m = l.match(/^([A-Za-z_]+)[:=]\s*(.*)$/); if (m) out[m[1]] = m[2].slice(0, 300); }
  return out;
}

/** 10604 §5: what went into the agent image, so same-tag Id drift can be explained and pinned. */
function buildInputs(agentTag) {
  const base = trySh('docker', ['image', 'inspect', '-f', '{{json .RepoDigests}}', 'node:24-bookworm-slim']);
  const inImage = (cmd) => trySh('docker', ['run', '--rm', '--network', 'none', '--entrypoint', 'sh', agentTag, '-c', cmd]);
  const dpkg = inImage("dpkg-query -W -f '${Package}=${Version}\\n' | sort");
  const npm = inImage('npm ls -g --depth=0 --json 2>/dev/null');
  const crypto = require('node:crypto'); const h = (x) => (x ? crypto.createHash('sha256').update(x).digest('hex') : null);
  return { base_image_ref: 'node:24-bookworm-slim (floating tag in sandbox/agent/Dockerfile)', base_repo_digests: base ? JSON.parse(base) : null,
    dpkg_packages: dpkg ? dpkg.split('\n').length : null, dpkg_list_sha256: h(dpkg), apt_selected: dpkg ? dpkg.split('\n').filter((l) => /^(socat|git|ca-certificates|curl)=/.test(l)) : null,
    npm_global: npm ? Object.fromEntries(Object.entries(JSON.parse(npm).dependencies || {}).map(([k, v]) => [k, v.version])) : null,
    created: trySh('docker', ['image', 'inspect', '-f', '{{.Created}}', agentTag]), layers: (trySh('docker', ['image', 'inspect', '-f', '{{json .RootFS.Layers}}', agentTag]) || 'null') };
}

/** 10600 §3/§4: the CLI's own tool host (`claude mcp serve`), no model, no network, dummy file + symlinks. */
function toolProbe(agentTag, variant, { settingsName = variant, extraEnv = [] } = {}) {
  const settings = path.join(HERE, 'probe', `settings-${settingsName}.json`);
  const env = [...extraEnv, 'HOME=/tmp/home', 'CLAUDE_CONFIG_DIR=/cfg', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1', 'DISABLE_AUTOUPDATER=1', 'DISABLE_TELEMETRY=1', 'DISABLE_ERROR_REPORTING=1'];
  let raw; try {
    raw = sh('docker', ['run', '--rm', '--user', '10001:10001', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only', '--init', '--network', 'none',
      '--tmpfs', '/tmp', '--tmpfs', '/tmp/home:rw,size=64m,uid=10001,gid=10001,mode=0700', '--tmpfs', '/cfg:rw,size=1m,uid=10001,gid=10001,mode=0700',
      '--tmpfs', '/work:rw,size=16m,uid=10001,gid=10001', ...env.flatMap((e) => ['-e', e]),
      '-v', `${path.join(HERE, 'probe')}:/probe:ro`, '-v', `${settings}:/etc/claude-code/managed-settings.json:ro`,
      '--entrypoint', 'node', agentTag, '/probe/tool-probe.mjs'], { timeout: 180_000 });
  } catch (e) { raw = String(e.stdout || ''); if (!raw) return { variant, error: String(e.stderr || e.message).slice(-400) }; }
  try { return { variant, ...JSON.parse(raw.split('\n').filter(Boolean).pop()) }; } catch { return { variant, error: 'unparseable probe output' }; }
}

function tapTotals(file) {
  if (!fs.existsSync(file)) return null; const t = fs.readFileSync(file, 'utf8'); const g = (k) => { const m = t.match(new RegExp(`^# ${k} (\\d+)$`, 'm')); return m ? Number(m[1]) : null; };
  return { tests: g('tests'), pass: g('pass'), fail: g('fail'), skipped: g('skipped'), todo: g('todo'), cancelled: g('cancelled') };
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

    const since = new Date(Date.now() - 1000).toISOString().replace('T', ' ').slice(0, 19);
    report.isolation = isolationProbe(report.images.agent_tag);
    report.isolation.userns_diagnostics = usernsDiagnostics(since);
    report.isolation.container_diagnostics = { agent: containerDiagnostics(report.images.agent_tag) };
    report.images.build_inputs = buildInputs(report.images.agent_tag);
    const fileRules = toolProbe(report.images.agent_tag, 'file-rules');
    const sandboxRequired = toolProbe(report.images.agent_tag, 'sandbox-required');
    // Dummy env token (CLAUDE_CODE_OAUTH_TOKEN is how the official GitHub route passes the token), with and without
    // the CLI's documented subprocess env scrub. No network: the dummy can't be used for anything.
    const DUMMY_ENV = 'CLAUDE_CODE_OAUTH_TOKEN=DUMMY-NOT-A-SECRET-7f3a-env';
    const envNoScrub = toolProbe(report.images.agent_tag, 'env-noscrub', { settingsName: 'file-rules', extraEnv: [DUMMY_ENV] });
    const envScrub = toolProbe(report.images.agent_tag, 'env-scrub', { settingsName: 'file-rules', extraEnv: [DUMMY_ENV, 'CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1'] });
    const bashCase = (r, kind) => { const c = (r.cases || []).find((x) => x.tool === 'Bash' && x.kind === kind); return c ? (c.result || (c.dummy_visible ? 'dummy_visible' : c.is_error ? 'error_or_denied' : 'not_visible')) : 'not_run'; };
    report.isolation.env_token = { no_scrub: bashCase(envNoScrub, 'env-token'), scrub: bashCase(envScrub, 'env-token'), started: { no_scrub: envNoScrub.started, scrub: envScrub.started } };
    report.isolation.bash_unsandboxed_reads = { cat_cred: bashCase(fileRules, 'cat-cred'), cat_symlink: bashCase(fileRules, 'cat-symlink') };
    report.isolation.tool_probe = { file_rules: fileRules, sandbox_required: sandboxRequired, env_noscrub: envNoScrub, env_scrub: envScrub };
    const FILE_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep'];
    const credCases = (fileRules.cases || []).filter((c) => FILE_TOOLS.includes(c.tool) && c.kind !== 'control' && c.kind !== 'work-tree');
    const control = (fileRules.cases || []).find((c) => c.kind === 'control');
    const leaks = credCases.filter((c) => c.result !== 'tool_not_exposed' && (c.dummy_visible || c.dummy_modified || c.new_file_in_cfg));
    const exercised = credCases.filter((c) => c.result !== 'tool_not_exposed');
    report.isolation.file_tools_enforced = Boolean(fileRules.started) && exercised.length > 0 && leaks.length === 0 && Boolean(control && !control.is_error)
      && ['Read', 'Edit', 'Write', 'Glob', 'Grep'].every((t) => exercised.some((c) => c.tool === t));
    report.isolation.file_tools_detail = !fileRules.started ? `tool host did not start: ${fileRules.error || fileRules.stderr_tail || 'unknown'}`
      : leaks.length ? `dummy reachable via: ${leaks.map((c) => `${c.tool}/${c.kind}`).join(', ')}`
      : `no leak in ${exercised.length} cases through the CLI tool host (mcp serve); a regression example, not proof of a complete boundary`;
  } catch (e) {
    report.error = `${e.code || 'error'}: ${String(e.message).slice(0, 500)}`;
  } finally {
    report.host.disk_free_bytes_end = measure().disk_free_bytes_docker; report.unit_tap = tapTotals(path.join(ROOT, 'unit.tap')); save();
    const ev = report.evaluation;
    console.log(ev.passed ? 'HOST QUALIFIED' : `BLOCKED at ${ev.first_blocker.gate}: ${ev.first_blocker.problems.join('; ')}`);
    for (const g of ev.gates) console.log(`  ${g.gate}: ${g.status}`);
    console.log(`report sha256 ${require('node:crypto').createHash('sha256').update(fs.readFileSync(outPath)).digest('hex')}`);
    process.exitCode = ev.passed ? 0 : 2;      // 10600 §5: a blocked qualification is a RED job, never green
  }
}
main().catch((e) => { console.error(e.message); process.exit(1); });
