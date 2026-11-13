# KAN-113 (10596 §5): supported-auth-route comparison. Assessment only; nothing is enabled

The two candidate routes for the paired pilot (KAN-112 10583/10586). Sources: Anthropic's official Claude Code docs and the official `anthropics/claude-code-action` README/docs, read 2026-11-12/13. Statements those sources don't make are marked **open**.

| | **R1: current interactive container route** (QB container, owner signs in per attempt) | **R2: official GitHub integration** (`anthropics/claude-code-action`, `claude setup-token`) |
|---|---|---|
| How auth happens | The owner runs `claude auth login --claudeai` on a TTY inside each attempt's container. The credential lives in container tmpfs and dies with it | `claude setup-token` (run once by the owner on their own machine) issues a long-lived (one-year) subscription token. It's stored as the repo secret `CLAUDE_CODE_OAUTH_TOKEN` |
| QB touches the credential? | No (design). But the design is **unbuilt** and unattended CI is not possible (it needs a human at a TTY each attempt) | QB never sees it. GitHub injects the secret into the job. It still exists in the job's environment, though |
| Frozen CLI version (2.1.322) | Yes: pinned in QB's image | **Open.** The action installs its own Claude Code. There's no documented version pin; `path_to_claude_code_executable` could point at a pinned install (needs review) |
| Frozen args (10586) | Yes, exactly: `buildAgentArgs` | Partly. `claude_args` passes CLI flags through. But the action is built on the Agent SDK, not plain `claude -p`, and its default permission mode is its own. **Open:** whether every frozen flag is honoured identically |
| Same container as QB (fairness 10586) | Yes: both arms run in QB's pinned container | **No** by default. The action runs on the runner host. Both arms would have to move to R2 (or into a container step) to stay fair |
| Managed settings / deny rules | Yes: `/etc/claude-code/managed-settings.json` in the image | `settings` is a JSON input. Managed (policy) settings aren't addressed: **open** |
| Can task tools read the credential? | Bash: blocked only in bubblewrap **weaker nested** mode, which isn't approved; normal mode can't start in Docker. File tools: **unproven** (10589 §5.1) | **Open / likely yes.** The token is an env var of the job. The docs don't say it's hidden from the tools. A best-effort subprocess env scrub (`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`) is documented only with `allowed_non_write_users`. Our test 8: env vars are inherited into sandboxed Bash |
| Billing preflight | `classifyAttempt` from stream-json: `apiKeySource` must be `none`, `isUsingOverage` must be false on every event, provider must be firstParty | **Weaker.** Logs are sanitized by default (`show_full_output` off). There's no documented execution file with model/usage/overage fields. Also, `ANTHROPIC_API_KEY` takes precedence over the OAuth token in `-p` mode, so its absence must be proven |
| Unattended | No (a human per attempt) | Yes |
| Secrets on forks | n/a | Fork PRs get no secrets (good). A `prompt` input enables automation mode |
| Policy status | Anthropic confirmation **recorded as an owner override** (10593), not a written reply | The documented, supported route for subscription use in GitHub Actions |

## Assessment
- **Neither route is ready for a live paired trial.**
- **R1** is blocked by isolation: no approved Bash sandbox mode in Docker, and the file tools are unproven. The host run (see the resubmission) records where the dummy boundary stops.
- **R2** is a documented route, so it answers the policy question better than R1 ("supported"). But it breaks two frozen KAN-112 conditions:
  - the identical container for both arms;
  - the exact plain-CLI version and args.

  Its token is also likely reachable by task tools, and its billing evidence is thinner than our stream-json preflight.
- **Correction of my 10595 statement.** I wrote that "a subscription sign-in must not live in CI". That was too broad. The accurate statement is: *our current interactive design isn't ready for unattended CI; a different documented route (R2) exists and requires review.*

## Open questions (for review; answering them needs no model call)
1. Can the action run a **pinned 2.1.322** binary with our exact flags, via `path_to_claude_code_executable` + `claude_args`, without SDK-side defaults changing permission mode or tools?
2. Can it run **inside QB's container** (a container job or step) so both arms stay identical (fairness 10586)? If not, does KAN-112 accept moving **both** arms to R2?
3. Is `CLAUDE_CODE_OAUTH_TOKEN` visible to the agent's Bash/file tools? It would be tested with a **dummy** secret value and the fake CLI, never a real token.
4. Does any official output record `apiKeySource`, `isUsingOverage` and the served model? If not, the billing preflight can't be met and the stop rule "missing billing evidence = unknown" blocks R2.

## Proposed next gate (no model, no real token)
A dummy-secret workflow:
- a repo secret with a dummy value;
- the fake CLI behind `path_to_claude_code_executable`;
- record whether the dummy reaches the tool environment, which args arrive, and what the logs and outputs contain.

Live use of either route stays blocked until reviewed.
