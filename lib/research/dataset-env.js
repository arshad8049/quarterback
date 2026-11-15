/**
 * lib/research/dataset-env.js — KAN-117 (review 10607): the reviewed, QB-held task environment
 * record for research-only dataset-native verification. It never comes from the repository or
 * from runner detection, and it never changes the customer default (context/test-plan.js).
 */

const SCHEMA = 'qb-kan117-task-env/1';           // Jest (review 10607), unchanged
const SCHEMA_MOCHA = 'qb-kan117-task-env/2';     // Mocha (review 10620): a new, separately versioned protocol
const MOCHA_BINS = new Set(['node_modules/mocha/bin/mocha', 'node_modules/mocha/bin/mocha.js']);   // Mocha 8 / Mocha 10 entry points
const isRelFile = (p) => typeof p === 'string' && /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*\.(c|m)?js$/.test(p) && !p.split('/').includes('..');
const isArgv = (a) => Array.isArray(a) && a.length > 0 && a.every((x) => typeof x === 'string' && x.length > 0);
const isRelDir = (p) => typeof p === 'string' && /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*\/$/.test(p) && !p.split('/').includes('..');

/** Throws `task env: …` on any problem; returns the record. */
function validateTaskEnv(e) {
  const bad = (m) => { throw new Error(`task env: ${m}`); };
  if (!e || typeof e !== 'object') bad('not an object');
  if (e && e.schema === SCHEMA_MOCHA) return validateMochaEnv(e, bad);
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

/**
 * Mocha (review 10620): exact resolved version, an explicit visible file set (a disclosed research subset, never a
 * glob), a fixed argv that ignores the repository's Mocha config (--no-config --no-package) and QB's own reporter
 * (appended by the stage, never in the record). No discovery step: the explicit file set is the discovery.
 */
function validateMochaEnv(e, bad) {
  if (!/^qbt_[0-9a-f]{12}$/.test(e.task_id || '')) bad('task_id');
  if (!['calibration', 'research'].includes(e.exposure)) bad('exposure must be calibration or research');
  if (e.runner !== 'mocha') bad(`${SCHEMA_MOCHA} is the mocha runner only`);
  if (!/^\d+\.\d+\.\d+$/.test(e.mocha_version || '')) bad('mocha_version must be the exact resolved version');
  if (!Array.isArray(e.env_unset)) bad('env_unset');
  if (!Array.isArray(e.protected) || !e.protected.length || !e.protected.every((p) => typeof p === 'string' && p && !p.includes('\n'))) bad('protected');
  if (!Array.isArray(e.generated_paths) || !e.generated_paths.every(isRelDir)) bad('generated_paths must be relative directories ending in /');
  if (!Array.isArray(e.pre_steps) || !e.pre_steps.every((s) => s && typeof s.name === 'string' && isArgv(s.argv))) bad('pre_steps');
  if (!e.probe || !isArgv(e.probe.argv) || !e.probe.expect || e.probe.expect.mocha !== e.mocha_version) bad('probe must expect the pinned mocha_version');
  if (e.list_argv !== undefined) bad('list_argv: the explicit test_files are the discovery for mocha');
  if (!Array.isArray(e.test_files) || !e.test_files.length || !e.test_files.every(isRelFile) || new Set(e.test_files).size !== e.test_files.length) bad('test_files must be explicit, unique, relative .js paths');
  const a = e.test_argv;
  if (!isArgv(a) || a[0] !== 'node' || !MOCHA_BINS.has(a[1])) bad('test_argv must start with node node_modules/mocha/bin/mocha[.js]');
  for (let i = 2; i < a.length; i++) {
    if (a[i] === '--no-config' || a[i] === '--no-package' || a[i] === '--exit') continue;
    if (a[i] === '--timeout' && /^\d+$/.test(a[i + 1] || '')) { i++; continue; }
    bad(`test_argv: flag not allowed (${a[i]})`);
  }
  if (!a.includes('--no-config') || !a.includes('--no-package')) bad('test_argv must ignore the repository Mocha config (--no-config --no-package)');
  if (!Array.isArray(e.omitted) || !e.omitted.length || !e.omitted.every((o) => o && typeof o.what === 'string' && typeof o.why === 'string')) bad('omitted: the subset must disclose what the repository test command runs that this does not');
  if (!Number.isInteger(e.internal_stage_cap_ms) || e.internal_stage_cap_ms <= 0) bad('internal_stage_cap_ms');
  if (typeof e.agent_notice !== 'string' || !e.agent_notice) bad('agent_notice');
  if (e.root_scripts_key !== undefined && (typeof e.root_scripts_key !== 'string' || !e.root_scripts_key)) bad('root_scripts_key');
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

module.exports = { SCHEMA, SCHEMA_MOCHA, validateTaskEnv, agentNotice, researchBriefing, generatedPathFindings };
