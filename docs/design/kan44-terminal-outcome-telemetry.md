# KAN-44: terminal-outcome telemetry (design approved for offline implementation in 10814; not implemented)

Requested in KAN-44 comment 10798. Approved with corrections in 10814, included below. Nothing here is built. No live migration, consent change or deployment is authorized.

## Problem, as the code is at `main` 0970e1c

`qb.js` sends one payload, only when a run reaches the final summary. Read against the code, the current numbers cannot be used as a success rate:

| Finding | Where |
|---|---|
| Runs that end early send nothing: rejected contract file, clarification exhausted, invalid after one correction, invalid contract, not approved, needs approval, late `blocked`, deadline or cancellation, `ERROR`. | the `return`s before the metrics block; `main().catch` |
| `attempts` is `Math.max(1, attempt)`, so a run with no agent attempt reports 1. | `qb.js` payload; the worker requires `attempts >= 1` |
| A dry run reports `passed: false`. `DRY_RUN`, `UNRESOLVED`, `FAILED` and `ERROR` all look the same. | `passed: report?.verdict === 'pass'` |
| `layers_used` is always `L1,L2,L3,L4,L5`, whatever ran. | `buildLayersUsed` |

## Proposed payload: `qb-outcome/1`

Same transport as today, with the new consent below. **At most one best-effort send** for an eligible, observed ending. Signals, crashes, forced kills, opt-outs and network failures make the sample incomplete: missing runs are neither successes nor failures. Every field is a fixed word, a bounded integer, or a random id.

| Field | Values |
|---|---|
| `schema` | `"qb-outcome/1"` |
| `run_id` | the run's random UUID (replay key, as today) |
| `qb_version` | as today |
| `outcome` | `VERIFIED`, `FAILED`, `UNRESOLVED`, `ERROR`, `BLOCKED`, `CANCELLED`, `DRY_RUN` (the run record's terminal states; `ABANDONED` is set later by the reaper and is not sent) |
| `reason` | one code from the list below, or `none`. **Never** the free-text reason, which can quote the request or the model. |
| `stage` | the last stage started: `not_started` (refused before any stage, so no L1 activity is invented), `L1`, `approval`, `L2`, `L3`, `L4`, `L5`, `done` |
| `agent` | `claude-code`, `manual`, `dry-run` |
| `attempts` | 0–20; **0 is real**: no agent attempt started |
| `l1_corrections` | 0 or 1 |
| `duration` | bucket: `<10s`, `10-<60s`, `1-<5min`, `5-<20min`, `>=20min`. Exact timing stays local |
| `stage_duration` | object with any of `L1`, `approval`, `L2`, `L3`, `L4`, `L5`; the same buckets. A stage never started is absent, never a zero or the smallest bucket |

**`reason` codes:** `invalid_contract_file`, `clarification_exhausted`, `needs_clarification`, `invalid_after_correction`, `invalid_contract`, `not_approved`, `needs_approval`, `sandbox_blocked`, `auth_blocked`, `deadline`, `cancelled`, `model_error`, `internal_error`, `other`. The client maps its own code paths to a code where each ends; it does not parse message text. An unmapped ending is `other`, so a new path is visible rather than miscounted.

**Not included, by design:** request, goal, contract, file or path names, code, patch, model text, error text, repository identity, hashes of any of these, email, machine or user name, IP (the worker does not store it with metrics).

**Not measured by this:** patch acceptance, human time, correctness, willingness to pay. Those stay on the session sheet. These are client-reported and say nothing about independent correctness.

## Rules

1. **Off by default**, per run, with a verified token, exactly as today. `--telemetry-dry-run` prints the exact payload and sends nothing, on every ending including early ones.
2. **At most one send, bounded (3 s), never changes the exit code or the outcome.** It runs after `run.finish`/`abort`.
3. **No signal handler sends.** On SIGINT/SIGTERM the process exits as it does now, so those runs are missing. The report must say so; it must not treat them as zero.
4. **Still not anonymous:** linked to the token, which is linked to an email. Copy must keep saying so.
5. **Deletion and retention unchanged:** `POST /api/telemetry/delete` deletes these rows too, in the same transaction; 180 days.
6. **Old payloads stay valid and separate.** `qb-outcome/1` goes to a new table (`client_outcomes`). Old rows are never converted or pooled, because they cannot say what they measured.
7. **No success rate.** Report counts of observed outcomes per `outcome` and `stage`. If a share is displayed internally, its name is "client-reported verified share among received attempted runs"; it lists its exclusions, and blocked-before-agent counts are shown separately. It says nothing about correctness, adoption or human time.

## Consent change

This collects more than participants agreed to. It needs updated text in the privacy page and data-flow inventory, and a new opt-in. An existing token alone must not be enough: the client sends `qb-outcome/1` only with `--telemetry` **and** the token's recorded scope `outcomes:write`, which is granted at a new confirmation. **The worker enforces the scope too**: an old token never acquires it silently.

## Tests to write first (all offline, fake worker and database)

**Client**
- one test per ending in the table above: the exact payload, `attempts: 0` where no attempt started, the right `stage` and `reason`;
- a stage that did not run is absent from `stage_duration`; a refusal before L1 is `not_started`; every bucket boundary (9,999 / 10,000 / 59,999 / 60,000 / 299,999 / 300,000 / 1,199,999 / 1,200,000 ms);
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

## Decided in 10814

1. Separate `client_outcomes` table and `outcomes:write` re-consent: approved.
2. Duration buckets instead of exact values.
3. Ordinary dry runs stop uploading the legacy payload now (a small separate patch, branch `kan44-dryrun-metrics`); `--telemetry-dry-run` stays a preview. Legacy rows are not backfilled or pooled, and their fields are labelled unreliable.
4. Order: safety controls first, then offline tests, then a separately reviewed disposable staging rehearsal.
