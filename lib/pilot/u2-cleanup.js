/**
 * lib/pilot/u2-cleanup.js — KAN-114 10720 item 8: cleanup leftovers FAIL the generalized (U2) workflows.
 * The shell gate (bench/opus-pilot/u2/cleanup-gate.sh) records key=value counts and exits nonzero on any leftover or
 * on unknown counts; this helper parses and decides the same way for drivers and tests.
 */
const KEYS = Object.freeze(['qb_containers', 'qb_volumes', 'qb_networks', 'qb_claude_auth_volume']);

function parseCleanup(text) {
  const out = {};
  for (const l of String(text || '').split('\n')) {
    const m = /^([a-z_]+)=(.*)$/.exec(l.trim());
    if (m) out[m[1]] = /^\d+$/.test(m[2]) ? Number(m[2]) : m[2];
  }
  return out;
}

/** [] = clean. Missing, non-integer or nonzero counts are problems (fail closed). */
function cleanupProblems(counts, keys = KEYS) {
  if (!counts || typeof counts !== 'object') return ['no cleanup record'];
  const p = [];
  for (const k of keys) {
    if (!(k in counts)) p.push(`${k} missing`);
    else if (!Number.isInteger(counts[k]) || counts[k] < 0) p.push(`${k} not a count`);
    else if (counts[k] !== 0) p.push(`${k}=${counts[k]} leftover`);
  }
  return p;
}

module.exports = { KEYS, parseCleanup, cleanupProblems };
