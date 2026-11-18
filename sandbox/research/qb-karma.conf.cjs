// QB research-only Karma config wrapper (KAN-114 10720, U2). Mounted READ-ONLY from the QB checkout, outside the task
// workspace. It runs the repository's own karma config, then forces QB's settings on top:
//   - browser: QBChromeHeadless = karma-chrome-launcher ChromeHeadless + QB's fixed flags; the Chromium sandbox stays
//     ON (the repo's own launchers, e.g. one with --no-sandbox, are dropped); only the named, separately approved
//     exception may add --no-sandbox, and the host refuses it unless approved
//   - reporter: QB's own (qb-karma-reporter.cjs, also read-only), writing to a QB-chosen path with a per-run nonce
//   - single run, no watch, loopback only, no Sauce Labs, no coverage reporter
// Inputs (env, set by QB): QB_KARMA_REPO_CONF, QB_KARMA_OUT, QB_KARMA_NONCE, QB_KARMA_VERSION, QB_KARMA_FLAGS (JSON),
// optional QB_KARMA_SANDBOX_EXCEPTION.
'use strict';
const path = require('path');

const BASE_FLAGS = ["--disable-gpu","--disable-dev-shm-usage"];
const EXCEPTION_ID = 'E1-chromium-no-sandbox-in-hardened-container';

function flagsFromEnv() {
  let flags;
  try { flags = JSON.parse(process.env.QB_KARMA_FLAGS || 'null'); } catch { flags = null; }
  if (!Array.isArray(flags)) throw new Error('qb-karma: flag list missing');
  const allowed = new Set(BASE_FLAGS);
  if (process.env.QB_KARMA_SANDBOX_EXCEPTION === EXCEPTION_ID) allowed.add('--no-sandbox');
  for (const f of flags) if (!allowed.has(f)) throw new Error(`qb-karma: flag ${f} is not allowed`);
  for (const f of BASE_FLAGS) if (!flags.includes(f)) throw new Error(`qb-karma: flag ${f} is required`);
  return flags;
}

module.exports = function qbKarmaConfig(config) {
  const flags = flagsFromEnv();
  const repoConf = process.env.QB_KARMA_REPO_CONF;
  if (!repoConf || !path.isAbsolute(repoConf)) throw new Error('qb-karma: QB_KARMA_REPO_CONF must be absolute');
  require(repoConf)(config);
  const reporter = require(path.join(__dirname, 'qb-karma-reporter.cjs'));
  const plugins = Array.isArray(config.plugins) && config.plugins.length ? config.plugins.filter((p) => typeof p === 'string') : ['karma-*'];
  if (!plugins.includes('karma-*')) plugins.push('karma-*');
  config.set({
    browsers: ['QBChromeHeadless'],
    customLaunchers: { QBChromeHeadless: { base: 'ChromeHeadless', flags: [...flags] } },
    reporters: ['qb'],
    plugins: [...plugins, reporter],
    qbReporter: { outPath: process.env.QB_KARMA_OUT, nonce: process.env.QB_KARMA_NONCE, karmaVersion: process.env.QB_KARMA_VERSION },
    singleRun: true,
    autoWatch: false,
    listenAddress: '127.0.0.1',
    hostname: '127.0.0.1',
    sauceLabs: undefined,
    coverageReporter: undefined,
    concurrency: 1,
  });
};
