/**
 * KAN-106 eval v1, POST-RUN scorer correction (found after the 881a51a batch, disclosed on KAN-106): the frozen
 * score.js expected a completed dry run to exit 0, but qb.js exits 0 only when the verdict is `pass`
 * (`process.exit(report?.verdict === 'pass' ? 0 : 1)`), and a dry run's verdict is always `no-diff`. So every
 * completed dry run was rejected as "exit code 1 does not match outcome DRY_RUN".
 *
 * This test goes through the PRODUCER: a real qb.js dry run (Ollama replaced by the preload stub, no model)
 * and a real BLOCKED run, and checks that the scorer's table expects exactly the exit codes qb.js produced.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const store = require('../../run/store');
const { makeRepo } = require('../helpers/tmprepo');
const { EXIT_FOR } = require('../../bench/kan106-eval-v1/score');

const QB = path.join(__dirname, '..', '..', 'qb.js');
const PRELOAD = path.join(__dirname, '..', 'helpers', 'preload-ollama.js');
const CONTRACT = JSON.stringify({
  goal: 'Add a clamp function', required_behavior: ['clamp(n, min, max) returns n bounded to [min, max]'], constraints: [],
  acceptance_criteria: [{ id: 'AC-1', criterion: 'clamp is exported from src/utils.js', requirement_ids: ['R-1'] }],
  requirements: [{ id: 'R-1', quote: 'Add a clamp function to src/utils.js' }],
  verification_plan: ['run tests'], relevant_context: [], ambiguity_flags: [], clarifying_question: null,
});

function realRun(args, reply, files = {}) {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-exit-runs-'));
  const memDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-exit-mem-'));
  const repo = makeRepo({ 'src/utils.js': 'module.exports = {};\n' });
  for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(memDir, f), body);
  args = args.map((a) => a.replace('<MEM>', memDir));
  try {
    const r = spawnSync(process.execPath, ['--require', PRELOAD, QB, 'Add a clamp function to src/utils.js', '--repo', repo.dir, ...args], {
      env: { ...process.env, QB_RUNS_DIR: runsDir, QB_MEMORY_DIR: memDir, QB_TEST_OLLAMA_REPLY: reply, QB_OLLAMA_URL: 'http://127.0.0.1:9' }, encoding: 'utf8', timeout: 60_000 });
    const ids = fs.readdirSync(runsDir);
    assert.equal(ids.length, 1, r.stdout + r.stderr);
    return { status: r.status, outcome: store.loadRun(ids[0], runsDir).manifest.outcome, out: r.stdout + r.stderr };
  } finally { for (const d of [runsDir, memDir]) fs.rmSync(d, { recursive: true, force: true }); repo.cleanup(); }
}

test('a completed qb.js dry run exits 1 (outcome DRY_RUN), and the scorer expects exactly that', () => {
  const r = realRun(['--agent', 'dry-run', '--no-llm-context', '--no-llm-verify'], CONTRACT);
  assert.equal(r.outcome, 'DRY_RUN', r.out);
  assert.equal(r.status, 1);
  assert.equal(EXIT_FOR.DRY_RUN, r.status);
});

test('a BLOCKED qb.js run exits 2, and the scorer expects exactly that', () => {
  const r = realRun(['--agent', 'dry-run', '--no-llm-context', '--no-llm-verify', '--contract-file', '<MEM>/bad-contract.json'], CONTRACT, { 'bad-contract.json': '{"not": "a contract"}' });
  assert.equal(r.outcome, 'BLOCKED', r.out);
  assert.equal(r.status, 2);
  assert.equal(EXIT_FOR.BLOCKED, r.status);
});

test('ERROR and CANCELLED keep the codes qb.js uses for them (1 and 3)', () => {
  const src = fs.readFileSync(QB, 'utf8');
  assert.match(src, /process\.exit\(report\?\.verdict === 'pass' \? 0 : 1\);/);
  assert.match(src, /currentRun\.abort\('CANCELLED', e\.message\); \}\n\s*budget\.endRun\(\);\n[^\n]*\n\s*process\.exit\(3\);/);
  assert.match(src, /if \(currentRun\) currentRun\.abort\('ERROR', e\.message\);\n[^\n]*\n[^\n]*\n\s*process\.exit\(1\);/);
  assert.deepEqual(EXIT_FOR, { DRY_RUN: 1, BLOCKED: 2, ERROR: 1, CANCELLED: 3 });
});
