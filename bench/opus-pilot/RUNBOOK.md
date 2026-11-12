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

## 3. Facts recorded on 2026-11-12 (`claude doctor`, `claude --help`)
- **Host Claude Code:** 2.1.322, native install. Auto-updates are **enabled** (channel `latest`). The last update attempt failed (`install_failed`). QB's agent image pins **2.1.288**.
- **Version parity:** both arms must run one version, frozen in KAN-112. During the pilot the host must not auto-update (`DISABLE_AUTOUPDATER=1` for every trial process, as `plan.json` already sets). Record `claude --version` before each trial.
- **Account type:** remote managed settings are not fetched ("requires an Enterprise or Team subscription"), and organization policy is not applicable (individual plan).

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

## 5. Live trials: BLOCKED
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
