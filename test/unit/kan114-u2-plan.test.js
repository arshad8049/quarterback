// KAN-114 10720 items 4, 5 and 7: the plan file's corrected usage section, qualification-before-checklists, and the
// clean-author protocol (specified only; not run). Static checks on committed files.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const plan = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'bench/opus-pilot/kan114-six-task-proposal.json'), 'utf8'));

test('usage: linear scaling is an ESTIMATE, not a worst-case bound; no dollar figure from Opus 4.5 list prices', () => {
  const u = plan().usage_estimate;
  assert.match(u.basis, /ESTIMATE/);
  assert.match(u.basis, /not a worst-case/i);
  assert.ok(!('per_task_worst' in u) && !('six_tasks_worst' in u) && !('six_tasks_with_1.5x_margin' in u), 'no "worst" labels');
  assert.ok(u.per_task_estimate && u.six_tasks_estimate && u.six_tasks_estimate_with_1_5x_margin);
  assert.ok(!('api_list_equivalent_usd' in u));
  assert.match(u.pricing_note, /Opus 4\.5 list prices are not prices for this model/);
  assert.match(u.pricing_note, /not subscription charges/);
  assert.ok(!/\$\s?\d/.test(JSON.stringify(u)), 'no dollar amounts');
});

test('usage: a separately bounded line for authoring sessions, and stop on subscription limits with no paid fallback', () => {
  const u = plan().usage_estimate;
  const a = u.authoring_sessions;
  assert.ok(a, 'authoring_sessions line');
  assert.equal(a.max_sessions_per_task, 3);
  assert.equal(a.max_wall_min_per_session, 45);
  assert.equal(a.max_sessions_total, 18);
  assert.match(a.tokens, /not estimated|unmeasured/i);
  assert.match(a.approval, /separate owner approval/i);
  assert.equal(u.stop_rule.on_subscription_limit, 'stop the batch; the task is incomplete in the denominator');
  assert.equal(u.stop_rule.paid_fallback, false);
  assert.match(u.stop_rule.detail, /no API key, no overage, no extra-usage purchase/);
});

test('qualification before checklists: first six environmentally eligible tasks (committed order) frozen before any checklist', () => {
  const p = plan();
  const q = p.qualification_v9;
  assert.ok(q, 'qualification_v9 section');
  assert.equal(q.freeze_before_checklists, true);
  assert.equal(q.qb_preparation_failure_replaces_task, false);
  assert.match(q.qb_preparation_failures, /recorded.*never grounds for replacing/i);
  assert.match(q.order, /committed seed order/);
  assert.ok(!q.environmental_eligibility.some((c) => /contract|checklist/i.test(c)), 'contract quality is not an eligibility criterion');
  assert.equal(q.reference_replay.preferred, 'after trial captures');
  assert.match(q.reference_replay.if_earlier, /controller-only counts/);
  assert.match(q.reference_replay.if_earlier, /no feedback/);
  assert.match(q.reference_replay.if_earlier, /no contract tuning or task replacement/);
  for (const s of p.selection_rule_v9) assert.ok(!/clean-authored reviewed contract passes/.test(s), 'old contract criterion removed from selection');
});

test('clean-author protocol: allowed inputs only, every record field named, specified but NOT run', () => {
  const c = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench/opus-pilot/u2/clean-author-protocol.json'), 'utf8'));
  assert.equal(c.schema, 'qb-kan114-clean-author-protocol/1');
  assert.equal(c.status, 'SPECIFIED ONLY - not run; each session is a model call that needs separate owner approval');
  assert.deepEqual(c.allowed_inputs, ['issue text (the task problem_statement as given to arm A, redacted)', 'the pinned base repository (one commit, no remotes)', 'QB contract schema and registry docs']);
  for (const k of ['hints', 'gold patch', 'test patch', 'FAIL_TO_PASS / PASS_TO_PASS names', 'grader output', 'prior trial results', 'web']) {
    assert.ok(c.forbidden_inputs.some((x) => x.includes(k)), k);
  }
  for (const k of ['model_requested', 'model_served', 'claude_code_version', 'transcript_sha256', 'wall_ms', 'tokens', 'ai_review_rounds', 'owner_minutes']) {
    assert.ok(c.record_fields.includes(k), k);
  }
  assert.match(c.freeze, /before any gold or reference replay/);
  assert.equal(plan().clean_author_protocol, 'bench/opus-pilot/u2/clean-author-protocol.json');
});

test('the plan records the U2 scope and what stays out of it', () => {
  const u = plan().u2_implementation;
  assert.ok(u);
  assert.match(u.decision, /10720/);
  assert.deepEqual(u.out_of_scope, ['lockfile-v1', 'leak-rule changes', 'yarn', 'QUnit']);
  assert.equal(u.image_digest, 'pending build approval');
  assert.equal(u.qualification_launch, 'NOT approved; not launched');
  assert.equal(u.arm_order, 'bench/opus-pilot/u2/arm-order.json');
});
