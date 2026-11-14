/**
 * lib/research/launch-spec.js — KAN-117 (review 10609): the same-environment launch specification
 * for a first task-2005 exploratory run. Both arms get the SAME saved images (by id), task env,
 * agent bundle and caps; they differ only in route and attempts (pilot-config.json). This is a
 * specification, not a launch: live use stays blocked on the listed KAN-112 / KAN-113 dependencies.
 */

const SCHEMA = 'qb-kan117-launch-spec/1';

function launchSpec({ provenance, env, envSha256, bundle, amendment, pilot, qbCommit }) {
  const images = Object.fromEntries(Object.entries(provenance.images).map(([k, v]) => [k, { id: v.id, ref: v.ref, tar_sha256: v.tar_sha256 }]));
  const t = amendment.time;
  const shared = {
    images, task_env_sha256: envSha256, agent_bundle: bundle.schema, effective_briefing_sha256: bundle.effective_briefing_sha256,
    trial_total_s: t.trial_total_s, coding_s: t.coding_s, internal_stage_cap_ms: env.internal_stage_cap_ms,
    run_options: { researchEnv: env.task_id, researchBaseline: 'baseline.json from a noAgent base run on these images, before any candidate',
      researchDeadlineAtMs: 'arm-trial start + trial_total_s (TrialClock)', requireMemoryCheck: true },
    capture_to_grader: 'lib/research/candidate.js record + exact patch bytes → bench/public/kan117/grade-candidate.mjs (after capture, outside the coding budget)',
  };
  const arms = {};
  for (const [arm, a] of Object.entries(pilot.pilot_arms)) {
    arms[arm] = { ...shared, qb28_arm: a.qb28_arm, max_attempts: a.max_attempts, route: (pilot.arm_routes[arm] || {}).route || null,
      route_status: (pilot.arm_routes[arm] || {}).status || 'unverified' };
  }
  return {
    schema: SCHEMA, qb_commit: qbCommit, task_id: env.task_id, exposure: env.exposure, live_authorized: false,
    image_provenance: provenance.schema, arms,
    dependencies: [
      { card: 'KAN-112', item: 'TrialClock (amendment 1) driving runSandboxed stage deadlines and the arm-trial report; integration results for 10603', status: 'open' },
      { card: 'KAN-112', item: 'trial outcome classification and slot accounting applied to these records (grader_outcome kept separate)', status: 'open' },
      { card: 'KAN-113', item: 'approved live sign-in route and credential boundary for the agent container (owner a/b/c decision)', status: 'open' },
    ],
    not_exercised: [
      'a live agent or any model call',
      'the full QB contract/repair loop (arm B): the scripted applyPatch seam is not that loop',
      'a matched A/B baseline',
    ],
  };
}

module.exports = { SCHEMA, launchSpec };
