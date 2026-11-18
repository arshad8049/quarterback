/**
 * KAN-44 (supervised customer demo): the demo runs from a hand-written, human-reviewed contract
 * (KAN-106 option A), not from a drafted one. The request is read from the runbook, so the
 * runbook, the contract and the pinned sample cannot drift apart. The file must load through the
 * real --contract-file path as a finalized contract with every check accepted, and QB's real check
 * runner must FAIL the unfixed sample at its pinned base and PASS a correct solution. No model,
 * agent or Docker is involved.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const proc = require('../../lib/proc');
const { loadContractFile } = require('../../intent/contract-file');
const { contractState } = require('../../intent/contract-state');
const { validateChecks } = require('../../verify/checks/registry');
const { policyErrors } = require('../../verify/policy');
const { validateCheckResults } = require('../../verify/checks/results');

const ROOT = path.join(__dirname, '..', '..');
const FILE = path.join(ROOT, 'docs', 'demo', 'velora-duration-contract.json');
const RUNBOOK = fs.readFileSync(path.join(ROOT, 'docs', 'demo', 'velora-demo-runbook.md'), 'utf8');
const REQUEST = RUNBOOK.match(/^qb '([^']+)' --repo velora-sample --agent claude-code --contract-file velora-duration-contract\.json/m)[1];
const BUNDLE = path.join(ROOT, 'landing_page', 'evidence', '2026-10-15-hero-run', 'sample-repo.bundle');
const BASE = '14fcfe4efa8f965ae2fb08b44fe0ef2a3869cf50';
const RUNNER = path.join(ROOT, 'sandbox', 'agent', 'qb-check-runner.mjs');

const CORRECT = `'use strict';
function formatDuration(ms) {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  if (minutes === 0) return \`\${seconds}s\`;
  return \`\${minutes}m \${seconds}s\`;
}
module.exports = { formatDuration };
`;

/** A checkout of the pinned sample base, optionally with src/duration.js replaced. */
function sample(impl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kan44-demo-'));
  const repo = path.join(dir, 'repo');
  const r = proc.run('git', ['clone', '-q', BUNDLE, repo], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(proc.run('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(), BASE);
  if (impl) fs.writeFileSync(path.join(repo, 'src', 'duration.js'), impl);
  return { dir, repo };
}

function runChecks(impl, checks) {
  const { dir, repo } = sample(impl);
  try {
    const out = path.join(dir, 'out.json');
    const r = proc.run(process.execPath, [RUNNER], { input: JSON.stringify({ root: repo, checks }), encoding: 'utf8', env: { ...process.env, QB_CHECK_RESULTS: out }, timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    const v = validateCheckResults(fs.readFileSync(out, 'utf8'), checks);
    assert.equal(v.ok, true);
    return Object.fromEntries(v.results.map((x) => [x.id, x.status]));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

describe('KAN-44: the Velora demo contract', () => {
  const { contract } = loadContractFile(FILE, REQUEST);

  test('the runbook request and the contract load as a finalized contract with every check accepted', () => {
    assert.equal(contractState(contract).state, 'finalized', JSON.stringify(contractState(contract)));
    const v = validateChecks(contract.checks, contract.acceptance_criteria);
    assert.deepEqual(v.rejected, []);
    assert.equal(v.accepted.length, 7);
    assert.deepEqual(policyErrors(contract), []);
  });

  test('a request with untraced extra text is not accepted for this contract', () => {
    const { contract: c } = loadContractFile(FILE, `${REQUEST} Also add hours.`);
    assert.equal(contractState(c).state, 'invalid');
  });

  test('the unfixed sample at its pinned base fails exactly the under-a-minute checks', () => {
    const r = runChecks(null, contract.checks);
    assert.deepEqual(Object.keys(r).filter((k) => r[k] !== 'pass').sort(), ['CHK-0S', 'CHK-1S', 'CHK-30S']);
  });

  test('a correct solution passes every check', () => {
    const r = runChecks(CORRECT, contract.checks);
    assert.deepEqual(Object.values(r).filter((s) => s !== 'pass'), []);
  });

  for (const [label, impl, failing] of [
    ['seconds only everywhere', "'use strict';\nmodule.exports = { formatDuration: (ms) => `${Math.floor(ms / 1000)}s` };\n", 'CHK-1M30S'],
    ['zero still shown as minutes', "'use strict';\nmodule.exports = { formatDuration: (ms) => { const m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000); return m === 0 && s > 0 ? `${s}s` : `${m}m ${s}s`; } };\n", 'CHK-0S'],
  ]) {
    test(`a wrong solution (${label}) fails ${failing}`, () => assert.equal(runChecks(impl, contract.checks)[failing], 'fail'));
  }
});
