# KAN-113: exact QB route for arm B, for review (2026-11-12). Arm B: UNVERIFIED

This document reports facts from the code at branch `kan113-runner-prep` (QB `main` 2f01d93 + KAN-113 changes). It **approves nothing**. No paired trial runs until the reviewer has reviewed this route and arm B is verified.

**Arm status:**
- **Arm A** (unmodified host `claude` 2.1.322, the owner's sign-in): **smoke-tested** (KAN-113 10582).
- **Arm B:** **unverified**.

The config gate enforces this: `checkPilotConfig(…, 'live')` refuses while any arm is `unverified`.

## 1. The route, step by step (what QB does today)
| Step | What happens | Code |
|---|---|---|
| Entry | `bench/experiment-run.js` → `runArm()` (QB-28 arms) or `qb run` → `lib/qb-pipeline.js` (repair loop) | `bench/arms.js`, `lib/qb-pipeline.js` |
| Attempts | up to `maxRetries` (QB default 3; `--max-retries` 1–10). `agentTimeMs` caps total agent time across all attempts, each attempt getting what remains. It's set by the experiment manifest (`budget.agent_time_ms`); **the `qb` CLI does not expose it** | `lib/qb-pipeline.js` 92–118; `bench/experiment-run.js` 142 |
| Credentials (Mode S) | (1) **pre-run refresh model call** `claude -p "Reply with exactly OK." --max-turns 1`, with **no `--model`**, in a clean auth container; (2) expiry read by `jq`; (3) `.credentials.json` **copied** from the `qb-claude-auth` volume into the run's tmpfs volume, mounted at `/cfg`. Mode K: `ANTHROPIC_API_KEY`/`CLAUDE_CODE_OAUTH_TOKEN` passthrough if set | `lib/sandbox/auth.js` 150–175 |
| Agent container | image `qb-sandbox-agent` (content tag of `sandbox/agent/`), unmodified `@anthropic-ai/claude-code@${CLAUDE_VERSION}` from npm. **Pin now 2.1.322 per the KAN-112 freeze; image not yet rebuilt.** `--network none` + proxy socket, egress `api.anthropic.com` only. Agent memory 2 GiB; stage deadline 30 min (`DEFAULT_DEADLINES.agent`) | `sandbox/agent/Dockerfile`, `lib/sandbox/agent.js`, `lib/sandbox/egress.js`, `lib/sandbox/pipeline.js` 35–36 |
| Policy | managed settings: deny `WebFetch`/`WebSearch`, no project MCP servers, all hooks disabled. Env: `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `DISABLE_AUTOUPDATER=1`, `DISABLE_TELEMETRY=1`, `DISABLE_ERROR_REPORTING=1`, `ENABLE_CLAUDEAI_MCP_SERVERS=false`, `CLAUDE_CODE_DISABLE_ARTIFACT=1` | `sandbox/agent/managed-settings.json`, `lib/sandbox/agent.js` 23–26 |
| Invocation | `exec claude -p --dangerously-skip-permissions --output-format text "$@"`. The briefing comes on stdin; `runAgent` passes **no extra arguments** | `sandbox/agent/entry.sh`, `lib/sandbox/agent.js` 40–48 |
| QB's own models | QB's L1–L4 steps call a **local model** (Ollama; `lib/budget.js` per-call deadline 180 s). They're outside the agent budget and recorded separately | `lib/budget.js`, `bench/arms.js` header |

## 2. Gaps that block a valid arm-B trial under the KAN-112 freeze (10583)
1. **No `--model`.** The agent and the pre-run refresh call run the **account default model**, not necessarily `claude-opus-5-5`. The freeze requires `--model claude-opus-5-5` in both arms.
2. **`--output-format text`.** The served model, token usage and billing route verified for arm A (stream-json: `system/init.model`, `assistant.message.model`, `result.modelUsage`, `apiKeySource`, the overage fields) **aren't captured** for arm B. `extract.mjs` can't build the audit record from text output.
3. **Permission mode differs.** Arm B uses `--dangerously-skip-permissions` inside the sandbox, while the arm-A smoke ran with the default mode and `--disallowed-tools`. The tool and permission configuration must be equal across arms, or the difference declared.
4. **Environment parity is undecided.** Arm A was smoke-tested on the host. QB-28's own arm A ("native agent") runs plain Claude Code **inside the same QB sandbox** (same image, network policy, managed settings). Running both arms in the sandbox gives environment parity, but then arm A also uses Mode S credentials and isn't smoke-tested. Running arm A on the host keeps the smoke-tested route, but the arms differ in environment (network, tools, OS). **This is a protocol decision for the reviewer and owner.**
5. **The pre-run refresh is an extra model call per run** (and runs without `--model`). It must be recorded as auxiliary usage. If the reviewer prefers, it could be dropped when the credential's remaining life covers the stage, but that's a QB change for review.
6. **The image isn't rebuilt at 2.1.322.** `--max-turns` (used by the refresh) isn't in the 2.1.322 help text; it's unverified whether the refresh still works on 2.1.322.
7. **Budget wiring.** The 1,800 s shared agent time exists only through the experiment manifest (`budget.agent_time_ms`), not the `qb` CLI. A trial must go through the experiment runner or an equivalent, with `agent_time_ms: 1800000` and `max_retries: 3`.
8. **Mode S credential handling** (stores and copies the subscription credential) is accepted by the owner for this testing (10582). This is recorded as an owner decision, not a policy finding.

## 3. Proposed steps to verify arm B (each needs a reviewer go-ahead; none started)
1. **QB change, red tests first:** pass `--model <frozen model>` and `--output-format stream-json --verbose` from the pilot config to the agent and to the refresh call. Capture the stream-json stdout for `extract.mjs`, then keep the text summary QB needs from the stream's `result` field.
2. **Decide items 3 and 4** (permission mode and arm-A environment) in KAN-112.
3. **Rebuild the agent image at 2.1.322.** Run one **arm-B smoke** (a trivial prompt in the QB sandbox, like the arm-A smoke) and check that every report agrees on `claude-opus-5-5`, with `apiKeySource` and no overage. Record the refresh call as auxiliary usage.
4. **Then** set `arm_routes.B.status` to `smoke-tested`. The config gate then allows a reviewer-approved paired trial.
