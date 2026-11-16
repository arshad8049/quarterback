/**
 * lib/research/contract-overlay.js — KAN-117 10650: rebuild a clean-authored research contract from a TEXT-FREE overlay
 * plus the hash-verified dataset agent store, so dataset task text is never committed to the public repository.
 * The overlay replaces `raw_request` with a reference to the agent-store problem_statement (trimmed) and each requirement
 * quote with its [start, length] span in that text. The rebuild refuses unless the JSON it produces hashes to the frozen
 * whole-file sha256 of the contract (so it is exactly the reviewed contract, byte for byte).
 */
const crypto = require('crypto');

function makeOverlay(contract, problemStatement) {
  const text = problemStatement.trim();
  if (contract.raw_request !== text) throw new Error('overlay: raw_request is not the trimmed problem_statement');
  return {
    ...contract,
    raw_request: { $from: 'agent_store.problem_statement', transform: 'trim' },
    requirements: contract.requirements.map((r) => {
      if (typeof r.quote !== 'string') return r;
      const i = text.indexOf(r.quote);
      if (i < 0) throw new Error(`overlay: ${r.id} quote not in the task text`);
      return { ...r, quote: { $span: [i, r.quote.length] } };
    }),
  };
}

function rebuildContract(overlay, problemStatement, expectedSha256) {
  const text = problemStatement.trim();
  const c = { ...overlay, raw_request: text,
    requirements: overlay.requirements.map((r) => (r.quote && r.quote.$span ? { ...r, quote: text.slice(r.quote.$span[0], r.quote.$span[0] + r.quote.$span[1]) } : r)) };
  const json = `${JSON.stringify(c, null, 2)}\n`;
  const got = crypto.createHash('sha256').update(json).digest('hex');
  if (got !== expectedSha256) throw new Error(`overlay: rebuilt contract sha256 ${got} != frozen ${expectedSha256}`);
  return { contract: c, json, sha256: got };
}

module.exports = { makeOverlay, rebuildContract };
