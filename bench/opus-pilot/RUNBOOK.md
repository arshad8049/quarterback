# Opus 5.5 pilot: owner runbook (KAN-113)

Everything here runs on the owner's machine. **Nothing in sections 1–3 calls a model or touches a credential.** Section 5 (live trials) stays blocked until its gates clear.

## 1. Checks anyone can run now (no model, no credentials)
```sh
node --test test/unit/kan113-audit.test.js          # audit record, config and dry-run tests (15)
node bench/opus-pilot/dry-run.mjs \
  --config=bench/opus-pilot/pilot-config.json --out=/tmp/opus-pilot-dry-run
claude doctor                                        # installation health; makes no model call
```
- **Dry run:** never starts `claude`. It refuses if a credential or billing-override variable is set, or if the configured Claude Code version differs from QB's agent image pin. It writes `plan.json` (the exact commands both arms would use) and a sample audit record.

## 2. Owner checks (account UI only; no settings change requested)
1. **Claude account** (claude.ai → Settings → Billing / Usage): record whether **extra usage / usage credits** are enabled.
2. **Claude Console**, if you have one (`platform.claude.com/settings/billing`): record whether **auto-reload** is on.
3. **In any Claude Code session:** `/status` shows the plan and the remaining allocation. Record it before the pilot.
4. **No overrides in the shell:** `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_BASE_URL` and the Bedrock/Vertex/Foundry switches must stay unset. The dry run enforces this. Checked unset on this Mac on 2026-11-12.

## 2b. Owner decisions (2026-11-12, recorded on KAN-113)
- **Auth:** the owner uses his own Claude subscription and treats the questions in the Anthropic inquiry as approved for this early-stage testing. The inquiry is **not sent**.
- **Billing:** no usage credits. Only the 5-hour and weekly plan limits apply, so there is no paid fallback. Confirmed by the smoke: `isUsingOverage: false`, `overageStatus: rejected` (`out_of_credits`).
- **`qb-claude-auth` volume:** kept (minimal loss); QB's own runs use it.

## 3. Facts recorded on 2026-11-12 (`claude doctor`, `claude --help`)
- **Host Claude Code:** 2.1.322, native install. Auto-updates are **enabled** (channel `latest`). The last update attempt failed (`install_failed`). QB's agent image pins **2.1.288**.
- **Version parity:** both arms must run one version, frozen in KAN-112. During the pilot the host must not auto-update (`DISABLE_AUTOUPDATER=1` for every trial process, as `plan.json` already sets). Record `claude --version` before each trial.
- **Account type:** remote managed settings are not fetched ("requires an Enterprise or Team subscription"), and organization policy is not applicable (individual plan).

**Live route verified (one owner-approved smoke call, `evidence/smoke-2026-11-12.json`):**
- The owner's existing sign-in on the unmodified host `claude` 2.1.322 served `--model claude-opus-5-5`. Every report agrees: `system/init.model`, each `assistant.message.model`, and `result.modelUsage` (`canonicalModel`).
- `apiKeySource: none`, `provider: firstParty`.
- Token usage is reported (input, output, cache read and write, thinking).
- `costUSD` is labelled `costBasis: list`, so it's recorded only as an estimate.
- `bench/opus-pilot/extract.mjs` turns this output into the audit fields.

## 4. Limits we can actually enforce, and ones we can't
| Limit | Mechanism | Status |
|---|---|---|
| Wall-clock per trial | runner kills the process at the deadline (both arms) | enforceable |
| Tools | `--allowed-tools` / `--disallowed-tools`, the same managed settings for both arms | enforceable |
| Network | QB container egress policy (arm B); arm A needs the same policy, decided in KAN-112 | enforceable, pending parity design |
| Fresh session, no memory | `--no-session-persistence`, a fresh config dir per trial, `--strict-mcp-config` | enforceable |
| Model | `--model claude-opus-5-5` (explicit). The served model is confirmed only from the live output | requested: enforceable; served: observed only |
| Turns | `--max-turns` is **not** in the 2.1.322 help text | not relied on unless verified for the frozen version |
| Dollar / token budget | `--max-budget-usd` is documented for "API calls"; a subscription has no per-trial dollar meter | **not enforceable** on a subscription; never claimed |
| QB retries | QB's own retry count, sharing the arm's wall-clock budget | enforceable (value set in KAN-112) |

All budget values stay `null` in `pilot-config.json` until KAN-112 freezes them. Live use is refused until then.

## 4b. Frozen parameters (KAN-112 comment 10583)
- **Version:** Claude Code **2.1.322** in both arms, checked per trial. QB's image is re-pinned to it but not yet rebuilt.
- **Model and effort:** `--model claude-opus-5-5` in both arms; effort is the CLI default.
- **Budgets:** coding wall-clock **1,800 s** per arm per trial. QB: max **3** attempts, sharing those 1,800 s. Turns and token/dollar caps are not enforced (recorded only).
- **Stop rules:** a rate limit, auth failure or host failure → stop, record `INFRA_INTERRUPTION`, no automatic retry. Budget reached → grade the existing patch. Preflight failure → refuse to start. Never paid usage. Reruns only with approval, originals kept.

## 4c. Arm status
- **Arm A:** **smoke-tested** (host `claude` 2.1.322, the owner's sign-in; `evidence/smoke-2026-11-12.json`).
- **Arm B:** **unverified**. See `docs/research/kan113-arm-b-route-review.md` for the exact QB route and its gaps (no `--model`, text output, permission mode, environment parity, refresh call, image not rebuilt).
- `checkPilotConfig(…, 'live')` refuses while any arm is unverified.

## 4d. Fairness decision (KAN-112 10586) and the rebuilt container (2026-11-12)
- **Both arms:** plain, unmodified Claude Code in the **same** QB agent container, with identical args (`plannedArgv` in `dry-run.mjs`), explicit restricted permissions (`dontAsk` + allowlist; web denied), the same network (`--network none` + `api.anthropic.com`), the same 1,800 s shared agent time, and the same repo snapshot. Arm A = QB-28 arm A (1 attempt); arm B = QB-28 arm E (≤ 3 attempts sharing the budget).
- **Image:** `qb-sandbox-agent:c-a11cdbc954d462aa`, Id `sha256:34f60e7f22e47dc67ce09617b32bb5a3e142c521fa061b41e2405f0a49e1e5a5`, linux/arm64 (this Mac's Docker), Claude Code 2.1.322. A different host or architecture means a rebuild with a new Id, recorded per trial.
- **No-model dry run of both arms:** `evidence/dry-run-2026-11-12.json`. It holds each arm's effective settings and the refusal checks:
  - an unapproved auth route is refused before any sandbox;
  - the wrong version, bypass permissions, an API-key billing route, overage, a wrong served model, and a misconfigured deadline (90 min total) are all refused;
  - the frozen 30-minute shared budget is accepted.
- **The Mac smoke** verified the account and model access only. It is **not** the benchmark baseline. Both containerized arms are `unverified`.

## 5. Live trials: gated by arm B verification and a run approval
**Auth route (owner decision):**
- **Arm A:** the unmodified host `claude`, signed in by the owner (verified above).
- **Arm B:** QB's agent stage. Its current subscription mode stores and copies the credential, plus a pre-run refresh call; the owner accepts that for this testing. The refresh call is recorded as auxiliary usage.

**Remaining gates:** arm B verified (review document above) and a reviewer-approved paired trial. KAN-112 freeze: done (10583).

### Previous gate list (superseded by the owner decision above)
**Gates (all required):**
1. Anthropic's written answer that option A is permitted (inquiry: `docs/research/kan113-anthropic-inquiry.md`);
2. the reviewer's approval of the auth route;
3. the owner's billing checks (section 2) recorded on KAN-113;
4. KAN-112 frozen: `pilot-config.json` `frozen: true` and `frozen_by` set;
5. a reviewer run approval.

**Planned procedure under option A** (design only, not built; changes if Anthropic's answer requires):
1. Fresh trial container, unmodified Claude Code at the frozen version, a temporary in-memory config dir, the same managed settings for both arms.
2. The owner signs in **inside that container** with Claude Code's own `/login` (Anthropic's flow, owner's terminal and browser). QB never receives, reads, copies or refreshes the credential.
3. `claude -p <prompt> --model claude-opus-5-5 --output-format stream-json --verbose --no-session-persistence`, with the wall-clock deadline.
4. The run ends, and the container and its in-memory config are destroyed. Then the audit record is written and validated (`audit.mjs`).
5. **On a usage limit, auth failure or host failure:** stop and record per the frozen stop rules. Never switch account, provider or billing.

## 6. Cleanup plan
- **Per trial:** the container and its temporary config are removed automatically (`--rm`, tmpfs). The audit record keeps hashes and paths only, never credentials.
- **Existing QB sign-in store:** the Docker volume `qb-claude-auth` (from the old Mode S design) still holds a stored Claude credential on this Mac. It will not be used for the pilot. Owner's choice to remove it:
  - `qb auth logout`: runs the official logout in a QB container, then deletes the volume; or
  - `docker volume rm qb-claude-auth`: deletes the stored copy only.
  - After either, `docker volume ls | grep qb-claude-auth` prints nothing.
- **Dry-run output:** delete the `--out` folder (for example `/tmp/opus-pilot-dry-run`).
- **After the pilot:** sign out of Claude Code sessions that were used only for trials, if desired (`/logout`); re-enable host auto-updates if you turned them off.
