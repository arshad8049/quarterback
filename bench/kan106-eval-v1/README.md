# KAN-106 eight-request evaluation v1 (frozen package, freeze v2, NOT run)

Prepared offline for KAN-106 10758; harness fixed for the senior's review 10761 (freeze v2, see `FREEZE.json` `changes_from_v1`). The v1 freeze at `c89ddf2` was never run. **Live evaluation is not authorized**: it needs the senior's review of the 10761 harness delta and the owner's approval of the local model time first. Nothing here has been run with a model, and the staged prototype was **not** run on these requests in any form before the freeze (not even with a faked model), so the requests could not be tuned to it.

## Items (frozen order)
| ID | Category | Expected | Controls besides base and correct |
|---|---|---|---|
| S1-slug | function: change + keep (named export) | finalize | wrong-keep (drops lowercasing) |
| S2-formatter | default-class method: change + keep | finalize | wrong-keep (", " separator) |
| S3-percent | requested new export, a throw stated in the request, keep | finalize | wrong-rounding (floor), wrong-no-throw |
| S4-parsebool | explicit protection ("Do not change lib/defaults.js."), change, keeps | finalize | wrong-keep (drops "true"), wrong-scope (edits the protected file) |
| S5-clock | preservation: one change, three kept behaviours | finalize | wrong-keep (always h:mm:ss) |
| S6-money | requested tests in test/money.test.js, change, keeps | finalize | wrong-keep (drops cent padding) |
| U1-userrepo | unsupported: constructor needs a dependency the method dereferences | refuse | — |
| U2-roundto | ambiguous: "handle negative numbers properly", no expected value | refuse | — |

Each item folder holds:
- `request.txt`, the frozen request;
- `base/`, the repository the compiler sees (materialized as a one-commit git repository, `base_shas` in `FREEZE.json`);
- `controls/<name>/`, files overlaid on the base;
- `reference.test.js`, a hand-written test that validates the controls;
- `item.json`: category, expected outcome, the frozen semantic requirements, control expectations, scope expectations, and the permitted and never-permitted compiler inputs.

**Compiler inputs are only `request.txt` and the materialized `base/`.** Controls, reference tests and `item.json` never reach the compiler's repository (`materialize.js` copies `base/` only).

## Offline evidence (no model)
- `offline-control-results.json` (from `validate-controls.js`): for every item, each control under the hand-written reference test matches its stated expectation. The correct control passes every requirement, the base fails the change, and each wrong control fails the stated requirement it violates. The base's own test suite passes.
- `FREEZE.json`: the sha256 of every item file and harness file, the frozen order, model, profile, flags, budgets, and the base commit SHAs. `check-freeze.js` verifies it.

## Batch plan (owner-run, once, after both approvals)
In a clean detached checkout at the frozen commit:
```
zsh bench/kan106-eval-v1/run-batch.sh <frozen QB commit SHA>
```
1. **`run-batch.sh` refuses before any run** if HEAD is not that SHA, the tree is dirty, `FREEZE.json` doesn't match, or the materialized base SHAs differ.
2. **`batch.js` refuses before any launch** if `intent/.env` exists, or if `http://127.0.0.1:11434` does not list `qwen2.5-coder:14b` with the full frozen digest. Nothing is pulled or updated, and there is no fallback endpoint.
3. **It runs the 8 items once each, sequentially,** with a built environment: `QB_OLLAMA_URL=http://127.0.0.1:11434`, `QB_MODEL=qwen2.5-coder:14b` and `QB_RUNS_DIR=<OUT>/runs`, plus PATH, HOME, TMPDIR and LANG only. Nothing else is inherited, so an inherited endpoint, L1 budget, profile, `NODE_OPTIONS` or credential cannot change the launch.
   ```
   node qb.js "<request>" --repo <repo> --agent dry-run --no-llm-context --no-llm-verify --l1-profile qwen-14b-staged --l1-budget 420 --deadline 15
   ```
   There is no retry, and it continues after a failure. It records each exit code in `runs.json` and `batch.json`, and checks the digest again after the batch.
4. **Scoring:** `score.js --batch-dir <OUT>` writes `scores.json`.

**Budget:** the **sum of the L1 budgets** is at most 8 × 420 s = **56 minutes**. That is a time ceiling, not a token or cost ceiling. Whole-batch wall time also includes setup and scoring. No Claude, and no agent.

**Scoring:** `score.js` reports all eight rows from the frozen roster (6 supported, 2 unsupported) and computes the mechanical dimensions of `rubric.md`.
- A record that does not match its frozen item, or whose evidence is missing or corrupt, is `invalid_record`.
- A crash, timeout or transport failure is `execution_failed`.
- Neither counts as a refusal.
- Semantic review stays a person's call, against the full original request: the junior proposes, the senior reviews.

## Known limitations of this set
- **One author.** The junior wrote both the prototype and these requests. They were written from the documented supported scope, not checked against the prototype, but the author knows the prototype's accepted sentence shapes: S4's "Do not change <file>." is one, and S6's "Add node:test cases in <file>." is another. The owner or senior may replace any request before the freeze is approved; a replacement means a new freeze.
- **Synthetic repositories only**, small and CommonJS. No public repository is in this set.
- **No "new file" item.** S3 asks for a new export in an existing file.
- **Wrong controls are task-specific.** Each violates a behaviour the request states explicitly; none is an adversarial search. Passing them is necessary, not sufficient.
- **Refusal items.** U1 targets a rule added in 10758 (`kan106-10758-constructor.test.js`). U2 has no rule written for it: a finalized checklist there means expected behaviour was invented.
- **Intended-refusal decisions.** They were written into `item.json` `refusal_evidence` from the compiler's documented refusal messages. The prototype was not run on U1 or U2 to see what it records.
