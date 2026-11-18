// QB research-only Karma reporter (KAN-114 10720, U2): JSONL, format qb-karma-events/1, validated by
// lib/research/karma-report.js. Mounted READ-ONLY from the QB checkout. The report file is created exclusively
// (an existing file is never appended to), starts with one qb:start line carrying the run nonce and start time,
// and ends with one qb:end line carrying karma's own run totals and exit code. Test names stay on the runner: the
// validator hashes them and only identities/counts leave it.
'use strict';
const fs = require('fs');

const FORMAT = 'qb-karma-events/1';

function QBReporter(baseReporterDecorator, config) {
  if (typeof baseReporterDecorator === 'function') baseReporterDecorator(this);
  const o = (config && config.qbReporter) || {};
  let fd = null;
  const write = (e) => { if (fd !== null) fs.writeSync(fd, `${JSON.stringify(e)}\n`); };
  const spec = (state) => (browser, r) => write({ type: 'test', browser: browser && browser.id, suite: Array.isArray(r.suite) ? r.suite.map(String) : [], description: String(r.description), state });

  this.onRunStart = () => {
    if (!o.outPath) throw new Error('qb-karma-reporter: no output path');
    fd = fs.openSync(o.outPath, 'wx', 0o600);
    write({ type: 'qb:start', format: FORMAT, nonce: o.nonce, started_at: Date.now(), karma_version: o.karmaVersion });
  };
  this.onBrowserStart = (browser) => write({ type: 'browser', id: browser.id, name: String(browser.name) });
  this.specSuccess = spec('passed');
  this.specFailure = spec('failed');
  this.specSkipped = spec('skipped');
  this.onBrowserError = (browser) => write({ type: 'browser_error', id: browser && browser.id });
  this.onBrowserComplete = (browser, result) => {
    const r = result || (browser && browser.lastResult) || {};
    write({ type: 'browser_complete', id: browser && browser.id, success: r.success, failed: r.failed, skipped: r.skipped, error: Boolean(r.error), disconnected: Boolean(r.disconnected) });
  };
  this.onRunComplete = (_browsers, results) => {
    const r = results || {};
    write({ type: 'qb:end', stats: { success: r.success, failed: r.failed, error: Boolean(r.error), disconnected: Boolean(r.disconnected), exit_code: r.exitCode } });
    if (fd !== null) { fs.closeSync(fd); fd = null; }
  };
  // base reporter console output is not used as evidence
  this.adapters = [];
}
QBReporter.$inject = ['baseReporterDecorator', 'config'];

module.exports = { 'reporter:qb': ['type', QBReporter] };
