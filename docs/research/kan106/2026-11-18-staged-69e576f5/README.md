# KAN-106 staged L1 smoke, run 69e576f5 (2026-11-18): raw evidence

**One generation-only run on one tuned request.** It is a feasibility record, not a reliability rate, and not a completed coding task: the run used `--agent dry-run`, so no agent changed any code. Published for the senior's review in KAN-106 10758.

## What ran
| | |
|---|---|
| Run id | `69e576f5-291a-4f5e-bee1-ae88732d3d8b` (owner-run, at the owner's direction; see 10754) |
| Quarterback | `95f9d58ee3b6f928e45ade881b93d27d386d316e` (branch `kan106-staged-l1`, unmerged) |
| Profile | `--l1-profile qwen-14b-staged --agent dry-run --no-llm-context --deadline 15`; 240 s per call, 420 s total L1 |
| Model | `qwen2.5-coder:14b` (ollama id `9ec8897f747e`, owner-reported); every fact reply reports this model |
| Request | `test/fixtures/kan106/request.txt` (the asNumber request) |
| Target | public fast-json-stringify at `2c71f484b4bdf6b864655cdd92b21f3d023c762d`; `lib/serializer.js` sha256 `ae9d3d2fdfcfea0477c3802d2e80ea2c15126aad073629d3ef8711ee36e80c5e` |
| Time | `l1.timings` event at 2026-11-18T23:21:07Z; L1 84.5 s |
| Outcome | contract **finalized** (9 criteria, 8 checks); run outcome `DRY_RUN` (expected for `--agent dry-run`) |

## Files and hashes
| File | sha256 | What it is |
|---|---|---|
| `contract-staged.json` | `8e4f788c72d9ea903579ad12ecbd24fa65f14dda9c370c97402c287498cc09aa` | The run's `contract-staged` artifact, **byte for byte**: passage roles, call targets, fragment list, and each fact call's **raw model reply** (`facts[].attempts[].raw`) with its byte count and validation errors (none). |
| `contract.json` | `35fcd621467d9f4049b7cf5f7b7f0c54fe5fd481dfb14343fdabd9acbae487ba` | The run's `contract` artifact, **byte for byte**: the finalized contract QB assembled. |
| `l1-timings.event.json` | `200b1f340eae536bdf03d31f7c98d2d3f07e24ec175e493167824a751b9b74bf` | The `l1.timings` line from the run's `events.jsonl`, verbatim. The rest of `events.jsonl` is not published: two of its lines hold local paths. |
| `control-results.json` | `038c2f8ee2be77983ee2ce1dccea992d3179c750c6b76af2274b591c94cfc214` | The 8 generated checks from `contract.json`, **unchanged**, run by the real check runner (`sandbox/agent/qb-check-runner.mjs`, identical to its 95f9d58 version) on two controls. Re-executed by the junior on 2026-11-19; no model call. |

The first two files hash to their artifact names in the run record, so they can be matched to the owner's local `~/.qb/runs/69e576f5…/artifacts/`. Neither contains a local path. The manifest is not published (it holds the local repository path); its fields used here are `qb_revision`, `outcome` and `models`.

## Timing (from `l1-timings.event.json`)
| Call | ms | Model load ms | Outcome |
|---|---|---|---|
| R-2 (change) | 29,401 | 7,895 | ok |
| R-3 (keep) | 12,473 | 30 | ok |
| R-4 (keep) | 12,665 | 1 | ok |
| R-5 (keep) | 29,787 | 19 | ok |
| **L1 total** | **84,462** | | 0 repairs |

## Control results (from `control-results.json`)
| Check | Base: target serializer `ae9d3d2f…` (no blank-string guard) | Correct: pinned upstream 07d7196 `fee15101…` |
|---|---|---|
| CHK-1 `asNumber("")` throws "cannot be converted to a number." | **fail**: returned '0' instead of throwing | pass |
| CHK-2 `asNumber("   ")` throws, same fragment | **fail**: returned '0' instead of throwing | pass |
| CHK-3 … CHK-8, kept returns (`0`, `"0"`, `"42"`, `"-42"`, `"3.14"`, `"-3.14"`) | pass | pass |

The correct control is public upstream source already in the repository (`test/fixtures/kan106/pinned-fast-json-stringify/serializer-07d7196.js`). It was never a compiler input.

## Reproduce without a model
`node --test test/unit/kan106-staged-69e576f5.test.js` checks the file hashes, replays the recorded replies through the current compiler with the model faked (the same checks, criteria, constraint policy and scope come out), and re-runs the checks on both controls.

## What this does not show
- **One tuned request.** The prototype was developed against this request; it says nothing about other requests.
- **Model judgement remains**: which cases, how many, and the error fragment. QB checks shape and conflicts, not truth; only the controls show truth.
- **Requested tests** (AC-9) are unresolved by design: human review.
- `call_targets[].constructor_args` reads `optional` here; KAN-106 10758 renamed it `appears_optional`, because a static reading is not proof that construction succeeds.
