/**
 * lib/research/candidate.js — KAN-117 (review 10609): the record that travels with a captured
 * candidate patch from QB's capture to the independent grader (bench/public/kan117/grade-candidate.mjs).
 *
 * Gradable = QB captured it cleanly (captured or no_change, not policy-refused, not unresolved).
 * The agent's run status is recorded, not judged: whether a patch counts for the trial (e.g. a
 * coding timeout) is decided by the KAN-112 trial classification, not here.
 */

const crypto = require('crypto');

const SCHEMA = 'qb-kan117-candidate/1';
const GRADER_TASKS = Object.freeze({ qbt_9b9a5da937c9: '2005', qbt_00b20b1b0285: '2006' });
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function notGradable(r) {
  const cap = r.sandbox && r.sandbox.capture;
  if (!cap || !cap.verdict) return 'no_capture';
  if (cap.policy_refused) return 'capture_policy_refused';
  if (cap.unresolved || cap.verdict.state === 'unresolved') return 'capture_unresolved';
  if (!['captured', 'no_change'].includes(cap.verdict.state)) return `capture_${cap.verdict.state}`;
  return null;
}

function candidateRecord(r, { label, env, qbCommit = null }) {
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(label || '')) throw new Error('candidate: label must be a lowercase id');
  const raw = r.patch_raw ? Buffer.from(r.patch_raw) : Buffer.alloc(0);
  const reason = notGradable(r);
  const cap = (r.sandbox && r.sandbox.capture) || null;
  const v = (r.sandbox && r.sandbox.verification) || null;
  return {
    schema: SCHEMA, label, task_id: env.task_id, grader_task: GRADER_TASKS[env.task_id] || null, qb_commit: qbCommit,
    run_status: r.status, capture_state: cap && cap.verdict ? cap.verdict.state : null,
    gradable: reason === null, not_gradable_reason: reason,
    policy_refused: cap && cap.policy_refused ? cap.policy_refused : null,
    sha256: sha(raw), bytes: raw.length, base_tree: r.base_tree || null, candidate_tree: r.candidate_tree || null,
    files: (r.changes || []).map((c) => ({ file: c.file, status: c.status })),
    internal: v ? { mode: v.mode || null, verdict: v.verdict || null, status: v.status || null, reason: v.reason || null } : null,
    patch_use: 'decided by the KAN-112 trial classification, not by this record',
  };
}

/** Throws unless `diff` is exactly the recorded candidate for this task. */
function checkCandidate(rec, diff, env) {
  if (!rec || rec.schema !== SCHEMA) throw new Error('candidate: not a candidate record');
  if (rec.task_id !== env.task_id || GRADER_TASKS[rec.task_id] !== rec.grader_task) throw new Error('candidate: task does not match the task env');
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(rec.label || '')) throw new Error('candidate: label');
  if (sha(diff) !== rec.sha256 || diff.length !== rec.bytes) throw new Error('candidate: sha256/bytes differ from the record');
  return rec;
}

module.exports = { SCHEMA, GRADER_TASKS, candidateRecord, checkCandidate };
