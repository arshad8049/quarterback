/**
 * lib/research/dataset-env.js — KAN-117 (review 10607): the reviewed, QB-held task environment
 * record for research-only dataset-native verification. It never comes from the repository or
 * from runner detection, and it never changes the customer default (context/test-plan.js).
 */

const SCHEMA = 'qb-kan117-task-env/1';
const isArgv = (a) => Array.isArray(a) && a.length > 0 && a.every((x) => typeof x === 'string' && x.length > 0);
const isRelDir = (p) => typeof p === 'string' && /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*\/$/.test(p) && !p.split('/').includes('..');

/** Throws `task env: …` on any problem; returns the record. */
function validateTaskEnv(e) {
  const bad = (m) => { throw new Error(`task env: ${m}`); };
  if (!e || typeof e !== 'object') bad('not an object');
  if (e.schema !== SCHEMA) bad(`schema must be ${SCHEMA}`);
  if (!/^qbt_[0-9a-f]{12}$/.test(e.task_id || '')) bad('task_id');
  if (!['calibration', 'research'].includes(e.exposure)) bad('exposure must be calibration or research');
  if (e.runner !== 'jest') bad('only the jest runner is supported in this stage');
  if (!/^\d+\.\d+\.\d+$/.test(e.jest_version || '')) bad('jest_version');
  if (!Array.isArray(e.env_unset) || !e.env_unset.includes('CI')) bad('env_unset must include CI (review 10607 decision 1)');
  if (!Array.isArray(e.protected) || !e.protected.length || !e.protected.every((p) => typeof p === 'string' && p && !p.includes('\n'))) bad('protected');
  if (!Array.isArray(e.generated_paths) || !e.generated_paths.every(isRelDir)) bad('generated_paths must be relative directories ending in /');
  if (!Array.isArray(e.pre_steps) || !e.pre_steps.every((s) => s && typeof s.name === 'string' && isArgv(s.argv))) bad('pre_steps');
  if (!e.probe || !isArgv(e.probe.argv) || !e.probe.expect || typeof e.probe.expect !== 'object') bad('probe');
  if (!isArgv(e.list_argv)) bad('list_argv');
  if (!isArgv(e.test_argv) || e.test_argv.some((a) => a.startsWith('--outputFile'))) bad('test_argv (QB appends its own fresh --outputFile)');
  if (!Number.isInteger(e.internal_stage_cap_ms) || e.internal_stage_cap_ms <= 0) bad('internal_stage_cap_ms');
  if (typeof e.agent_notice !== 'string' || !e.agent_notice) bad('agent_notice');
  return e;
}

/** The rule and command every arm is told before execution (the same text for every arm). */
function agentNotice(e) {
  return `## Verification for this task\n${e.agent_notice}\n`;
}

/** What the agent actually receives in research mode: the task briefing, then the notice (one function, so the bundle hash and the pipeline agree). */
function researchBriefing(briefing, e) {
  return `${briefing}\n\n${agentNotice(e)}`;
}

/**
 * Changes under declared generated paths (decision 2): reported and refused, never dropped.
 * Kinds separate a newly generated file from an edit or deletion of content tracked in the base.
 */
function generatedPathFindings(changes, generated) {
  const kind = { A: 'new_untracked', M: 'tracked_edit', D: 'tracked_delete', T: 'tracked_edit' };
  return (changes || []).filter((c) => generated.some((g) => c.file.startsWith(g)))
    .map((c) => ({ file: c.file, status: c.status, kind: kind[c.status] || `status_${c.status}` }));
}

module.exports = { SCHEMA, validateTaskEnv, agentNotice, researchBriefing, generatedPathFindings };
