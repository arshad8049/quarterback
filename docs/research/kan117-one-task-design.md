# KAN-117 stage A: one-task dataset-native design and end-to-end gate map (review 10605)

**Status: design only, for review.** No code path has changed. Nothing ran under this design: no model, sign-in, image pull, cloud spend or merge. Research-only. The customer CLI default (node:test only) stays as it is.

Machine-readable files on branch `kan117-dataset-native`:
- `bench/public/kan117/counts.json`: the recount, produced by `counts.mjs` and tested by `test/unit/kan117-counts.test.js` (5 tests pass);
- `bench/public/kan117/task-2005.env.proposed.json`: the task and environment record proposed below.

## 0. Counts, recomputed from the committed file (the reviewer's connector returned it empty)

Input: `bench/public/manifest/candidates.json` @ `473af3c`, blob `e563a41de9a97e2f6b3e47e7756ecced5f2feb0e`. Every classification reason is mapped to exactly one blocker key; an unmapped reason fails the script. Result: 0 unmapped.

| | Pro v2 | Multilingual | PolyBench | Total |
|---|---|---|---|---|
| JS/TS tasks | 149 | 43 | 1,746 | **1,938** |
| Statically eligible under the **existing** QB rules | 0 | 0 | 0 | **0** |
| With a pinned image digest | 149 | 43 | **0** | 192 |
| Needing services | 68 | 0 | 209 | 277 |
| **Bound A:** blocked only by runner and/or installer rules | 54 | 43 | 1,537 | **1,634** |
| Bound B: A plus "no package.json test script" | 81 | 43 | 1,537 | 1,661 |

Bound A by runner (the grading command's runner first, then package.json scripts): mocha 1,288 · jest 280 · unknown 29 · karma 17 · qunit 9 · mocha+tap 6 · vitest 5.

**Corrections to the KAN-117 description** (my numbers, now superseded):
- "1,653" should read **1,634**. It is an upper bound, not an unlocked count.
- "Jest alone unlocks ~8" was wrong. **Runner-only** blocked tasks number 16. Of those, only **2 use Jest**: immutable-js 2005 and 2006, both exposed calibration tasks. The other 14 are 3 mocha+tap, 3 qunit, and 8 PolyBench tasks whose runner is unknown.
- PolyBench has **no** pinned images, so 1,537 of the 1,634 have no dataset environment to reuse. They would need a separately built and qualified environment.

## 1. The task and how it was chosen

**Predeclared feasibility properties** (no model outcome was consulted; no model has run on these tasks):
- P1: no services.
- P2: a pinned linux/amd64 image digest.
- P3: passes QB's **existing** installer gate (`deps-plan` ready).
- P4: grader evidence present.
- P5: an existing calibrated independent grader.

Results:
- **P1–P4:** 8 tasks, all from Multilingual: 2 jest, 3 mocha+tap, 3 qunit.
- **P1–P5:** 2005 and 2006.
- **Tie-break:** lowest instance number, which gives **2005**.

| | |
|---|---|
| Task | `qbt_9b9a5da937c9` (instance id is controller-only: it embeds the PR number) |
| Source | SWE-bench Multilingual @ `846e647b9f33c0b51b739d005d13d85493c9af09` ([dataset](https://huggingface.co/datasets/SWE-bench/SWE-bench_Multilingual)) |
| Repo / base | [`immutable-js/immutable-js@77434b3c`](https://github.com/immutable-js/immutable-js/tree/77434b3cbbc8ee21206f4cc6965e1c9b09cc92b6) |
| Runner | Jest 29.6.4 with `testRunner: jest-jasmine2`, custom resolver and preprocessor ([`jest.config.js`](https://github.com/immutable-js/immutable-js/blob/77434b3cbbc8ee21206f4cc6965e1c9b09cc92b6/jest.config.js)) |
| Grader image | `swebench/sweb.eval.x86_64.immutable-js_1776_immutable-js-2005` index `sha256:d038a276…5549` → amd64 manifest `sha256:2f1811a8…647f` → config `sha256:86ec6787…52cd`, created 2026-08-13, 1.01 GB (read from the registry API; not pulled) |
| Image recipe (from layer history) | Ubuntu 22.04; NodeSource `setup_20.x` (minor unpinned, so **not reproducible from the recipe: the digest is the identity**); Chrome; the repo-setup step is an inline heredoc not visible in the history |
| Exposure | **Calibration only.** I read the gold patch, test patch and required lists in KAN-111. Never a research holdout; I can't write blind contracts for it |

**Why 2005 keeps the first slice small:** it already passes QB's installer, deps-check and seed gates. KAN-110 run 3 ([42883845882](https://github.com/arshad8049/quarterback/actions/runs/42883845882)) showed, in QB's own agent image:
- `npm ci` via the DEPS proxy: exit 0, 979 packages;
- the offline build: ok;
- Jest: 44/44 suites, 683 passed, 0 failed, 1 pending.

So only the **verification** gates have to change. That is a property of this task, not of the population: most of bound A also fails the installer (no npm lockfile v2/v3).

## 2. Manifests

| Agent-visible (both arms identically) | Grader-only |
|---|---|
| Base tree at `77434b3c`, seeded with a fresh one-commit `.git` and no remotes (`sandbox/scripts/seed.sh`) | The dataset image (**not inspected**; see §5), `/testbed`, its git objects and refs |
| `problem_statement` (field policy: `agent`) | `test_patch`, gold `patch`, FAIL_TO_PASS (2) / PASS_TO_PASS (20) lists, `eval.sh` (sha `70da858d…f66caa`) |
| `node_modules` from QB's `npm ci`, read-only | `hints_text` (quarantine), `instance_id`, image ref (controller) |
| The internal channel's command and its parsed results | KAN-111 grade outputs, `required.json`, `grade.json` |

## 3. Where each part runs, and how the patch crosses

The host is a GitHub `ubuntu-24.04` runner running the QB supervisor (trusted).

1. **Seed** (tools image, network none): a host source mirror → trusted git → `/work` tree. The host mirror's future history never enters `/work`.
2. **Deps** (agent image, DEPS proxy for registry.npmjs.org only): `npm ci` → deps volume.
3. **Agent** (the KAN-112 pinned agent image, unchanged; both arms are bound to the same image id by `D.bindImages`). For stage B this is the existing no-model `agentStage` seam with scripted edits.
4. **Capture** (tools image): `/work` → `refs/qb/candidate` → patch.
5. **Internal verification** (agent image, network none, uid 10001, read-only rootfs, `/verify` disposable):
   - `verify-prep` restores `__tests__/**` and the base test script;
   - then the pre-test build;
   - then Jest with JSON output.

   Its results may go back to the agent (E repair loop).
6. **Patch export:** QB writes `candidate.diff` and its sha256 into the trial directory, after the arm's `result.json`.
7. **Independent grader** (a separate step after the arm ends; dataset image by digest; fresh container; network none; no SYS_ADMIN; KAN-111 A1): applies `candidate.diff`, then the official test patch, the offline build and Jest. It writes to a separate directory that no arm reads.

## 4. Commands, limits, versions

| Step | argv / setting | Where | Limit |
|---|---|---|---|
| Install | `npm ci --no-audit --no-fund` (existing) | `/scratch` → deps volume | 20 min stage; admission memory |
| Internal pre-test build | `npm run build:clean`, `build:dist`, `build:types`, `build:prepare` (each separate; `build:stats` omitted because it fetches bundlephobia.com) | `/verify` | part of 600 s proposed |
| Internal tests | `node node_modules/jest/bin/jest.js --ci --json --testLocationInResults --outputFile=/out/qb-jest.json` | `/verify` | 600 s proposed; existing 30 min cap stays the backstop |
| Grader | KAN-111 A1 unchanged (`/bin/bash /eval.sh`, offline build line, `qbx-boundary.sh`) | `/testbed` | 1,800 s |

**Versions:**
- Agent/verifier: Node v24.22.2, npm 11.19.1 (observed KAN-110 x86_64).
- Grader: image Node 20.x (minor unrecorded: to be recorded in stage B).

**Why the repo's own `npm test` is not usable offline.** It runs `format --write` (rewrites files), `flow check`, and `build:stats` (network).

## 5. Sandbox controls and the incompatibilities found

**Controls kept unchanged:** network none, uid 10001, `--cap-drop ALL`, no-new-privileges, read-only rootfs, `/tmp` tmpfs 256 MiB, pids 256, read-only `node_modules`, protected-test restore, no credentials in any verify or grader stage. There are no exceptions; if one turns out to be needed, it comes back for approval.

**Incompatibilities, each needing a decision:**
1. **`CI` env.** QB injects `CI=1` (`lib/sandbox/stages.js:98,125`). This repo's resolver then tests the **built `dist/`**, whereas the dataset harness runs with `CI` unset (tests import `src/`). KAN-110's base run used `CI=1`. **Proposal:** unset `CI` in this mode, so both channels test the same module. A CI-unset run in QB's image is not observed yet.
2. **Capture ignores `.gitignore`** (`sandbox/scripts/capture.sh:11`). If the agent runs the build in `/work`, then `dist/` and `npm/` enter the patch. **Proposal:** with `CI` unset the agent can run Jest without building. Additionally, the research environment record declares generated paths `dist/` and `npm/`, which capture **reports and refuses** (unresolved), never silently drops. The alternative is to accept them, since the grader's `build:clean` removes `dist`. Both arms get the same rule.
3. **The `NODE_OPTIONS` node:test reporter flags** are injected into every verify process (`stages.js:96-98`). In this mode they must not be set; the reporter is Jest's JSON file.
4. **Runtime mismatch:** Node 24 (agent/internal) vs Node 20 (grader). This is recorded, not hidden. A candidate could pass one channel and fail the other for runtime reasons; the report attributes such a failure to the channel.
5. **The base image is not digest-pinned** by QB's content tag (KAN-110 finding 2). Both arms already share one bound image id per experiment; the built id is recorded.
6. **npm 11 skipped install scripts** (`microtime`, `esbuild`; KAN-110 finding 3). This works for this task. The setup policy must state it, because other tasks may need scripts.
7. **The dataset image is not inspected** for gold patches, future git objects or refs, baked scripts or credentials. **It stays grader-only.** Inspection (on the runner, not a Mac) is required before any agent-visible use and isn't needed for this design.

## 6. End-to-end gate map

The question was whether verification-only replacement is enough. For 2005 it is, because the installer gates already pass. For the population it is not: 1,598 tasks fail both the runner and the installer gates.

| # | Gate (at `473af3c` unless noted) | 2005 today | Mode-aware change proposed |
|---|---|---|---|
| G0 | `lib/run-options.js:51` CLI refuses an unsupported runner | n/a (the bench path doesn't call it) | **none**: the customer CLI is unchanged |
| G1 | `context/test-plan.js:32` `testPlan`: jest → `unsupported_runner` | **blocks** | research mode takes the plan from the reviewed env record (QB-held; not the repo, not detection) |
| G2 | `lib/sandbox/pipeline.js:209-211` plan or `o.testCommand` (labelled `node-test`) | **blocks** | accept only an env-record plan with an explicit `runner: jest` and reporter contract |
| G3 | `agent/briefing.js:92`, `context/builder.js:74` say "not used for verification" | misleading | state the real internal command; identical in both arms |
| G4 | `sandbox/scripts/deps-plan.sh` (lockfile v2/3 etc.) | passes | none for 2005. **The main gate for the population** (1,408 missing lockfile, 476 unsupported) |
| G5 | `sandbox/agent/deps-install.sh` `npm ci` | passes | none; record the npm version and script-skips |
| G6 | `deps-check.sh` (install touches only `node_modules`) | passes | none |
| G7 | `seed.sh` | passes | none |
| G8 | `pipeline.js:171` agent gets `node_modules` read-only | can run Jest (untested) | none; verify in stage B with the scripted agent |
| G9 | `capture.sh` (no `.gitignore`) | risk: `dist/`, `npm/` | declared generated paths reported and refused (§5.2) |
| G10 | `verify-prep.sh` protected tests and base test script | passes | none |
| G11 | `stages.js:77` `runVerification` (`CI=1`, node:test `NODE_OPTIONS`, `npm test` probe) | **blocks** | env-record argv, pre-test steps as separately recorded steps, Jest JSON output, `CI` per decision |
| G12 | `verify/tests.js:31,38` parser accepts only `qb-node-test-events/1` | **blocks** | new Jest-JSON validator (§7) |
| G13 | `stages.js:115` `runBaseTests` | same as G11 | same as G11 |
| G14 | `bench/qualify.js:58` QB-27 hidden-suite qualification (needs `.quarterback.json`, node:test) | n/a | dataset tasks use the dataset grader instead. Spec gets `grader: dataset_native` and `exposure: calibration` |
| G15 | `bench/grader.js:202` QB-27 grader in the agent image | not applicable | adapter calls KAN-111 `grade.mjs` after the arm |
| G16 | KAN-111 `grade.mjs` modes: only empty, gold, isolation, with fixed expectations | missing | add `candidate` mode: same strict F2P/P2P view, reports resolution, no expectation; still only in the approved CI workflow |
| G17 | KAN-112 pilot preflight: pinned `AGENT_IMAGE` (`agent/runner.js`, `kan113-runner-prep` @ `0d8880b`) | passes | none. Stage B branch = `kan111-grader-validation` + `kan113-runner-prep` (no `main` merge) |

## 7. Reporter contract (internal channel)

**Recorded:**
- Jest version (from `node_modules/jest/package.json`), the exact argv, and exit, signal or timeout;
- `numTotalTestSuites` and the suites listed by `--listTests` (discovery) vs executed;
- per-test `fullName`, `location`, `status`;
- pass, fail, pending and todo counts.

**Fails closed (verdict `error`, never pass)** on any of:
- no file, malformed JSON, or a truncated or oversize file;
- `numRuntimeErrorTestSuites > 0`;
- listed ≠ executed;
- zero tests, or a count below the env record's expected minimum (684 at base);
- a Jest version or argv that differs from the record;
- an exit code that contradicts `success`;
- a reporter crash.

**Verdicts:**
- A correctly parsed **failing** suite is `failed`. That is a different verdict from a broken harness (`error`), and the tests cover both.
- The known duplicate identity (`List … remove removes any index`, from `it.each`) is reported as a group and never deduplicated.
- Jest 29's file status `focused` means "pending present", not `.only`.
- Nothing from the grader channel is ever read by this parser or by the repair feedback.

**Proposed regression tests** (all fake runner output, no Docker): valid pass; valid fail; runtime-error suite; listed≠executed; zero tests; truncated file; version mismatch; exit/`success` contradiction; duplicate identity; a `CI` env assertion on the argv builder; a capture refusing declared `dist/`; the G0 CLI still refusing jest (customer default unchanged); and a grader-candidate mode refusing outside CI.

## 8. Stage B, once approved (no model; GitHub runner)

Through QB's **real** `runSandboxed` path with the scripted `agentStage`:
- (i) **empty** (no edit);
- (ii) **gold**: calibration only, a scripted edit applying the gold source diff.

Each is followed by the KAN-111 grader in `candidate` mode.

**Expected:**

| | Internal channel | Grader |
|---|---|---|
| Empty | passes (coverage limit) | `RESOLVED_NO`, with F2P failing |
| Gold | passes | `RESOLVED_FULL` |

Any install, timeout, reporter or zero-test problem is attributed to its channel and never counted as detection.

**Out of scope until B passes:** stage C (2 Mocha + 2 Jest). The pinned, no-service, installer-passing pool has only 2 Jest tasks (both exposed) and 3 mocha+tap tasks; plain Mocha has **none** with a pinned image and no services. So C will likely report a blocker rather than weaken filters.
