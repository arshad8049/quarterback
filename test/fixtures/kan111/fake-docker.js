#!/usr/bin/env node
// Test-only stand-in for the docker CLI used by bench/public/grader/immutable-offline-v1/grade.mjs.
// Behaviour per run label comes from the JSON scenario in FAKE_DOCKER_SCENARIO. Never used for real grading.
// Every call is appended to FAKE_DOCKER_CALLS (if set) so tests can prove the fake, not real docker, was used.
const fs = require('fs');
const crypto = require('crypto');
const sc = JSON.parse(fs.readFileSync(process.env.FAKE_DOCKER_SCENARIO, 'utf8'));
// Defaults model a correct grader: conflicting and 0-byte patches are rejected; the timeout fixture runs long.
if (!sc.apply) sc.apply = { 'iso-patch-conflict': 1, 'iso-empty-patch-file': 1, default: 0 };
if (!sc.evalSleep) sc.evalSleep = { 'iso-timeout-fixture': 5, default: 0 };
const [cmd, ...rest] = process.argv.slice(2);
if (process.env.FAKE_DOCKER_CALLS) fs.appendFileSync(process.env.FAKE_DOCKER_CALLS, `${cmd}\n`);
const nameArg = (rest.find((a) => /^kan111-/.test(a)) || '');
const m = /^kan111-(\d+)-(.+)-(\d+)-[a-z0-9]+(?::|$)/.exec(nameArg); const label = m ? m[2] : '';
const pick = (o, d) => (!o ? d : o[label] !== undefined ? o[label] : o.default !== undefined ? o.default : d);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const H = (s) => sha(s);
// Tested manifest: entries for the official test file(s) unless the scenario removes them.
const testedManifest = () => {
  if (pick(sc.manifestMissing, false)) return `${H('src')}  ./src/Immutable.js\n`;
  let m = `${H(pick(sc.testedHash, 'gold'))}  ./__tests__/Range.ts\n${H('src')}  ./src/Immutable.js\n`;
  if (pick(sc.manifestMalformed, false)) m += 'not a manifest line\n';
  if (pick(sc.manifestDuplicate, false)) m += `${H('dup')}  ./src/Immutable.js\n`;
  return m;
};
if (sc.fail && sc.fail[cmd] && (sc.fail[cmd] === '*' || sc.fail[cmd] === label)) { process.stderr.write(`fake docker ${cmd} failure`); process.exit(1); }
if (cmd === 'cp') {
  const [src, dst] = rest;
  if (/:\/tmp\/qbx-tested\.txt$/.test(src)) fs.writeFileSync(dst, pick(sc.manifestCorrupt, false) ? testedManifest().slice(0, 20) : testedManifest());
  else if (/:\/tmp\/qbx-final\.txt$/.test(src)) fs.writeFileSync(dst, `${H('base')}  ./__tests__/Range.ts\n`);
  else if (/:\/tmp\/candidate\.diff$/.test(src)) fs.writeFileSync(dst, 'diff --git a/x b/x\n');
  process.exit(0);
}
if (cmd !== 'exec') process.exit(0); // pull, create, start, rm
const sh = rest[rest.length - 1];
const nm = (when) => H(when === 'tested' && pick(sc.nodeModulesChanged, false) ? 'nm-changed' : 'nm');
if (sh === 'git rev-parse HEAD') { process.stdout.write(process.env.FAKE_BASE || 'base'); process.exit(0); }
if (/^test "\$\(git rev-parse HEAD\)"/.test(sh)) process.exit(pick(sc.baseCheck, 0));
if (/^git apply --check --reverse/.test(sh)) { process.stderr.write('error: patch does not apply'); process.exit(1); }
if (/^(git apply|patch )/.test(sh)) { const code = pick(sc.apply, 0); if (code) process.stderr.write('error: patch failed'); process.exit(code); }
if (/^grep -c /.test(sh)) { process.stdout.write(String(pick(sc.markerBefore, 1))); process.exit(0); }
if (/qbx-boundary\.sh start/.test(sh)) { process.stdout.write(`QBX_START_SHA256=${H('start')}\nQBX_START_FILES=2\nQBX_START_MARKER_COUNT=0\nQBX_START_NODE_MODULES_SHA256=${nm('start')}\n`); process.exit(0); }
if (/qbx-boundary\.sh final/.test(sh)) { process.stdout.write(`QBX_FINAL_SHA256=${H(`${H('base')}  ./__tests__/Range.ts\n`)}\nQBX_FINAL_FILES=1\nQBX_FINAL_MARKER_COUNT=0\nQBX_FINAL_NODE_MODULES_SHA256=${nm('final')}\n`); process.exit(0); }
if (rest.includes('/grade-wrapper.sh')) {
  const sleep = pick(sc.evalSleep, 0); if (sleep) { const end = Date.now() + sleep * 1000; while (Date.now() < end) { /* busy wait so a SIGKILL is the only way out */ } }
  const ec = pick(sc.evalExit, label === 'empty' ? 1 : 0);
  const printed = pick(sc.evalExitPrinted, ec);
  let body;
  if (ec === 97) body = '>>>>> QBX Build Failed\n';
  else if (ec === 98) body = 'QBX boundary helper failed\n';
  else {
    const tm = testedManifest();
    body = `QBX_TESTED_SHA256=${sha(tm)}\nQBX_TESTED_FILES=${tm.trim().split('\n').length + Number(pick(sc.manifestFilesOff, 0))}\nQBX_TESTED_MARKER_COUNT=${pick(sc.markerTested, 0)}\nQBX_TESTED_NODE_MODULES_SHA256=${nm('tested')}\n>>>>> Start Test Output\nok\n>>>>> End Test Output\n`;
  }
  process.stdout.write(`QBX_ENV_BEGIN\nCI=<unset>\nQBX_ENV_END\n${body}QBX_EVAL_EXIT=${printed}\n`);
  process.exit(ec);
}
process.exit(0); // checkout/clean, printf, git diff > file
