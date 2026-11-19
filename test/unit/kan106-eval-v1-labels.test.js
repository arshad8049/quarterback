/**
 * KAN-106 10770 terminology correction (analysis revision v4, labels only): a dry-run adapter attempt in
 * manifest.attempts is NOT evidence that Claude or another coding model launched. The scorer reports
 * `adapter_attempt_recorded` (any attempt) separately from `coding_agent_launched` (an attempt by a coding-agent
 * adapter, i.e. not dry-run/manual, from the recorded agent type). Checked on the published pack's real records.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { scoreBatchDir } = require('../../bench/kan106-eval-v1/score');

const PACK = path.join(__dirname, '..', '..', 'docs', 'research', 'kan106', '2026-11-19-eval-v1-881a51a');

test('the dry-run records show an adapter attempt but no coding-agent launch; the old ambiguous label is gone', () => {
  const out = scoreBatchDir(PACK);
  const byId = Object.fromEntries(out.items.map((x) => [x.id, x]));
  for (const id of ['S1-slug', 'S2-formatter', 'S3-percent', 'S4-parsebool', 'S5-clock', 'S6-money', 'U2-roundto']) {
    assert.equal(byId[id].adapter_attempt_recorded, true, id);
    assert.equal(byId[id].coding_agent_launched, false, id);
  }
  assert.equal(byId['U1-userrepo'].adapter_attempt_recorded, false);
  assert.equal(byId['U1-userrepo'].coding_agent_launched, false);
  for (const x of out.items) assert.equal('agent_launched' in x, false, x.id);
});

test('the coding-agent label follows the recorded agent type, not the presence of an attempt', () => {
  const { codingAgentLaunched } = require('../../bench/kan106-eval-v1/score');
  assert.equal(codingAgentLaunched({ agent: { type: 'dry-run' }, attempts: [{ attempt: 1 }] }), false);
  assert.equal(codingAgentLaunched({ agent: { type: 'manual' }, attempts: [{ attempt: 1 }] }), false);
  assert.equal(codingAgentLaunched({ agent: { type: 'claude-code' }, attempts: [{ attempt: 1 }] }), true);
  assert.equal(codingAgentLaunched({ agent: { type: 'claude-code' }, attempts: [] }), false);
  assert.equal(codingAgentLaunched({ attempts: [{ attempt: 1 }] }), null, 'no recorded agent type: unknown, not false');
});
