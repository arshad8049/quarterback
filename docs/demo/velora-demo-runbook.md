# Velora supervised demo: runbook (KAN-44)

**Status: draft for the rehearsal.** Written by the junior, offline. The checklist (contract) in it is **authored by the junior, pending owner/senior review**. Nothing here has been run with Claude yet: the one rehearsal needs the owner's approval for live model use.

This is a **supervised demo**, not a beta release. KAN-44 stays NOT QUALIFIED for self-service use. The owner runs every command on the owner's own Mac and shares the screen. Velora installs nothing.

**Contents:**
- [What is pinned](#what-is-pinned)
- [Known limitations](#known-limitations) (read this out, or share it, before the demo)
- [Prerequisites on the owner's Mac](#prerequisites-on-the-owners-mac)
- [Install (once, before the rehearsal)](#install-once-before-the-rehearsal)
- [The rehearsal run](#the-rehearsal-run)
- [The demo script (about 15 minutes)](#the-demo-script-about-15-minutes)
- [Recovery and fallback](#recovery-and-fallback)
- [After the demo](#after-the-demo)
- [Rehearsal timing and intervention log](#rehearsal-timing-and-intervention-log)

---

## What is pinned

| | Value |
|---|---|
| Quarterback candidate | `main` at `2f01d93df05d819d71d38515082a60e534156769` (2026-11-12). Exact-SHA CI run 43250747366: unit on Node 20, 22 and 24 and the Docker integration job all succeeded (one run, attempt 1). |
| Fixes it contains | KAN-103 (one repair of an invalid generated contract), KAN-104 (malformed model JSON), KAN-105 first part (an allowed change that is entirely protected is refused at L1), KAN-31 runner preflight, KAN-37 README and setup guide. |
| Not in it | KAN-105 review fix `59972e6` (a generated correction may not erase a protection the request asked for). It is on `kan105-impossible-scope` only. It affects contract **drafting**, which this demo does not use. KAN-96 (OOM classification) is not fixed; see [risks](#known-limitations). |
| Sample repository | The two-file `duration-format` sample shipped in the candidate at `landing_page/evidence/2026-10-15-hero-run/sample-repo.bundle` (sha256 `044ce30d298ff4f9260867996830d5163f12bb526aaaffdd905ff70c28771d4b`), base commit `14fcfe4efa8f965ae2fb08b44fe0ef2a3869cf50`. Public, no customer code. The author is a placeholder (`demo@example.invalid`). |
| Request | Show durations under one minute as seconds only (`30000` ms as `"30s"`, not `"0m 30s"`). One minute or more keeps the current format (`90000` ms stays `"1m 30s"`). |
| Checklist (contract) | `docs/demo/velora-duration-contract.json` on branch `kan44-demo-prep`, sha256 `7fcb8c91120b5f2ba512555059b3012b275089667f75b7aafc5d14c48825c6a6`. Hand-written; **authored by the junior, pending owner/senior review**. If a reviewer edits it, the hash changes: update it here and in the install step, and the approval in a run follows the new hash. |
| Agent | Claude Code, in Quarterback's Docker sandbox. |

### The checklist, in plain words

| Criterion | Checks (run by Quarterback, not by Claude) |
|---|---|
| AC-1 `formatDuration` is still exported as a function | `module_exports` |
| AC-2 under one minute, seconds only | `formatDuration(30000)` is `"30s"`, `formatDuration(1000)` is `"1s"`, `formatDuration(0)` is `"0s"` |
| AC-3 one minute or more keeps the current format | `formatDuration(90000)` is `"1m 30s"`, `formatDuration(60000)` is `"1m 0s"`, `formatDuration(3600000)` is `"60m 0s"` |

Scope: Claude may change `src/duration.js` and files under `test/`. `package.json`, `package-lock.json` and `.quarterback.json` are protected: changing them fails the run.

**For the reviewer:** `0` → `"0s"` and `3600000` → `"60m 0s"` are the junior's reading of the request (zero is under a minute; an hour keeps the current minutes-and-seconds format, which has no hours). Confirm or change them before the freeze.

**Offline evidence** (no model, no agent, no Docker; QB's own loader, check registry and check runner on Node 20.20.2):
- the contract loads through the `--contract-file` path as `finalized`, 7 of 7 checks accepted, no scope-policy errors; the same file with an extra untraced sentence in the request is `invalid`;
- the unfixed sample at `14fcfe4`: 4 of 7 checks pass; `CHK-30S`, `CHK-1S` and `CHK-0S` fail (`'0m 30s'`, `'0m 1s'`, `'0m 0s'`). The repository's own test passes (it only checks `90000`), which is why the checklist matters;
- a hand-written correct solution: 7 of 7 pass, and the repository test (plus one added test) passes;
- two wrong solutions fail: "seconds everywhere" fails the three one-minute-or-more checks, and "zero still shown as minutes" fails `CHK-0S`;
- `qb … --agent dry-run --contract-file …` with the model server address pointed at a closed port: `outcome=DRY_RUN`, exit 1 as documented, sample unchanged.

`test/unit/kan44-velora-demo-contract.test.js` repeats these through the real code, reading the request from this runbook.

---

## Known limitations

Say these before the run, not after it.

- **This is a supervised demo, not a product release.** Quarterback is pre-release (0.1.0). No current commit is qualified for unsupervised use (KAN-44).
- **Windows is not supported.** Velora's machines run Windows; Quarterback has never been run on Windows, WSL2 or Docker Desktop for Windows. That is why the owner runs the demo and shares the screen.
- **macOS is not a validated environment.** `docs/support.md`: macOS + Docker Desktop has "limited successful runs; not a validated supported environment". The validated profile is Ubuntu 24.04 x86_64 with Docker Engine and 16 GB RAM. The demo machine is qualified for this demo only by the rehearsal below. On macOS, Quarterback does not measure free memory before a run.
- **Claude Code only.** Cursor, Codex, Gemini and GitHub Copilot are not supported.
- **JavaScript / Node.js repositories tested with node:test only**, with an npm lockfile. Repositories using Jest, Mocha, Vitest or another runner are refused before any model call.
- **Automatic checklist drafting is not reliable** (KAN-106). This demo uses a checklist a person wrote and reviewed, then froze. Drafting from plain language is not part of the demo and must not be implied to work.
- **A PASS means the stated checks and tests passed,** not that every bug was ruled out. The checklist is only as good as its review.
- **No measured benefit yet.** Comparisons of Claude Code alone against Claude Code with Quarterback have shown no measured Quarterback advantage so far.
- **No private code** without Velora's consent and a data-flow review. During a Claude Code run, the sandboxed code and the briefing go to Anthropic under the owner's Claude account ([data flows](../privacy/data-flows.md)). This demo uses only the public sample.
- **Quarterback never applies a patch.** It exports one; a person reads it, runs `git apply --check`, and decides.

---

## Prerequisites on the owner's Mac

Check each before the rehearsal, and again on the demo day.

| | Needed | Check with |
|---|---|---|
| macOS | the owner's Mac; record the version in the log | `sw_vers -productVersion` |
| Docker Desktop | installed and **running**; record the version and the memory set under Settings → Resources | `docker version --format '{{.Server.Version}}'` |
| Node.js | 20 or newer (this Mac had v20.20.2 on 2026-11-18) | `node --version` |
| git | any recent version | `git --version` |
| Ollama | running, with `deepseek-r1:7b` pulled (used for the context stage) | `ollama list` |
| Claude Code sign-in | a QB-scoped sign-in made with `qb auth login` (it does not use or change `~/.claude`), or a key typed at a hidden prompt as in [onboarding step 7](../onboarding.md#7-sign-in-to-claude). Never write a key into a command, a file or this runbook. | `qb auth status` |
| Free memory | close heavy apps. Do not run any other Quarterback run, benchmark or pilot job on this Mac during the rehearsal or the demo: one run per installation is allowed, and a second is refused (`run_in_progress`). | Activity Monitor |
| Network | GitHub, the npm registry and the Claude endpoint reachable | — |

---

## Install (once, before the rehearsal)

Run in a new terminal. Everything lives in one work folder, `~/qb-velora`, separate from any other Quarterback checkout on the Mac.

```zsh
mkdir -p ~/qb-velora
cd ~/qb-velora
git clone https://github.com/arshad8049/quarterback.git quarterback
git -C quarterback checkout --detach 2f01d93df05d819d71d38515082a60e534156769
git -C quarterback rev-parse HEAD
cd quarterback
npm ci
cd ~/qb-velora
```

Expected: `rev-parse` prints `2f01d93df05d819d71d38515082a60e534156769`; `npm ci` ends without an error.

Fetch the frozen checklist and the sample:

```zsh
cd ~/qb-velora
git -C quarterback fetch origin kan44-demo-prep
git -C quarterback show FETCH_HEAD:docs/demo/velora-duration-contract.json > velora-duration-contract.json
shasum -a 256 velora-duration-contract.json
git clone -q quarterback/landing_page/evidence/2026-10-15-hero-run/sample-repo.bundle velora-sample
git -C velora-sample rev-parse HEAD
git -C velora-sample status --porcelain
```

Expected: the hash is `7fcb8c91120b5f2ba512555059b3012b275089667f75b7aafc5d14c48825c6a6` (stop if it differs: the checklist is not the reviewed one); `rev-parse` prints `14fcfe4efa8f965ae2fb08b44fe0ef2a3869cf50`; `status --porcelain` prints nothing.

Define `qb` for this terminal (repeat in every new terminal):

```zsh
export QBDIR=~/qb-velora/quarterback
qb() { node "$QBDIR/qb.js" "$@"; }
qb --help
```

Expected: `Usage: qb [options] <request>`. A line like `◇ injected env (0) from …` is harmless.

---

## The rehearsal run

**This calls Claude (the owner's account) and the local model. It needs the owner's approval for live model use. Do not run it until that approval is recorded on KAN-44.**

Start the [timing log](#rehearsal-timing-and-intervention-log) first. With `qb` defined:

```zsh
cd ~/qb-velora
qb auth status
qb doctor --repo velora-sample
```

Expected: `qb doctor` has no `✗` line and its last line starts with `Ready`. On macOS, `memory` shows `!` (not measured) and `agent-auth` shows `!` (validity not verified); both are expected. If there is a `✗`, apply its `fix:` line and run doctor again.

The run:

```zsh
cd ~/qb-velora
qb 'Show durations under one minute as seconds only, for example 30000 ms as "30s" instead of "0m 30s". Durations of one minute or more keep the current format, for example 90000 ms stays "1m 30s".' --repo velora-sample --agent claude-code --contract-file velora-duration-contract.json --deadline 20
```

Expected:
- `[L1] Using the reviewed contract file …/velora-duration-contract.json (sha256 7fcb8c91120b)`, then `Oracle approved (contract-file)`;
- the **first** run on this checkout also builds the sandbox images, which takes several minutes (this is one reason to rehearse);
- `[L4] Verdict: ✓ PASS` with `✓ [AC-1]`, `✓ [AC-2]`, `✓ [AC-3]`;
- `RESULT: ✓ PASS`, `Run: <run_id>  outcome=VERIFIED`, exit code 0. A comparable run on this sample on this Mac took 111 s (2026-10-15, QB `3fc08fd`, a smaller contract).

Write down the run id. Then the evidence, the patch and the target tests:

```zsh
cd ~/qb-velora
git -C velora-sample status --porcelain
qb show <run_id>
qb replay <run_id>
qb patch <run_id> --out velora.patch
cat velora.patch
git -C velora-sample apply --check ../velora.patch
```

Expected: `status --porcelain` prints nothing (the sample was not modified); `qb show` prints the run record as JSON: `qb_revision` is the candidate SHA, `repo.base_sha` is `14fcfe4…`, then `contract_hash`, `outcome` and the attempts with their verdicts and evidence (read it once in the rehearsal and note where the check results and the changed files appear, so you can scroll to them in the demo); `qb replay` ends `outcome=VERIFIED  reproduced`; the patch header states its verification status; `git apply --check` prints nothing.

Target tests, on a throwaway copy that a person applies the patch to by hand (the sample itself stays unchanged):

```zsh
cd ~/qb-velora
git clone -q velora-sample velora-review
git -C velora-review apply ../velora.patch
cd velora-review
node --test test/duration.test.js
node -e "const { formatDuration: f } = require('./src/duration'); console.log(f(0), '|', f(30000), '|', f(90000))"
cd ~/qb-velora
```

Expected: `# fail 0`, and `0s | 30s | 1m 30s`. Name the test file as shown: the sample's `npm test` passes a directory, which fails on Node 24.

Reset for the demo (keeps the run record in `~/.qb/runs` as the fallback):

```zsh
cd ~/qb-velora
rm -rf velora-review velora.patch
git -C velora-sample status --porcelain
```

Then record the run id, the times and every intervention in the log, and post it with a redacted excerpt on KAN-44.

---

## The demo script (about 15 minutes)

Before the call: terminal font large, a clean terminal in `~/qb-velora` with `qb` defined, Docker Desktop and Ollama running, the rehearsal's run id at hand, the fallback recording ready to play, notifications off.

| Min | Say | Show | Expected on screen |
|---|---|---|---|
| 0–2 | "Quarterback runs Claude Code against a checklist a person approved, checks the result itself, and hands back a patch with the evidence. You decide whether to apply it." Then the [known limitations](#known-limitations), briefly: supervised; the validated platform is Ubuntu 24.04 on x86_64, and this Mac has one successful rehearsal, not general Mac support; Windows not supported; Claude Code and node:test only, the checklist is written and reviewed by a person. | — | — |
| 2–4 | "Here is a tiny public repository. Today it shows 30 seconds as `0m 30s`. We want `30s`. Its own test only checks `1m 30s`, so it passes either way." | `cat velora-sample/src/duration.js`, then `cat velora-sample/test/duration.test.js` | the code and the single test |
| 4–6 | "This is the checklist. A person wrote it and reviewed it before the call. It says what must be true, which files Claude may touch, and which it must not. Passing this file is the approval." | `cat velora-duration-contract.json` (scroll to `checks` and `scope`) | seven checks; `allowed_changes`, `protected_paths` |
| 6–10 | "Now Claude Code works in an isolated sandbox. Our checkout is not touched." | the run command from [the rehearsal](#the-rehearsal-run) | `[L1]` reviewed contract file, `[L2]`, `[L3]` Claude Code, `[L4] Verdict: ✓ PASS`, `outcome=VERIFIED` (about 2 minutes, the images are already built) |
| 10–12 | "Quarterback, not Claude, ran these checks on the exact change. Here is the evidence, and a replay of the verdict from the stored record." | `git -C velora-sample status --porcelain`, `qb show <run_id>`, `qb replay <run_id>` | empty status; the run record (SHA, base, outcome, attempt evidence); `reproduced` |
| 12–14 | "The change comes back as a patch. Nothing was applied. We read it and check that it applies cleanly." | `qb patch <run_id> --out velora.patch`, `cat velora.patch`, `git -C velora-sample apply --check ../velora.patch`; then the target tests on `velora-review` | a few-line diff; nothing from `--check`; `# fail 0`; `0s | 30s | 1m 30s` |
| 14–15 | "What is next: Windows support, other test runners, reliable drafting from plain language. Nothing with your code until you consent and we review the data flow together." | — | — |

If anything on screen differs from "Expected", go to [recovery](#recovery-and-fallback). Say what happened; do not hide a failure.

---

## Recovery and fallback

General rule: say plainly what happened, then switch to the fallback within one minute. Never edit the checklist during the call (a changed file is a new, unreviewed approval).

| Likely failure | What you see | Do |
|---|---|---|
| Docker Desktop not running | `qb doctor`: `✗ docker` | Start Docker Desktop, wait for "Engine running", run `qb doctor --repo velora-sample` again. |
| Ollama not running or model missing | `✗ model`, or `FATAL: model call timed out after 180000ms` | `ollama list`; start the Ollama app; run again. If it repeats, switch to the fallback. |
| Not signed in, or sign-in expired | `qb auth status` says not signed in; or the run ends `ERROR` / `BLOCKED` with an auth reason in `qb show` | `qb auth login` off-screen (do not share the screen while signing in), then run again. |
| Another run holds the lock | `✗ Blocked: run_in_progress` | Stop the other Quarterback job (benchmark, pilot), then run again. |
| Checklist hash differs | `shasum` is not `7fcb8c91…` | Do not run. Fetch again from `kan44-demo-prep`; if it still differs, the checklist was changed after review: use the fallback. |
| Run fails verification | `RESULT: ✗ FAIL` (Claude's change did not meet a check) | This is the product working: show `qb show <run_id>` and the failing check. If attempts remain, Quarterback retries with a repair hint. |
| Run is slow | no progress for several minutes | `--deadline 20` ends it as `CANCELLED`, naming the stage. Switch to the fallback. |
| Run ends `ERROR` with an out-of-memory or sandbox reason | `outcome=ERROR` | Quit heavy apps, check Docker Desktop memory, run once more after the call if needed. Switch to the fallback now. Memory is not checked before a run on macOS. |
| Image build during the call | long `building` output | The rehearsal should have built the images. Switch to the fallback; do not wait on screen. |
| Screen share drops | — | Rejoin; the run continues in the terminal. |

**Fallback A (preferred): the rehearsal's own run.** It used the same pinned candidate, sample and checklist. Show `qb show <rehearsal_run_id>`, `qb replay <rehearsal_run_id>` (it recomputes the verdict from the stored evidence and calls no agent), `qb patch <rehearsal_run_id> --out velora-fallback.patch`, `git -C velora-sample apply --check ../velora-fallback.patch`, and the target tests on a throwaway copy as in the rehearsal.

**Fallback B: the recorded terminal playback** of the rehearsal (about 55 s, labelled "RECORDED PLAYBACK, not a live run"; accepted as the fallback in KAN-44 10756): `open ~/qb-velora/FALLBACK-velora-rehearsal-playback.html` and share the browser tab. Source: `docs/demo/fallback/velora-rehearsal-playback.html`.

**Demo-day preflight:** `zsh ~/qb-velora/demo-day-preflight.sh` (copy of `docs/demo/demo-day-preflight.sh`). No model call; checks the pins, Docker, Ollama, sign-in and `qb doctor`, then prints the run and fallback commands.

**Fallback C: the published 2026-10-15 run** on the same sample (`landing_page/evidence/2026-10-15-hero-run/`, QB `3fc08fd`, run `e01b3273-…`, VERIFIED). Its contract is smaller (two checks) and older; say so.

---

## After the demo

```zsh
cd ~/qb-velora
rm -rf velora-review velora.patch velora-fallback.patch
```

Keep `~/qb-velora` and the run records until KAN-44 has the redacted evidence. Record in KAN-44: the date, who attended, the run id, the outcome, every intervention and any question Velora asked about Windows or other runners.

---

## Rehearsal timing and intervention log

Copy this into the KAN-44 comment for the rehearsal. An intervention is anything a person did that the runbook did not say: a retry, a restart, a fix, a workaround, an off-script command, a wait.

```text
Rehearsal (KAN-44), owner's Mac
Date / time zone:
Operator:
Owner approval for live model use (comment id):

Environment
  macOS version:
  Docker Desktop version / memory setting:
  Node version:
  Ollama model (ollama list):
  Claude Code sign-in mode (subscription via qb auth login / key at hidden prompt):
  Quarterback SHA (git -C quarterback rev-parse HEAD):
  Checklist sha256:
  Sample base (git -C velora-sample rev-parse HEAD):

Timings (start - end, duration)
  Install (clone, npm ci):
  Checklist + sample fetch and checks:
  qb doctor (result line):
  Run (Total time printed; includes image build: yes/no):
  qb show / replay:
  Patch export + apply-check:
  Target tests:
  Whole rehearsal:

Result
  Run id (redacted if needed):
  RESULT / outcome / exit code:
  Attempts used:
  Checks passed (of 7):
  replay:
  apply --check:
  target tests (# pass / # fail):
  sample unchanged after run (status --porcelain empty): yes/no

Interventions (one line each)
  # | time | step | what happened | what was done | minutes lost | would it block the demo?
  1 |      |      |               |               |              |

Failures and errors (verbatim, redacted)

Cost
  Claude usage noted (subscription limits / API spend):

Go / no-go for the demo, and why:
```
