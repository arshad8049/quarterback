# KAN-106 post-integration L1 evaluation, plan v2 (PLAN ONLY, NOT AUTHORIZED)

Written for senior comment KAN-106 10815. **No model run is authorized by this document.** It becomes a frozen plan only when the senior approves it on KAN-106. After that, any change to this file or to `bench/kan106-eval-v2/plan.json` is a new plan version. The machine-readable copy is `bench/kan106-eval-v2/plan.json`. If the two disagree, the JSON wins, and the disagreement is reported as a defect.

Written on branch `kan106-eval-plan`, off the KAN-107 combined head `kan107-consistency-design` @ `2150ab6690c4444c7cc5b9ba45e375d00d5e36a3` (unmerged; it contains the unmerged KAN-106 prototype `f907d97`). The plan reads that code and does not change it. Every file and flag named below was checked to exist at `2150ab6`, unless it is marked **(proposed, does not exist)**.

## 0. Decision being evaluated (10815)
- **`qwen2.5-coder:14b` is the explicitly selected L1 *development* candidate.** It is not a customer default, and neither candidate is qualified.
  - Pinned digest: `9ec8897f747e246e970bc5cfdda85d22f1123dc2e3d34978a010a75968716849`, Q4_K_M.
  - That digest was listed on the owner's Mac on 2026-11-19, under Ollama 0.40.16, in `bench/kan106-eval-v1/FREEZE.json` `model_digest_source`. It must be re-listed at run time. A different digest is a different model, and the batch refuses.
- **The global default stays as it is.** `QB_MODEL` still falls back to `deepseek-r1:7b` in `intent/compiler.js`, `intent/staged.js`, `context/builder.js`, `verify/judge.js`, `lib/doctor.js` and `lib/budget.js`. The L2 and judge models are untouched.
- **How the L1 role is isolated today.** The batch builds the child environment rather than inheriting it (the same approach as `bench/kan106-eval-v1/batch.js`):
  - It sets `QB_MODEL=qwen2.5-coder:14b`.
  - It passes `--no-llm-context --no-llm-verify`, so L2 enrichment and the L4 judge make no model call. The pinned model can therefore reach only L1.
  - This isolation holds only while both of those flags are set.
- **A role-specific L1 model setting does not exist at `2150ab6`.** `lib/budget.js` `L1_PROFILES` (`qwen-14b-experimental`, `qwen-14b-staged`) sets only time budgets and the staged compiler, not the model. To run L1 = Qwen together with model-backed L2/L4, QB would need the following **(proposed, not built)**:
  - an `l1_model` and `l1_model_digest` on the profile, or a `QB_L1_MODEL` variable, read only by `intent/compiler.js` and `intent/staged.js`;
  - a digest check before the first L1 call;
  - the L1 model and digest recorded in the run manifest, separately from `models`.
  - `qb doctor` would also have to check both models.
  - None of this is needed for this plan, because L2 and L4 stay off.

## 1. Code under evaluation
- **One exact QB SHA**, named in the freeze. It is either the 107 combined head or its merged successor on `main`. Results from different SHAs are never pooled.
- **Nothing is edited between the held-out hash and the end of scoring:** not `intent/`, `lib/budget.js`, `verify/`, `qb.js` nor the harness. A change after any held-out result has been seen ends that evaluation. The next one needs a new held-out set (§2.3).

## 2. Two sets that are never mixed
### 2.1 Development / regression set D (known; may be tuned against; never reported as held-out)
| Source | What | How it is used |
|---|---|---|
| `bench/kan106-eval-v1/items/` S1-slug, S2-formatter, S3-percent, S4-parsebool, S5-clock, S6-money, U1-userrepo, U2-roundto | The eight KAN-106 items. Base SHAs are in `bench/kan106-eval-v1/FREEZE.json` (freeze v3 at `2150ab6`; freeze v4, labels only, exists only on `kan106-staged-l1` @ `e5c460d`). | Offline first: `validate-controls.js`, `check-freeze.js`, `replay-validators.js` (with `--pack` from `e5c460d`). A model run is allowed only as a separately labelled **development batch**. |
| `test/fixtures/kan106/` (b2416ebc, eba7015e, 0ae9efc9, e578f99b, b7a4bfe2, export-mutations, pinned-fast-json-stringify; labels in `FIXTURES.md`) | Observed smoke drafts and replies, plus synthetic and pinned-source fixtures | Unit regressions only (no model) |
| `docs/research/kan106/2026-11-18-staged-69e576f5/` | The staged run that finalized in 84.5 s | A development observation. **Not** a latency or quality claim (§6). |
| `test/fixtures/kan105/`, `test/fixtures/kan107/` | Scope-consistency and protection drafts | Unit regressions only |
| `bench/l1-eval/tasks.json` (greeting, cart, clamp, duration, slugify, port) | The earlier proxy-scored L1 tasks | Development only |

The full unit suite (`npm test`) must be green at the frozen SHA on CI Node 20, 22 and 24 before any held-out run. A D-set model batch, if one is authorized, is reported on its own. It never adds to a held-out denominator.

### 2.2 Held-out set H (new requests; never tuned against)
- **Author.** Not the junior, who wrote the prototype and the eight D requests. The proposal is that the senior or the owner writes them, or a fresh session that has no access to `intent/`, the D results or the prototype prompts (the KAN-117 packet method).
  - The author writes, per item: `request.txt` and a short `item.json` spec (category; expected `finalize` or `refuse`; the semantic requirements; `must_allow` / `must_protect`; for a refusal, the reason that would make it intended).
- **Junior role.** The junior builds only `base/` and `controls/` from that spec, and the reference test that validates the controls. The author or the senior then checks that `base/` and the controls match the spec.
- **Hash before anything runs.**
  - The author posts the sha256 of every `request.txt` and `item.json` on KAN-106, plus a manifest hash, before the prototype touches the requests in any form (no model run, no fake-model run, no replay).
  - The full freeze (base SHAs, controls, harness hashes) is posted before the first model call.
- **Never edited.** A request is never edited after it is hashed. If one is replaced, the replacement gets a new item ID, and both IDs stay in the record.
- **Retired after one evaluation.** After the evaluation, H joins D. The next evaluation needs a new H.
- **Proposed composition, 12 items.** The author may change the mix before hashing.
  - **8 supported.** They must be within the documented staged scope, and must include:
    - one array or object argument (the S2 gap);
    - one request-quoted error message for a new export (the S3 gap);
    - one explicit protection;
    - one requested-tests item;
    - one default-class method;
    - one preservation-heavy item;
    - two of the author's choice.
  - **4 refusal.** Two genuinely ambiguous (a vague qualifier, and a missing expected value); one unsupported call shape; one impossible or conflicting scope (KAN-105).
  - Known-gap items are included on purpose. Failing them is a recorded result, not a reason to drop the item.

## 3. Scoring (human review required)
`bench/kan106-eval-v1/score.js` and `rubric.md` are reused for the mechanical part. The pieces this plan needs on top are **(proposed, do not exist)**: a `bench/kan106-eval-v2/` copy of `batch.js` and `score.js` with the H roster, plus the dimensions below.

**Rule: "validator finalized" alone is never correctness.** An item counts as a success only when it is finalized, passes the mechanical gates, and is ruled acceptable by a person against the full original request.

| Dimension | Decided by | Fail examples |
|---|---|---|
| D1 **Faithful requirement coverage.** Every stated behaviour appears as a criterion. A general rule must not shrink to an example unless it is labelled "sampled coverage" (the S1/S5 ruling in 10770). | Person; `score.js` lists unresolved criteria | A dropped message (S3) or a dropped kept behaviour |
| D2 **Real target and API, and argument binding:** the right module, export or method, `new` versus function call, argument count, shapes and types | `score.js` controls, then a person | Changed argument shapes (S2); an invented export |
| D3 **Consistent permissions and scope:** `must_allow` is allowed, `must_protect` is protected, no protection is weakened, and `contractState` is consistent (KAN-105/107) | `score.js` (L4 policy matcher), then a person | A protected file in `allowed_changes` |
| D4 **Required tests:** an `adds_tests` criterion when the request asks for tests. Adequacy stays human-reviewed. | Person | No requested-tests criterion |
| D5 **Genuine ambiguity or refusal:** `intended_refusal` with the frozen decision, on the refusal items only. A safe refusal on a supported item is not a success. | `score.js`, then a person | U2-style: finalized with made-up values |
| D6 **Forbidden or invented defaults:** any expected value, error text or behaviour that is in neither the request nor the grounded source. Reviewers list each one. | Person | Model-proposed defaults that became requirements |
| Mechanical | `score.js`: the correct control passes every generated check, the base fails at least one, and no `wrong-*` control passes all of them | Incorrect control acceptance |

**Review process.** The junior writes `semantic-review-proposed.json`, and the senior rules in `semantic-review-ruled.json`, the same files as v1.

**Who sees what.** The reviewers see the request, the contract and the control results. They do not see latency or load data until the semantic ruling is recorded.

## 4. Capability versus load
Every run records both. Load can make a run fail or be slow. It is never read as a semantic result, and a semantic result is never excused by load.

**Recorded per batch, before and after:**
- **Model:**
  - name and full digest (`/api/tags`, as `batch.js` does now);
  - quantization and parameter size (Ollama `/api/show`, `details`);
  - context limit (`num_ctx` 8192 and temperature 0, hard-coded in `intent/staged.js` `callModel`);
  - per-call cap 240 s and L1 total 420 s (`qwen-14b-staged`, `--l1-budget 420`), and run deadline `--deadline 15`.
- **Ollama:** version (`/api/version`), and the loaded models with `size` versus `size_vram`, which shows CPU/GPU offload (`/api/ps`).
- **Host:**
  - OS, CPU model and count, physical RAM;
  - free memory and swap use (macOS: `vm_stat`, `sysctl vm.swapusage`, `memory_pressure`; Linux: `/proc/meminfo`, `/proc/pressure/memory`).
- **Docker:** running or not, and its allocation (`docker info` MemTotal and NCPU). This eval runs no container.
- **Other processes:** the top processes by resident memory, and any other loaded model.
- **Cold or warm:** `load_ms` per call is already recorded in the `l1.timings` event (`intent/staged.js` reads Ollama's `load_duration`). The model is unloaded before the batch, so item 1 is cold by design. `--l1-warmup` is **not** used, so the first item's cold load is visible rather than hidden.

The snapshot tool is **(proposed, does not exist)**: `bench/kan106-eval-v2/host-snapshot.js`, read-only, with no model call. The `l1-eval.js` `host` line (platform, arch, cpus, mem_gib, node) exists, but it is not enough.

**Two profiles, judged separately; neither is ever inferred from the other:**
- **P-Mac:** the owner's Mac (18 GB, Docker Desktop installed but idle during the batch). This is a development profile.
- **P-Linux:** the supported beta profile in `docs/support.md`, Linux x86_64 with Docker Engine and at least 16 GB RAM. It is CPU-only unless a GPU is recorded.
  - A 14B Q4 model may not fit or may be very slow there. Either outcome is a recorded result (§5), not a reason to borrow the Mac numbers.
  - `run-batch.sh` is `#!/bin/zsh`, and CI ubuntu runners have no zsh. A Linux run needs zsh installed on the host, or a POSIX port of the launcher. The port is a new harness hash in the freeze.

## 5. Sequencing and resource gate
- **Strictly sequential:** one item at a time, in the frozen order. No parallel model calls (`QB_MODEL_CONCURRENCY` is pinned to 1 in the built environment, **proposed**; the v1 batch did not pin it). No Docker workload or other model runs during the batch.
- **This eval uses `--agent dry-run`, so there is no sandbox.**
  - If a later plan adds an agent stage, L1 must be unloaded first (`lib/model-release.js` `releaseLocalModel`, already called by `lib/sandbox/pipeline.js`) and must pass sandbox admission (`lib/sandbox/admission.js`, per-run peak + reserve).
  - That is a separate plan.
- **Resource gate before each item (proposed):**
  - no other model loaded;
  - free memory at least the model's `/api/ps` size (or the `/api/show` size estimate) + 2 GiB;
  - swap growth below a declared bound since the previous item.
  - A failing item is recorded as **`resource_blocked`** and is not launched. It is not a semantic failure, it is never rerun to fill the gap, and it makes that profile's result **incomplete**.
- **Execution outcomes:** OOM kill, transport failure or timeout is `execution_failed`, with the host snapshot attached. A mismatched or corrupt record is `invalid_record`. Neither is ever counted as a refusal or as a success.

## 6. Batch size, gates and the no-cherry-picking rule
- **Batch size:** H = 12 items × 1 run × 2 profiles = **24 runs**.
  - The L1 ceiling is 12 × 420 s = 84 min per profile; wall time also includes setup and scoring.
  - No reruns.
  - Repeated-run stability is a different question, for a later plan.
- **Predeclared gates, per profile.** The senior sets the final numbers before the freeze; these are the junior's proposal.
  - **Q1:** at least 7/8 supported items ruled acceptable on D1–D4 and D6, and **no** item with an invented default (D6).
  - **Q2:** no incorrect control acceptance and no protected-scope weakening.
  - **Q3:** at least 3/4 intended refusals, and **both** ambiguous items refused. A finalized checklist on a genuinely ambiguous request fails Q3 outright.
  - **Q4, latency, reported separately from correctness:** median L1 ≤ 120 s and every item ≤ 180 s, over items with timings. The count of missing timings is shown. Cold item 1 is reported both with and without the cold load.
  - **Q5, completeness:** at most one `execution_failed`, `invalid_record` or `resource_blocked` item. With more, the profile is **inconclusive**, not passed.
- **Everything is recorded:** every attempt, every fact-call repair, every refusal and its recorded decision, every OOM or timeout, and the load snapshots (`runs.json`, `batch.json`, per-run manifests and events, as in v1, plus the snapshots).
- **No selection.** Every item is reported, including failures, and denominators are always 8 and 4 per profile. A single good run (for example the 84.5 s `69e576f5`) is never quoted as the model's latency or quality. A "best" profile or run is never reported in place of the full table.

## 7. What this would and would not show
**Would show**, for one pinned QB SHA, one pinned model digest and settings, and each named host profile:
- whether the staged L1 produces faithful, scope-consistent and reviewable checklists on 8 new supported requests written by someone else;
- whether it refuses 4 new ambiguous, unsupported or impossible ones for the right reason;
- how long that takes under recorded load.

**Would not show:**
- a population reliability rate (n = 8 + 4, one run each);
- run-to-run stability;
- performance on public or customer repositories (the bases are small synthetic repositories);
- coding-task success (dry-run, so no agent changes code);
- that `qwen2.5-coder:14b` should be a customer default;
- anything about L2/L4 with Qwen (they are off);
- anything about a profile that was not run;
- beta qualification. That remains a separate gate.

## 8. Approvals needed before any run (none is given here)
1. The senior approves this plan and sets the gates (§6).
2. The H author is named. The H hashes are posted, then the full freeze.
3. The proposed harness pieces are built test-first, offline:
   - the v2 batch and score copies;
   - the host snapshot;
   - the resource gate;
   - `QB_MODEL_CONCURRENCY=1`;
   - a POSIX launcher for Linux, if needed.
4. The owner approves the local model time per profile, and names the Linux host.
