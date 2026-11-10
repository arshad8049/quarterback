# KAN-111: exact offline grader adaptation `immutable-offline-v1` for immutable-js tasks 2005 and 2006 (for review, NOT run)

KAN-110 reviews 10545 and 10549. This is a **separately versioned adaptation** of the official SWE-bench harness. It is never reported as an official benchmark score.

## Exact artifacts (submitted for review)

| File | SHA-256 | Role |
|---|---|---|
| `grade.mjs` | `272215b4de60def748b18be30dbc28c4e5458dee5c94c5db884eaec4aac88b0f` | Runner. **Plan-only by default**; `--execute` is refused without `--approved-by=<review comment id>` |
| `grade_report.py` | `e4629c9263f85cbf107e5c889b2210c2991d92f8e40d60d32274e52169966f44` | Grades one run with the **pinned harness functions** plus strict additive checks |
| `grade-wrapper.sh` | `19184519e448563bd1cd4cc7181dd03c9173de930abfb76496ac46e1a45b9e0c` | Records `CI`, Node/npm, the resolver target and tree hashes, then runs the eval script unmodified |
| `plan-A0.txt` | `0b5d879cceac25e8a127f5985d144f35cffc4b43e68deafb950ceeedb8051d94` | Every command the A0 run would issue: 230 commands, 20 runs. A1's commands are identical except the results folder; A1 differs only in the one-line content of `eval.sh` |

**Pinned harness:** SWE-bench/SWE-bench @ `02e7a74ffd0b707aab73d203fe87bdc7c76afc8e` (main, 2026-09-02; the latest PyPI release is 5.0.2).

| Harness file | SHA-256 |
|---|---|
| `swebench/harness/log_parsers/javascript.py` | `87e907b2…` |
| `swebench/harness/grading.py` | `a0952730…` |
| `swebench/harness/run_evaluation.py` | `04b5dab5…` |

**Replicated exactly from `run_evaluation.py`:**
- user `root`, workdir `/testbed`;
- the candidate patch at `/tmp/patch.diff`, applied with `git apply --verbose` → `--3way` → `--reject` → `patch --batch --forward --fuzz=5 -p1 -i`, with `git checkout -- . ; git clean -fd` between attempts and a final `git apply --check --reverse`;
- the eval script run as `/bin/bash /eval.sh` via exec, **with no extra environment** (so `CI` is unset);
- default timeout 1,800 s.

**Grading** calls the harness's own `get_logs_eval` (log gate and markers), `parse_log_immutable_js` (2006 → `parse_log_jest`, `--verbose`, keyed by leaf title; 2005 → `parse_log_jest_json`, `[PASSED|FAILED] ancestors > title`), `get_eval_tests_report` and `get_resolution_status`.

**Differences from the official harness (for review):**
1. **`--network none`.** The harness uses default networking. This is the "offline" adaptation.
2. **No `--cap-add SYS_ADMIN`.** The harness adds it for browser sandboxes; these tasks run no browser. Least privilege is the proposal; `--keep-sys-admin` restores it if review prefers fidelity.
3. **The wrapper's recording lines**, printed before the eval script and outside the test-output markers.
4. **Empty candidate = base + official test patch with no candidate patch.** This is the harness's `--no-patch` path, per this card's method (a).
5. **The harness package will be installed on the CI runner at the pinned commit** (`pip install "swebench @ git+…@02e7a74"`). That is new external code on the runner, so it needs approval. It was not installed locally: Claude Code's safety check blocked that install pending the owner's permission.

**Nothing here has been executed.** KAN-111 runs only after this proposal is reviewed. No QB Jest adapter is involved: this concerns the independent grader only.

## Official grader inputs (pinned)

| | Task 2006 (`immutable-js__immutable-js-2006`) | Task 2005 (`immutable-js__immutable-js-2005`) |
|---|---|---|
| Dataset | SWE-bench/SWE-bench_Multilingual @ `846e647b9f33` | same |
| Image | `swebench/sweb.eval.x86_64.immutable-js_1776_immutable-js-2006:latest` = `sha256:ecf16bc4835839696fac8f3eed1ec36473306d5277a641f2e05254f9a552608d` (amd64) | `…-2005:latest` = `sha256:d038a276cb975ddfbb1a6b13fe9c8260fb22a0145c8605bb2a477a4d75ee5549` |
| Image runtime | Node 20 (NodeSource `setup_20.x`), build-essential, Chrome; `WorkingDir /testbed`; Env has **no `CI`** | same |
| Official eval script | sha256 `5ce0993702c9cb23375cd0bf35aced243bb51a2074ac637eb9ebc4972ff9f647` (988 B) | sha256 `70da858d49b4dc2bb8f8223f44d409c4e52296d001a24396353cdaa021f66caa` (1,965 B) |
| Log parser | `parse_log_immutable_js` (SWE-bench harness; version to pin in KAN-111) | same |
| Official test patch | `__tests__/Range.ts`, sha256 `0c6f4b5562044cea…` | `__tests__/OrderedMap.ts`, `__tests__/OrderedSet.ts`, sha256 `6948678cdb29895b…` |
| Gold patch (vault) | `src/Operations.js`, sha256 `731c25ddabfc2a00…` | `CHANGELOG.md`, `src/CollectionImpl.js`, sha256 `ee2a6dd8664143cf…` |
| Required tests | F2P 1, P2P 22 | F2P 2, P2P 20 |

## What the official script does (both tasks)

The script runs `set -uxo pipefail`, **without `-e`**:
1. reset the test files to the base;
2. `git apply` the official test patch;
3. **`npm run build`**;
4. `npx jest <test files>` (2006: `--verbose`; 2005: `--silent --json | jq …`), between the official output markers;
5. restore the test files.

## Analysis

1. **Offline, `npm run build` fails only at its last step.** `build:stats` fetches bundlephobia.com. Because the script has no `-e`, that failure is **non-fatal**: Jest still runs. `run-s` stops at the first failing step, and `build:stats` is last at both bases, so every output-producing step has already run.
2. **Which code the tests exercise depends on `CI`.** Neither the eval script nor the image sets `CI`. If the harness doesn't set it at run time, `resources/jestResolver.js` maps `immutable` to **`src/Immutable.js`**, so the tests exercise the patched sources directly and the rebuilt `dist/` is not used. `__tests__/MultiRequire.js` requires `../src/Immutable` directly in any case.
   - Our QB feasibility runs set `CI=1` and so tested **`dist/`**. That difference must be recorded, not assumed away.
3. **No stale outputs.** Under `CI` unset, tests don't read `dist/`. If `CI` turns out to be set, `dist/` is rebuilt **after** the candidate and test patches by step 3, before step 4. The run must record `jest_resolves_immutable_to` to prove which one applies.
4. **`npx jest` resolves the local `/testbed/node_modules/.bin/jest`**, so there's no download. This needs confirming offline in the run.

## Strict checks required by review 10549 (additive; the official result is reported unchanged beside them)

The official harness has three behaviours the review asks us to surface:
- **A missing required test** counts as a failure: `_resolve_case` finds no key, so `test_failed`. It isn't distinguished from a real failure.
- **The parsers build a dict,** so **duplicate result names collapse silently**: the last one wins. For 2006 the key is only the leaf title.
- **`test_maintained` treats a skipped P2P test as maintained.** The JSON transform for 2005 also drops `PENDING` lines.

`grade_report.py` therefore also reports, per required test (by index; names stay in the vault):
- **`ambiguous`:** the raw output has more than one result line for the key. **Never a pass.**
- **`missing`:** no result line.
- **`skipped`:** a skipped/`○` result, or seen only as `[PENDING]`/`[TODO]`. **Never a pass,** even where the official P2P counts it as maintained.
- **`passed` / `failed`.**
- **`all_required_unambiguous_and_present`:** a task replay is acceptable for KAN-111 only if this is true **and** the official resolution is as expected.

**Static pre-check at the base** (run-3 Jest JSON; counts only):

| | Task 2006 | Task 2005 |
|---|---|---|
| Selected-file tests | 22 | 20 |
| Duplicate parser keys | 0 | 0 |
| P2P present exactly once | 22/22 | 20/20 |
| F2P absent before the test patch, as expected for new tests | 1 | 2 |
| Duplicates within the required lists | 0 | 0 |

The post-patch output can only be checked at run time, which is what the strict check does.

**Unit tests** (`test/unit/kan111-grader.test.js`, 8 pass; the harness is replaced by a minimal stand-in, so only QB's additions are tested):
- A0 is verbatim;
- A1 changes exactly one line and refuses anything else;
- pinned identities;
- missing / ambiguous / skipped are never a pass;
- pending-only reports as skipped;
- a malformed log (no End marker) fails the gate.

The pending-only test failed first and found a real bug in my strict check, which was fixed.

## Proposed variants (choose one in review; apply identically to empty, gold and both candidate arms)

- **A0 (recommended): no script change.**
  - Run the official eval script **verbatim** in the official image (by digest) with `--network none`.
  - Expected: the build exits non-zero only at `build:stats`, and the Jest output section is unaffected.
  - Accept a run only if the recorded build log shows every step before `build:stats` completed.
  - The only adaptation is "offline", which is disclosed.
- **A1: a single-line change.** If review prefers a clean build exit, an adapted copy of the eval script that replaces only the line `npm run build` with:
  - 2006: `npm run build:clean && npm run build:dist && npm run build:esm && npm run build:copy && npm run build:prepare`;
  - 2005: `npm run build:clean && npm run build:dist && npm run build:types && npm run build:prepare`.

  The adapted script's hash is recorded beside the original, and labelled `immutable-offline-v1-A1`.

**Both variants** use the wrapper `grade-wrapper.sh` (sha256 `19184519e448563bd1cd4cc7181dd03c9173de930abfb76496ac46e1a45b9e0c`). It records `CI`, Node and npm versions, the resolver's target for `immutable`, and the tested tree's HEAD and diff hash, then runs the chosen eval script unmodified. The official test selection, assertions, test patch, image and runtime are preserved.

## KAN-111 run plan (after review)

1. **Per task, on a fresh container from the pinned image digest each time:**
   - **(a) empty candidate:** base + official test patch, via the eval script;
   - **(b) gold:** base + gold patch + official test patch.

   Each run **3 times**: a smoke check for instability, not proof that there are no flakes.
2. **Grading:** parse individual test identities with `parse_log_immutable_js`.
   - Required: F2P **fail** on empty and **pass** on gold; P2P pass on both.
   - Record any F2F as observed.
3. **Grader isolation tests**, once per task, all in `plan-A0.txt`:
   - **Hidden-test tamper:** gold + an edit to the official test file. The eval script's `git checkout <base> -- <test files>` must revert it before the test patch.
   - **Patch conflict:** expected `patch_apply_failed`, not graded.
   - **0-byte patch file:** expected `patch_apply_failed`. This is distinct from the empty candidate.
   - **Timeout:** 5 s, expected `timeout`, not graded.
   - **Malformed report:** covered by the unit test, because it needs no container.
   - **Hashes recorded:** the submitted patch and the tree before/after (`diff_before_sha256`, `diff_after_sha256`, the wrapper's `tested_tree_diff_sha256`).
4. **Store:** machine-readable outcomes, raw logs, image digests, run IDs, the wrapper hash, the adaptation label, and the exact commands for one-task reproduction.
5. **Host:** the standard ubuntu-24.04 runner, the same approval as KAN-110 runs 1–3, via a temporary branch-only workflow.
   - **Network use:** pulling the public SWE-bench images by digest, `pip install` of the pinned harness, and `node public/import.mjs --download`, which rebuilds the vault from the hash-verified dataset files. All happen before any offline container starts.
6. **Review decisions needed:**
   - A0 or A1;
   - SYS_ADMIN omitted or kept;
   - approval to install the pinned harness on the runner;
   - the strict acceptance rule above.

**Do not change any expectation after seeing results.** Any task that can't be reproduced is quarantined with its reason.
