# KAN-106 eight-request evaluation v1: scoring rubric (frozen)

Set by the senior in KAN-106 10758, before any run. These are demanding **development gates**, not statistical reliability claims, and not permission to merge or enable the staged prototype by default.

## Per item

Each item is run **once**, at one pinned QB commit, with `qwen2.5-coder:14b`, `--l1-profile qwen-14b-staged`, `--agent dry-run --no-llm-context --deadline 15`, and at most 420 s of L1 in total (240 s per call, repairs included). There are no discretionary reruns. The implementation is not edited after an outcome is seen while still calling it this evaluation.

| Dimension | How it is decided | By |
|---|---|---|
| Structural validity | The run's `contract` artifact exists and `contractState` says `finalized` | `score.js` |
| **Semantic review** | Every frozen requirement in `item.json` is represented by a checklist criterion with the right call, inputs, types and expected value (or throw and fragment). Requested-test adequacy may stay explicitly human-reviewed. | **a person** (junior proposes; senior reviews) |
| Correct control | Every generated check passes on the correct control | `score.js` (real check runner, checks unchanged) |
| Base control | At least one generated check fails on the base | `score.js` |
| Wrong controls | No `wrong-*` control passes every generated check. A wrong control that does is an **incorrect control acceptance**. (`wrong-scope` in S4 is judged by scope, not by checks.) | `score.js` |
| Unresolved coverage | Criteria without a check, listed | `score.js` |
| Scope and protection | `must_allow` files are allowed; `must_protect` files are matched by `scope.protected_paths`; the S4 `wrong-scope` control's changed file is refused by protected paths | `score.js` (L4 policy matcher) |
| Elapsed time | L1 ms from the run's `l1.timings` event | `score.js` |
| Model identity | The configured model and the model each fact reply reports | `score.js` |
| Repairs | Fact-call repairs within the budget, recorded | `score.js` |

A **safe refusal on a supported item is not semantic success.** The refusal items (U1, U2) are scored only on whether they refused safely: no finalized checklist and no agent launch. They are counted separately, never in a combined success percentage.

## Engineering progression thresholds (predeclared, 10758)

1. **6/6 supported requests** produce semantically correct, reviewable checklists with all required behaviour represented. Requested-test adequacy may remain explicitly human-reviewed.
2. **No incorrect control acceptance** and **no protected-scope weakening**.
3. **2/2 unsupported cases safely refuse.**
4. **Latency:** median L1 ≤ 120 s, and each ≤ 180 s. A latency miss is reported **separately from correctness**.

Missing any of 1–3 means the staged prototype does not progress on this evidence. The result is reported per item either way.
