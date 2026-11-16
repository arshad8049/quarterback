/**
 * lib/research/reviewed-checks.js — KAN-117 review 10640: the ONLY path by which a KAN-99 `scenario` check (code) is
 * accepted on this research branch. Contract files, the benchmark oracle and model output keep rejecting scenarios.
 * A scenario is accepted only if a review entry names its exact check id and source sha256
 * (review 10642: `reviewed_by` / `ref` are required non-empty METADATA, not an authenticated identity — the trusted
 * controller supplies the externally reviewed manifest; the task or the agent never supplies it)
 * (source review and hash binding before a real task contract runs). Data checks pass through the normal registry.
 *
 * The research check runner (the KAN-99 runner, kept at sandbox/research/qb-check-runner.mjs so the agent image content tag and ids stay unchanged) is mounted
 * READ-ONLY at its own path in stage ⑥; its sha256 is recorded. An unchanged image id does NOT mean an unchanged
 * effective environment: this override must be carried into the settings freeze.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { validateChecks } = require('../../verify/checks/registry');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function validateResearchChecks(proposed, criteria = [], { reviewed = [] } = {}) {
  const ok = (r) => r && typeof r.check_id === 'string' && /^[0-9a-f]{64}$/.test(r.source_sha256 || '')
    && typeof r.reviewed_by === 'string' && r.reviewed_by.trim() && typeof r.ref === 'string' && r.ref.trim();
  const rev = (Array.isArray(reviewed) ? reviewed : []).filter(ok);
  const pass = []; const pre = [];
  for (const c of Array.isArray(proposed) ? proposed : []) {
    if (c && c.adapter === 'scenario') {
      const src = c.params && typeof c.params.source === 'string' ? c.params.source : '';
      if (!rev.some((r) => r.check_id === c.id && r.source_sha256 === sha(src))) {
        pre.push({ check: c, reason: 'scenario source not in the reviewed list (research reviewed path: exact check id + source sha256 + reviewer)' });
        continue;
      }
    }
    pass.push(c);
  }
  const v = validateChecks(pass, criteria, { allowScenario: true });
  return { ...v, rejected: [...pre, ...v.rejected],
    accepted_scenarios: v.accepted.filter((c) => c.adapter === 'scenario').map((c) => ({ id: c.id, source_sha256: sha(c.params.source) })) };
}

function researchCheckRunner() {
  const host = path.join(__dirname, '..', '..', 'sandbox', 'research', 'qb-check-runner.mjs');
  return { host, path: '/opt/qb-research/qb-check-runner.mjs', sha256: sha(fs.readFileSync(host)) };
}

module.exports = { validateResearchChecks, researchCheckRunner };
