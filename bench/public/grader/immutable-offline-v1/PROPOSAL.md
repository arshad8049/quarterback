# KAN-111 proposal: offline grading adaptation for immutable-js tasks 2005 and 2006 (v1, for review, NOT run)

Review 10545, item 3. This is a **separately versioned adaptation**, not the official benchmark harness.

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
3. **Grader isolation tests:** patch conflict, malformed report, timeout and empty-patch paths. Hash the tested tree and the submitted patch.
4. **Store:** machine-readable outcomes, raw logs, image digests, run IDs, the wrapper hash, the adaptation label, and the exact commands for one-task reproduction.
5. **Host:** the standard ubuntu-24.04 runner, the same approval as runs 1–3. Pulling the public SWE-bench images is the only network use, and it happens before the offline container starts.

**Do not change any expectation after seeing results.** Any task that can't be reproduced is quarantined with its reason.
