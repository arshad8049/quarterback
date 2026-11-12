# KAN-111: exact offline grader `immutable-offline-v1`, revision 6 (for review; only the approved lock phase has run)

Revision 3 answers KAN-111 review 10554 and correction 10555. Revision 2 answered review 10551, which builds on KAN-110 reviews 10545 and 10549. It covers immutable-js tasks **2005** and **2006** only.

This is a **separately versioned adaptation** of the official SWE-bench harness, never reported as an official benchmark score.

**Nothing has been executed:** no Docker replay, no external harness install, no model call, no merge. Real execution is now refused outside the approved CI workflow (see revision 3).

## Task exposure (review 10554)
Tasks **2005** and **2006** are **EXPOSED development/calibration tasks**, not unexposed holdout:
- this context has read their gold patches, test patches and required-test lists;
- their grading material was briefly pushed in `9265147` (see the incident below).

They may be used to validate the grader. They must never be reported as held-out evaluation results. Blinded contracts (KAN-112) must be written by a context that has not seen this material.

## Artifacts (all on branch `kan111-grader-validation`)

| File | SHA-256 | Role |
|---|---|---|
| `grade.mjs` | `5949380572b1458c687ff2bfc489e4557448711837288e8c6a8a439edfd8afeb` | Runner. Plan-only by default. Real `--execute` runs only in the approved CI workflow (`GITHUB_ACTIONS=true`, `KAN111_CI_RUN=1`), with variant A1 and at least 3 reps. Every step is checked and logged, every run has an expectation, and it exits 1 if any expectation fails |
| `grade_report.py` | `f8f0fccd73efc9f420acfeadf7ce3f3e8389f0baff84e7d4ff5caaee450c1978` | Pinned-harness grading + strict view + mode-aware acceptance gate. Exit 0 = graded, 3 = infrastructure error |
| `grade-wrapper.sh` | `9d50247191821a5eabdb52327de0c94ab04bd788b9786af1f3b2948b2d11d9aa` | Records `CI`, Node/npm and the resolver target; runs the eval script; **exits with its status** |
| `qbx-boundary.sh` | `aa230ddd1068343f93e91194ef9c2cfc1c11ca40a0453cb7d6919da837fc94f0` | **Instrumentation** (separately versioned), **fails closed**: content manifests (files and symlinks) at start, at the test boundary and at the end, plus a `node_modules` digest |
| `plan-A1.txt` | `7c5336572a63e8aeb88071a672a887e0b08228368b2cd545dcf3eae53d975e88` | Every command: 340 commands, 20 runs |
| `workflow.proposed.yml` | `316cd5448e6b9fb8a2e7c9e4eec28270d36f5cd6b067537d266be7c6350ea9dd` | **Not active** (outside `.github/workflows`). **Lock phase only**; grades nothing |
| `approvals.json` | `29703d95e2d42db5dd201c14b72e03a4e300f9b79bb0d57b1d965e4d008f9a00` | Committed, reviewed phase approvals (replaces repository variables). All `null`: nothing is approved |
| `lock-sanitize.sh` | `bb25af264e415a1c3ba6cc3d86e6b034f18cbdd189f61c0422721137a1a0c838` | Lock-output sanitizer: exact allowlist, size and plain-text limits, secret and task-material scan |

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
- **Instrumentation**, separately hashed and not called verbatim: one line, `bash /qbx-boundary.sh tested || exit 98` (revision 3; was `bash /qbx-boundary.sh tested`), inserted immediately before the official `: '>>>>> Start Test Output'` line.
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

## Tests (revision 2)

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

## Revision 3: review 10554 fixes

All written failing first (`7feb837`: 15 red), then fixed.

1. **The boundary helper fails closed.**
   - `set -euo pipefail`. The manifest is written to a `.partial` file and moved into place only on success. Symlinks are recorded with their targets. The values are printed only at the end.
   - The instrumentation line is `bash /qbx-boundary.sh tested || exit 98`. Exit 98 is an `infra_error` naming the boundary helper; it is never graded.
2. **The runner validates every boundary value.**
   - The tested hash must be 64 hex characters, the file count a positive integer, and the marker count an integer.
   - The runner recomputes the sha256 of the copied `tested-tree.txt` and requires it to equal the printed hash. A mismatch is an `infra_error` ("manifest").
3. **`node_modules` is checked.** A new `start` boundary runs before any patch. The `node_modules` digest at the test boundary must equal the start digest, else `infra_error` ("node_modules").
4. **The exit record is checked.** `QBX_EVAL_EXIT` must be an integer equal to the observed exit status, else `infra_error` ("exit").
5. **The tamper comparison requires real entries.** Every official test file must have a 64-hex entry in both the gold and the tamper manifests. A missing entry fails the gate. Before this fix, two missing entries compared equal (`undefined === undefined`).
6. **A step log per run.** `run.json` `steps` holds `{step, status, signal, stdout_tail, stderr_tail}` for every docker step, including each of the four apply attempts and the reverse check.
7. **Execution guards.**
   - Real `--execute` (anything that is not a fixture) is refused, with exit 2 and nothing written, unless `GITHUB_ACTIONS=true` and `KAN111_CI_RUN=1`.
   - An approved run also requires `--reps` ≥ 3 and `--variant=A1`.
   - `--reps` must always be a positive integer.

**Tests:** boundary helper 6/6 (the real script on temporary trees), grader 16/16, runner 19/19 (fake docker and grader, with a tripwire `docker` on PATH that is asserted never to be called). Full suite: 1036 tests, 1025 pass, 0 fail, 10 skipped.

## Lock phase plan (LOCK ONLY; needs the reviewer's approval comment id in `approvals.json`)

The owner authorized installing the pinned harness **on the CI runner only** (comment 10553). This plan covers **the lock phase only**. It grades nothing: no task image is pulled, no container is created, no dataset is downloaded, and `grade.mjs` is never invoked.

**To activate (after review):**
1. The reviewer records the lock approval comment id in `approvals.json` in a reviewed commit.
2. `workflow.proposed.yml` is copied to `.github/workflows/kan111-lock.yml` on `kan111-grader-validation` only.

**The job** (one `ubuntu-24.04` standard runner, 20 min limit):
1. **Checkout** at a pinned SHA, without persisted credentials. Permissions are `contents: read`, and no secrets are referenced.
2. **Approval gate:** refuse unless `approvals.json` `.lock.approval_comment_id` is numeric.
3. **Python 3.11.9** via `setup-python` at a pinned SHA.
4. **Harness source:**
   - download the GitHub archive of `02e7a74` and record its sha256;
   - extract it and require the three reviewed source hashes to match exactly:
     - `log_parsers/javascript.py` `87e907b2…eb1a`;
     - `grading.py` `a0952730…9483`;
     - `run_evaluation.py` `04b5dab5…7d84`.
5. **Distributions:** `pip wheel` the extracted source into `dists/` (the harness wheel and every dependency), plus the pinned build backend (`setuptools==75.6.0`, `wheel==0.45.1`, binary only).
6. **`requirements.lock`:** one `name==version --hash=sha256:…` line per distribution, each with its source: PyPI wheel, built from sdist, or built from the archive. `build-notes.txt` lists every locally built distribution, because their hashes are not reproducible across builds. `env.txt` records the Python, pip, OS and runner versions, the harness ref and the commit.
7. **Sanitize** with `lock-sanitize.sh`: exactly the allowlisted files, each ≤ 256 KiB and plain text, with no secret-like strings and no task material. Self-tested on five cases (clean, extra file, secret, task string, missing file).
8. **Upload** only if the sanitizer passed (no `if: always()`). It uploads the six named files, with `if-no-files-found: error` and 5-day retention.

**Network use:** GitHub (the checkout and the archive) and PyPI (the dependencies) only.

### Lock artifact list (explicit; nothing else is uploaded)

| File | Contents |
|---|---|
| `requirements.lock` | `name==version --hash=sha256:…` per distribution, each with a `# source:` line |
| `dists.sha256` | `sha256sum` of every file in `dists/` |
| `archive.sha256` | sha256 of the `02e7a74` source archive |
| `harness-files.sha256` | sha256 of the three reviewed harness files (already checked against the reviewed values) |
| `env.txt` | Python and pip versions, OS, runner OS and arch, harness ref, commit SHA |
| `build-notes.txt` | Distributions built locally (hash not reproducible) and how the grade phase handles them |

**Never uploaded:** the wheels themselves, the archive, any dataset, gold patch, `eval.sh`, test patch or required-test list.

### Grade phase (outline only; a separate proposal after the lock is reviewed)
- **Approval:** `approvals.json` `.grade` must hold an approval comment id and the sha256 of the reviewed `requirements.lock`.
- **Install:**
  - PyPI distributions with `pip install --no-index --require-hashes --no-deps` from a directory fetched against the reviewed lock;
  - swebench rebuilt from the hash-verified archive with `--no-build-isolation --no-deps`, using the locked build backend;
  - `pip freeze` recorded.
- **Paths:** absolute `$GITHUB_WORKSPACE` paths throughout.
- **Grading:** `KAN111_CI_RUN=1 grade.mjs --execute --approved-by=<grade comment id> --variant=A1 --reps=3`.
- **Uploads:** an explicit allowlist (run summaries, step logs, manifests, `grade.json`), and never `eval.sh`, `patch.diff`, gold or required-test material.

## Lock phase result (approval 10557; reviewed PASS in 10559)
- Commit `e52e88a`, run https://github.com/arshad8049/quarterback/actions/runs/42906422892 (one attempt, success).
- Artifact zip sha256 `7e49b518…3a20` (matches GitHub's digest, per the reviewer). 82 locked distributions; `build-notes.txt` lists only swebench as locally built.
- **Evidence to persist** in `lock-evidence/run-42906422892/`, exactly these bytes (the grade workflow checks them):

| File | sha256 |
|---|---|
| `requirements.lock` | `3ff9e5ec290027e4925964a8eb537af39f676a588aa81d9da2f429619e7de1ba` |
| `dists.sha256` | `0123302e17e1933d5c7e321734c47b25e0764ab4bb91b5fa1a941c74d98b2b32` |
| `archive.sha256` | `a60f0de346e0783dc6645edeb537b24b0f5d35c9d01be7a19f6b129bf5f79bff` |
| `harness-files.sha256` | `1a454284cf5fd8afef66e40a0e0d3581548c2504a938fbdfdea35c20f177705c` |
| `env.txt` | `7195c125aa09cc048505378fbede55c127dc65b7797ab8b75d7ca5cc843cfcf7` |
| `build-notes.txt` | `24b24a510d29fdac8c7215faf93238ac41453332d472e91fdec85545af6a3f5e` |

  Source archive digest: `d06181d5365b51fc7ff490171581b9ee87d77e19b3a739a8d574bf25d9ef9479`.

## Revision 4: review 10557/10559 fixes

**`qbx-boundary.sh` (red first in `35283ee`):**
- No process substitution. Every enumeration (`find` for files, symlinks and `node_modules`) is an ordinary checked command writing a NUL list to a work file; hashing loops read those files, and every hash or `readlink` is checked.
- Marker count: `grep` exit 1 = no match (0); exit ≥ 2 = read error = failure. No `|| true`.
- Paths (or link targets) containing a newline are refused.
- The written entry count must equal the enumerated count (files, and `node_modules` separately), and the manifest must be non-empty.
- Nothing is printed and no finished manifest is left behind on any failure.

**`grade.mjs`:** the copied tested manifest must be well formed (`<64 hex>  ./path` or `symlink ./path -> target`), have unique paths, and have exactly the printed number of entries; otherwise `infra_error` (malformed / duplicate / count).

**New tests:** 7 boundary regressions (a part-way `find` failure via a PATH shim, an unreadable directory, a `grep` read error via a shim, "no marker" vs a marker, a `node_modules` enumeration failure, a newline path, count/format/uniqueness), 3 runner regressions (count mismatch, malformed line, duplicate path).

## Grade-phase proposal (NOT active; `approvals.json` `.grade` stays null)

`workflow.grade.proposed.yml`, one job on the standard `ubuntu-24.04` runner (180 min limit), pinned actions, `contents: read`, no secrets:
1. **Gate:** `.grade.approval_comment_id` numeric AND `.grade.lock_sha256` = `3ff9e5ec…e1ba`.
2. **Evidence:** the six persisted files must match the hashes above; the archive digest must be the recorded one.
3. **Split:** 82 entries = 81 PyPI wheels + swebench. `setuptools` must be among the 81 (swebench's only build requirement is `setuptools>=42`; version comes from `swebench.__version__`; no other build dependency).
4. **Download:** `pip download --no-deps --only-binary=:all: --require-hashes` for the 81; the downloaded files must equal `dists.sha256` (same names, same bytes). The archive is downloaded and checked against `d06181d5…9479`.
5. **Install offline:** `pip install --no-index --require-hashes --no-deps` for the 81.
6. **Source-build exception (disclosed, not bypassed):** the lock's swebench line is the lock run's own build and is not reproducible. swebench is rebuilt with `pip wheel --no-index --no-deps --no-build-isolation` from the verified source, using only the locked setuptools; the **new** wheel hash is recorded and never claimed equal to the lock line.
7. **Verify:** `pip check`; `pip freeze` equals the lock's 82 name/version pairs exactly (pip itself excluded); the installed `javascript.py`, `grading.py`, `run_evaluation.py` hashes equal the reviewed ones; `harness-smoke.py` (synthetic logs only: both immutable parsers, the `parse_log_immutable_js` registry key, unknown-instance refusal, `RESOLVED_FULL`/`RESOLVED_NO`).
8. **Vault:** `npm ci && node public/import.mjs --download` (the hash-verified dataset; the only network use after install).
9. **Grade:** `KAN111_CI_RUN=1 SWEBENCH_PYTHON=/tmp/kan111/swe/bin/python node public/grader/immutable-offline-v1/grade.mjs --execute --approved-by=<grade comment id> --variant=A1 --reps=3`. The exact docker commands are `plan-A1.txt` (sha256 `7c533657…5e88`, 340 commands, unchanged by revision 4). Runs, per task (2005, 2006): `empty-1..3`, `gold-1..3`, `iso-test-file-tamper-1`, `iso-patch-conflict-1`, `iso-empty-patch-file-1`, `iso-timeout-fixture-1` = 20 runs.
10. **Sanitize, then upload** (upload runs only if the sanitizer passed): `grade-sanitize.mjs` builds one new `results.json` from an explicit field allowlist (no output tails, no failure details, no `eval.sh`, patch, test output, required list, `grade.json` or manifests; grader reasons only in the `KIND[index]: expected X, got Y` shape), then refuses if it contains ANY required test name of the two tasks (read from the vault; reported by index only), diff text or a secret-like string. The install record (rebuilt-wheel hash, `pip check`, `pip freeze`, installed source hashes, smoke output) gets an exact file-list and secret/diff check.
11. The job fails at the end if grading did not meet every expectation; the sanitized results are still published.

**Grade artifact allowlist:** `results.json`, `sanitize-report.txt`, `swebench-rebuilt-wheel.sha256`, `pip-check.txt`, `pip-freeze.txt`, `installed-harness-files.sha256`, `harness-smoke.txt`. 5-day retention.

**Not yet run anywhere:** `harness-smoke.py` against the real harness (local install is not authorized; it first runs inside the grade job), and the grade workflow itself. Its embedded scripts were syntax-checked and the lock-split / installed-set checks were dry-run on synthetic data.

## Revision 5: review 10561 corrections (red first in `4cc2075`)
1. **Installed set from metadata, not `pip freeze`.** `installed-set-check.py` reads the installed distributions with `importlib.metadata`, because swebench is installed from the local rebuilt wheel and `pip freeze` prints it as `swebench @ file:///…whl`. It requires:
   - (normalised name, version) of everything installed equals the lock, with `pip` excluded and no distribution installed twice;
   - swebench has `direct_url.json` pointing to the rebuilt `file://` wheel, and any hash pip recorded equals the rebuilt wheel's sha256;
   - no other distribution was installed by direct reference.

   Its JSON report is saved as `install-provenance.json`; `pip freeze` is kept as supporting evidence only. Regressions use fake `.dist-info` folders, including a local-wheel direct reference: 10 tests.
2. **Sanitized results keep the real fingerprints and identify the experiment.**
   - `grade-sanitize.mjs` now uses the runner's actual keys: `eval_sha256`, `official_eval_sha256`, `patch_sha256`, `diff_before_sha256`.
   - It refuses any fingerprint (including the tree hashes) that is not a 64-hex SHA-256.
   - `results.json.experiment` records the executed QB commit (`$GITHUB_SHA`), the dataset revision (from `sources.json`), the reviewed lock hash, and the sha256 of each of the six install-record files. Malformed or missing values, and an install record that isn't exactly those six files, are refused.
   - A new test sanitizes the output of a real fixture run of `grade.mjs`: fingerprints survive as 64-hex, while patch, eval and log text don't.
3. **Lock evidence persisted** in `lock-evidence/run-42906422892/` (commit `87f8e6f`): the zip and all six hashes equal 10559.

The grade artifact allowlist gains `install-provenance.json`.

## Grade run 42914501341 (approval 10564, commit `c199af1`): FAILED. Analysis in 10567, decision in 10568
- **Passed in the real environment:** every install and provenance gate (evidence, 81 wheels, archive, offline build, `pip check`, installed set, source hashes, harness smoke).
- **2006:** empty and gold 6/6 met; tamper, conflict and timeout met.
- **2005:** empty and gold 0/6, with every required test "missing" in the strict view.
- **Zero-byte control:** graded on both tasks.
- **Sanitizer:** refused (a false positive), so no artifact was published.

## Revision 6: review 10568 (red first in `99e6c7c`, 11 failing; fixtures only)
1. **Empty patch excluded as the harness does.** `harnessExcludesPatch()` is true only for a submitted string that is exactly `""` (`run_evaluation.py` lines 627–639). The run is recorded as `empty_patch_excluded` before any container: no docker call at all, including cleanup. The no-candidate baseline (`null`) and whitespace-only patches are unaffected. The control now expects `empty_patch_excluded`; the conflict control is unchanged.
2. **Diagnostics only for 2005.** No gate, parser, image or expectation change.
   - **Per run (`log_diag`):** `jq_available` (a recorded `command -v jq` step before the eval); start/end marker presence; result-line counts inside the marker section and across the whole captured log; `command_not_found`; `jq_error`; and `output_capture` (`stdout_then_stderr`, which states how this runner captures output).
   - **From `grade_report.py`:** `diagnostics` (marker presence, section and whole-log result-line counts, the official status-map size) plus `grade.log_gate`, `official_status_map_entries` and `strict_raw_result_lines`.
   - Counts and booleans only.
   - The grader test stub now mirrors the pinned `get_logs_eval` whole-log fallback.
3. **Sanitizer.**
   - **Scope:** names come from the two pinned tasks only (`TASKS` in `grade.mjs`; a fixture scope is accepted only for `fixture_mode` summaries).
   - **Fail closed:** if either vault row or required list is missing or empty, or a name is under 6 characters, nothing is published (exit 1). Identity and install-record errors also publish nothing.
   - **Fallback:** content refusals (a required name, patch text, a secret, an invalid fingerprint, invalid diagnostics) produce `fallback.json`, built independently from validated enums, integers and booleans (task, label, rep, outcome, expectation_met, accepted, plus refusal codes and indexes), and scanned separately. The sanitizer then exits 3. Any invalid value blocks the fallback (exit 1).
   - **Never green:** the proposed workflow fails the job whenever only the fallback was published.

**Observation for the reviewer (not acted on; needs a decision):**
- The pinned harness reads the container output as one stream in arrival order (`docker_utils.exec_run_with_timeout`: `exec_start(stream=True)`, not demultiplexed).
- This runner stores stdout and then stderr. With `set -x`, the Start/End markers go to stderr, while 2005's `jq` result lines go to stdout, so they land outside the marked section.
- The official `get_logs_eval` falls back to the whole log when the section parses empty. Its own comment names this ordering case, which fits 2005's official resolution being as expected while the strict view (section only) saw nothing.
- The diagnostics above will confirm or refute this. Capturing the output combined (`2>&1` inside the container) and mirroring the fallback in the strict view are candidate fixes, deliberately **not** made in revision 6.

**Proposed CI change (inactive file only):** sanitize exit 0 → `published=full`; exit 3 → `published=fallback` plus an error annotation; anything else → step failure. Upload runs only when something was published (`fallback.json` added to the paths). The final step fails the job if grading failed **or** only the fallback was published. `plan-A1.txt` is now 324 commands for 20 runs. The active `.github/workflows/kan111-grade.yml` is unchanged; its one-run approval is spent.

## Incident: an unintended local execution attempt (disclosed, 2026-11-10)

**What happened:**
- While writing the red-phase tests, I ran the new runner tests against the **old** `grade.mjs`. The old runner didn't know about test fixtures.
- One guard test passed `--execute --approved-by=10551` (a real-looking review comment id). The old runner treated that as real approval and attempted a real run on this Mac (darwin/arm64) with the real `docker` CLI.

**What ran:**
- No SWE-bench image was present afterwards, and no `kan111` container existed. Every `docker exec` returned "No such container", so **no task code ran**.
- The pinned harness was not installed, so the grade step failed.
- The only external effect was the attempted image pulls.

**What leaked:**
- The run's output folder was committed and pushed in `9265147`: per-run `run.json`, `test_output.txt`, the official `eval.sh` copies (which contain the hidden test patches) and `patch.diff` copies of the gold patches.
- They were removed in `8a018d1`, and `bench/public/grader/*/results/` is now gitignored.
- **They remain in the public branch history at `9265147`.** Rewriting that history (a force push) is the owner's decision. The dataset itself is public on Hugging Face, but this repository's rule is that grading material stays out of it.

**Prevention:**
- The guard test now runs with the fake docker CLI and fake grader, a temporary output folder and an obviously fake approval string, and asserts that a refused run writes nothing.
- Test fixtures are only honoured with `--approved-by=FIXTURE`, and that string is refused without a fixture.
