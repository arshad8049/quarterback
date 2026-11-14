// KAN-110 leak scanner for agent-visible text.
// Redacts answer-bearing identifiers: the task's instance ID, the fixing commit SHA (Pro embeds it
// in instance_id), links to the same repository's pull requests, commits, compares and
// SHA-pinned trees/blobs (future history), and "#<fixing PR number>" references.
// It never rewrites anything else. Every redaction is reported so a reviewer can audit it.

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Answer-bearing identifiers for one task, from controller-side fields. */
export function answerIds(source, c) {
  const ids = { instance_id: c.instance_id || null, fix_sha: null, fix_pr: null, repo: c.repo };
  if (source === 'swe-bench-pro-v2') {
    const m = /-([0-9a-f]{40})(?:-v[0-9a-f]+)?$/.exec(c.instance_id || '');
    if (m) ids.fix_sha = m[1];
  } else {
    const m = /-(\d+)$/.exec(c.instance_id || '');
    if (m) ids.fix_pr = m[1];
  }
  if (c.pull_number != null && c.pull_number !== '') ids.fix_pr = String(c.pull_number);
  return ids;
}

/** Returns { text, redactions: [{kind, match}] }. */
export function redact(text, ids) {
  if (typeof text !== 'string' || !text) return { text, redactions: [] };
  const redactions = [];
  let t = text;
  const sub = (re, kind, repl) => {
    t = t.replace(re, (m) => { redactions.push({ kind, match: m.length > 120 ? m.slice(0, 120) + '…' : m }); return repl; });
  };
  if (ids.instance_id) sub(new RegExp(esc(ids.instance_id), 'g'), 'instance_id', '[task]');
  if (ids.repo) {
    const r = esc(ids.repo);
    // Same-repository links that can point at the fix or later history
    sub(new RegExp(`https?://(?:www\\.)?github\\.com/${r}/(?:pull|pulls|commit|commits|compare)/[^\\s)\\]>"']*`, 'gi'), 'repo_history_link', '[link removed]');
    sub(new RegExp(`https?://(?:www\\.)?github\\.com/${r}/(?:tree|blob)/[0-9a-f]{7,40}[^\\s)\\]>"']*`, 'gi'), 'repo_history_link', '[link removed]');
  }
  if (ids.fix_sha) {
    // Full SHA, or any abbreviation of it of 7+ characters, as a whole token
    sub(new RegExp(`\\b${ids.fix_sha.slice(0, 7)}[0-9a-f]{0,33}\\b`, 'gi'), 'fix_sha', '[commit]');
  }
  if (ids.fix_pr) {
    sub(new RegExp(`(?<![\\w/])#${ids.fix_pr}\\b`, 'g'), 'fix_pr_ref', '#[pr]');
    if (ids.repo) sub(new RegExp(`${esc(ids.repo)}#${ids.fix_pr}\\b`, 'g'), 'fix_pr_ref', '[pr]');
  }
  return { text: t, redactions };
}

/**
 * Report-only check: how much of the reference solution's added code already appears verbatim
 * in the agent text (an issue can legitimately quote a fix). Lines shorter than 25 characters
 * after trimming are ignored as too generic. Returns counts only, never the lines.
 */
export function goldOverlap(agentText, patch) {
  if (!agentText || !patch) return { added_lines: 0, found: 0 };
  const added = patch.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .map((l) => l.slice(1).trim()).filter((l) => l.length >= 25);
  const uniq = [...new Set(added)];
  return { added_lines: uniq.length, found: uniq.filter((l) => agentText.includes(l)).length };
}
