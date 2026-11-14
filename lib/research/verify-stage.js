/**
 * lib/research/verify-stage.js — KAN-117 (review 10607): QB's research-only internal verification
 * channel for a reviewed Jest task env (lib/research/dataset-env.js).
 *
 * Same sandbox as ⑤ (lib/sandbox/stages.js): every step is its own hardened container (uid 10001,
 * cap-drop ALL, read-only rootfs, network none, no credentials) in the bound QB agent image, on the
 * disposable /verify checkout with read-only node_modules. Differences, all approved in 10607:
 *   - verify-prep restores the env record's protected controls (QB_PROTECTED);
 *   - CI is never set, and no node:test reporter flags (NODE_OPTIONS) are injected;
 *   - probe → pre-test build steps → `jest --listTests` → the Jest run, sharing ONE stage cap
 *     (further bounded by the trial deadline), each failure recorded separately;
 *   - the report goes to a fresh, unpredictable /out path and must postdate this run.
 * Results are visible-suite only. They never include grader material.
 */

const crypto = require('crypto');
const path = require('path');
const { validateJestRun } = require('../../verify/jest-report');

const MAX_REPORT_BYTES = 8 * 1024 * 1024;

function realDocker() {
  const D = require('../sandbox/docker');
  const { readTar } = require('../sandbox/tar');
  return {
    runStage: D.runStage,
    async readFile(container, file) {
      const r = await D.op(['cp', `${container}:${file}`, '-'], { raw: true, maxBytes: MAX_REPORT_BYTES + 64 * 1024 });
      if (!r.ok || !r.stdout_buffer) return null;
      const f = readTar(r.stdout_buffer).get(path.basename(file));
      return f && f.length <= MAX_REPORT_BYTES ? f.toString('utf8') : null;
    },
  };
}

const tail = (s) => String(s || '').slice(-1500);
const stepName = (s) => s.replace(/[^A-Za-z0-9_.-]+/g, '-');

/**
 * @param {object} ws    workspace (runId, mount, image)
 * @param {object} deps  prepareDeps result
 * @param {object} env   validated task env record
 * @param {object} [o]   { memoryBytes, deadlineAtMs, baseline, image, docker, now }
 * @returns {Promise<object>} { status: 'ran'|'not_run', verdict, reasons, failed_step, probe, steps, validation, prep }
 */
async function runResearchVerification(ws, deps, env, o = {}) {
  const { hardened } = require('../sandbox/workspace');
  const docker = o.docker || realDocker();
  const now = o.now || Date.now;
  const image = o.image || require('../sandbox/agent').AGENT_IMAGE;
  const steps = [];
  const rec = (name, r) => { steps.push({ name, state: r.state, exit_code: r.exit_code, duration_ms: r.duration_ms, reason: r.reason || null, stderr_tail: tail(r.stderr) }); return r; };

  // ⑤a trusted prep in the tools image: dependency gate + protected controls restored from the base
  const prepName = `${ws.runId}-verify-prep`;
  const prepStage = await docker.runStage(prepName, [...hardened(ws.runId, 'verify-prep'), '--network', 'none',
    '-e', `QB_PROTECTED=${env.protected.join('\n')}`,
    ...ws.mount('git', true), ...ws.mount('verify'), ...ws.mount('out'), ws.image, '/usr/local/lib/qb/verify-prep.sh'],
  { waitTimeoutMs: 20 * 60_000 });
  rec('verify-prep', prepStage);
  let prep = null;
  try { prep = JSON.parse(await docker.readFile(prepName, '/out/verify-prep.json')); } catch { prep = null; }
  if (prepStage.state !== 'completed' || !prep) return { status: 'not_run', reason: 'verify_prep_failed', steps };
  if (prep.status === 'dependency_change_required') return { status: 'not_run', reason: 'dependency_change_required', prep, steps };

  const t0 = now();
  const deadline = Math.min(t0 + env.internal_stage_cap_ms, Number.isFinite(o.deadlineAtMs) ? o.deadlineAtMs : Infinity);
  const mem = o.memoryBytes ? ['--memory', String(o.memoryBytes), '--memory-swap', String(o.memoryBytes)] : [];
  const depsMount = deps && deps.status === 'ready' ? ['-v', `${ws.runId}-deps:/verify/node_modules:ro`] : [];
  const result = (verdict, extra = {}) => ({ status: 'ran', verdict, reasons: [], prep, steps, stage_ms: now() - t0, ...extra });

  async function step(label, argv, extra = {}) {
    const remaining = deadline - now();
    if (remaining <= 0) return { timeout: true };
    const r = await docker.runStage(`${ws.runId}-r-${stepName(label)}`, [
      ...hardened(ws.runId, 'workload'), '--network', 'none', ...mem,
      '-e', 'HOME=/tmp/home', '-e', 'npm_config_update_notifier=false',
      '--tmpfs', '/tmp/home:rw,size=256m,uid=10001,gid=10001,mode=0700',
      ...ws.mount('out'), ...ws.mount('verify'), ...depsMount,
      '-w', '/verify', '--entrypoint', argv[0], image, ...argv.slice(1),
    ], { waitTimeoutMs: remaining, maxBytes: 2 * 1024 * 1024, ...extra });
    rec(label, r);
    return { r, timeout: r.state === 'timeout' || now() > deadline };
  }

  // probe: runtime identity and source resolution under THIS environment (decision 1)
  const p = await step('probe', env.probe.argv);
  if (p.timeout) return result('stage_timeout', { failed_step: 'probe' });
  if (p.r.state !== 'completed' || p.r.exit_code !== 0) return result('error', { reasons: ['probe_failed'], failed_step: 'probe' });
  let probe = null;
  try { probe = JSON.parse(p.r.stdout); } catch { probe = null; }
  const expect = { ...env.probe.expect, jest: env.jest_version };
  if (!probe || Object.entries(expect).some(([k, v]) => probe[k] !== v)) return result('error', { reasons: ['probe_mismatch'], failed_step: 'probe', probe });

  for (const s of env.pre_steps) {
    const b = await step(s.name, s.argv);
    if (b.timeout) return result('stage_timeout', { failed_step: s.name, probe });
    if (b.r.state !== 'completed' || b.r.exit_code !== 0) return result('build_failed', { failed_step: s.name, probe });
  }

  const l = await step('list', env.list_argv);
  if (l.timeout) return result('stage_timeout', { failed_step: 'list', probe });
  if (l.r.state !== 'completed' || l.r.exit_code !== 0) return result('error', { reasons: ['list_failed'], failed_step: 'list', probe });

  const out = `/out/qb-jest-${crypto.randomBytes(16).toString('hex')}.json`;
  const startedAtMs = now();
  const t = await step('test', [...env.test_argv, `--outputFile=${out}`]);
  if (t.timeout) return result('stage_timeout', { failed_step: 'test', probe });
  if (!['completed', 'execution_error'].includes(t.r.state)) return result('error', { reasons: [`test_${t.r.state}`], failed_step: 'test', probe });
  const reportText = await docker.readFile(t.r.name || `${ws.runId}-r-test`, out);
  const validation = validateJestRun({ reportText, listText: l.r.stdout, exitCode: t.r.exit_code, startedAtMs, root: '/verify', baseline: o.baseline || null });
  return result(validation.verdict, { reasons: validation.reasons, probe, validation, report_path: out });
}

module.exports = { runResearchVerification };
