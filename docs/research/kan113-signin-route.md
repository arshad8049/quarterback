# KAN-113: proposed pilot sign-in route ("in-container sign-in"), FOR REVIEW. NOT BUILT, NOT APPROVED.

**Goal:** both pilot arms use the owner's own Claude subscription, while **QB never stores, reads, copies, forwards or refreshes the subscription credential**, and there is no model call outside the measured trial.

**Status:** design only. `APPROVED_AUTH_ROUTES` stays empty, so every pilot run is refused, until the reviewer approves this route, it is built with tests, and a separate smoke is approved per arm.

## 1. The route, per attempt
Every agent attempt (arm A: 1 per trial; arm B: up to 3 per trial) runs in **one fresh container** that does both sign-in and work. Nothing about the credential leaves that container.

1. **Start.** QB creates the attempt's agent container exactly as today (the same image `qb-sandbox-agent:c-a11cdbc954d462aa`, Claude Code 2.1.322, repo snapshot, managed settings, `--network none` + the proxy), with these changes:
   - **`CLAUDE_CONFIG_DIR` is a tmpfs inside this container** (`--tmpfs /cfg`, mode 0700, owned by the agent user). It is **not** a Docker volume, has no host path, and is never mounted anywhere else.
   - **No credential arguments at all:** no `-v <cred-volume>:/cfg`, no `-e ANTHROPIC_API_KEY`, no `-e CLAUDE_CODE_OAUTH_TOKEN`. `credentialsForRun` is not called, so there is no pre-run refresh and no copy.
   - **Interactive:** the container gets a TTY (`docker run -it`) on the owner's terminal for the sign-in phase only. The briefing is no longer on stdin; it's copied in as a read-only file outside `/work` (for example `/brief/briefing.md`), so the repository snapshot is unchanged.
2. **Sign in (owner, Anthropic's flow).** The entrypoint runs the **official** subcommand `claude auth login --claudeai` (verified present in 2.1.322). The owner completes it in their own browser and terminal. Claude Code writes its credential into `/cfg` itself. QB prints nothing about it, and logs only "sign-in completed" and a timestamp.
3. **Check, without a model call.** The entrypoint runs `claude auth status` (verified present in 2.1.322). QB records only the subscription type it reports, if it reports one, and never the token. If it isn't a subscription sign-in, the attempt stops before the agent runs.
4. **Agent clock starts.** The entrypoint prints a start marker, then runs `exec claude -p <pilot args> < /brief/briefing.md` with the frozen args (KAN-112 10586). QB's agent-time debit starts **at the marker**, so sign-in minutes never count against the shared 1,800 s budget. Sign-in time is recorded as a `human_events` `sign_in` entry instead.
5. **End.** The container exits and is removed (`--rm`). The tmpfs `/cfg`, and with it the credential, is destroyed. QB then runs capture and verification exactly as today, on the work volume, which never held a credential. The stream-json verification (served model, `apiKeySource: none`, no overage) runs as already built.

## 2. What QB does NOT do
- **No credential handling:** QB doesn't create, mount or read any credential volume or file; doesn't pass any credential by variable or argument; doesn't copy `/cfg`; doesn't reuse a sign-in across attempts, trials or arms.
- **No extra model calls:** no pre-run refresh, and no other model call outside the agent's own session. Claude Code may refresh its own token during the 30 minutes; that's the CLI's own behaviour, inside its own container.
- **No fallback:** no API-key or billing fallback. A usage limit or auth failure stops the attempt (frozen stop rules).
- **Mode S stays off for the pilot.** QB's existing flow (the `qb-claude-auth` volume, the per-run copy, the refresh) remains in the code for non-pilot use only.

## 3. Changes needed (each with red tests first; none started)
1. **New auth route `in-container-signin`** in `lib/sandbox/agent-profile.js`. It's added to `APPROVED_AUTH_ROUTES` only after review.
2. **`lib/sandbox/pipeline.js`:** when the profile's route is `in-container-signin`, skip `credentialsForRun` entirely. Tests: the credential function and the refresh are never called, and no credential mount or variable appears in the docker args.
3. **`lib/sandbox/agent.js` / `entry.sh`:** add a sign-in phase (`claude auth login --claudeai`, then `claude auth status`), the start marker, the briefing from a read-only file, the `--tmpfs /cfg` config dir, and a TTY for the sign-in phase. Tests: the args contain `--tmpfs /cfg`, never `-v …:/cfg`; the briefing isn't in `/work`.
4. **Agent-time debit from the start marker** (`agentStageMs`), so sign-in time is excluded. Tests: a 5-minute sign-in plus 20 minutes of work debits 20 minutes.
5. **Egress during the attempt:** sign-in needs `claude.ai`, `platform.claude.com` and `console.anthropic.com`, besides `api.anthropic.com` (QB's existing AUTH list). It's **one policy for the whole attempt, identical in both arms**, so parity holds. **Reviewer decision needed:** accept the AUTH list for the whole attempt, or have the proxy drop the sign-in hosts once the start marker appears (more code).
6. **Audit:** a `sign_in` human event per attempt, and `auth_route: "in-container-signin"` in the record.

## 4. Costs and risks to weigh
- **Owner effort:** one manual sign-in per attempt. For 6 task pairs that's 6 for arm A plus up to 18 for arm B, about 24 sign-ins. They're recorded as human events and excluded from agent time. If too heavy, the alternative is fewer QB attempts (a KAN-112 change) or option B.
- **Unequal sign-in counts:** arm B may sign in more often than arm A. That's owner time, not agent time; it's reported separately and never counted as QB benefit or cost in the coding budget.
- **Policy:** this matches the documented permitted case ("signing in to the unmodified Claude Code binary with their own Claude subscription," including where a platform hosts it): the sign-in completes through Anthropic's own flow, and QB doesn't store or intermediate the credential. Anthropic has not confirmed it in writing; the owner decided not to ask (KAN-113 10582). This is the owner's accepted risk, not a policy finding.
- **Interactivity:** trials can't run unattended; the owner must be present at the start of each attempt.
- **Architecture:** the image is linux/arm64 on this Mac. A different trial host means a rebuild and a new image Id.

## 5. Approval sequence (proposed)
1. The reviewer approves (or amends) this route, including the egress decision in §3.5.
2. Build it with red tests first, plus a no-model dry run. Then post the SHA.
3. **One arm-B smoke**, approved separately: a trivial prompt through QB-28 arm E in the container, with the owner's sign-in. Check the stream (`claude-opus-5-5`, `apiKeySource: none`, no overage), check the credential is gone after the run, and set arm B to `smoke-tested`.
4. **One containerized arm-A smoke**, approved separately, the same way. Set arm A to `smoke-tested`.
5. Only then can a paired trial be requested.
