/**
 * lib/research/verify-stage.js — KAN-117 (review 10607): QB's research-only internal verification
 * channel for a reviewed Jest task env (lib/research/dataset-env.js), and (review 10620) a reviewed Mocha task env.
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
const fs = require('fs');
const { validateJestRun } = require('../../verify/jest-report');
const { validateMochaRun } = require('../../verify/mocha-report');

// Review 10620: QB's research Mocha reporter, bind-mounted READ-ONLY from the QB checkout (the agent image is unchanged)
const MOCHA_REPORTER_HOST = path.join(__dirname, '..', '..', 'sandbox', 'research', 'qb-mocha-reporter.cjs');
const MOCHA_REPORTER = '/opt/qb-research/qb-mocha-reporter.cjs';

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
  const rec0 = rec;

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

  async function step(label, argv, extra = {}, mounts = []) {
    const remaining = deadline - now();
    if (remaining <= 0) return { timeout: true };
    const r = await docker.runStage(`${ws.runId}-r-${stepName(label)}`, [
      ...hardened(ws.runId, 'workload'), '--network', 'none', ...mem,
      '-e', 'HOME=/tmp/home', '-e', 'npm_config_update_notifier=false',
      '--tmpfs', '/tmp/home:rw,size=256m,uid=10001,gid=10001,mode=0700',
      ...ws.mount('out'), ...ws.mount('verify'), ...depsMount, ...mounts,
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

  if (env.runner === 'mocha') {
    // review 10620: no discovery step (the explicit file set is the discovery); fixed argv + QB's reporter, fresh
    // unpredictable output path and nonce per run; the report must be current, complete and consistent
    const id = crypto.randomBytes(16).toString('hex');
    const out = `/out/qb-mocha-${id}.ndjson`;
    const nonce = crypto.randomBytes(16).toString('hex');
    const reporter = { source: 'bind-mount (read-only) from the QB checkout; agent image unchanged', path: MOCHA_REPORTER,
      sha256: crypto.createHash('sha256').update(fs.readFileSync(MOCHA_REPORTER_HOST)).digest('hex') };
    const argv = [...env.test_argv, '--reporter', MOCHA_REPORTER, '--reporter-option', `output=${out},nonce=${nonce},mocha_version=${env.mocha_version}`, ...env.test_files];
    const startedAtMs = now();
    const t = await step('test', argv, {}, ['-v', `${MOCHA_REPORTER_HOST}:${MOCHA_REPORTER}:ro`]);
    if (t.timeout) return result('stage_timeout', { failed_step: 'test', probe, reporter });
    if (!['completed', 'execution_error'].includes(t.r.state)) return result('error', { reasons: [`test_${t.r.state}`], failed_step: 'test', probe, reporter });
    const reportText = await docker.readFile(t.r.name || `${ws.runId}-r-test`, out);
    const validation = validateMochaRun({ reportText, exitCode: t.r.exit_code, startedAtMs, nonce, root: '/verify', files: env.test_files,
      mochaVersion: env.mocha_version, baseline: o.baseline || null });
    const isolation_rechecks = await isolationRechecks(validation);
    return result(validation.verdict, { reasons: validation.reasons, probe, validation, report_path: out, reporter, ...(isolation_rechecks ? { isolation_rechecks } : {}) });
  }

  /**
   * KAN-117 10631 option (c): for a FROZEN re-check entry whose test failed in the full suite with its exact signature,
   * ONE isolated re-run (no retry) on a FRESH checkout of the SAME captured tree (checks-prep.sh, byte-identical to
   * refs/qb/candidate; its tree must equal the verified one), protected tests restored (verify-prep.sh on that copy),
   * the same dependencies read-only, exactly the frozen test (--grep on its exact full title, its file only), charged to
   * the shared stage cap. Qualified only if exactly that one test ran, the report is complete and current, and it passed.
   * The full-suite failure is preserved; the adapter labels a qualified test isolation-qualified/advisory.
   */
  async function isolationRechecks(validation) {
    const entries = (env.known_base_failures && env.known_base_failures.isolation_rechecks) || [];
    if (!entries.length || !Array.isArray(validation.failing)) return null;
    const same = (a, b) => JSON.stringify([...(a || [])].sort()) === JSON.stringify([...(b || [])].sort());
    const out = [];
    for (const r of entries) {
      const f = validation.failing.find((x) => x.id === r.id);
      if (!f) continue;
      const rec = (verdict, reasons, extra = {}) => { out.push({ id: r.id, verdict, reasons, ...extra }); };
      const g = r.signature;
      if (!(f.file === r.file && same(f.kinds, g.kinds) && same(f.codes, g.codes) && f.failed_count === g.count)) { rec('not_run', ['signature_mismatch']); continue; }
      const left = () => deadline - now();
      if (left() <= 0) { rec('blocked', ['cap_exhausted']); continue; }
      const t0r = now();
      const p1 = await docker.runStage(`${ws.runId}-r-recheck-prep`, [...hardened(ws.runId, 'checks-prep'), '--network', 'none',
        ...ws.mount('git', true), ...ws.mount('scratch'), ws.image, '/usr/local/lib/qb/checks-prep.sh'], { waitTimeoutMs: left() });
      rec0('recheck-prep', p1);
      let tree = null;
      try { tree = JSON.parse(String(p1.stdout || '').trim().split('\n').pop()).tree; } catch { tree = null; }
      if (p1.state !== 'completed' || !tree) { rec('blocked', ['recheck_prep_failed']); continue; }
      if (!prep || tree !== prep.tree) { rec('blocked', ['tree_mismatch'], { tree }); continue; }
      if (left() <= 0) { rec('blocked', ['cap_exhausted']); continue; }
      const p2 = await docker.runStage(`${ws.runId}-r-recheck-protect`, [...hardened(ws.runId, 'verify-prep'), '--network', 'none',
        '-e', `QB_PROTECTED=${env.protected.join('\n')}`, ...ws.mount('git', true), '-v', `${ws.runId}-scratch:/verify`, ...ws.mount('out'),
        ws.image, '/usr/local/lib/qb/verify-prep.sh'], { waitTimeoutMs: left() });
      rec0('recheck-protect', p2);
      let pp = null;
      try { pp = JSON.parse(await docker.readFile(`${ws.runId}-r-recheck-protect`, '/out/verify-prep.json')); } catch { pp = null; }
      if (p2.state !== 'completed' || !pp || pp.status !== 'ready' || pp.tree !== tree) { rec('blocked', ['recheck_protect_failed']); continue; }
      if (left() <= 0) { rec('blocked', ['cap_exhausted']); continue; }
      const id2 = crypto.randomBytes(16).toString('hex'); const out2 = `/out/qb-mocha-recheck-${id2}.ndjson`; const nonce2 = crypto.randomBytes(16).toString('hex');
      const esc = r.full_title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const argv = [...env.test_argv, '--grep', `^${esc}$`, '--reporter', MOCHA_REPORTER, '--reporter-option', `output=${out2},nonce=${nonce2},mocha_version=${env.mocha_version}`, r.file];
      const started = now();
      const x = await docker.runStage(`${ws.runId}-r-recheck`, [
        ...hardened(ws.runId, 'workload'), '--network', 'none', ...mem,
        '-e', 'HOME=/tmp/home', '-e', 'npm_config_update_notifier=false', '--tmpfs', '/tmp/home:rw,size=256m,uid=10001,gid=10001,mode=0700',
        ...ws.mount('out'), '-v', `${ws.runId}-scratch:/verify`, ...(deps && deps.status === 'ready' ? ['-v', `${ws.runId}-deps:/verify/node_modules:ro`] : []),
        '-v', `${MOCHA_REPORTER_HOST}:${MOCHA_REPORTER}:ro`, '-w', '/verify', '--entrypoint', argv[0], image, ...argv.slice(1),
      ], { waitTimeoutMs: left(), maxBytes: 2 * 1024 * 1024 });
      rec0('recheck', x);
      if (x.state === 'timeout' || now() > deadline) { rec('blocked', ['timeout']); continue; }
      const text = await docker.readFile(x.name || `${ws.runId}-r-recheck`, out2);
      const v2 = validateMochaRun({ reportText: text, exitCode: x.exit_code, startedAtMs: started, nonce: nonce2, root: '/verify', files: [r.file], mochaVersion: env.mocha_version });
      const one = v2.counts && v2.counts.total === 1 && v2.counts.passed === 1 && v2.identities.length === 1 && v2.identities[0].id === r.id;
      if (v2.verdict === 'passed' && one) rec('qualified', [], { tree, counts: v2.counts, duration_ms: now() - t0r });
      else rec('blocked', [...v2.reasons, ...(one ? [] : ['not_exactly_the_frozen_test']), ...(v2.verdict === 'failed' ? ['failed'] : [])], { tree, counts: v2.counts, duration_ms: now() - t0r });
    }
    return out;
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
