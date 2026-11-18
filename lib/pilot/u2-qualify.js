/**
 * lib/pilot/u2-qualify.js — KAN-114 10720 items 3-4: the bounded no-model U2 qualification (NOT launched) and the
 * freeze rule.
 *
 *   u2Scope          walk the COMMITTED arm-a-batch-1 order; only the reviewed pattern-B bases are screened; every
 *                    other task is recorded with its reason (exposed, or a blocker outside U2), never screened
 *   LIMITS           max 9 tasks, concurrency 1, per-job timeouts and the resulting job-minute ceiling
 *   validateRequest  the request file is refused unless qualification AND the image are approved in
 *                    bench/opus-pilot/u2/approvals.json, and the tasks are a prefix of the screen order (<= max)
 *   freezeFirstSix   the first six ENVIRONMENTALLY eligible tasks (setup, agent input, grader calibration, QB visible
 *                    channel on the base) in committed order are frozen BEFORE any checklist is authored; a missing
 *                    earlier result keeps the freeze incomplete (never padded); fewer than six is a reported shortfall
 *   recordPrepFailure  a later QB preparation failure (contract cannot be written, checks fail the reference) is
 *                    recorded as an unresolved outcome for that frozen task; replaceTask always refuses
 */
const LIMITS = Object.freeze({
  max_tasks: 9,
  concurrency: 1,
  job_timeout_min: Object.freeze({ plan: 5, qualify: 45, summary: 10 }),
  job_minutes_ceiling: 5 + 9 * 45 + 10,
});
const CRITERIA = Object.freeze(['setup', 'agent_input', 'calibration', 'visible_channel']);

const keyOf = (instanceId) => String(instanceId).split('__')[1].replace(/^three\.js-/, 'threejs-');

function u2Scope(plan, allowDoc) {
  const allowKeys = new Set(allowDoc.entries.map((e) => e.key));
  const screen = []; const notScreened = [];
  for (const t of [...plan.tasks].sort((a, b) => a.rank - b.rank)) {
    const key = keyOf(t.instance_id);
    const blockers = (t.blockers || []).join('; ');
    if (t.eligible_for_v9 === false) { notScreened.push({ key, reason: `exposed (${t.exposure || 'seen'})` }); continue; }
    if (allowKeys.has(key)) { screen.push(key); continue; }
    const why = [];
    if (/lockfile v1/.test(blockers)) why.push('lockfile v1');
    if (/leak/.test(blockers)) why.push('briefing-leak v1');
    if (!why.length) why.push(blockers || 'not a U2 blocker');
    notScreened.push({ key, reason: `${why.join(' + ')}: out of U2 scope (10720 item 1)` });
  }
  return { screen, not_screened: notScreened };
}

function parseKv(text) {
  const kv = {};
  for (const l of String(text || '').split('\n')) { const m = /^([a-z_]+)=(.*)$/.exec(l.trim()); if (m) kv[m[1]] = m[2]; }
  return kv;
}

function validateRequest(text, { approvals, screen }) {
  const bad = (m) => { throw new Error(`u2 qualify request: ${m}`); };
  const kv = parseKv(text);
  const digits = (v) => /^[0-9]+$/.test(String(v || ''));
  const q = (approvals && approvals.u2_qualification) || {};
  const im = (approvals && approvals.u2_image) || {};
  if (!digits(q.approval_comment_id)) bad('qualification not approved (bench/opus-pilot/u2/approvals.json)');
  if (!digits(im.approval_comment_id) || !digits(im.build_run_id) || !/^sha256:[0-9a-f]{64}$/.test(im.image_digest || '')) bad('U2 image not approved (build run + digest + approval required)');
  if (kv.mode !== 'qualify') bad('mode must be qualify');
  if (kv.approval !== String(q.approval_comment_id)) bad('approval does not match the recorded qualification approval');
  if (kv.images_run !== String(im.build_run_id)) bad('images_run is not the approved image build run');
  const tasks = (kv.tasks || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!tasks.length) bad('no tasks');
  if (tasks.length > LIMITS.max_tasks) bad(`more than ${LIMITS.max_tasks} tasks`);
  if (new Set(tasks).size !== tasks.length) bad('duplicate tasks');
  if (JSON.stringify(tasks) !== JSON.stringify(screen.slice(0, tasks.length))) bad('tasks must be a prefix of the committed U2 screen order');
  return { tasks, images_run: kv.images_run, approval: kv.approval, image_digest: im.image_digest };
}

function freezeFirstSix(screen, results) {
  const frozen = []; const failures = []; const notNeeded = [];
  for (const key of screen) {
    if (frozen.length === 6) { notNeeded.push(key); continue; }
    const r = results[key];
    if (!r) {
      return { status: 'incomplete', pending: key, frozen: [], environment_failures: failures, frozen_before_checklists: true, checklists_authored: 0,
        note: 'an earlier task in committed order has no qualification result; nothing is frozen and later tasks are not promoted' };
    }
    const failed = CRITERIA.filter((c) => r[c] !== true);
    if (failed.length) failures.push({ key, reason: r.reason || `failed: ${failed.join(', ')}` });
    else frozen.push(key);
  }
  const shortfall = 6 - frozen.length;
  return {
    status: shortfall ? 'shortfall' : 'frozen', frozen, environment_failures: failures, not_needed: notNeeded, shortfall,
    frozen_before_checklists: true, checklists_authored: 0,
    ...(shortfall ? { note: 'fewer than six environmentally eligible tasks under U2: report the shortfall before expanding scope (10720)' } : {}),
  };
}

function recordPrepFailure(freeze, key, reason) {
  if (!freeze || !freeze.frozen.includes(key)) throw new Error(`${key} is not a frozen task`);
  return { ...freeze, frozen: [...freeze.frozen],
    qb_preparation_failures: [...(freeze.qb_preparation_failures || []), { key, reason, outcome: 'qb_preparation_failure (unresolved; counts in the denominator)' }] };
}

function replaceTask() {
  throw new Error('frozen tasks are never replaced for QB preparation failures or results (10720 item 4)');
}

module.exports = { LIMITS, CRITERIA, keyOf, u2Scope, validateRequest, freezeFirstSix, recordPrepFailure, replaceTask };
