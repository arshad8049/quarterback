# Copied-credential check and live-restore (KAN-44)

## What happens

1. **After capture**, QB scans the exact patch bytes for known credential formats (added lines, file names, headers) and compares them with **this run's own** Claude credential.
   - API key or token (Mode K): compared inside QB's process.
   - Subscription (Mode S): QB never reads the credential. A trusted container with no network compares the patch with the stored login and with the run's copy, and answers only FOUND or ABSENT.
2. The result is stored with the run, bound to the SHA-256 of the patch. It holds kinds, counts and file names, never a value.
3. **On a finding:** the diff is not sent to the model judge, no further attempt is made, and `qb patch` refuses to export. The verdict and the stored bytes are unchanged. There is no override.
4. **`qb patch` scans again** and also refuses if the evidence belongs to another patch, or if the own-credential check failed and still fails when repeated.

## What it does not do

- A clean result **is not proof**. Encoded, encrypted, split, reversed or otherwise transformed values and unknown formats are not found (tests pin this).
- The content of binary files is not scanned; `qb patch` says how many there are.
- Removed and context lines are not searched for known formats: they are the user's own content. The run's own credential is searched everywhere.
- Only the patch is scanned. Logs, the run record and memory stay sensitive. The run record still holds the patch after a refusal.
- If someone signs in again during a run **and** the agent overwrites its copy, the old credential is in neither place QB compares.
- An agent can force a refusal by writing a known format, or by putting ordinary text in its own copy. That blocks its patch; it does not leak anything.
- `--save` and the local run directory keep their own copies; they are not covered by the export refusal.
- Runs recorded before this check have no own-credential result. `qb patch` scans their formats and says the rest was not checked.

## Docker live-restore

`qb doctor` fails when it is enabled and warns when it cannot be read; a claude-code run prints the same warning first and records the state. QB reads the setting only and never changes it. The private-code beta requires it to be disabled, because cleanup is tested only that way. A run is **not blocked** by this today: the warning and `qb doctor` are the gate.
