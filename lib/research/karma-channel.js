/**
 * lib/research/karma-channel.js — KAN-114 10720 (U2): QB's research-only Karma visible channel.
 *
 * Env record schema qb-kan114-task-env/3 (runner karma). The run is a FIXED argv: karma from the task's own
 * node_modules (exact version pinned by the record, checked against the report), started with QB's config wrapper
 * (sandbox/research/qb-karma.conf.cjs, mounted read-only from the QB checkout, outside the workspace). The wrapper
 * runs the repo's karma config and then forces QB's launcher, QB's reporter, single run, no Sauce Labs, no coverage.
 *
 * Browser sandbox: ON by default. The QB launcher is ChromeHeadless plus BASE_FLAGS only; `--no-sandbox` is refused
 * unless the named exception is separately approved (bench/opus-pilot/u2/approvals.json). Nothing here approves it.
 * Ordinary QB still validates only node-test; this channel is for research callers.
 */
const path = require('path');

const SCHEMA = 'qb-kan114-task-env/3';
const RUNNER = 'karma';
const LAUNCHER = 'QBChromeHeadless';
const BASE_FLAGS = Object.freeze(['--disable-gpu', '--disable-dev-shm-usage']);
const EXCEPTION_ID = 'E1-chromium-no-sandbox-in-hardened-container';
const EXCEPTION_FLAGS = Object.freeze(['--no-sandbox']);
const CHROME_BIN = '/usr/bin/chromium';
const MAX_TIMEOUT_S = 1800;
/** Env the record may set, with the only values allowed. Everything else (CI, RUN_SAUCE_LABS, SAUCE_*, NODE_OPTIONS…) is refused. */
const ENV_ALLOWED = Object.freeze({ COVERAGE: ['false'], BABEL_NO_MODULES: ['true', 'false'], MINIFY: ['true', 'false'], PERFORMANCE: ['true', 'false'] });
const FORBIDDEN_FLAG = /^--(no-sandbox|disable-setuid-sandbox|no-zygote|single-process|disable-web-security|remote-debugging-address|proxy-server|proxy-pac-url|host-resolver-rules|user-data-dir|load-extension|disable-features=.*Sandbox|enable-logging)/;

function approvedException(approvals) {
  const x = approvals && approvals.browser_sandbox_exception;
  return Boolean(x && x.id === EXCEPTION_ID && /^[0-9]+$/.test(String(x.approval_comment_id || '')));
}

/** The launcher flags for a run. Throws unless any exception asked for is the known one AND approved. */
function launcherFlags({ exception = null, approvals = null } = {}) {
  if (!exception) return [...BASE_FLAGS];
  if (exception !== EXCEPTION_ID) throw new Error(`karma launcher: unknown browser sandbox exception ${JSON.stringify(exception)}`);
  if (!approvedException(approvals)) throw new Error(`karma launcher: browser sandbox exception ${EXCEPTION_ID} is not approved`);
  return [...BASE_FLAGS, ...EXCEPTION_FLAGS];
}

/** Problems ([] = ok) with a flag list, given the approvals in force. */
function launcherProblems(flags, approvals) {
  const p = [];
  if (!Array.isArray(flags)) return ['flags must be a list'];
  const allowed = new Set([...BASE_FLAGS, ...(approvedException(approvals) ? EXCEPTION_FLAGS : [])]);
  for (const f of flags) {
    if (!allowed.has(f)) p.push(`flag ${f} is not allowed${FORBIDDEN_FLAG.test(String(f)) ? ' (weakens the browser sandbox or isolation)' : ''}`);
  }
  for (const f of BASE_FLAGS) if (!flags.includes(f)) p.push(`missing base flag ${f}`);
  return p;
}

const relSafe = (p) => typeof p === 'string' && p.length > 0 && !path.isAbsolute(p) && !p.split(/[\\/]/).includes('..');

function validateKarmaEnv(rec) {
  const bad = (m) => { throw new Error(`karma env: ${m}`); };
  if (!rec || rec.schema !== SCHEMA) bad(`schema must be ${SCHEMA}`);
  if (rec.runner !== RUNNER) bad('runner must be karma');
  if (typeof rec.task !== 'string' || !rec.task) bad('task');
  if (!/^\d+\.\d+\.\d+$/.test(rec.karma_version || '')) bad('karma_version must be an exact version (from the lockfile at the base)');
  if (!/^\d+\.\d+\.\d+$/.test(rec.karma_chrome_launcher_version || '')) bad('karma_chrome_launcher_version must be exact');
  if (!relSafe(rec.repo_config) || !/\.c?js$/.test(rec.repo_config)) bad('repo_config must be a relative path inside the repo');
  if (rec.files_grep !== null && rec.files_grep !== undefined && (!relSafe(rec.files_grep) || /\s/.test(rec.files_grep))) bad('files_grep must be a relative glob');
  if (!Number.isInteger(rec.timeout_s) || rec.timeout_s < 1 || rec.timeout_s > MAX_TIMEOUT_S) bad(`timeout_s must be 1..${MAX_TIMEOUT_S}`);
  const env = rec.env || {};
  for (const [k, v] of Object.entries(env)) {
    if (!(k in ENV_ALLOWED)) bad(`env ${k} is not allowed`);
    if (!ENV_ALLOWED[k].includes(v)) bad(`env ${k}=${v} is not allowed`);
  }
  const b = rec.browser || {};
  if (b.launcher !== LAUNCHER) bad(`browser.launcher must be ${LAUNCHER}`);
  if (!(b.sandbox === 'on' || b.sandbox === `exception:${EXCEPTION_ID}`)) bad('browser.sandbox must be "on" (or the named, separately approved exception)');
  return rec;
}

/**
 * The exact invocation inside the agent image (cwd = repoRoot, --network none, node_modules read-only).
 * @returns {{ argv: string[], env: Record<string,string> }}
 */
function karmaInvocation(rec, { nonce, outPath, researchDir, repoRoot, approvals = null }) {
  validateKarmaEnv(rec);
  const exception = rec.browser.sandbox === 'on' ? null : EXCEPTION_ID;
  const flags = launcherFlags({ exception, approvals });
  const argv = ['node', 'node_modules/karma/bin/karma', 'start', `${researchDir}/qb-karma.conf.cjs`, '--single-run', '--no-auto-watch'];
  if (rec.files_grep) argv.push(`--grep=${rec.files_grep}`);
  const env = {
    ...rec.env, CHROME_BIN, QB_KARMA_REPO_CONF: `${repoRoot}/${rec.repo_config}`, QB_KARMA_OUT: outPath, QB_KARMA_NONCE: nonce,
    QB_KARMA_VERSION: rec.karma_version, QB_KARMA_FLAGS: JSON.stringify(flags), ...(exception ? { QB_KARMA_SANDBOX_EXCEPTION: exception } : {}),
  };
  return { argv, env };
}

module.exports = { SCHEMA, RUNNER, LAUNCHER, BASE_FLAGS, EXCEPTION_ID, EXCEPTION_FLAGS, CHROME_BIN, ENV_ALLOWED, launcherFlags, launcherProblems, validateKarmaEnv, karmaInvocation };
