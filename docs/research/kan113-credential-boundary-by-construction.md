# KAN-113 (10600 §3/§4): can untrusted task tools be kept from credential state *by construction*?

**Finding (architecture).** Not with Claude Code 2.1.322 in a single container, under our requirements (subscription auth; QB never reads, copies, forwards or refreshes a credential).
- The CLI process must hold its credential (a file in `$CLAUDE_CONFIG_DIR` or the `CLAUDE_CODE_OAUTH_TOKEN` env var) to call the API.
- The built-in **file tools** (Read/Edit/Write/Glob/Grep) run **in that same process**, with its uid, filesystem view and environment (`/proc/self/environ`).
- **Bash** runs as children of that process.

So inside one container, only **rules** stand between the tools and the credential:
- permission deny rules for the file tools;
- the bubblewrap sandbox plus the env scrub for Bash.

No uid, process or container boundary separates them. That is an observation about where the tools execute (docs, and the CLI's own `mcp serve` tool host, which runs the tools in-process), not a guess.

## Interfaces inspected (no model call)
| Interface | What it is | Use for us |
|---|---|---|
| `claude -p` (stream-json) | the pilot path; tools are chosen by the model | needs inference, so not usable offline |
| **`claude mcp serve`** (2.1.322) | the CLI's own tool host over MCP JSON-RPC. It runs setup, loads permission settings (telemetry names `mcp_serve_tool_host_permission`, "none of its permission rules apply" warnings), honours `sandbox.failIfUnavailable` ("sandbox required but unavailable … refusing to start") and exposes the built-in tools | **a deterministic, no-model entry point.** The run #2 probe calls Read/Edit/Write/Glob/Grep/Bash directly on a dummy file, symlinks, a directory symlink, a chained symlink, and an env-held dummy token. **Caveat:** it's a different entry point from `-p`, so a pass is a regression example for the same rule engine, not proof that `-p` enforces identically |
| Agent SDK (`canUseTool`, hooks) | programmatic permission callbacks | still model-driven, and hooks are disabled by our managed settings |
| `sdk-tools.d.ts` (npm package) | tool input schemas only | documents the tool arguments; no enforcement |

Source: `@anthropic-ai/claude-code@2.1.322` and `@anthropic-ai/claude-code-linux-x64@2.1.322`. Tarball sha256: `3cc175d82980c20ab66057d345bd2d913244f8cf1791d10722a1225214b57219`. Embedded strings were read; nothing was executed locally.

## Boundary checklist (status after run #2: see the resubmission)
- **Resolved paths and symlinks:** probed through `mcp serve`. The cases are direct, file symlink, directory symlink, chained symlink, Edit/Write through a symlink, and Glob/Grep on the directory.
- **Process and environment:** probed. An env-held dummy token, read by Bash, with and without `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`. `/proc/**` is denied by rule only.
- **Proxy controls:** outside the agent container already. The squid config lives in the proxy container; only CONNECT to allow-listed hosts is permitted (credential-wall test 9).
- **Hidden-grader separation:** already by construction. Verification runs in a separate container, and hidden tests are never mounted in the agent container.

## Alternatives, if rule-based isolation is not acceptable
1. **Credential outside the agent container, injected by a gateway** (`ANTHROPIC_BASE_URL` → a QB proxy that adds auth).
   - This is by construction: no credential exists in the container at all.
   - **Refused for subscription auth:** QB would hold and forward the credential.
   - It would only fit a **Console API key** for a dedicated, spend-capped workspace (an owner billing decision; it ends "subscription only").
2. **Accept rule-based isolation as defense in depth.** That means:
   - managed deny rules;
   - mandatory Bash sandbox **only where it can start**;
   - env scrub;
   - no env-held token;
   - a per-attempt disposable sign-in;
   - a regression probe through `mcp serve` on every image change.

   The residual risk must be stated and accepted by the reviewer and owner. It's not a proof.
3. **Official GitHub route.** Same architecture: the token sits in the CLI's environment (`env = {...process.env}` in the action's `parse-sdk-options.ts`). Bash protection depends on the scrub and bubblewrap. The action itself lifts the AppArmor userns restriction when it enables subprocess isolation (see the auth-route comparison).

No credential, model, sign-in or real token was used for any of this.

## Run #2 results (run 43490722842, commit 3b69a650e3ddbe4142fc1671665897bf4285940d): no model, dummy only
Managed settings for the probe: deny `Read(//cfg/**)`, `Edit(//cfg/**)`, `Read(//proc/**)`, `Edit(//etc/claude-code/**)`, mounted read-only at `/etc/claude-code/managed-settings.json`.

| Case (through `claude mcp serve`) | Result |
|---|---|
| Read `/cfg/.credentials.json` (direct) | **dummy returned** |
| Read via file symlink, dir symlink, chained symlink | **dummy returned** (all three) |
| Edit/Write via file symlink | refused: "Refusing to write …: it is a symbolic link" |
| Write via **directory** symlink (`/work/link-to-cfg/new.txt`) | **file created inside `/cfg`** |
| Glob / Grep | not exposed by `mcp serve` (not tested) |
| Bash `cat /cfg/.credentials.json` and via symlink (no sandbox in this variant) | **dummy returned** |
| Bash `printenv CLAUDE_CODE_OAUTH_TOKEN` (dummy in the CLI's env, scrub off) | `UNSET`: not visible to Bash in this path |
| Scrub on (`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`) | CLI **refused to start**: "bubblewrap is required for subprocess env scrubbing" (fail closed) |
| Mandatory sandbox settings (`failIfUnavailable`) | CLI **refused to start**: "sandbox required but unavailable … bubblewrap (bwrap) not installed" (fail closed; the pilot image has no bwrap) |

**Interpretation, with limits.**
- Through the CLI's own tool host, the path deny rules **did not stop** Read (direct or resolved), nor a Write through a directory symlink.
- `tools/list` also still listed `WebFetch`/`WebSearch`, which the same settings deny. So either `mcp serve` doesn't apply managed permission rules, or it didn't load them. This run can't tell which.
- It does **not** prove that `claude -p` behaves the same.
- It does show that **no tested no-model interface demonstrates the file-tool boundary**, and that the boundary isn't by construction.
- Per §4, this is returned as a finding, not papered over with more deny rules.
