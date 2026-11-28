# KAN-106 post-integration L1 evaluation v2: plan revision 4 (FREEZE CANDIDATE, NOT AUTHORIZED)

Written for senior comment KAN-106 10849. Revision 3 (10838) was `9bdbfa6`, kept as branch `kan106-eval-plan-pre118`. **No model run is authorized by this document.** It becomes the frozen plan only when the senior sets `status.frozen` to `true` and names `qb_under_test.sha`, as a new plan version. The junior sets neither.

**This document and `bench/kan106-eval-v2/plan.json` must agree.** `bench/kan106-eval-v2/plan-check.js` compares the "Normative values" table below with `plan.json` `normative`, key by key. It also checks that the plan.json sha256 named below is the file's exact hash. **Any disagreement refuses launch.** Nothing silently takes precedence. Prose outside the table is not machine-checked; reviewers check it against the table.

## 0. Decision being evaluated (10815, 10838, 10849)
- **`qwen2.5-coder:14b` stays the pinned L1 development candidate.** Digest `9ec8897f…8716849`, Q4_K_M. It is re-listed at run time, and a different digest refuses the batch.
- **No customer-default switch to Qwen.** The `QB_MODEL` fallback stays `deepseek-r1:7b`, unchanged.
- **L2 and L4 stay model-disabled** (`--no-llm-context --no-llm-verify`).
- **What it tests:** checklist quality only. Not coding success (dry-run), and not beta readiness.

## 1. Evaluation candidate and the freezes
- **Candidate:** `2150ab6` (KAN-107 combined head, unchanged on `kan107-consistency-design`), plus KAN-118 (PR #35, `g5c-docker-down-commit` @ `5ebb8c8`).
  - They are merged as `f1ddad4` on branch `kan106-eval-candidate-118`.
  - The merge changes only `lib/sandbox/*` (G5c), their tests, `docs/security/agent-sandbox.md`, and website files from main `ff3585c`.
  - `qb.js`, `intent/`, `verify/` and `context/` are byte-identical to `2150ab6`.
- **This plan branch:** `kan106-eval-plan-118`, rebuilt on `f1ddad4`. It adds the carried evidence, the v2 harness and this plan.
- **Freeze 1, the harness freeze, comes BEFORE the 12 requests are revealed.**
  - `HARNESS-FREEZE.json` holds the sha256 of every compiler file under test (`qb.js`, `intent/`, `verify/`, `context/`, `lib/`, the check runner, the v1 scorer it reuses, `package*.json`) and of every harness file.
  - It is regenerated at the integrated head **after CI passes there**.
  - Any change refuses the batch. The compiler is never tuned after the requests are seen.
- **The qb_under_test binding.** `plan.json` cannot contain its own commit's SHA. So the senior names `qb_under_test.sha` as the CI-green code commit, and the launch head must satisfy both of these, or launch refuses (`freeze.js` `revisionProblems`):
  - it **descends** from `qb_under_test.sha`;
  - it differs from it **only** in `bench/kan106-eval-v2/plan.json`, `bench/kan106-eval-v2/held-out/` and `docs/`.
  - The junior's proposed value is in `plan.json` `proposed` (not normative): `d30e8eda4af1932937677752ceea88cc53775c75` (branch `kan106-eval-plan-main`, on candidate `564ea03` = `f1ddad4` + main `bb56ff6`), the code head on which CI run 46104807881 passed every job. The earlier proposal `0d5a697` (branch `kan106-eval-plan-118`) is kept there unchanged. `HARNESS-FREEZE.json` was regenerated there after CI and is byte-identical.
- **Freeze 2, the packet freeze, comes before any model call.** It is the hash manifest of the complete held-out packet (`freeze.js --packet`) plus the base SHAs. The owner's spec-only manifest is posted first.

## 2. Two sets that are never mixed
- **D, development.** The eight v1 items, the evidence pack `2026-11-19-eval-v1-881a51a` (carried, §8), and the fixtures under `test/fixtures/kan105|kan106|kan107`. The fake-model serialization proof uses D items only.
- **H, held-out: a fresh owner-authored engineering set, not a blinded benchmark.**
  - **Authoring.** The owner writes all 12 specs (`request.txt` and `spec.json`). A fresh drafting session may help if it is given only the supported interface and the 8+4 mix.
  - **The junior's part.** The junior builds bases, controls, reference tests and `item.json` only. The controls are validated independently of the compiler (`items.js`).
  - **Freezing and retirement.** The senior freezes the specs and the final rulings. No request is ever edited after hashing. H is retired into D after one evaluation.
  - **Composition: 8 supported + 4 refusal.**
    - Supported: an array or object argument; a request-quoted error on a new export; an explicit protection; requested tests; a default-class method; a preservation-heavy item; two of the owner's choice.
    - Refusal: two genuinely ambiguous, one unsupported call shape, one impossible or conflicting scope.

## 3. Gates (senior, 10838), per machine, never pooled (`gates.js`)
- **Q1.** At least 7/8 supported requests produce checklists that are mechanically valid **and** human-approved as faithful.
  - A safe refusal on a supported request is a failure.
  - Any finalized checklist that invents a requirement or default, or omits a required protection, fails Q1 outright.
  - A bad intermediate draft that was correctly repaired is not automatically a failure.
- **Q2.** Zero incorrect-control acceptance and zero protected-scope weakening.
- **Q3.** All 4 refusal items stop for the correct frozen reason. Any fabricated answer to ambiguity fails Q3.
- **Q4.** Median ≤ 120 s and every item ≤ 180 s, on the **full elapsed L1 time including the cold load and any reload**. Load-excluded numbers are secondary. 420 s is a kill limit, not the target.
- **Q5.** A profile passes only if all 12 records are complete and scorable.
  - `resource_blocked`, `execution_failed`, `invalid_record` or a missing row or ruling makes the profile **incomplete**.
  - Observed failures are still reported.
  - No absent run is a successful refusal. Denominators stay 8 and 4. No replacement and no retry.
  - Unplanned model reloads are listed here (§4).

**Scoring runs at the frozen code** (§8).

## 4. Resource gate and keep-alive policy (10838 fix 1, revised for 10849)
Before each item there is a read-only snapshot: OS counters plus Ollama `/api/version` and `/api/ps` (listings only).
- **Cold rule** (item 1, which is unloaded on purpose, and any item not provably warm): requires 11 GiB + the 2 GiB reserve.
  - The **11 GiB is a provisional, conservative engineering admission assumption, not a measurement.** It is weights 8.99 GB + f16 KV at 8192 tokens 1.5 GiB + buffers. Measuring it needs a model load.
  - Disk size is never used as runtime memory.
- **Insufficient memory makes the item `resource_blocked`.** The item is not launched and the profile is incomplete. It is **never a model failure**.
- **Available memory:**
  - macOS: (vm_stat free + inactive) × page size. This is **an estimate**, so the pressure and swap checks are kept.
  - Linux: `MemAvailable`.
- **Pressure:**
  - macOS level: cold needs ≤ 1, warm blocks above 2;
  - Linux PSI full avg10: cold ≤ 1, warm ≤ 10.
- **Swap:** growth over 256 MiB since the previous item blocks.
- **Unknown values block:** unknown capacity, pressure, swap or `/api/ps` all block, and so does any other resident model.
- **Keep-alive (10849).** A loaded model may expire during a 420 s item, so 120 s of remaining residency was not enough.
  - What QB does: it sends no `keep_alive`, so the server's setting governs.
  - What Ollama does (verified from its source, main branch, fetched 2026-11-27; **not yet verified against the pinned server version**):
    - `envconfig.KeepAlive` defaults to 5 min. `OLLAMA_KEEP_ALIVE` takes a Go duration or seconds; a negative value means infinite and 0 means none.
    - `server/sched.go` `useLoadedRunner` stops the expiry timer while a request uses the runner.
    - `processCompleted` restarts it (`expiresAt = now + sessionDuration`) only when the last request finishes.
  - **Frozen policy:**
    - The owner starts the server for the window with `OLLAMA_KEEP_ALIVE=-1`, or a duration of at least 21 min.
    - An item is admitted **warm** only if `/api/ps` shows the pinned name and digest resident with **at least 1260 s** left (the 1200 s child ceiling + 60 s).
    - That covers the whole item even if no call refreshes the timer.
    - Anything less, including Ollama's default 5 min, is held to the **cold rule**, so a possible reload is charged in full.
  - **Detection:** any model load ≥ 1 s that the admission did not plan for (any load in a warm-admitted item, or a second load in a cold one) is recorded as `unplanned_reload` and reported in Q5. Its time is already in Q4.
  - The pinned model is unloaded again after the last item.
  - Whether an unplanned reload should also make the profile incomplete is a senior decision. It is not applied.
- Fixture tests cover cold, warm and keep-alive on macOS and Linux (`test/unit/kan106-eval-v2-gate.test.js`).

## 5. Launch and serialization
- **Launcher:** `sh bench/kan106-eval-v2/run-batch.sh <PROFILE> <launch head SHA>` is POSIX `sh` (dash-tested).
- **`batch.js` refuses before any model contact** in any of these cases:
  - the plan is not frozen;
  - the revision binding fails (§1);
  - the profile is not in `batch.authorized_profiles`;
  - the packet, spec or base hashes do not match;
  - the profile lacks an owner host label, an approval reference, or a current window;
  - the host does not match the profile;
  - `intent/.env` exists;
  - the digest does not match.
- Items run strictly one at a time, each child awaited, with no warm-up and no retry. The child environment is built rather than inherited, with `QB_MODEL_CONCURRENCY=1` (defence in depth only).
- **Serialization is measured** (`test/unit/kan106-eval-v2-serial.test.js`): the real `batch.js` and the real `qb.js` run on 3 D items against an instrumented fake model server.
  - Peak in flight is 1, with no overlap.
  - With concurrency set to 8: still 1.
  - The instrument self-test detects 2.
- **The owner keeps other Ollama clients idle during the window**, including QB agents and sibling worktrees.

## 6. Profiles: Mac first; Linux optional, separate, never pooled
- **P-Mac is staged first.** It runs only after its packet and window are authorized (`batch.authorized_profiles` is empty in this candidate).
- **The batch for P-Mac:** 12 items × 1 run = 12 runs. The L1 kill limit is 84 min; wall time also includes setup and scoring.
- **P-Linux is optional and not scheduled.** No Linux host is assumed to exist. If one is named later, it gets its own authorization and its own 12 runs. It is never pooled with P-Mac or inferred from it.

## 7. What this would and would not show
- **It would show**, for one pinned code commit, the pinned model and each profile run, whether the staged L1 writes faithful, scope-consistent checklists on 8 new owner-authored requests and refuses 4 for the right reason, with latency under recorded load.
- **It would not show:**
  - a population reliability rate (n = 8 + 4, one run each);
  - run-to-run stability;
  - public or customer repositories;
  - coding success;
  - fitness as a customer default;
  - L2/L4 with Qwen;
  - any profile not run;
  - beta readiness.

## 8. Carried evidence and historical re-scoring (10838, 10849)
- **Carry-over.** `4b50bbb`, `cec4c60` and `e5c460d` were carried in that order (first as `fcec0fc`, `66c066d`, `a87a194`; rebuilt here as `7f9f4ee`, `11b4e74`, `78abfef`). The source branch `kan106-staged-l1` is unchanged.
  - Every resulting blob id is identical to the originals, `HASHES.json` matches 63/63, and the raw replies, contracts and old scores are unchanged.
  - `db18ecf` and `5975220` were not duplicated: they are patch-equivalent to `8e6c864` and `1ff7c66`, which are already in `2150ab6`.
- **The original result** (`scores-freeze-v4.json`) is reproduced byte for byte with the scorer tree of its analysis revision: `bench/kan106-eval-v2/rescore-pinned.js --rev e5c460d`. **The senior accepted this in 10849.**
  - The CI job `kan106-offline-evidence` **fetches `e5c460d` explicitly** and runs it with `QB_KAN106_PINNED_REQUIRED=1`, so a missing commit fails there.
  - In the shallow unit jobs the test skips with the message "NOT RUN", and is never reported as having run there.
- **Current-validator drift is kept separately:** `docs/research/kan106/eval-v1-881a51a-current-validator-drift.json`, labelled "not a new result".
  - Under the current validators, S2 and S3 (`checklist`) and U2 (`not_refused`) become `invalid_record`, because the recorded contracts are no longer finalized.
  - All three were already ruled failures.

## 9. Approvals and inputs needed before any run (none is given here)
1. **Senior:**
   - review this candidate;
   - name `qb_under_test.sha` (proposal in `plan.json` `proposed`);
   - rule on unplanned reloads (§4);
   - after the packet freeze, set `status.frozen` and `batch.authorized_profiles: ["P-Mac"]`.
2. **Owner:**
   - write the 12 specs and post the spec manifest hash;
   - name the Mac by a label, not a hostname, and approve its local-model window (`profiles.P-Mac`);
   - set `OLLAMA_KEEP_ALIVE` for the window and confirm the server version, so the keep-alive behaviour can be re-checked against its source.
3. **Junior, after the specs arrive:** build the bases and controls, run `items.js validate` (no QB compiler), and post the packet hash.

## Normative values (machine-checked; launch refuses on any disagreement)
plan.json sha256: `b19344e56a8c1b5d1e81baf0206e1b4fa0a767b1f42cc3f6c7e14c25d3d15590`

| key | value |
|---|---|
| `status.version` | `4` |
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
| `qb_under_test.kan118_integrated` | `"5ebb8c872d6cb0100a8e358e5eb3293b15aa32ab"` |
| `qb_under_test.no_edits_after_harness_freeze` | `true` |
| `qb_under_test.launch_head_may_change_only` | `["bench/kan106-eval-v2/plan.json","bench/kan106-eval-v2/held-out/","docs/"]` |
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
| `batch.retries` | `0` |
| `batch.replacements` | `0` |
| `batch.pooling_across_profiles` | `false` |
| `batch.staging_order` | `["P-Mac"]` |
| `batch.authorized_profiles` | `[]` |
| `batch.optional_profiles` | `["P-Linux"]` |
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
| `resource_gate.warm_min_remaining_s` | `1260` |
| `resource_gate.swap_growth_max_bytes` | `268435456` |
| `resource_gate.darwin.available` | `"(vm_stat Pages free + Pages inactive) x page size"` |
| `resource_gate.darwin.cold_max_pressure_level` | `1` |
| `resource_gate.darwin.warm_max_pressure_level` | `2` |
| `resource_gate.linux.available` | `"/proc/meminfo MemAvailable"` |
| `resource_gate.linux.cold_max_full_avg10` | `1` |
| `resource_gate.linux.warm_max_full_avg10` | `10` |
| `resource_gate.unknown_capacity` | `"blocks"` |
| `resource_gate.other_model_loaded` | `"blocks"` |
| `resource_gate.cold_runtime_status` | `"provisional conservative admission assumption (not measured)"` |
| `resource_gate.insufficient_memory` | `"resource_blocked: profile incomplete, never a model failure"` |
| `resource_gate.keep_alive.qb_sends_keep_alive` | `false` |
| `resource_gate.keep_alive.server_default_s` | `300` |
| `resource_gate.keep_alive.owner_sets` | `"OLLAMA_KEEP_ALIVE=-1 (or a duration >= 21m) on the Ollama server for the window"` |
| `resource_gate.keep_alive.warm_requires_remaining_s` | `1260` |
| `resource_gate.keep_alive.basis` | `"child_timeout_ms 1200 s + 60 s margin: the expiry timer runs only while the model is idle and is reset after each request, so 1260 s remaining covers the whole item even with no call"` |
| `resource_gate.keep_alive.otherwise` | `"cold rule (a possible reload is charged in full)"` |
| `resource_gate.keep_alive.reload_detect_load_ms` | `1000` |
| `resource_gate.keep_alive.release_after_batch` | `true` |
| `resource_gate.keep_alive.verify_against_pinned_ollama_before_launch` | `true` |
| `profiles.P-Mac.platform` | `"darwin"` |
| `profiles.P-Mac.arch` | `"arm64"` |
| `profiles.P-Mac.min_total_memory_bytes` | `19327352832` |
| `profiles.P-Mac.host_label` | `null` |
| `profiles.P-Mac.owner_approval` | `null` |
| `profiles.P-Mac.window_start_utc` | `null` |
| `profiles.P-Mac.window_end_utc` | `null` |
| `profiles.P-Mac.status` | `"staged first (packet and window still to be authorized)"` |
| `profiles.P-Linux.platform` | `"linux"` |
| `profiles.P-Linux.arch` | `"x64"` |
| `profiles.P-Linux.min_total_memory_bytes` | `16106127360` |
| `profiles.P-Linux.host_label` | `null` |
| `profiles.P-Linux.owner_approval` | `null` |
| `profiles.P-Linux.window_start_utc` | `null` |
| `profiles.P-Linux.window_end_utc` | `null` |
| `profiles.P-Linux.status` | `"optional; not scheduled; needs its own authorization; never pooled with P-Mac"` |
