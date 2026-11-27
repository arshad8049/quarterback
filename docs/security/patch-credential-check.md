# Copied-credential check and live-restore (KAN-44)

These are **defence-in-depth controls, not credential isolation.** Code in the agent container can still read the Claude credential it runs with (agent-sandbox.md §5.4). The checks below reduce the chance that a copied credential leaves the machine through the patch or reaches a model; they do not prevent it being copied.

## What happens

1. **After capture**, QB scans the exact patch bytes for known credential formats (added lines, file names, headers) and compares them with **this run's own** Claude credential.
   - API key or token (Mode K): compared inside QB's process.
   - Subscription (Mode S): QB never reads the credential. A trusted container with no network compares the patch with the stored login and with the run's copy, and answers only FOUND or ABSENT.
2. The result is stored with the run, bound to the SHA-256 of the patch. It holds kinds, counts and **file numbers** ("file 2 of the patch"; name, header or content), never a value and never a file name. A file name is text the agent chose and can itself be a credential.
3. The result is `clean`, `finding`, or `incomplete` (the own-credential comparison could not finish: Docker failed, the comparison timed out or was cancelled, the API-key variable vanished). **Incomplete is never labelled clean.**
4. **On a finding or an incomplete scan (a hold):** the diff and file contents are not sent to any model judge (enforced in `verify()` itself, so the benchmark's direct calls are covered too), no further coding attempt is made (QB pipeline and benchmark native arms), changed file names are not printed and not stored in QB's memory (memory is recalled into later prompts), and `qb patch` refuses to export. QB prints what happened. The verdict and the stored bytes are unchanged. There is no override.
5. **`qb patch` scans again** and also refuses if the evidence belongs to another patch, or if the stored result is not clean.
6. **A hold is never presented as a pass** (KAN-44 10846). The overall verdict is `unresolved` (an execution error stays an error), the verification report carries `security_hold: { status, export: "denied" }`, `qb` prints "UNRESOLVED … security hold … export denied" and records the run as `UNRESOLVED` with reason `security_hold: …`. The individual test results stay in the run record as evidence and are not rewritten; the stored verify input replays to the same verdict. In the benchmark, a held arm-trial has status `security_hold` (attrition, never scored), is not graded, and its patch is not copied into the experiment record: only `patch.withheld.json` (SHA-256, size, reason) is. The exact bytes stay in the local run record.

## Clearing a failed own-credential check (recheck binding)

When a run is given its credential, QB records a **salted fingerprint** of it (local sensitive evidence, in the run record only: never printed, not in the `credential.hold` event, not in telemetry or experiment records; it is not anonymised data): SHA-256 of a random per-run 16-byte salt and each credential value (Mode K: the variable's value and its name; Mode S: the access and refresh token, computed in the same trusted container that copies the login, so QB's process still never reads it). The values are high-entropy tokens, so the fingerprint does not reveal them; no plaintext is stored.

If the own-credential comparison failed during the run, `qb patch` repeats it **only if the credential it can compare now has exactly those fingerprints**, i.e. it is demonstrably the credential the run had. Otherwise the answer is `unbound` and export stays refused: `qb patch` says why, that the stored patch is unchanged and has **not** been sanitised, and that the task must be run again. The binding is not weakened for convenience:

- Mode K: the recorded variable is not set now, or holds a different key.
- Mode S: the stored login was refreshed, replaced or signed out. QB refreshes the login before every run, so after another QB run the recheck will usually be `unbound`: run the task again.
- No fingerprint was recorded (runs before 10837, or the copy container's fingerprint output could not be read): `unbound`.

## Docker live-restore

Enforced in the shared sandbox entry (`lib/sandbox/pipeline.js` `runSandboxed`), so every caller is covered: `qb`, the agent runner, the benchmark arms and baseline, the grader and qualification, and direct calls. When live-restore is **enabled or cannot be read**, the run is `BLOCKED` (`live_restore_enabled` / `live_restore_unknown`) before anything is created: no reaping, no model release, no volume, no credential copy, no container. Disabled proceeds. A dry run never reaches the sandbox. `qb` stops before the context stage with the same reason, and `qb doctor` fails on both enabled and unknown.

The same refusal applies, before the container is created, to the two credential-reading container operations outside a run: `qb auth login` and the Mode S recheck in `qb patch` (KAN-44 10846). `qb auth status`, `qb auth logout` and cleanup are never blocked by it: a safety gate must not prevent cleanup.

**Unresolved earlier runs (KAN-44 10846, from KAN-118 10845).** A run whose enforcement could not be confirmed while Docker was away stays open (no terminal state) until its supervisor, or the reaper, confirms nothing of it runs. Under the admission lock, a new run first asks Docker about every open earlier run: if one still has a running container, the new run is `BLOCKED unresolved_workload`; if Docker cannot answer, `BLOCKED unresolved_workload_unknown`. The check only reads; the lock is released, so a later attempt succeeds once the earlier workload has stopped. Two runs starting at once are serialised by the lock and both see the same answer. This prevents admitting work on top of a workload that is still running; it does not itself stop that workload (the supervisor or the reaper does), and a supervisor that never sees Docker return keeps new runs blocked until Docker answers.

QB only reads the setting (`docker info`) and never changes Docker's configuration. **It is checked once, at the start of a run:** if the host or daemon is reconfigured or restarted with live-restore while a run is in progress, the gate does not notice, and cleanup is then not guaranteed.

## What it does not do

- A clean result **is not proof**. Encoded, encrypted, split, reversed or otherwise transformed values and unknown formats are not found (tests pin this).
- The content of binary files is not scanned; `qb patch` says how many there are.
- Removed and context lines are not searched for known formats: they are the user's own content. The run's own credential is searched everywhere.
- Only the patch is scanned. Logs, stdout/stderr, the run record, `--save` output and memory are **not** scanned or sanitised, and remain sensitive. The run record still holds the patch (and the file names) after a refusal.
- `--save` and the local run directory keep their own copies; they are not covered by the export refusal.
- The verification report can still name changed files (for example a scope violation); it stays in the local run record and is not sent to a model during a hold.
- If someone signs in again during a run **and** the agent overwrites its copy, the old credential is in neither place QB compares.
- A recheck compares only the stored login: a value that existed only in the run's copy (for example one Claude Code obtained by refreshing inside the run) cannot be rechecked, and the copy is gone. The fingerprints cover what the run was given.
- The comparison container is named, labelled and removed after an answer, a timeout, a cancellation or a failure. If the Docker daemon is wedged when QB removes it, or `qb patch` itself is killed, a stopped container can remain; it carries `qb.role=credential-check` and a `qb.run` label.
- An agent can force a refusal by writing a known format, or by putting ordinary text in its own copy. That blocks its patch; it does not leak anything.
- Runs recorded before this check have no own-credential result. `qb patch` scans their formats and says the rest was not checked. Runs recorded under the first version of the check (`qb-credential-scan/1`) may hold file names in their stored findings; `qb patch` no longer prints them, but the run record still contains them.
