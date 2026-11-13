# KAN-113 owner decision brief (review 10604 §4). For Arshad. No route is approved by this document

**The decision.** The current requirement says task tools must be unable to reach the credential. Run 43490722842 found that **this can't be shown** for Claude Code's same-process design: in the tested `claude mcp serve` configuration, the dummy file was readable. Pick one of three routes; the reviewer won't choose the risk/spend trade-off for you.

| | **(a) Subscription, bounded rule-based protection** | **(b) Separately budgeted API key** | **(c) Pause live trials** |
|---|---|---|---|
| What runs | Your Claude subscription, signed in per attempt inside the trial container | A Console API key for a dedicated workspace, **held outside the agent container** by a proxy that adds it to requests | Nothing live; offline work continues (KAN-112 runner, reports) |
| Requirement changed | "Tools can't reach the credential" becomes "tools *probably* can't, under these rules; the residual risk is accepted" | "Subscription only, no paid usage" becomes "paid API usage within a set budget". The credential requirement is **kept by construction** (no key in the container) | None |
| Protection | Managed deny rules, mandatory Bash sandbox where it starts, env scrub, per-attempt disposable sign-in, regression probe on every image. **Not a proof** | The key never enters the container, so no tool can read it. Billing is visible per request in the API's usage | n/a |
| What you can observe | stream-json billing evidence (`apiKeySource`, overage flags) per attempt | the Console usage/cost pages and the API `usage` per request | n/a |
| Cost | Your existing plan limits (5-hour/weekly windows). A usage limit stops the trial | **Estimate, not a quote:** Opus 5.5 list price is $4 / $20 per M input/output tokens, $0.20 cache reads. One 30-min arm-trial likely uses ~5–15 M cache-read + 0.5–1.5 M cache-write + 50–150 k output tokens, so **about $5–15 per arm-trial**. 12 pairs (24 arm-trials) come to **about $120–$360**. Our only real smoke was 1 turn (~22 k prompt tokens), so this range is unmeasured | $0 |
| Spending control | Plan limits only (no paid fallback; overage must be off) | Console workspace spend limits exist, but for Console orgs the API spend-limit controls are an **early-access preview**. I can't confirm a limit stops in-flight requests. **Don't treat it as a hard cap.** QB would also stop between attempts at a set token/dollar count it measures itself | n/a |
| Policy status | Your owner override (10593); no written Anthropic reply | Standard API terms for API keys | n/a |
| Smallest remaining validation | One dummy-file Read/symlink regression through the real `claude -p` path, which needs one approved model turn with a dummy file, plus a reviewed residual-risk statement | Build the key-injecting proxy (offline, fake key), then **one** measured live arm-trial to replace the cost estimate with real numbers | none |
| Reverses | the strict isolation rule | the "no paid usage" rule | nothing |

**Notes.**
- (a) and (b) both still need the reviewer's approval for each smoke and the paired trial.
- (b) needs a new KAN-112 amendment, because billing would differ from the frozen "subscription only".
- In every route, both arms use the same route, image digest and limits.

**What I need from you:** a, b or c, plus for (b) a budget ceiling you'd accept.
