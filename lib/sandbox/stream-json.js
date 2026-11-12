/**
 * lib/sandbox/stream-json.js — read Claude Code's own `-p --output-format stream-json --verbose` output (KAN-113).
 * Field names were observed on Claude Code 2.1.322 (bench/opus-pilot/evidence/smoke-2026-11-12.json):
 *   served model : system/init.model, every assistant.message.model, result.modelUsage keys + canonicalModel
 *   usage        : result.usage.{input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens},
 *                  result.modelUsage[*].thinkingTokens
 *   billing      : system/init.apiKeySource, modelUsage[*].provider, rate_limit_event.rate_limit_info.{isUsingOverage, overageStatus}
 * Nothing is invented: unreported fields become { unavailable }, disagreeing model reports become { unobservable }.
 */
const NA = Object.freeze({ unavailable: 'not reported by Claude Code' });
const num = (v) => (Number.isInteger(v) && v >= 0 ? v : NA);

function fromStreamJson(text) {
  const events = String(text || '').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const init = events.find((e) => e.type === 'system' && e.subtype === 'init') || {};
  const result = [...events].reverse().find((e) => e.type === 'result') || {};
  const rate = [...events].reverse().find((e) => e.type === 'rate_limit_event');
  const mu = Object.values(result.modelUsage || {});
  const reports = [
    ...(init.model ? [init.model] : []),
    ...events.filter((e) => e.type === 'assistant' && e.message && e.message.model).map((e) => e.message.model),
    ...Object.keys(result.modelUsage || {}),
    ...mu.map((m) => m.canonicalModel).filter(Boolean),
  ];
  const distinct = [...new Set(reports)];
  const served = distinct.length === 1 ? distinct[0]
    : { unobservable: distinct.length ? `model reports disagree: ${distinct.join(', ')}` : 'no served-model field in the output' };
  const u = result.usage || {};
  const thinking = mu.length && mu.every((m) => Number.isInteger(m.thinkingTokens)) ? mu.reduce((a, m) => a + m.thinkingTokens, 0) : NA;
  const info = rate && rate.rate_limit_info ? rate.rate_limit_info : null;
  const providers = [...new Set(mu.map((m) => m.provider).filter(Boolean))];
  const out = {
    model: { requested: init.model || null, served },
    usage: { input_tokens: num(u.input_tokens), output_tokens: num(u.output_tokens), cache_read_tokens: num(u.cache_read_input_tokens),
      cache_write_tokens: num(u.cache_creation_input_tokens), reasoning_tokens: thinking },
    billing_route: {
      api_key_source: typeof init.apiKeySource === 'string' ? init.apiKeySource : NA,
      provider: providers.length === 1 ? providers[0] : NA,
      is_using_overage: info && typeof info.isUsingOverage === 'boolean' ? info.isUsingOverage : NA,
      overage_status: info && typeof info.overageStatus === 'string' ? info.overageStatus : NA,
    },
    claude_code_version: init.claude_code_version || null,
    num_turns: Number.isInteger(result.num_turns) ? result.num_turns : null,
    is_error: result.is_error === true,
    rate_limit_type: info ? info.rateLimitType || null : null,
  };
  if (mu.length && mu.every((m) => m.costBasis === 'list') && typeof result.total_cost_usd === 'number') {
    out.estimates = { api_equivalent_usd: { value: result.total_cost_usd, label: 'estimate', basis: 'Claude Code costUSD at list price (costBasis=list); not a subscription charge' } };
  }
  return out;
}

module.exports = { fromStreamJson };
