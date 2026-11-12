# KAN-113 runner preparation: credential and billing checks (2026-11-12)

Preparation only. No model calls, billing changes or credential handling were made. **Status: STOPPED at the checks. One blocker and one inconclusive item are below.** The per-trial audit record was not started. It waits for the owner's decision.

## 1. Credential path: BLOCKER (QB stores and copies the subscription credential)

**What QB does today** (`lib/sandbox/auth.js`, default Mode S):
- `qb auth login` runs the official binary's `claude auth login --claudeai` inside a QB container. The resulting `.credentials.json` is written into the **QB-managed Docker volume `qb-claude-auth`**.
- Per run, under QB's auth lock:
  1. a **pre-run refresh** runs `claude -p "Reply with exactly OK." --max-turns 1` in a clean container. This is a **model call** on the subscription before every run;
  2. QB reads the token expiry (via `jq` in a trusted container; QB's Node process never reads the token);
  3. QB **copies `.credentials.json`** into the run's tmpfs volume and mounts it into the agent container at `/cfg`.
- **Mode K:** if `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` is set in QB's environment, QB switches to it silently (`-e NAME` passthrough).

**What the cited policy says.** From `code.claude.com/docs/en/legal-and-compliance`, "Authentication and credential use", read 2026-11-12:
- developers "may not collect, store, or intermediate Claude.ai credentials or session tokens";
- "sign-in to a Claude account must complete through Anthropic's own flow";
- permitted: an end user "signing in to the unmodified Claude Code binary with their own Claude subscription," including where a platform hosts Claude Code;
- OAuth is "designed to support ordinary use of Claude Code and other native Anthropic applications".

**Assessment:** QB storing the credential in its own volume and copying it into each run is credential storage and intermediation by QB, even though only containers touch the file. Under KAN-113 ("If existing QB auth flow intermediates credentials, stop and propose a supported integration before running"), **the live pilot must not use QB's Mode S as it is.** This is a policy reading for the owner and reviewer to confirm, not a legal opinion.

**Current state on this machine:** the volume `qb-claude-auth` **exists**, so QB is holding a stored subscription credential now. I did not open, copy or remove it. Removing it (for example `qb auth logout`, which runs the official logout and deletes the volume) is the owner's decision.

**Supported-integration options, for decision (nothing implemented):**
- **(A) Per-trial sign-in inside the run, no QB storage.**
  - The owner signs in through the official flow (`claude` → `/login`) inside that trial's agent container, interactively.
  - The credential lives only in that run's tmpfs and is discarded with the run. QB never stores, copies or refreshes it.
  - The pre-run refresh model call goes away.
  - Cost: one manual sign-in per trial (about 12 for the pilot).
  - Arm A (plain Claude Code) would sign in the same way, for parity.
  - Open question for the reviewer: whether running the unmodified binary in QB's container counts as the permitted "platform hosts Claude Code" case.
- **(B) API key (Console) in Mode K.** This is the documented route for products. It means API billing, which conflicts with the card's preference for zero incremental spend, so it's an owner billing decision.
- **(C) Ask Anthropic for written clarification** before choosing.

**Recommendation:** decide between (A) and (B) with the reviewer before any audit or runner work that depends on the auth route.

## 2. Billing overrides: local checks CLEAN; account-level checks INCONCLUSIVE (owner must check)

**Presence only; no values were read or printed.**

| Check | Result |
|---|---|
| `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`, `CLAUDE_CODE_USE_BEDROCK` / `_VERTEX` / `_FOUNDRY` in the environment | all **unset** |
| The same names in `~/.zshrc`, `~/.zprofile`, `~/.zshenv`, `~/.bashrc`, `~/.bash_profile`, `~/.profile` | not mentioned |
| `~/.claude/settings.json` | no `apiKeyHelper`, no `env` block. It does contain a `model` key (value not read): affects plain Claude Code on the host, not QB's container (`CLAUDE_CONFIG_DIR=/cfg`) |
| `~/.claude/settings.local.json`, repo `.claude/settings.json` | absent |
| repo `.claude/settings.local.json` | `permissions` only; no `env`, no `apiKeyHelper` |

Per Anthropic's Pro/Max/Ultra article, an `ANTHROPIC_API_KEY` in the environment makes Claude Code use API billing instead of the subscription. None is set here.

**Not verifiable locally:** whether usage credits or extra usage are enabled on the Claude account, and whether a Console account has auto-reload (`platform.claude.com/settings/billing`). The owner checks these in the account UI. `/status` shows the remaining allocation. **This half is inconclusive until the owner confirms.**

## 3. Claude Code version and model-ID confirmation (recorded; nothing run)

**Versions:**
- QB's agent image pins `@anthropic-ai/claude-code@2.1.288` (`sandbox/agent/Dockerfile`, `ARG CLAUDE_VERSION`), installed unmodified from npm.
- The image adds the official managed-settings policy: deny WebFetch/WebSearch, no project MCP servers, hooks disabled.
- The host CLI and npm `latest` are **2.1.322**.

**Parity:** both arms must run the same version. Pick one in KAN-112 (pin 2.1.288 for both, or move QB's image to 2.1.322 and re-validate).

**Requesting a model:** `--model claude-opus-5-5` (CLI help: "Model for the current session"), plus `--effort <level>`. `ANTHROPIC_MODEL` also exists, and the host settings `model` key applies to host sessions. The precedence between them is not documented on the cited pages, so the trial should pass `--model` explicitly and record every other source.

**Confirming the served model:**
- The cited pages document `/status` (interactive) only. A dry run can verify the *requested* setting, not which model served a request.
- For `-p` runs, the live trial must capture Claude Code's own machine-readable output (`--output-format stream-json` / `json`) and record the model it reports for the session and for each response.
- Which output fields carry that, in v2.1.288 or v2.1.322, is **not documented on the cited pages**. It is established on the first owner-approved live trial, which is blocked by section 1.
- If no served-model field exists, the record says "requested only; served model not observable", with no claim beyond that.

## Not done (stopped per instruction)

The per-trial audit record schema, validator, fixtures and tests; the configurable budgets and stopping rules; the non-inference dry run. They resume after the decisions in sections 1 and 2.
