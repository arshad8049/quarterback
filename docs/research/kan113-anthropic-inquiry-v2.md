# DRAFT inquiry to Anthropic, v2 (KAN-113 10589/10590 review). FOR ARSHAD TO REVIEW AND SEND. NOT SENT.

Written confirmation of this exact route is required before any live use (KAN-113). It replaces the earlier draft (`kan113-anthropic-inquiry.md`). Nothing here contains a credential.

---

**Subject:** Is this way of running Claude Code with my own Claude subscription permitted (personal evaluation)?

Hello,

I'm building Quarterback (QB), an open-source tool that runs Claude Code on a coding task in an isolated container and then checks the result with tests. For a small personal research pilot (about 12 runs, each with a 30-minute coding budget), I'd like to use my own Claude subscription. I want to confirm that the exact setup below is permitted under your "Legal and compliance" page ("Authentication and credential use"). Nothing has run in this setup yet.

**Who launches what**
- QB, running on my own Mac, starts one fresh Docker container per run. It contains the **unmodified** Claude Code CLI (`@anthropic-ai/claude-code`, a pinned version from npm) and Anthropic's own managed-settings policy file.
- The only thing QB passes to Claude Code is command-line options: an explicit `--model`, `--output-format stream-json`, `--permission-mode dontAsk`, a list of allowed and denied tools, and no MCP servers. It sends no credential, token or API key in any variable, file or argument.

**Where the sign-in state lives**
- At the start of each run, **I** sign in through Claude Code's own `claude auth login --claudeai` flow, in my own terminal and browser.
- Claude Code writes its credential to its own config directory **inside that container**, in memory only (a tmpfs). It's destroyed when the container ends. There's no shared credential store between runs, and nothing is copied out.
- QB never reads, copies, backs up, forwards or refreshes the credential, and makes no model calls of its own, including no "keep-alive" or refresh requests.

**What QB and the task tools can access**
- QB, outside the container, can see only the code change and Claude Code's structured output (model name, token counts, rate-limit and overage status). It cannot see the credential.
- Inside the container, Claude Code's tools are restricted by your managed settings:
  - Bash runs in Claude Code's own sandbox, made mandatory, with read access to the credential directory denied;
  - the file tools have deny rules for that directory;
  - web tools are denied;
  - the tools have no network access.

**How network access changes after sign-in**
- During sign-in, the container can reach only the Anthropic sign-in hosts the official flow needs, through a proxy QB controls from outside the container.
- Before any task code is copied into the container or any tool can run, QB switches that proxy to allow only `api.anthropic.com` for Claude Code's own requests. The coding task and its instructions are delivered only after that switch.

**Billing**
- Subscription only. I have no usage credits; extra usage and overage are off.
- If a usage limit is reached, the run stops and is recorded as interrupted. There's no API-key or paid fallback.

**My questions**
1. Is this setup permitted for an individual subscriber, including the per-run container, the temporary in-container credential, and a tool launching the unmodified CLI on my behalf?
2. If not, which part is the problem, and what is the supported way to run a small personal evaluation like this (for example, a Console API key)?
3. Is about 12 such runs, each with its own manual sign-in, consistent with the "ordinary, individual usage" the plan limits assume?

For transparency: an earlier version of QB stored the Claude Code credential in its own Docker volume and copied it into each run, refreshing it with a short model call. That design is disabled for this evaluation and won't be used.

Thank you,
Arshad Ahmed Shaik

---

## Notes for Arshad (not part of the message)
- **Not built yet:** it describes a design that is **not built yet** (`docs/research/kan113-credential-wall.md`). Two parts are still open blockers there: the file tools' symlink behaviour, and the weaker nested sandbox needed in Docker. If the reviewer changes the design, update the text before sending.
- **Sending:** your choice of channel (the support.claude.com contact form, or email), and whether to send at all. I haven't contacted Anthropic.
- **When an answer arrives:** paste the reply into KAN-113. Live use stays blocked until written confirmation of this exact route.
