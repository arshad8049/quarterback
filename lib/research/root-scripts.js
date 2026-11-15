/**
 * lib/research/root-scripts.js — KAN-117 review 10620, slice B: the reviewed allowlist for deps-root-scripts-v1
 * (sandbox/research/deps-root-scripts.sh). Research callers only; QB's product policy (deps-plan.sh) is unchanged.
 */
const path = require('path');

const RULE = 'deps-root-scripts-v1';
const LIFECYCLE = new Set(['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare', 'postprepare']);
const SCRIPT = path.join(__dirname, '..', '..', 'sandbox', 'research', 'deps-root-scripts.sh');

/** Throws `root scripts allow: …`; returns the entries. */
function validateAllow(entries) {
  const bad = (m) => { throw new Error(`root scripts allow: ${m}`); };
  if (!Array.isArray(entries) || !entries.length) bad('at least one reviewed entry is required');
  for (const e of entries) {
    if (!e || typeof e.key !== 'string' || !e.key) bad('key');
    if (e.rule !== RULE) bad(`rule must be ${RULE}`);
    if (!/^[0-9a-f]{40}$/.test(e.base_tree || '')) bad(`${e.key}: base_tree must be a full tree id`);
    if (!/^[0-9a-f]{64}$/.test(e.package_json_sha256 || '')) bad(`${e.key}: package_json_sha256`);
    if (!Array.isArray(e.removed) || !e.removed.length || !e.removed.every((s) => LIFECYCLE.has(s))) bad(`${e.key}: removed must name root lifecycle scripts only`);
  }
  return entries;
}

module.exports = { RULE, SCRIPT, validateAllow };
