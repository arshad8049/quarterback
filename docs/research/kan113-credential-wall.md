# KAN-113: credential-wall design, FOR REVIEW (10589 §3). Dummy state only; nothing built; live route stays disabled

**Question.** Can the unmodified Claude Code CLI keep access to its own sign-in state, while its task tools (Bash, Read/Edit/Write/Glob/Grep) can't read that state or reach the proxy controls, host files or grader material? And can that hold without QB ever reading, copying, forwarding or refreshing a credential?

**Short answer.** It's a **viable candidate with two open blockers** (§5). Experiments with dummy files show the mechanism blocks the obvious and the `/proc` side channels for **Bash**. But (1) the **built-in file tools run outside that sandbox** and are protected only by path-based deny rules, whose symlink behaviour I can't verify without a model call; and (2) Docker forces the documented **"weaker nested sandbox"** mode. A different user or container is a candidate, not proof. Neither is built here.

## 1. Facts from the official docs (code.claude.com, read 2026-11-12)
- **Bash sandbox:** Claude Code's Bash tool can run in a native sandbox: bubblewrap + socat on Linux. It can deny reads (`sandbox.filesystem.denyRead`, and `sandbox.credentials.files` entries with mode `deny`).
  - **Mandatory:** with `failIfUnavailable: true` and `allowUnsandboxedCommands: false`.
  - **Enforced by managed settings**, which nothing else overrides.
- **Built-in file tools run outside the sandbox:** "A denyRead entry doesn't stop the Read tool." They're covered only by permission rules (`Read(//cfg/**)` etc.). Read/Edit deny rules also cover some Bash file commands Claude Code recognises (cat, head, sed, redirections), but not every subprocess.
- **In containers:** "In an unprivileged container, bubblewrap can't mount a fresh /proc"; the workaround `enableWeakerNestedSandbox: true` "weakens isolation".
- **Credential location:** on Linux it's `$CLAUDE_CONFIG_DIR/.credentials.json` (mode 0600). There's no built-in deny list protecting it: "only the files and variables you list are restricted."

## 2. Experiments (dummy files and dummy env only; no credential, no model, no sign-in)
**Setup:** a scratch image built from the pilot image plus `bubblewrap 0.8.0`, `socat`, `ripgrep` and Anthropic's `@anthropic-ai/sandbox-runtime` (`srt` 0.0.82, the engine the CLI's sandbox uses). It ran with **QB's exact hardening flags** (`--user 10001:10001 --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs /tmp --init --network none`) and `--tmpfs /cfg` (0700, uid 10001) holding `DUMMY-FILE-SECRET`.

| # | Test | Result |
|---|---|---|
| 1 | `cat /cfg/.credentials.json`, same user, **no sandbox** | **readable**: 0700 alone is no wall (as you noted) |
| 2 | bubblewrap, normal mode, under QB's hardening **and** in a plain container | **fails**: `Can't mount proc on /newroot/proc: Operation not permitted` |
| 3 | `srt` normal mode | fails the same way (2): the sandbox can't start |
| 4 | `srt` with `enableWeakerNestedSandbox: true`, `denyRead: ["/cfg"]`: `cat /cfg/.credentials.json` | **blocked** (`/cfg` appears empty inside) |
| 5 | same, `cat /etc/hostname` | allowed (normal reads still work) |
| 6 | sandbox reads a **sibling** same-user process's `/proc/<pid>/environ`, `/proc/<pid>/root/cfg/…`, `/proc/<pid>/maps` | **Permission denied** (the sandbox has its own user namespace) |
| 7 | same against the sandbox's **ancestor** (the CLI's position), including `/proc/<pid>/mem` | **Permission denied** |
| 8 | the ancestor's environment variable `DUMMY_TOKEN` | **inherited** into the sandbox, so the credential must never be in the environment |
| 9 | QB egress proxy (squid): any non-CONNECT request, e.g. a cache manager | **denied by config** (`http_access deny !CONNECT`; only CONNECT to allow-listed hosts on 443). The allowlist lives in the proxy container; only QB can restart it |
| 10 | deliver a dummy checkout into an already-running hardened container (`docker cp` into a tmpfs-backed volume) | **works**: the container saw it only after the copy. Ownership arrives as the host uid, so the real version must stream a tar with owner 10001 |

The scratch images and the dummy volume were removed after the tests.

## 3. Candidate design (not built)
**One attempt = one container, two phases, with QB acting only from outside.**

| | Sign-in phase | Coding phase |
|---|---|---|
| What runs | the official `claude auth login --claudeai` on a TTY, then `claude auth status` | the CLI `claude -p <frozen args>` with the briefing on stdin |
| Credential | written by the CLI into `/cfg` (container tmpfs; never a volume or host path; QB never touches it) | read only by the CLI process (outside the Bash sandbox) |
| Checkout / briefing | **absent**: the work volume is empty; no briefing | the checkout is delivered by QB after the gate (test 10); the briefing is streamed on stdin after the gate |
| Egress (QB proxy, outside the agent) | a SIGN-IN allowlist: only the hosts the official flow needs. **Unconfirmed**: recorded from the proxy's CONNECT log (hostnames only) during the first approved sign-in | QB **stops** the sign-in proxy and **starts** the INFERENCE proxy (`api.anthropic.com`) on the same socket, *before* opening the gate |
| Bash tool | none | Claude Code's mandatory sandbox via managed settings: `enabled`, `failIfUnavailable`, `allowUnsandboxedCommands: false`, no `excludedCommands`, `enableWeakerNestedSandbox` (required, test 2), `filesystem.denyRead: ["/cfg", "/sock"]`, `credentials.files: [/cfg/.credentials.json → deny]`, network `allowedDomains: []` (task tools need no network) |
| File tools | none | managed permission deny: `Read/Edit(//cfg/**)`, `Read/Edit(//sock/**)`, `Read(//proc/**)`, `Edit(//etc/claude-code/**)` |
| Gate | the entrypoint blocks on a root-owned, read-only FIFO that only QB writes (`docker exec -u root`) once the proxy switch is done | the coding budget starts at the gate (agent-time debit from the start marker) |

**Already outside the agent's reach in QB:**
- host files: there are no host mounts, only the work/deps/sock volumes;
- grader material: verification runs in a separate container, and hidden tests are never mounted in the agent container;
- the proxy configuration: in the proxy container.

**Deadlines:**
- sign-in: its own limit (proposed 10 min; an owner human event);
- coding: the shared 1,800 s agent budget from the gate;
- the trial: the existing `trial_deadline_ms`.

No sign-in starts once the coding budget is spent: an attempt only starts while `remaining > 0`, which is existing behaviour.

## 4. Stop conditions honoured
Every one of these makes the design invalid, and I would stop it:
- QB reads, copies, forwards or refreshes a credential (it doesn't);
- the credential is in the environment (it must not be, test 8);
- task tools can reach the credential. That's open for the file tools (§5.1).

## 5. Open blockers (for your decision)
1. **The built-in file tools aren't inside the sandbox.** A sandboxed Bash command can't *read* `/cfg`, but it can create a **symlink** in `/work` pointing at `/cfg/.credentials.json`. Then the **Read** tool, running in the unsandboxed CLI process, might follow it. Whether the `Read(//cfg/**)` deny rule resolves symlink targets is **not stated in the docs I read**, and it **can't be tested without a model turn**, which needs your approval: a smoke with a dummy file, not a credential. Until confirmed, this is a **blocker**.
2. **Weaker nested sandbox.** It's required in Docker (test 2). Tests 4–7 show file and `/proc` isolation holding, but the docs say this mode "weakens isolation", without detail. Alternative: grant the container what bubblewrap needs for the normal mode. That means relaxing QB's hardening (for example a custom seccomp or `--security-opt systempaths=unconfined`), which is a security trade-off for you to decide.
3. **Sign-in hostnames** for the phase-1 allowlist aren't confirmed from official documentation. They'd be observed during the first approved sign-in (logging hostnames only).
4. **Host memory:** see the resubmission (admission fails on this Mac's Docker VM).

## 6. If rejected: other candidates (not evaluated)
- **Separate user:** a different uid for the CLI and for its tools. Claude Code has no built-in way to run its tools as another user. That would need a modified setup around the binary, and it isn't proven.
- **Separate container:** moving the credential between containers is forwarding, so it's refused.
- **Console API key (option B):** a key in an env var is visible to tools (test 8), unless `sandbox.credentials.envVars` scrubs it. It's a billing decision.
