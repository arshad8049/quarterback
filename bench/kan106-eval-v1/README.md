# KAN-106 eight-request evaluation v1 (frozen package, NOT run)

Prepared offline for KAN-106 10758. **Live evaluation is not authorized**: it needs the senior's review of this frozen package and the owner's approval of the model time first. Nothing here has been run with a model, and the staged prototype was **not** run on these requests in any form before the freeze (not even with a faked model), so the requests could not be tuned to it.

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
1. **Refuses before any run** if HEAD is not that SHA, the tree is dirty, `FREEZE.json` doesn't match, the materialized base SHAs differ, or Ollama / `qwen2.5-coder:14b` is unavailable.
2. **Runs the 8 items once each, sequentially:**
   ```
   QB_MODEL=qwen2.5-coder:14b node qb.js "<request>" --repo <repo> --agent dry-run --no-llm-context --l1-profile qwen-14b-staged --deadline 15
   ```
   No retry, and it continues after a failure.
3. **Writes** logs, `runs.json`, the Ollama tags and `scores.json` under `~/qb-evidence/kan106-eval-v1/<UTC time>/`.

At most 8 × 420 s = **56 minutes of L1 model time**. That is a time ceiling, not a token or cost ceiling. No Claude, and no agent.

**Scoring:** `score.js` computes the mechanical dimensions of `rubric.md`. Semantic review stays a person's call: the junior proposes, the senior reviews.

## Known limitations of this set
- **One author.** The junior wrote both the prototype and these requests. They were written from the documented supported scope, not checked against the prototype, but the author knows the prototype's accepted sentence shapes: S4's "Do not change <file>." is one, and S6's "Add node:test cases in <file>." is another. The owner or senior may replace any request before the freeze is approved; a replacement means a new freeze.
- **Synthetic repositories only**, small and CommonJS. No public repository is in this set.
- **No "new file" item.** S3 asks for a new export in an existing file.
- **Wrong controls are task-specific.** Each violates a behaviour the request states explicitly; none is an adversarial search. Passing them is necessary, not sufficient.
- **Refusal items.** U1 targets a rule added in 10758 (`kan106-10758-constructor.test.js`). U2 has no rule written for it: a finalized checklist there means expected behaviour was invented.
