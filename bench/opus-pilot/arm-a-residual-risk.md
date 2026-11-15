# Arm A: credential route `subscription_token_env` and its residual risk (for the owner's confirmation)

**Route.**
- **The token:**
  - Arshad creates a long-lived Claude Code token on his own machine (`claude setup-token`).
  - He stores it only as the secret `CLAUDE_CODE_OAUTH_TOKEN` in the GitHub environment `opus-pilot-live`.
  - The environment requires Arshad as reviewer and allows only the branch `opus-arm-a`.
- **Where it can go:** only the `trial` job of `.github/workflows/arm-a-live.yml` receives it.
  - QB passes it by name (`-e CLAUDE_CODE_OAUTH_TOKEN`, Mode K) to the agent container only.
  - The grade and collect jobs never receive it.
- **Refusals before any model call:** the route is refused unless all of these hold:
  - the caller is `bench/opus-pilot/arm-a.mjs`, with `GITHUB_ACTIONS=true` and `ARM_A_LIVE=1`;
  - `bench/opus-pilot/approvals.json` records this confirmation;
  - none of `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` or the Bedrock/Vertex/Foundry switches is set.

  Ordinary QB runs and `experiment-run` never accept it.
- **Billing:** subscription only. Paid overage must be OFF in the account before any call.
  - Each attempt's own stream must show `apiKeySource: none`, a first-party provider, at least one rate-limit event and `isUsingOverage: false`.
  - Anything else fails closed. Missing billing evidence is unknown, never free.

**Residual risk (accepted by the owner, not removed).**
1. **The credential-isolation test failed** (KAN-113, run 43490722842). Inside the agent container, Claude Code's own file tools may be able to read the token, because the CLI that must hold the token runs in the same container. This route is **not a security boundary** and is not described as secure.
2. **Mitigations, which are not a proof:**
   - the container's network reaches only `api.anthropic.com` through QB's proxy;
   - web tools are denied; MCP servers and hooks are disabled;
   - the root filesystem is read-only; a fresh, empty per-run `/cfg` is used.
3. **Before any upload,** every output file is scanned inside the trial job for the exact token value and for secret patterns. On any hit, nothing is uploaded (exit 6). The raw Claude stream never leaves the runner.
4. **Public repository:**
   - the uploaded artifacts (the patch, records, usage and model fields) are readable by GitHub users;
   - GitHub masks the secret in logs, but artifacts are only protected by the scan above.
5. **What a leak would mean:** whoever saw the token could use Arshad's Claude subscription until it is revoked. Arshad revokes or rotates the token after the batch.
