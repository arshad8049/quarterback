// QB research-only Mocha reporter (KAN-117 review 10620). Format "qb-mocha-events/1", one JSON object per line,
// appended synchronously so a run that dies part-way leaves a visibly incomplete file (no qb:end):
//
//   {"type":"qb:start","format":"qb-mocha-events/1","nonce","mocha_version","started_at"}
//   {"type":"suite","file"}                                    a file's root-level suite was entered (discovery = execution)
//   {"type":"test","file","full_title","title","state":"passed"|"failed"|"pending","error_kind"?,"error_code"?}
//   {"type":"hook_fail","file","full_title","title","error_kind","error_code"}   a before/after hook failed
// v2 (review 10623): a failure carries only a coarse error KIND and the error's code, never its message text.
//   {"type":"qb:end","stats":{suites,tests,passes,pending,failures},"ended_at"}   Mocha's own runner stats
//
// It is bind-mounted READ-ONLY into the verification container by lib/research/verify-stage.js (the agent image is
// unchanged); the output path and the nonce are fresh per run (--reporter-option output=...,nonce=...). verify/mocha-report.js
// accepts the file only if it is complete, current, consistent with Mocha's stats and the exit code, and covers exactly
// the explicit file set. Like QB's node:test reporter it runs in the same process as the tests, so test code that
// deliberately forges the whole file is not prevented by the reporter itself (see the validator's notes).
'use strict';
const fs = require('fs');

class QbMochaReporter {
  constructor(runner, options) {
    const o = (options && (options.reporterOptions || options.reporterOption)) || {};
    const out = o.output;
    if (typeof out !== 'string' || !out.startsWith('/')) throw new Error('qb-mocha-reporter: reporter option output=<absolute path> is required');
    const w = (obj) => fs.appendFileSync(out, `${JSON.stringify(obj)}\n`);
    const file = (t) => (t && typeof t.file === 'string' ? t.file : null);
    const title = (t) => (t && typeof t.fullTitle === 'function' ? String(t.fullTitle()) : String((t && t.title) || ''));
    const leaf = (t) => String((t && t.title) || '');
    const code = (e) => (e && typeof e.code === 'string' && /^[A-Z0-9_]{2,40}$/.test(e.code) ? e.code : null);
    const kind = (e) => {
      const m = `${(e && e.code) || ''} ${(e && e.message) || ''}`;
      if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|EHOSTUNREACH|ENETUNREACH|getaddrinfo|socket hang up/i.test(m)) return 'network';
      if (/ERR_OSSL|ERR_SSL|EPROTO|certificate|self[- ]signed|digital envelope|unsupported.*(cipher|key)/i.test(m)) return 'tls';
      if (/Timeout of \d+ms exceeded/.test(m)) return 'timeout';
      if (e && (e.name === 'AssertionError' || /^ERR_ASSERTION$/.test(e.code || ''))) return 'assertion';
      if (e && ['TypeError', 'ReferenceError', 'SyntaxError', 'RangeError'].includes(e.name)) return e.name;
      if (/ERR_MODULE_NOT_FOUND|Cannot find module|ERR_REQUIRE_ESM|ERR_UNSUPPORTED/i.test(m)) return 'module';
      return 'other';
    };
    runner.on('start', () => w({ type: 'qb:start', format: 'qb-mocha-events/1', nonce: String(o.nonce || ''), mocha_version: String(o.mocha_version || ''), started_at: Date.now() }));
    runner.on('suite', (s) => { if (s && typeof s.file === 'string' && !s.root) w({ type: 'suite', file: s.file }); });
    runner.on('pass', (t) => w({ type: 'test', file: file(t), full_title: title(t), title: leaf(t), state: 'passed' }));
    runner.on('pending', (t) => w({ type: 'test', file: file(t), full_title: title(t), title: leaf(t), state: 'pending' }));
    runner.on('fail', (t, err) => {
      if (t && t.type === 'hook') w({ type: 'hook_fail', file: file(t), full_title: title(t), title: leaf(t), error_kind: kind(err), error_code: code(err) });
      else w({ type: 'test', file: file(t), full_title: title(t), title: leaf(t), state: 'failed', error_kind: kind(err), error_code: code(err) });
    });
    runner.on('end', () => {
      const s = runner.stats || {};
      const n = (k) => (Number.isInteger(s[k]) ? s[k] : null);
      w({ type: 'qb:end', stats: { suites: n('suites'), tests: n('tests'), passes: n('passes'), pending: n('pending'), failures: n('failures') }, ended_at: Date.now() });
    });
  }
}

module.exports = QbMochaReporter;
