# KAN-106 post-integration L1 evaluation v2: plan revision 3 (FREEZE CANDIDATE, NOT AUTHORIZED)

Written for senior comment KAN-106 10838, which approved **offline preparation only**. **No model run is authorized by this document.** It becomes the frozen plan only when the senior freezes it on KAN-106 (`status.frozen` becomes `true`, a new plan version). Revision 2 is commit `5ff9d7d`.

**This document and `bench/kan106-eval-v2/plan.json` must agree.** `bench/kan106-eval-v2/plan-check.js` compares the "Normative values" table below with `plan.json` `normative`, key by key, and checks that the plan.json sha256 named below is the file's exact hash. **If they disagree, the batch refuses to launch.** Revision 2's rule that one file silently takes precedence is withdrawn. Prose outside the table is not machine-checked; reviewers check it against the table.

Branch `kan106-eval-plan`, on the evaluation candidate `2150ab6` (KAN-107 combined head, unmerged; it contains the KAN-106 prototype `f907d97`). The compiler is unchanged from `2150ab6`. This branch adds only the carried evidence, the v2 harness and this plan.

## 0. Decision being evaluated (10815, 10838)
- **`qwen2.5-coder:14b` stays the pinned L1 development candidate.** Digest `9ec8897f…8716849`, Q4_K_M. It is not a customer default and is not qualified. The digest is re-listed at run time; a different digest refuses the batch.
- **L2 and L4 stay model-disabled** (`--no-llm-context --no-llm-verify`), so the pinned model can reach only L1. **No default changes**: `QB_MODEL` still falls back to `deepseek-r1:7b`.
- **What it tests:** checklist quality from the staged L1 on 12 new requests. It does **not** test coding success (dry-run, no agent) or beta readiness.

## 1. Code under evaluation and the two freezes
- **One exact QB SHA** (`qb_under_test.sha`, named by the senior at freeze). Results from different SHAs are never pooled.
- **Freeze 1, the harness freeze, comes BEFORE the junior sees any held-out spec.** `bench/kan106-eval-v2/HARNESS-FREEZE.json` holds the sha256 of every file of the compiler under test (`qb.js`, `intent/`, `verify/`, `context/`, `lib/`, the check runner, the v1 scorer it reuses, `package*.json`) and of every harness file. `freeze.js --check-harness` runs in the launcher and in the batch. Any change refuses the batch. This is what stops control-building from turning into compiler tuning.
- **Freeze 2, the packet freeze, comes BEFORE any model call.** It is the sha256 manifest of the complete held-out packet: every request, spec, base, control, reference test and `item.json` (`freeze.js --packet`). It also covers the materialized base SHAs. These go into `plan.json` together with the host approvals, and the senior freezes that new version.

## 2. Two sets that are never mixed
### 2.1 Development set D (known; may be tuned against; never reported as held-out)
- The eight v1 items `bench/kan106-eval-v1/items/` and their evidence pack `docs/research/kan106/2026-11-19-eval-v1-881a51a/`. The pack is now carried onto this branch (§8).
- The fixtures under `test/fixtures/kan105|kan106|kan107/`, the staged run `2026-11-18-staged-69e576f5` and `bench/l1-eval/tasks.json`.
- The fake-model serialization proof replays D items only (S1, S4, S5), never H.

### 2.2 Held-out set H: a fresh owner-authored engineering set, not a blinded benchmark
- **Author.** The owner writes all 12 specs. A separate fresh drafting session may help, but it gets **only** the supported product interface and the 8+4 category mix: no contracts, no internal prompts, no prior outputs.
  - Per item, the owner writes `held-out/<ID>/request.txt` and `spec.json`. The spec gives the category, `expected` (`finalize` or `refuse`), the semantic requirements, `must_allow` and `must_protect`, and, for a refusal, the reason that makes it intended.
- **The junior never writes the requests.** After freeze 1 the junior builds `base/`, `controls/` (correct, plus `wrong-*` and scope controls), `reference.test.js` and `item.json` from each spec.
  - The controls are validated **independently of QB**: `items.js validate` uses Node built-ins only, with no compiler module and no model.
  - The senior checks the bases and controls against the specs and freezes the specs and the final semantic rulings.
- **Hashing.** The owner posts the spec manifest (`freeze.js --packet held-out --specs-only`) on KAN-106 before the junior receives the specs. The full packet hash is posted before any model call. A request is never edited after it is hashed. A replacement gets a new ID, and both IDs stay in the record.
- **Composition: 8 supported + 4 refusal.** The owner may change the mix within the supported scope before hashing.
  - Supported: an array or object argument; a request-quoted error message on a new export; an explicit protection; requested tests; a default-class method; a preservation-heavy item; two of the owner's choice.
  - Refusal: two genuinely ambiguous (a vague qualifier; a missing expected value), one unsupported call shape, and one impossible or conflicting scope.
  - Known-gap items are included on purpose.
- **Retired after one evaluation.** H then joins D.

## 3. Gates (senior, 10838), per machine, never pooled (`gates.js`)
- **Q1.** At least 7 of the 8 supported requests produce a checklist that is mechanically valid **and** human-approved as faithful.
  - A safe refusal on a supported request is a failure.
  - No finalized checklist, on any item, may invent a requirement or default, or omit a required protection. One such checklist fails Q1 outright.
  - Only the final checklist is judged. A bad intermediate draft that was correctly repaired is not automatically a failure.
- **Q2.** Zero incorrect-control acceptance and zero protected-scope weakening (mechanical or ruled).
- **Q3.** All 4 refusal items stop for the correct frozen reason (`intended_refusal`, and ruled correct). Any fabricated answer to ambiguity fails Q3, and so does a finalized checklist on a refusal item.
- **Q4.** Median ≤ 120 s and every item ≤ 180 s, using the **full elapsed L1 time including the cold load** (`l1_ms`).
  - Load-excluded numbers are secondary only.
  - The 420 s L1 budget is a kill limit, not the latency target.
- **Q5.** A profile can pass only if all 12 records are complete and scorable.
  - Any `resource_blocked`, `execution_failed` or `invalid_record`, or a missing row or ruling, makes the profile **incomplete**.
  - Every observed failure is still reported.
  - No absent run becomes a successful refusal. Denominators stay 8 and 4. No replacement and no retry.
- **Gate status** is `pass`, `fail` (an observed failure) or `incomplete`. A profile passes only if Q1–Q5 all pass. It fails if any of Q1–Q4 fails, and is otherwise incomplete.

Scoring reuses the v1 scorer's per-item checks (`score.js` `scoreItem`: record identity, artifact hashes, generated checks run unchanged on base and controls). **Scoring runs at the frozen QB SHA.** The v1 scorer reads `contractState` from the checkout it runs in (§8). Reviewers see the request, the contract and the control results, and do not see latency or load until the semantic ruling is recorded.

## 4. Resource gate, residency-aware (10838 fix 1; `resource-gate.js`, `host-snapshot.js`)
The revision 2 rule ("free ≥ model size + 2 GiB before every item") double-counted a resident model and could wrongly block a warm 18 GB Mac. Before each item, a read-only snapshot is taken: OS counters plus Ollama `/api/version` and `/api/ps` (listing only, never inference). From it:
- **Warm:** the pinned model (name **and** full digest) is resident, expires at least 120 s ahead, and was not loaded with a different context length. The requirement is then the reserve only (2 GiB). The resident model's memory is already outside "available", so it is not charged twice.
- **Cold** (anything else, including item 1, which is unloaded on purpose): the requirement is the frozen runtime estimate of 11 GiB plus the 2 GiB reserve.
  - The 11 GiB is weights 8.99 GB, plus an f16 KV cache at 8192 tokens = 1.5 GiB, plus compute buffers, rounded up.
  - **It is an estimate, not a measurement**, because measuring needs a model load. The disk size is never used as runtime memory.
- **Available memory:**
  - macOS: (vm_stat free + inactive) × page size, psutil's definition;
  - Linux: `MemAvailable`.
- **Pressure:**
  - macOS `kern.memorystatus_vm_pressure_level`: cold needs level 1 (normal); warm blocks above level 2 (warn);
  - Linux PSI `full avg10`: cold needs ≤ 1, warm ≤ 10.
- **Swap:** the gate blocks on growth of more than 256 MiB since the previous item. Swap use is recorded every time.
- **These block:** unknown capacity, pressure or swap (unknown is unavailable, never sufficient); an unavailable `/api/ps`; any other resident model.
  - A blocked item is `resource_blocked`. It is not launched, never retried, and never replaced, and the profile is incomplete.
- Fixture-tested cold and warm cases on both OSes: `test/unit/kan106-eval-v2-gate.test.js`.
- **Recorded per item, before and after:** memory, swap, pressure, top processes by RSS (basenames only), Docker state and allocation, and the Ollama version and loaded models (`size` vs `size_vram`). No hostname or user name is recorded.

## 5. Launch and serialization (10838 fix 2 and the serialization point)
- **Launcher:** `sh bench/kan106-eval-v2/run-batch.sh <PROFILE> <SHA>` is POSIX `sh`, so zsh is not required.
  - It refuses unless HEAD is the SHA, the tree is clean, the plan document and plan.json agree, and the harness freeze matches.
  - It then materializes the bases and calls `batch.js`.
- **`batch.js` refuses before any model contact** in any of these cases:
  - the plan is not frozen, or the SHA is not `qb_under_test.sha`;
  - the packet or spec manifest, or the base SHAs, differ from the frozen ones;
  - the profile has no owner-named host label, no owner approval reference, or now is outside its approved window;
  - the host does not match the profile (platform, arch, minimum RAM);
  - `intent/.env` exists;
  - the endpoint does not list the pinned digest.
- **Sequential:** one item at a time, each child awaited before the next starts. No warm-up, no retry. Item 1 is cold by design: the model is unloaded once before the batch.
- **Built child environment:** PATH, HOME, TMPDIR and LANG, plus the pinned endpoint, model, runs dir and `QB_MODEL_CONCURRENCY=1`.
- **Serialization is shown by measurement, not by the variable.** Setting `QB_MODEL_CONCURRENCY` proves nothing by itself. `test/unit/kan106-eval-v2-serial.test.js` runs the real `batch.js` and the real `qb.js` against an **instrumented fake model server** that records every `/api/chat` and `/api/generate` call's start and end and the peak number in flight.
  - Three D items: peak 1, no overlapping intervals.
  - The same with the plan's concurrency set to 8: still peak 1, because the staged L1 awaits each fact call.
  - An instrument self-test confirms the counter does detect two concurrent calls.
- **The owner must keep other Ollama clients idle during the window**, including other QB agents and sibling worktrees. The gate detects another *model* being resident, but it cannot see another client using the *same* model.

## 6. Batch size
H = 12 items × 1 run × 2 profiles = **24 runs**: the same 12 requests once on each profile, with no pooling. The L1 kill limit is 12 × 420 s = 84 min per profile; wall time also includes setup and scoring. The owner names and approves each host and its local-model time before launch, in `plan.json` `profiles.<P>`.

## 7. What this would and would not show
- **It would show**, for one pinned QB SHA, the pinned model digest and each named profile, whether the staged L1 produces faithful, scope-consistent checklists on 8 new owner-authored supported requests, refuses 4 for the right reason, and how long that takes under recorded load.
- **It would not show:**
  - a population reliability rate (n = 8 + 4, one run each);
  - run-to-run stability;
  - performance on public or customer repositories;
  - coding-task success;
  - fitness as a customer default;
  - anything about L2/L4 with Qwen;
  - anything about a profile that was not run;
  - beta readiness.

## 8. Carried evidence (10838 carry-over)
`4b50bbb` → `fcec0fc`, `cec4c60` → `66c066d` and `e5c460d` → `a87a194` were cherry-picked in that order with `-x` from `origin/kan106-staged-l1`, which is kept unchanged.
- **Every resulting blob is identical to the originals.** The three commits' changed paths (64, 1 and 7) have the same blob ids.
- **Every `HASHES.json` entry matches** (63 of 63), and the 38 artifacts are each named by their sha256.
- The raw replies, the contracts and the v2/v3/v4 scores are unchanged.
- `db18ecf` and `5975220` were not carried: they are patch-equivalent to `8e6c864` and `1ff7c66`, which are already in `2150ab6`.

**Rescore finding.**
- At this branch, the carried one-command rescore (`score.js --batch-dir <pack>`) does **not** reproduce `scores-freeze-v4.json`. S2, S3 and U2 become `invalid_record` ("outcome DRY_RUN without a finalized contract artifact").
- The cause: the scorer reads `contractState` from the running checkout, and at `2150ab6` the KAN-107 10812 validators no longer finalize those three recorded contracts. All three were already ruled failures.
- `bench/kan106-eval-v2/rescore-pinned.js --rev e5c460d` re-scores the carried records with the scorer tree as it was at the analysis revision. **It reproduces `scores-freeze-v4.json` byte for byte.**
- The pack test now asserts both results: the pinned byte-for-byte match, and exactly this three-row drift at the current checkout. The pinned case is skipped where `e5c460d` is not in the clone (CI's shallow checkout).

## 9. Approvals and inputs needed before any run (none is given here)
1. The senior reviews this freeze candidate and the harness freeze, and names `qb_under_test.sha`.
2. The owner authors the 12 specs and posts the spec manifest hash. The junior builds the bases and controls, the senior checks them and freezes the specs, and the packet hash is posted.
3. The owner names each host (a label, not a hostname) and approves its local-model time window, recorded in `profiles.<P>`. The senior freezes that plan version (`status.frozen: true`).

## Normative values (machine-checked; launch refuses on any disagreement)
plan.json sha256: `8ca0937d853feebb29ec590f4dc28f5f85610a8cbf27d2bc3d410f759b67ac7c`

| key | value |
|---|---|
| `status.version` | `3` |
| `status.kind` | `"freeze candidate"` |
| `status.frozen` | `false` |
| `status.authorizes_model_runs` | `false` |
| `model.name` | `"qwen2.5-coder:14b"` |
| `model.digest` | `"9ec8897f747e246e970bc5cfdda85d22f1123dc2e3d34978a010a75968716849"` |
| `model.quantization` | `"Q4_K_M"` |
| `model.role` | `"pinned L1 development candidate"` |
| `model.customer_default` | `false` |
| `model.default_change` | `false` |
| `qb_under_test.sha` | `null` |
| `qb_under_test.compiler_source_rev` | `"2150ab6690c4444c7cc5b9ba45e375d00d5e36a3"` |
| `qb_under_test.no_edits_after_harness_freeze` | `true` |
| `launch.ollama_url` | `"http://127.0.0.1:11434"` |
| `launch.l1_profile` | `"qwen-14b-staged"` |
| `launch.flags` | `["--agent","dry-run","--no-llm-context","--no-llm-verify","--l1-profile","qwen-14b-staged","--l1-budget","420","--deadline","15"]` |
| `launch.expected_config.agent` | `"dry-run"` |
| `launch.expected_config.llmContext` | `false` |
| `launch.expected_config.llmVerify` | `false` |
| `launch.expected_config.l1Profile` | `"qwen-14b-staged"` |
| `launch.expected_config.l1Budget` | `"420"` |
| `launch.expected_config.deadline` | `"15"` |
| `launch.per_call_ms` | `240000` |
| `launch.l1_total_ms` | `420000` |
| `launch.model_concurrency` | `1` |
| `launch.warmup` | `false` |
| `launch.l2_model_calls` | `false` |
| `launch.l4_model_calls` | `false` |
| `launch.child_timeout_ms` | `1200000` |
| `batch.items_per_profile` | `12` |
| `batch.supported` | `8` |
| `batch.refusal` | `4` |
| `batch.runs_per_item` | `1` |
| `batch.profiles` | `2` |
| `batch.total_runs` | `24` |
| `batch.retries` | `0` |
| `batch.replacements` | `0` |
| `batch.pooling_across_profiles` | `false` |
| `held_out.items_dir` | `"bench/kan106-eval-v2/held-out"` |
| `held_out.spec_author` | `"owner"` |
| `held_out.spec_review_and_freeze` | `"senior"` |
| `held_out.junior_builds` | `["base/","controls/","reference.test.js","item.json"]` |
| `held_out.junior_writes_requests` | `false` |
| `held_out.order` | `[]` |
| `held_out.spec_manifest_sha256` | `null` |
| `held_out.packet_manifest_sha256` | `null` |
| `held_out.called` | `"a fresh owner-authored engineering set, not a blinded benchmark"` |
| `gates.supported_n` | `8` |
| `gates.refusal_n` | `4` |
| `gates.q1_min_supported` | `7` |
| `gates.q4_median_ms` | `120000` |
| `gates.q4_max_ms` | `180000` |
| `gates.q4_basis` | `"full elapsed L1 time (l1_ms), cold load included"` |
| `gates.q5_all_records_complete` | `true` |
| `resource_gate.reserve_bytes` | `2147483648` |
| `resource_gate.cold_runtime_bytes` | `11811160064` |
| `resource_gate.num_ctx` | `8192` |
| `resource_gate.warm_min_remaining_s` | `120` |
| `resource_gate.swap_growth_max_bytes` | `268435456` |
| `resource_gate.darwin.available` | `"(vm_stat Pages free + Pages inactive) x page size"` |
| `resource_gate.darwin.cold_max_pressure_level` | `1` |
| `resource_gate.darwin.warm_max_pressure_level` | `2` |
| `resource_gate.linux.available` | `"/proc/meminfo MemAvailable"` |
| `resource_gate.linux.cold_max_full_avg10` | `1` |
| `resource_gate.linux.warm_max_full_avg10` | `10` |
| `resource_gate.unknown_capacity` | `"blocks"` |
| `resource_gate.other_model_loaded` | `"blocks"` |
| `profiles.P-Mac.platform` | `"darwin"` |
| `profiles.P-Mac.arch` | `"arm64"` |
| `profiles.P-Mac.min_total_memory_bytes` | `19327352832` |
| `profiles.P-Mac.host_label` | `null` |
| `profiles.P-Mac.owner_approval` | `null` |
| `profiles.P-Mac.window_start_utc` | `null` |
| `profiles.P-Mac.window_end_utc` | `null` |
| `profiles.P-Linux.platform` | `"linux"` |
| `profiles.P-Linux.arch` | `"x64"` |
| `profiles.P-Linux.min_total_memory_bytes` | `16106127360` |
| `profiles.P-Linux.host_label` | `null` |
| `profiles.P-Linux.owner_approval` | `null` |
| `profiles.P-Linux.window_start_utc` | `null` |
| `profiles.P-Linux.window_end_utc` | `null` |
