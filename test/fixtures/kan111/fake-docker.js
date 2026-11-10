#!/usr/bin/env node
// Test-only stand-in for the docker CLI used by bench/public/grader/immutable-offline-v1/grade.mjs.
// Behaviour per run label comes from the JSON scenario in FAKE_DOCKER_SCENARIO. Never used for real grading.
const fs = require('fs');
const sc = JSON.parse(fs.readFileSync(process.env.FAKE_DOCKER_SCENARIO, 'utf8'));
const [cmd, ...rest] = process.argv.slice(2);
const nameArg = (rest.find((a) => /^kan111-/.test(a)) || rest.find((a) => /^kan111-.*:/.test(a)) || '');
const m = /^kan111-(\d+)-(.+)-(\d+)-[a-z0-9]+(?::|$)/.exec(nameArg); const label = m ? m[2] : '';
const pick = (o, d) => (o && (o[label] !== undefined ? o[label] : o.default !== undefined ? o.default : d));
if (sc.fail && sc.fail[cmd] && (sc.fail[cmd] === '*' || sc.fail[cmd] === label)) { process.stderr.write(`fake docker ${cmd} failure`); process.exit(1); }
if (cmd === 'cp') {
  const [src, dst] = rest;
  if (/:\/tmp\/qbx-tested\.txt$/.test(src)) fs.writeFileSync(dst, `${pick(sc.testedHash, 'h-gold')}  ./__tests__/Range.ts\n`);
  else if (/:\/tmp\/qbx-final\.txt$/.test(src)) fs.writeFileSync(dst, `h-base  ./__tests__/Range.ts\n`);
  else if (/:\/tmp\/candidate\.diff$/.test(src)) fs.writeFileSync(dst, 'diff --git a/x b/x\n');
  process.exit(0);
}
if (cmd !== 'exec') process.exit(0); // pull, create, start, rm, image inspect
const sh = rest[rest.length - 1];
if (sh === 'git rev-parse HEAD') { process.stdout.write(process.env.FAKE_BASE || 'base'); process.exit(0); }
if (/^test "\$\(git rev-parse HEAD\)"/.test(sh)) process.exit(pick(sc.baseCheck, 0));
if (/^git apply --check --reverse/.test(sh)) process.exit(1);
if (/^(git apply|patch )/.test(sh)) process.exit(pick(sc.apply, 0));
if (/^grep -c /.test(sh)) { process.stdout.write(String(pick(sc.markerBefore, 1))); process.exit(0); }
if (/qbx-boundary\.sh final/.test(sh)) { process.stdout.write('QBX_FINAL_SHA256=f\n'); process.exit(0); }
if (rest.includes('/grade-wrapper.sh')) {
  const sleep = pick(sc.evalSleep, 0); if (sleep) { const end = Date.now() + sleep * 1000; while (Date.now() < end) { /* busy wait so a SIGKILL is the only way out */ } }
  const ec = pick(sc.evalExit, label === 'empty' ? 1 : 0);
  process.stdout.write(`QBX_ENV_BEGIN\nCI=<unset>\nQBX_ENV_END\n${ec === 97 ? '>>>>> QBX Build Failed\n' : `QBX_TESTED_MARKER_COUNT=${pick(sc.markerTested, 0)}\n>>>>> Start Test Output\nok\n>>>>> End Test Output\n`}QBX_EVAL_EXIT=${ec}\n`);
  process.exit(ec);
}
process.exit(0); // checkout/clean, printf, git diff > file, diff hashing
