/**
 * intent/grounding-binding.js: QB's API grounding is never mutable, caller-supplied proof (KAN-107, senior 10847).
 *
 * Request-to-check consistency (intent/request-examples.js) reads contract.api_grounding to decide whether a request
 * example can be tied to a target, so the field can change whether a contract is valid. Two rules:
 *
 *   BIND (intent/contract-state.js approvedContent): when the field is present, its validator-relevant contents and
 *   the source identity (api-grounding.js groundingIdentity) are part of the approved content. Editing it after
 *   approval voids the approval. Absent -> not hashed: contracts and approvals from before KAN-107 keep their hash.
 *
 *   RECOMPUTE (checkGrounding, below): before an approval or execution decision on a contract that came from outside
 *   this process (a --contract-file, a stored contract given to the agent CLI, and again right before qb.js runs the
 *   pipeline), QB recomputes the grounding from the target repository's working tree with the same producer
 *   (groundApi, static; nothing is executed) and compares identities:
 *     - a carried grounding (on the contract, or claimed by a contract file) that differs is refused: it was edited,
 *       written by the caller, or the repository changed since it was recorded. It is never used, never "repaired",
 *       and the caller is told to review and approve again;
 *     - no carried grounding and no approval yet: QB attaches its own recomputation (the approval then binds it);
 *     - no carried grounding on an ALREADY approved contract (a pre-KAN-107 approval): left as it is. It is not
 *       migrated; its class-method examples cannot be tied to a target and are refused (fail-closed).
 *
 * Why both: binding alone would trust whatever grounding a stored contract carried when it was approved (a forged
 * one, or one the repository no longer matches); recomputing alone would let an approval silently cover a different
 * repository. Recomputation is NOT done at verification time: the task is expected to change the target files.
 *
 * KAN-107 10867: what is compared is the APPROVED STARTING STATE. Every checkGrounding call runs before the agent
 * (qb.js before runPipeline, agent/cli.js before orchestrate); nothing after the agent recomputes the grounding, so
 * the run's own candidate edits are the resulting patch, never "pre-run drift" (test/unit/kan107-10867.test.js).
 * Only the bound identity (api-grounding.js groundingIdentity) is compared. Excerpt ranges and default.ctor_stores
 * are provenance (not authenticated by approval): they decide nothing, so they are neither bound nor compared.
 */
const { groundApi, contractGrounding, groundingIdentity } = require('./api-grounding');

/**
 * KAN-107 10867 (2): the way out of a stale or edited grounding, in every agent mode (--agent manual included): the
 * approval is never reused against a different source. Regenerate from the repository as it is now, review, approve.
 */
const REAPPROVE = 'QB does not use it, and the approval is not reused against a different source (in any agent mode, manual included). '
  + 'To continue: regenerate the contract from the current repository (run qb with the same request and --repo, without --contract-file; '
  + 'it writes a new proposed-contract.json), review it, then approve it again (run qb with --contract-file <that file>, '
  + 'or qb-agent --approve-contract)';

const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`
    : JSON.stringify(v === undefined ? null : v));

/** The module paths whose identity differs between two groundings (missing or extra modules included). */
function groundingDiff(a, b) {
  const ia = groundingIdentity(a); const ib = groundingIdentity(b);
  const mods = (g) => new Map((g && Array.isArray(g.modules) ? g.modules : []).map((m) => [String(m && m.path), canon(m)]));
  if (!ia || !ib || !Array.isArray(ia.modules) || !Array.isArray(ib.modules)) return canon(ia) === canon(ib) ? [] : ['(the whole grounding)'];
  const ma = mods(ia); const mb = mods(ib);
  const paths = [...new Set([...ma.keys(), ...mb.keys()])];
  const diff = paths.filter((p) => ma.get(p) !== mb.get(p));
  if (!diff.length && canon(ia.schema) !== canon(ib.schema)) diff.push('(schema)');
  return diff;
}

/**
 * @param {object} contract
 * @param {string} repoPath     the target repository (its working tree, before the agent runs)
 * @param {{ claimed?: any }} [o]  a grounding claimed by a contract file (not on the contract itself)
 * @returns {{ ok: true, contract, recomputed } | { ok: false, reason, changed: string[], recomputed }}
 */
function checkGrounding(contract, repoPath, { claimed } = {}) {
  const request = typeof contract?.raw_request === 'string' ? contract.raw_request : '';
  const recomputed = contractGrounding(groundApi(repoPath, request));
  const carried = claimed !== undefined ? claimed : contract.api_grounding;
  if (carried !== undefined) {
    const changed = groundingDiff(carried, recomputed);
    if (changed.length) {
      return { ok: false, changed, recomputed,
        reason: `the contract's api_grounding of ${changed.join(', ')} does not match the repository (it was edited, written by the caller, or the repository changed since it was recorded). ${REAPPROVE}` };
    }
    return { ok: true, recomputed, contract: claimed !== undefined ? { ...contract, api_grounding: recomputed } : contract };
  }
  if (contract && contract.approval) return { ok: true, recomputed, contract };   // a prior approval is never migrated
  return { ok: true, recomputed, contract: { ...contract, api_grounding: recomputed } };
}

module.exports = { checkGrounding, groundingDiff };
