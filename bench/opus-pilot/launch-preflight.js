// KAN-114 10697: offline preflight for the ONE v8 axios-5892 engineering pair's launch route. No network, no token.
//   promote: fast-forward the authorized launch branch (kan117-axios-mocha) to the reviewed v8 commit. The push must not
//            touch the request file, so it cannot queue a live run; the live workflow may only be the frozen one.
//   launch:  after the senior's go-ahead, ONE commit changing only the request file (mode=pair, citing the approval).
// CLI: node bench/opus-pilot/launch-preflight.js --stage=promote|launch --from=<sha> [--to=HEAD]
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const REQ = 'bench/opus-pilot/mocha/pair-live-request.txt';
const LIVE_WF = '.github/workflows/pair-5892-live.yml';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function promoteProblems({ fastForward, changed, workflowMatchesFreeze = true }) {
  const p = [];
  if (!fastForward) p.push('not a fast-forward of the launch branch (never force or rewrite it)');
  if (!changed || !changed.length) p.push('nothing to promote');
  if ((changed || []).includes(REQ)) p.push('the promote push touches the request file and would queue a live run');
  if ((changed || []).includes(LIVE_WF) && !workflowMatchesFreeze) p.push('the live workflow differs from the frozen v8 one');
  return p;
}

function launchProblems({ changed, request }) {
  const p = [];
  if (!(changed && changed.length === 1 && changed[0] === REQ)) p.push('the launch commit must change only the request file');
  const lines = String(request || '').split('\n');
  if (lines[0].trim() !== 'mode=pair') p.push('the request file first line must be mode=pair');
  if (!/\b1\d{4}\b/.test(lines.slice(1).join(' '))) p.push('the request comment must cite the senior approval comment id');
  return p;
}

function freezeCheck(root) {
  const M = (f) => JSON.parse(fs.readFileSync(path.join(root, 'bench/opus-pilot/mocha', f), 'utf8'));
  const v8 = M('pair-5892-freeze-v8.json'); const v7 = M('pair-5892-freeze-v7.json');
  const drift = Object.entries(v8.files).filter(([f, h]) => !fs.existsSync(path.join(root, f)) || sha(fs.readFileSync(path.join(root, f))) !== h).map(([f]) => f);
  const driver = fs.readFileSync(path.join(root, 'bench/opus-pilot/pair.mjs'), 'utf8');
  const same = (k) => JSON.stringify(v7[k]) === JSON.stringify(v8[k]);
  return {
    version: v8.version, files: Object.keys(v8.files).length, drift,
    driver_uses_v8: /pair-5892-freeze-v8\.json/.test(driver),
    live_workflow_frozen: Object.prototype.hasOwnProperty.call(v8.files, LIVE_WF) && !drift.includes(LIVE_WF),
    same_as_v7: { shared: same('shared'), arm_a: same('arm_a'), arm_b: same('arm_b') },
    base_commit: v8.shared.base_commit, images: v8.shared.images, model: v8.shared.model, cli: v8.shared.claude_code_version,
  };
}

function git(root, args) { return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim(); }

if (require.main === module) {
  const root = path.join(__dirname, '..', '..');
  const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
  const stage = arg('stage'); const from = arg('from'); const to = arg('to', 'HEAD');
  if (!['promote', 'launch'].includes(stage) || !from) { console.error('usage: --stage=promote|launch --from=<sha> [--to=HEAD]'); process.exit(2); }
  const changed = git(root, ['diff', '--name-only', `${from}..${to}`]).split('\n').filter(Boolean);
  let fastForward = true; try { git(root, ['merge-base', '--is-ancestor', from, to]); } catch { fastForward = false; }
  const f = freezeCheck(root);
  const problems = f.drift.length ? [`freeze v8 drift: ${f.drift.join(', ')}`] : [];
  if (!f.driver_uses_v8) problems.push('the driver does not use freeze v8');
  if (stage === 'promote') problems.push(...promoteProblems({ fastForward, changed, workflowMatchesFreeze: f.live_workflow_frozen }));
  else problems.push(...launchProblems({ changed, request: git(root, ['show', `${to}:${REQ}`]) }));
  const out = { stage, from: git(root, ['rev-parse', from]), to: git(root, ['rev-parse', to]), fast_forward: fastForward, changed_files: changed.length,
    touches_request_file: changed.includes(REQ), freeze: { version: f.version, files: f.files, drift: f.drift.length, driver_uses_v8: f.driver_uses_v8,
      live_workflow_frozen: f.live_workflow_frozen, same_as_v7: f.same_as_v7 }, ok: problems.length === 0, problems };
  console.log(JSON.stringify(out, null, 1));
  process.exit(problems.length ? 1 : 0);
}

module.exports = { REQ, LIVE_WF, promoteProblems, launchProblems, freezeCheck };
