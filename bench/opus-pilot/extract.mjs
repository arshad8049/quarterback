// KAN-113: build the model / usage / billing parts of an audit record from Claude Code's own output
// (`claude -p … --output-format stream-json --verbose`). Field names were observed in the owner-approved smoke of
// 2026-11-12 on Claude Code 2.1.322 (see bench/opus-pilot/RUNBOOK.md §3). Nothing is invented: a field Claude Code
// did not report becomes { unavailable }, and disagreeing model reports become { unobservable } with the reason.
const NA = { unavailable: 'not reported by Claude Code' };
const num = (v) => (Number.isInteger(v) && v >= 0 ? v : NA);

export function fromStreamJson(text) {
  const events = text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const init = events.find((e) => e.type === 'system' && e.subtype === 'init') || {};
  const result = [...events].reverse().find((e) => e.type === 'result') || {};
  const rate = [...events].reverse().find((e) => e.type === 'rate_limit_event');
  const msgModels = events.filter((e) => e.type === 'assistant' && e.message && e.message.model).map((e) => e.message.model);
  const usageModels = Object.keys(result.modelUsage || {});

  // Served model: every report Claude Code gives must agree; otherwise it is not resolved silently
  const reports = [...msgModels, ...usageModels, ...Object.values(result.modelUsage || {}).map((m) => m.canonicalModel).filter(Boolean)];
  const distinct = [...new Set(reports)];
  const served = distinct.length === 1 ? distinct[0]
    : { unobservable: distinct.length ? `model reports disagree: ${distinct.join(', ')}` : 'no served-model field in the output' };

  const u = result.usage || {};
  const mu = Object.values(result.modelUsage || {});
  const thinking = mu.length && mu.every((m) => Number.isInteger(m.thinkingTokens)) ? mu.reduce((a, m) => a + m.thinkingTokens, 0) : NA;
  const usage = { input_tokens: num(u.input_tokens), output_tokens: num(u.output_tokens), cache_read_tokens: num(u.cache_read_input_tokens),
    cache_write_tokens: num(u.cache_creation_input_tokens), reasoning_tokens: thinking };

  const info = rate && rate.rate_limit_info ? rate.rate_limit_info : null;
  const providers = [...new Set(mu.map((m) => m.provider).filter(Boolean))];
  const billing_route = {
    api_key_source: typeof init.apiKeySource === 'string' ? init.apiKeySource : NA,
    provider: providers.length === 1 ? providers[0] : NA,
    is_using_overage: info && typeof info.isUsingOverage === 'boolean' ? info.isUsingOverage : NA,
    overage_status: info && typeof info.overageStatus === 'string' ? info.overageStatus : NA,
  };

  const out = { model: { requested: init.model || null, served }, usage, billing_route,
    claude_code_version: init.claude_code_version || null, num_turns: Number.isInteger(result.num_turns) ? result.num_turns : null,
    is_error: result.is_error === true, rate_limit_type: info ? info.rateLimitType || null : null };
  const listPrice = mu.length && mu.every((m) => m.costBasis === 'list') && typeof result.total_cost_usd === 'number';
  if (listPrice) out.estimates = { api_equivalent_usd: { value: result.total_cost_usd, label: 'estimate', basis: 'Claude Code costUSD at list price (costBasis=list); not a subscription charge' } };
  return out;
}
