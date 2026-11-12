# DRAFT inquiry to Anthropic (KAN-113, option C). NOT SENT.

Also saved as a Gmail draft in Arshad's mailbox on 2026-11-12, with no recipient set. Arshad adds the address, or uses the support.claude.com form, and sends.

Status: draft for Arshad. It is sent only with Arshad's authorization, through a channel Arshad chooses (for example the support form on support.claude.com). Nothing here contains a credential.

---

**Subject:** Is this way of running Claude Code with my own Pro/Max subscription permitted?

Hello,

I'm building **Quarterback (QB)**, an open-source tool that runs Claude Code on a coding task inside an isolated container. QB then checks the resulting change against tests. For a small research pilot (about 12 runs), I'd like to use my own Claude subscription, signed in by me, and I want to make sure the setup below is within your terms. It's based on your "Legal and compliance" page ("Authentication and credential use"), read on 2026-11-12.

**What QB would do (option A):**
1. **Unmodified binary.** QB starts the official, unmodified Claude Code CLI (`@anthropic-ai/claude-code`, a pinned version installed from npm) inside a fresh Docker container, one container per run. QB does not change, remove or restrict any of Claude Code's authentication methods.
2. **Native sign-in, every run.** In each run, I sign in myself with Claude Code's own `/login` flow, in that run's container, in my own terminal and browser. QB never sees, receives, reads or handles the sign-in.
3. **Claude Code owns the credential, and it is temporary.** Whatever Claude Code stores is kept by Claude Code in its own config directory inside that run's container. That directory is a temporary in-memory filesystem that is destroyed when the run ends. QB does not read, copy, back up, forward or reuse it, and there is no shared credential store between runs.
4. **QB's role is limited to launching.** QB starts the container and the `claude` command, with an explicit `--model` and a fixed policy file (official managed settings). It passes the task description and collects Claude Code's output and the code change. It sends no credential, token or API key through any variable, file or argument.
5. **No refresh call, and no billing fallback.** QB makes no model calls of its own. It does no automatic "refresh" or keep-alive requests, and does not switch to an API key if the subscription runs out. If my usage limit is reached, the run simply stops and is recorded as interrupted.
6. **Only me.** It's only for my own use on my own machine. No other user's account or credentials are involved, and nobody else's usage is resold or paid for.

**My questions:**
1. Is option A, as described above, permitted under your terms for an individual subscriber, including the per-run container and temporary credential storage?
2. If not, which part is the problem, and is there a supported way to run a small personal evaluation like this with a subscription? Or should it use a Console API key instead?
3. Is running a scripted sequence of about 12 such runs, each with its own manual sign-in, consistent with the "ordinary, individual usage" your plan limits assume?

For full transparency: an earlier version of QB stored the Claude Code credential in its own Docker volume and copied it into each run, refreshing it with a short model call first. We stopped using that design after reading your policy. The pilot will not run on it.

Thank you,
Arshad Ahmed Shaik

---

## Notes for Arshad (not part of the message)
- **Your decision:** whether to send it, where, and from which account. I haven't contacted Anthropic.
- **Wording:** everything in "What QB would do" describes a design that does **not exist yet**. If anything is unacceptable or inaccurate, change it before sending, and the build will follow the final wording.
- **When an answer arrives:** paste it into KAN-113 for the reviewer. Live execution stays blocked until then.
