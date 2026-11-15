// QB research-only Mocha reporter (KAN-117 review 10620). Format "qb-mocha-events/1", one JSON object per line,
// appended synchronously so a run that dies part-way leaves a visibly incomplete file (no qb:end):
//
//   {"type":"qb:start","format":"qb-mocha-events/1","nonce","mocha_version","started_at"}
//   {"type":"suite","file"}                                    a file's root-level suite was entered (discovery = execution)
//   {"type":"test","file","full_title","state":"passed"|"failed"|"pending"}
//   {"type":"hook_fail","file","full_title"}                   a before/after hook failed (tests may not have run)
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
    runner.on('start', () => w({ type: 'qb:start', format: 'qb-mocha-events/1', nonce: String(o.nonce || ''), mocha_version: String(o.mocha_version || ''), started_at: Date.now() }));
    runner.on('suite', (s) => { if (s && typeof s.file === 'string' && !s.root) w({ type: 'suite', file: s.file }); });
    runner.on('pass', (t) => w({ type: 'test', file: file(t), full_title: title(t), state: 'passed' }));
    runner.on('pending', (t) => w({ type: 'test', file: file(t), full_title: title(t), state: 'pending' }));
    runner.on('fail', (t) => {
      if (t && t.type === 'hook') w({ type: 'hook_fail', file: file(t), full_title: title(t) });
      else w({ type: 'test', file: file(t), full_title: title(t), state: 'failed' });
    });
    runner.on('end', () => {
      const s = runner.stats || {};
      const n = (k) => (Number.isInteger(s[k]) ? s[k] : null);
      w({ type: 'qb:end', stats: { suites: n('suites'), tests: n('tests'), passes: n('passes'), pending: n('pending'), failures: n('failures') }, ended_at: Date.now() });
    });
  }
}

module.exports = QbMochaReporter;
