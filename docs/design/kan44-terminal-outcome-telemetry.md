# KAN-44: terminal-outcome telemetry (proposal, not implemented)

Requested in KAN-44 comment 10798. Nothing here is built or approved. No schema, worker or client change is made by this document.

## Problem, as the code is at `main` 0970e1c

`qb.js` sends one payload, only when a run reaches the final summary. Read against the code, the current numbers cannot be used as a success rate:

| Finding | Where |
|---|---|
| Runs that end early send nothing: rejected contract file, clarification exhausted, invalid after one correction, invalid contract, not approved, needs approval, late `blocked`, deadline or cancellation, `ERROR`. | the `return`s before the metrics block; `main().catch` |
| `attempts` is `Math.max(1, attempt)`, so a run with no agent attempt reports 1. | `qb.js` payload; the worker requires `attempts >= 1` |
| A dry run reports `passed: false`. `DRY_RUN`, `UNRESOLVED`, `FAILED` and `ERROR` all look the same. | `passed: report?.verdict === 'pass'` |
| `layers_used` is always `L1,L2,L3,L4,L5`, whatever ran. | `buildLayersUsed` |

## Proposed payload: `qb-outcome/1`

Same transport, consent and token as today. Sent once per run, at its end. Every field is a fixed word, a bounded integer, or a random id.

| Field | Values |
|---|---|
| `schema` | `"qb-outcome/1"` |
| `run_id` | the run's random UUID (replay key, as today) |
| `qb_version` | as today |
| `outcome` | `VERIFIED`, `FAILED`, `UNRESOLVED`, `ERROR`, `BLOCKED`, `CANCELLED`, `DRY_RUN` (the run record's terminal states; `ABANDONED` is set later by the reaper and is not sent) |
| `reason` | one code from the list below, or `none`. **Never** the free-text reason, which can quote the request or the model. |
| `stage` | the last stage started: `L1`, `approval`, `L2`, `L3`, `L4`, `L5`, `done` |
| `agent` | `claude-code`, `manual`, `dry-run` |
| `attempts` | 0–20; **0 is real**: no agent attempt started |
| `l1_corrections` | 0 or 1 |
| `duration_ms` | 0–86,400,000 |
| `stage_ms` | object with any of the stage names above except `done`; integers. A stage that did not run is absent, never 0. |

**`reason` codes:** `invalid_contract_file`, `clarification_exhausted`, `needs_clarification`, `invalid_after_correction`, `invalid_contract`, `not_approved`, `needs_approval`, `sandbox_blocked`, `auth_blocked`, `deadline`, `cancelled`, `model_error`, `internal_error`, `other`. The client maps its own code paths to a code where each ends; it does not parse message text. An unmapped ending is `other`, so a new path is visible rather than miscounted.

**Not included, by design:** request, goal, contract, file or path names, code, patch, model text, error text, repository identity, hashes of any of these, email, machine or user name, IP (the worker does not store it with metrics).

**Not measured by this:** patch acceptance, human time, correctness, willingness to pay. Those stay on the session sheet. These are client-reported and say nothing about independent correctness.

## Rules

1. **Off by default**, per run, with a verified token, exactly as today. `--telemetry-dry-run` prints the exact payload and sends nothing, on every ending including early ones.
2. **One send, bounded (3 s), never changes the exit code or the outcome.** It runs after `run.finish`/`abort`.
3. **No signal handler sends.** On SIGINT/SIGTERM the process exits as it does now, so those runs are missing. The report must say so; it must not treat them as zero.
4. **Still not anonymous:** linked to the token, which is linked to an email. Copy must keep saying so.
5. **Deletion and retention unchanged:** `POST /api/telemetry/delete` deletes these rows too, in the same transaction; 180 days.
6. **Old payloads stay valid and separate.** `qb-outcome/1` goes to a new table (`client_outcomes`). Old rows are never converted or pooled, because they cannot say what they measured.
7. **Denominators.** Report counts per `outcome` and per `stage`. A success rate is only `VERIFIED / (runs with attempts >= 1)`, with the early endings shown beside it. `DRY_RUN` is never in it.

## Consent change

This collects more than participants agreed to. It needs updated text in the privacy page and data-flow inventory, and a new opt-in. An existing token alone must not be enough: the client sends `qb-outcome/1` only with `--telemetry` **and** the token's recorded scope `outcomes:write`, which is granted at a new confirmation.

## Tests to write first (all offline, fake worker and database)

**Client**
- one test per ending in the table above: the exact payload, `attempts: 0` where no attempt started, the right `stage` and `reason`;
- a stage that did not run is absent from `stage_ms`;
- content canary: put a unique marker in the request, a file name, the model reply, the contract error and the agent's output; no ending's payload contains it;
- no `--telemetry`, no token, or the old scope only: **no network call**, for every ending;
- `--telemetry-dry-run`: prints, sends nothing, for every ending;
- an endpoint that hangs, refuses or returns 500: same exit code and outcome as with telemetry off.

**Server**
- unknown field, unknown code, out-of-range number, oversized body, missing field: 400 and no row;
- `attempts: 0` accepted only with a compatible `outcome`/`stage`; `VERIFIED` with 0 attempts refused;
- wrong scope, revoked token: 401 and no row; duplicate `run_id`: 409; quota: 429;
- **deletion:** removes both tables' rows and revokes, in one transaction; an upload racing a deletion leaves no row (the existing QB-32/33 regressions, extended);
- retention removes both tables' rows after 180 days;
- the owner report keeps the two schemas apart and shows `CANCELLED` by signal as not measured.

**Before calling it operational:** one staging rehearsal with disposable data (consent, upload, report, delete). The live migration state, secrets and cron have not been verified (10798).

## Decisions needed

1. Approve, change or reject the field list and reason codes.
2. Is the separate table and new scope acceptable, or is a simpler opt-in wanted?
3. `duration_ms` and `stage_ms` exactly, or in buckets? Buckets reveal less; exact values are more useful for finding slow stages. I suggest buckets (under 10 s, 10–60 s, 1–5 min, 5–20 min, over 20 min).
4. Should the current payload's defects (dry runs counted as failures, `attempts` forced to 1, constant `layers_used`) be fixed now or only replaced? I suggest stopping dry runs from sending now, as a small separate change.
