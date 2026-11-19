# KAN-106 eight-request evaluation v1: scoring rubric (frozen)

Set by the senior in KAN-106 10758, before any run. These are demanding **development gates**, not statistical reliability claims, and not permission to merge or enable the staged prototype by default.

## Per item

Each item is run **once**, at one pinned QB commit, with `qwen2.5-coder:14b` at its frozen digest on the local endpoint `http://127.0.0.1:11434`, `--l1-profile qwen-14b-staged --l1-budget 420`, `--agent dry-run --no-llm-context --no-llm-verify --deadline 15`, and at most 420 s of L1 in total (240 s per call, repairs included). There are no discretionary reruns. The implementation is not edited after an outcome is seen while still calling it this evaluation.

**Every row comes from the frozen roster** (10761): the denominators are always 6 supported and 2 unsupported. Before any result is assigned, the record must match its frozen item: run id, QB revision, request, base SHA, configured and replying model, profile, effective L1 budget (420 s from `--l1-budget`) and 240 s per-call cap, flags, dry-run agent, local endpoint, and an exit code consistent with the outcome. Artifacts are verified against their manifest sha256. A mismatch, or missing or corrupt evidence, is `invalid_record` (inconclusive). A crash, timeout or model/transport failure is `execution_failed`. Neither is ever a refusal.

| Dimension | How it is decided | By |
|---|---|---|
| Structural validity | The run's `contract` artifact exists and `contractState` says `finalized` | `score.js` |
| **Semantic review** | Against the **full original request**, not only `item.json`: every stated behaviour is represented by a checklist criterion with the right call, inputs, types and expected value (or throw and fragment). For example, S3's general rounding rule and its exact error message must not shrink to two examples. Requested-test adequacy may stay explicitly human-reviewed. | **a person** (junior proposes; senior reviews) |
| Correct control | Every generated check passes on the correct control | `score.js` (real check runner, checks unchanged) |
| Base control | At least one generated check fails on the base | `score.js` |
| Wrong controls | No `wrong-*` control passes every generated check. A wrong control that does is an **incorrect control acceptance**. (`wrong-scope` in S4 is judged by scope, not by checks.) | `score.js` |
| Unresolved coverage | Criteria without a check, listed | `score.js` |
| Scope and protection | `must_allow` files are allowed; `must_protect` files are matched by `scope.protected_paths`; the S4 `wrong-scope` control's changed file is refused by protected paths | `score.js` (L4 policy matcher) |
| Elapsed time | L1 ms from the run's `l1.timings` event | `score.js` |
| Model identity | The configured model and the model each fact reply reports | `score.js` |
| Repairs | Fact-call repairs within the budget, recorded | `score.js` |

A **safe refusal on a supported item is not semantic success.** The refusal items (U1, U2) are scored separately, never in a combined success percentage:

| Result | Meaning |
|---|---|
| `intended_refusal` (pass) | BLOCKED with the task-relevant L1 decision frozen in `item.json` `refusal_evidence`, no finalized checklist, no agent launch. U1: an unsupported call shape naming `UserRepo` and its constructor, before any model call. U2: a clarification/ambiguity stop. |
| `blocked_other_reason` | Execution was safely blocked, but for another reason (for example model output QB refused, or a different refusal). **Not** an intended refusal. |
| `not_refused` | A finalized checklist or a completed run. |
| `execution_failed` / `invalid_record` | As above; never a refusal. |

## Engineering progression thresholds (predeclared, 10758)

1. **6/6 supported requests** produce semantically correct, reviewable checklists with all required behaviour represented. Requested-test adequacy may remain explicitly human-reviewed.
2. **No incorrect control acceptance** and **no protected-scope weakening**.
3. **2/2 unsupported cases are `intended_refusal`** (refused for the right reason).
4. **Latency:** median L1 ≤ 120 s, and each ≤ 180 s. A latency miss is reported **separately from correctness**. Missing timings are counted; a median over fewer than six supported items is labelled as such, never as complete coverage.

Missing any of 1–3 means the staged prototype does not progress on this evidence. The result is reported per item either way.
