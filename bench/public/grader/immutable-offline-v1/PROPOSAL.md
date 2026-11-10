# KAN-111: exact offline grader `immutable-offline-v1`, revision 2 (for review, NOT executed)

This answers KAN-111 review 10551, which builds on KAN-110 reviews 10545 and 10549. It covers immutable-js tasks **2005** and **2006** only.

This is a **separately versioned adaptation** of the official SWE-bench harness, never reported as an official benchmark score.

**Nothing has been executed:** no Docker replay, no external harness install, no model call, no merge.

## Artifacts (all on branch `kan111-grader-validation`)

| File | SHA-256 | Role |
|---|---|---|
| `grade.mjs` | `3b11d753f632049e260630cf1eda83eb6be88ee0bf56055255d82d371f4e9521` | Runner. Plan-only by default; `--execute` is refused without `--approved-by`. Every step is checked, every run has an expectation, and it exits 1 if any expectation fails |
| `grade_report.py` | `f8f0fccd73efc9f420acfeadf7ce3f3e8389f0baff84e7d4ff5caaee450c1978` | Pinned-harness grading + strict view + mode-aware acceptance gate. Exit 0 = graded, 3 = infrastructure error |
| `grade-wrapper.sh` | `9d50247191821a5eabdb52327de0c94ab04bd788b9786af1f3b2948b2d11d9aa` | Records `CI`, Node/npm and the resolver target; runs the eval script; **exits with its status** |
| `qbx-boundary.sh` | `426183c54bfff5e5caba23d373cc0591407b007f1723c8bfb5af331dcc5fb5a8` | **Instrumentation** (separately versioned): a content manifest at the test boundary, and the final state |
| `plan-A1.txt` | `abc02c2158c92a315de84c1de1d56e137d9e82fbdbf245c6b70b3b00b5c40def` | Every command: 320 commands, 20 runs |
| `workflow.proposed.yml` | `3b201d758d5458042f3dda9c88aca2a71c0dc7d208abefbceb22aab5da9da439` | **Not active** (outside `.github/workflows`). The two-phase lock → grade workflow |

## Pinned official inputs

| | Task 2006 | Task 2005 |
|---|---|---|
| Dataset | SWE-bench Multilingual @ `846e647b9f33` | same |
| Image (by digest) | `swebench/sweb.eval.x86_64.immutable-js_1776_immutable-js-2006@sha256:ecf16bc4…608d` | `…-2005@sha256:d038a276…5549` |
| Official eval script | sha256 `5ce09937…f9f647` | `70da858d…f66caa` |
| Parser | `parse_log_immutable_js` → `parse_log_jest` (`--verbose`) | → `parse_log_jest_json` |
| Required tests | F2P 1, P2P 22 | F2P 2, P2P 20 |

**Harness:** SWE-bench @ `02e7a74ffd0b707aab73d203fe87bdc7c76afc8e`. The run path is replicated from `run_evaluation.py`:
- user `root`, `/testbed`;
- `/tmp/patch.diff` with the four apply fallbacks, resets between attempts and a reverse check;
- `/bin/bash /eval.sh` with no environment (`CI` unset, so tests resolve `immutable` to `src/`);
- a 1,800 s timeout.

Grading uses the harness's own `get_logs_eval`, `parse_log_immutable_js`, `get_eval_tests_report` and `get_resolution_status`.

## Review 10551 decisions applied

- **Variant A1** (preferred): the official eval script with **only** the `npm run build` line replaced by
  `if ! ( <verified offline build steps> ); then echo '>>>>> QBX Build Failed'; exit 97; fi`.
  - 2006 steps: `build:clean, build:dist, build:esm, build:copy, build:prepare`.
  - 2005 steps: `build:clean, build:dist, build:types, build:prepare`.
  - The network-only `build:stats` is omitted. A failed required step stops the script **before** tests run, and the runner records `build_failed`, never a qualified replay.
  - Test selection, assertions, test patch and parser are unchanged. The same adaptation applies to empty, gold and future candidate arms.
- **Instrumentation**, separately hashed and not called verbatim: one line, `bash /qbx-boundary.sh tested`, inserted immediately before the official `: '>>>>> Start Test Output'` line.
- **SYS_ADMIN omitted.** No flag remains to add it.
- **Stricter, additive grading:** adopted in principle and fixed as below.
- **External harness install: not authorized yet.** See "Install proposal".

## Required changes 1–5

1. **Expected matrix, enforced and failing closed** (`grade.mjs`):
   - Outcomes are `infra_error` | `patch_apply_failed` | `timeout` | `build_failed` | `graded`.
   - Any non-zero setup step, a grader exit ≠ 0, or an unreadable `grade.json` (or one without a boolean `acceptance.accepted`) → `infra_error`, with the failing step named. Evidence for that run is saved, and the later runs still execute.
   - **Per run:**
     - each **empty** and **gold** replay must be `graded` with `accepted = true`;
     - the **tamper** run must satisfy the proof below;
     - **conflict** and **0-byte** must be `patch_apply_failed` and never graded;
     - the **timeout fixture** must be `timeout`.
   - `gates_passed` = every expectation met. **Exit 1 otherwise.**
2. **Acceptance gate** (`grade_report.py <…> <empty|gold>`):
   - The official log gate must be ok.
   - The official resolution must be `RESOLVED_NO` (empty) / `RESOLVED_FULL` (gold).
   - **Each required identity** must have exactly one raw result line. **All statuses count**: 2005's `[PENDING]`/`[TODO]` lines too, so PASSED + PENDING for one key is `ambiguous`.
   - The status must be the expected real one: **F2P `failed` on empty, `passed` on gold; P2P `passed` on both.** Skipped, todo, unknown, missing and ambiguous never pass.
   - The structural flag is renamed `structural_present_and_unique` and is explicitly **not** the acceptance decision.
3. **Isolation controls as executable proofs:**
   - **Tamper:** built **inside the container from the exact base**: apply gold, append a marker line to the first official test file, `git diff`, reset, then apply that valid candidate the normal way. Proven only if:
     - the marker is present before grading;
     - it is **absent at the test boundary** (`QBX_TESTED_MARKER_COUNT=0`);
     - the tested-tree hashes of the official test files **equal the gold replay's**;
     - and the run is accepted as gold.
   - **Conflict and 0-byte patches:** must be rejected and never graded.
   - **Timeout:** a **separately labelled deterministic fixture** (`sleep 600` under a 5 s limit), not a shortened real replay.
4. **The actual tested tree** is the manifest written by `qbx-boundary.sh tested`: the sha256 of every file under `/testbed`, including untracked files and build output (`.git` and `node_modules` excluded; they're fixed by the image digest). It's taken after the candidate patch, the official test patch and the build, immediately before Jest. The final state is recorded separately (`qbx-boundary.sh final`). The earlier claim that the wrapper hashed the tested tree is withdrawn.
5. **Setup checks and truthful exits:**
   - Every `docker create/start/cp/exec` prerequisite is checked: HEAD, and the base check (`HEAD == base` or no diff to base).
   - The wrapper saves `eval.sh`'s status, prints `QBX_EVAL_EXIT` and **exits with it**. A missing exit record is `infra_error`.
   - Non-zero Jest exits on empty runs are interpreted through the acceptance gate, not treated as infrastructure failure.

## Tests

All written failing first (`444f7ab`: 20 red), then fixed. The real harness is **stubbed** in these tests, as each file states.

**`test/unit/kan111-grader.test.js` (16 pass):**
- variants: A0 verbatim; A1 changes exactly one line with the build gate; the instrumentation adds exactly one line before the Start marker;
- pinned identities;
- strict view and acceptance: gold accepted; empty F2P must fail; a wrong F2P pattern is rejected; skipped-only, unknown status and a mixed-status duplicate are never accepted; the structural flag is not acceptance; a malformed log is not accepted.

**`test/unit/kan111-runner.test.js` (11 pass; fake docker and grader in `test/fixtures/kan111/`, accepted only with `--approved-by=FIXTURE`):**
- all gates met → exit 0;
- wrong matrix → exit 1;
- grader crash → `infra_error`;
- malformed `grade.json` → `infra_error`;
- Docker failure → `infra_error`, with later runs still executed;
- base mismatch → `infra_error`;
- build failure → `build_failed`, not graded;
- conflict or 0-byte patch unexpectedly applying → gate fails;
- tamper: not applied / still present / different tree → gate fails;
- timeout fixture that finishes → gate fails;
- approval guards.

While building the fake environment I hit three fixture bugs: argument order, defaults, and a lookup returning `undefined`. All were in the test fakes; the runner and grader code needed no change for them.

## Install proposal (needs Arshad's explicit authorization, then reviewer approval)

**Two phases** (`workflow.proposed.yml`), each on its own approved push:
1. **`lock`:** `pip download` the harness from the GitHub archive of commit `02e7a74`, and record the sha256 of **every** resolved distribution. The output is a `requirements.lock` for review (exact distributions + `--hash`).
2. **`grade`:**
   - `pip install --require-hashes --no-deps -r requirements.lock`, then `pip freeze` recorded;
   - rebuild the vault from the hash-verified dataset;
   - `grade.mjs --execute --approved-by=<comment id> --variant=A1 --reps=3`.

**Security properties:**
- `permissions: contents: read`, no secrets referenced, checkout without persisted credentials;
- task containers have **no host mounts** (only `docker cp`), `--network none`, and no added capabilities;
- results are secret-scanned before upload (5-day retention).

**Network use:** image pulls by digest, the locked pip install, and the dataset download. All happen before any offline task container starts.
