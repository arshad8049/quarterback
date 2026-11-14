/**
 * lib/research/agent-bundle.js — KAN-117 (review 10609): the clean agent input bundle.
 *
 * Built only from the KAN-110 agent store (already leak-redacted by bench/public/leak.mjs) plus the
 * controller's repository coordinates. Grading material (vault) is used here for ONE purpose: a
 * leak check that refuses the bundle if the briefing contains a required test name, a gold-patch
 * line or a test-patch line. Errors carry counts only, never the matched text.
 * The same bundle, and so the same effective briefing, goes to every arm.
 */

const crypto = require('crypto');
const { researchBriefing } = require('./dataset-env');

const SCHEMA = 'qb-kan117-agent-bundle/1';
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const ORDER = ['problem_statement', 'requirements', 'interface'];
const HEADINGS = { requirements: '## Requirements', interface: '## Interface' };
const MIN_LINE = 20;   // shorter added lines (braces, `return x;`) are too generic to count as a leak

const arr = (v) => (Array.isArray(v) ? v : (typeof v === 'string' && v ? JSON.parse(v) : []));
const norm = (s) => s.replace(/\s+/g, ' ').trim();

/** Added lines of a unified diff, normalised, long enough to be specific. */
function addedLines(patch) {
  if (typeof patch !== 'string') return [];
  return patch.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => norm(l.slice(1)))
    .filter((l) => l.length >= MIN_LINE && /[A-Za-z]/.test(l));
}

/** Leak findings by kind (counts), for any text the agent would see. */
function leakCheck(text, vaultRow) {
  const t = norm(text);
  const out = {};
  const add = (k) => { out[k] = (out[k] || 0) + 1; };
  for (const n of [...arr(vaultRow.FAIL_TO_PASS), ...arr(vaultRow.PASS_TO_PASS)]) if (n && t.includes(norm(n))) add('required_test_name');
  for (const l of addedLines(vaultRow.patch)) if (t.includes(l)) add('gold_patch_line');
  for (const l of addedLines(vaultRow.test_patch)) if (t.includes(l)) add('test_patch_line');
  return out;
}

/**
 * @returns {{ bundle: object, leaks: object }}  throws `agent bundle: …` on any problem
 */
function buildAgentBundle({ agentRow, controllerRow, vaultRow, env }) {
  const bad = (m) => { throw new Error(`agent bundle: ${m}`); };
  if (!agentRow || !controllerRow || !vaultRow || !env) bad('agent, controller and vault rows and the task env are required');
  if (![agentRow.task_id, controllerRow.task_id, vaultRow.task_id].every((id) => id === env.task_id)) bad('task id mismatch between the stores and the task env');
  if (typeof agentRow.problem_statement !== 'string' || !agentRow.problem_statement.trim()) bad('problem_statement missing from the agent store');
  if (!/^[0-9a-f]{40}$/.test(controllerRow.base_commit || '')) bad('controller base_commit is not a full commit id');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(controllerRow.repo || '')) bad('controller repo');

  const shown = ORDER.filter((k) => typeof agentRow[k] === 'string' && agentRow[k].trim());
  const extra = Object.keys(agentRow).filter((k) => k !== 'task_id' && !ORDER.includes(k));
  if (extra.length) bad(`unexpected agent-store fields: ${extra.join(', ')}`);
  const briefing = shown.map((k) => (HEADINGS[k] ? `${HEADINGS[k]}\n${agentRow[k]}` : agentRow[k])).join('\n\n');
  const effective = researchBriefing(briefing, env);

  const leaks = leakCheck(effective, vaultRow);
  if (Object.keys(leaks).length) bad(`leak check failed: ${Object.entries(leaks).map(([k, n]) => `${k}×${n}`).join(', ')}`);

  const withheld = [...new Set([...Object.keys(vaultRow), ...Object.keys(controllerRow)])].filter((k) => k !== 'task_id').sort();
  const bundle = {
    schema: SCHEMA, task_id: env.task_id, exposure: env.exposure, arms: 'identical for every arm',
    repo: { upstream: controllerRow.repo, base_commit: controllerRow.base_commit,
      checkout: 'shallow fetch of base_commit only (depth 1); QB seeds /work with a fresh .git holding one commit and no remotes' },
    fields_shown: shown, fields_withheld: withheld,
    briefing, briefing_sha256: sha(briefing),
    notice_sha256: sha(effective.slice(briefing.length + 2)), effective_briefing_sha256: sha(effective),
    leak_check: { checked: ['required_test_name', 'gold_patch_line', 'test_patch_line'], min_line_chars: MIN_LINE, findings: 0 },
  };
  return { bundle, leaks };
}

/** The publishable summary: hashes and field names, never the briefing text. */
function bundleSummary(b) {
  const { briefing, ...rest } = b;
  return { ...rest, briefing_bytes: Buffer.byteLength(briefing) };
}

module.exports = { SCHEMA, buildAgentBundle, bundleSummary, leakCheck, addedLines };
