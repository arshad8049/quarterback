# Proposal A, revised: a bounded Jest + Yarn Classic adapter (for review, not implemented)

KAN-110 review, comment 10539. This is a scope proposal for a **separate product change**. Nothing here is implemented in QB. No task is selected or run.

Every number comes from `manifest/proposal-a.json`, produced by `node public/proposal-a-audit.mjs`. It is a static audit at the pinned dataset revisions, against QB `784e721`.

## 1. What the revised audit found

The first estimate (216 tasks, 181 without gold overlap) was wrong. `deps-plan.sh` stops at a missing `package-lock.json`, so Yarn-only projects were never checked for workspaces, lifecycle scripts or git/file/link dependencies.

The revised audit:
- **Reads the real files:** `yarn.lock` (SHA-256 recorded), `.yarnrc`, `.yarnrc.yml` and `packageManager`.
- **Checks every restriction independently:**
  - workspaces;
  - root lifecycle scripts;
  - git/file/link/portal/patch dependencies;
  - registries;
  - integrity hashes;
  - Yarn generation;
  - a repository-supplied `yarnPath` or plugins;
  - the Plug'n'Play linker.
- **Checks dependency install scripts:** from `package-lock.json`, or for Yarn Classic from npm registry metadata.
- **Treats runtime hints as hints:**
  - a pinned old Node is **unknown**;
  - only an `engines` range that excludes Node 24 blocks.

Status under the revised Proposal A (Jest runner, Yarn Classic):

| Source | Eligible (static) | Unknown | Incompatible | Gold-overlap flagged |
|---|---|---|---|---|
| Pro V2 | 0 | 0 | 149 | 12 |
| Multilingual | 0 | 2 | 41 | 0 |
| PolyBench | 21 | 38 | 1,687 | 65 |

### Per repository (Jest repositories)

| Repository | Eligible | Unknown | Incompatible | What decides it |
|---|---|---|---|---|
| immutable-js (Multilingual) | 0 | **2** | 0 | Native/script dependencies `microtime` (both tasks) and `esbuild` (one task); no compiler in the QB image; Node undeclared |
| prettier (PolyBench) | **21** | 30 | 145 | See below |
| element-web (Pro) | 0 | 0 | 52 | git/GitHub-tarball deps (52), non-npm registries `gitlab.matrix.org` / `packages.matrix.org` (40) |
| protonmail/webclients (Pro) | 0 | 0 | 55 | Yarn Berry with repo plugins and yarnPath, patch protocol, workspaces, root lifecycle scripts |
| babel (Multilingual) | 0 | 0 | 5 | Yarn Berry, plugins, patch protocol, workspaces, git deps |
| docusaurus (Multilingual) | 0 | 0 | 5 | Workspaces, root lifecycle scripts |
| tailwindcss (PolyBench) | 0 | 0 | 20 | Root lifecycle scripts, missing integrity |
| code-server (PolyBench) | 0 | 0 | 14 | Root lifecycle scripts, a third-party registry mirror; runner also unidentified |

The remaining unknowns are three.js tasks whose runner can't be identified; they aren't Jest targets.

**Prettier detail:**
- **Incompatible (145):** 110 have git deps only; 24 are Yarn Berry with plugins and patches; 6 have git deps and a non-npm mirror; 1 has no lockfile.
- **Unknown (30):** dependency install scripts, mostly `fsevents`. That one is macOS-only and normally optional, but Yarn Classic's lockfile doesn't mark it optional, so it stays unknown.
- **Eligible-static (21):** 18 base commits, none gold-flagged. These are prettier's 2017 history (PRs #459–#921), with **Jest 18.0.0 (13 tasks) and 19.0.1 (8 tasks)**. The PolyBench setup pins Node 20.16.
  - Each needs two adapter features: **`registry.yarnpkg.com` mapped to registry.npmjs.org**, and **acceptance of SHA-1-only integrity** (2017 Yarn lockfiles have no sha512 `integrity` lines).
  - **Runtime is unverified:** QB's image is Node 24.

**Conclusions:**
- Proposal A as bounded here **cannot give cross-source coverage**. Pro and Multilingual Jest repositories stay incompatible for reasons other than the runner.
- The smallest technical smoke is **immutable-js (2 tasks, npm, Jest 27/29)**. One source, and still unknown on native installs and runtime.
- The largest pool is **21 old prettier tasks** (one source, Jest 18/19, 2017). Being that old, they have a higher chance of training-data exposure; that's a reviewer judgement, not something this audit decides.

## 2. Smallest feasibility option first: immutable-js (2 tasks)

| | Task 2006 (`qbt_00b20b1b0285`) | Task 2005 (`qbt_9b9a5da937c9`) |
|---|---|---|
| Base commit | `493afba6` | `77434b3c` |
| Lockfile | package-lock v2, 1,071 entries, all `registry.npmjs.org`, all with integrity | v2, 1,008 entries, same |
| Jest | 27.2.0 (default runner) | 29.6.4, with `jest-jasmine2` installed |
| Install scripts | `microtime` 3.0.0 (required, native addon); `fsevents` optional | `microtime`, `esbuild` 0.18.20 (required); `fsevents` optional |
| Workspaces / root lifecycle / git deps | none / none / none | none / none / none |
| `npm test` | `run-s format lint type-check build unit-test` (Prettier, ESLint, tslint, tsc, dtslint, Flow, Rollup, a shell script, then Jest) | same shape, plus `tstyche` |
| Grader | `npm run build`, then `npx jest <files>` | same, with `--json` |
| Grader image | `swebench/sweb.eval.x86_64.immutable-js_1776_immutable-js-2006`, linux/amd64, `sha256:ecf16bc4…`; Node 20 (NodeSource), build-essential | `…-2005`, `sha256:d038a276…`; same |
| QB sandbox | Node 24 (`node:24-bookworm-slim`), no compiler, dependency scripts run contained | same |
| Status | **unknown**: microtime install, runtime | **unknown**: esbuild/microtime install, runtime |

**Findings that change the adapter design:**
1. **`npm test` is the wrong command.** It runs linters, type-checkers and a build before Jest. A Jest adapter must run Jest itself, and the grader also runs a build first. QB needs an explicit, approved pre-test step; it must not guess from `scripts.test`.
2. **Two Jest generations, one with the jasmine2 runner.** The reporter mapping must be tested on both.
3. **Native addons.** `microtime` builds with node-gyp unless a prebuilt binary matches. QB's image has no compiler. Either the image gains a toolchain (a separate decision), or these tasks stay unknown until a real install proves otherwise.
4. **Runtime mismatch.** The grader uses Node 20 and QB uses Node 24. The independent grader keeps its own image, so the risk is to QB's internal verification, not to grading.

## 3. Bounded Jest adapter (product change, separate PR)

| Topic | Proposal |
|---|---|
| Supported versions | **Jest 27.x–29.x** for the first release, which covers the immutable-js smoke. Versions 18/19 (prettier) only after a separate fixture run proves the JSON shape and the Node 24 runtime. Version read from the lockfile; outside the range, refuse before any model call (exit 2, named), like other unsupported runners today. |
| Invocation | QB runs the project's pinned `node_modules/.bin/jest` directly, never `npm test`: `jest --ci --runInBand --no-cache --watchman=false --passWithNoTests=false --json --outputFile=<QB path> --testLocationInResults`. An optional pre-test command (e.g. `npm run build`) comes only from the approved contract or `.quarterback.json`, never inferred. |
| Trusted result | Parse only the JSON file QB asked Jest to write (plus the exit code). Never parse console output. The file is read by trusted QB code after the process ends, like the node:test reporter path today. |
| Per-test mapping | `testResults[].assertionResults[]` becomes a QB test: identity = file path + `ancestorTitles` + `title` (same shape as QB-10's file + suite path + name). Status: `passed`→pass; `failed`→fail with `failureMessages`; `pending`/`skipped`/`todo`→skipped (never counted as pass); `duration` kept. |
| Errors | A suite that failed to run (`testExecError`, `numRuntimeErrorTestSuites > 0`) → error for that file, so the run can't pass. Non-zero exit with every test passed → unresolved. Missing or invalid JSON → error. Timeout → error. |
| Zero tests | Zero matched tests → not run / unresolved, never pass (explicitly no `--passWithNoTests`). |
| Snapshots | Run with `--ci`, so missing snapshots fail instead of being written. Obsolete snapshots are reported, not failed. |
| Protected files | Jest config (`jest.config.*`, the `jest` key in package.json), its transformers/setup files and babel config become protected paths: an agent change there is a scope violation, like test files today. Hidden grader tests (`test_patch`) never enter the agent workspace; they are applied only by the independent grader (KAN-111). |
| Detection | Order: `.quarterback.json` runner `jest`, then the detector. A detected Jest whose actual entry point can't be resolved (e.g. Jest inside yarn workspaces) is refused, not run as `npm test`. |
| Repair/replay | Per-test results gain `runner: "jest"`, the Jest version and the reporter schema version. Replay re-reads the stored JSON with the same mapper; manifests and hashes include runner identity. Existing node:test runs replay unchanged. |
| Regressions | All node:test tests unchanged. New fixtures from real Jest 27 and 29 JSON: pass, fail, skip, todo, zero tests, exec error, timeout, snapshot-missing, console noise, jasmine2 runner. QB-10 baseline and pre-existing-failure logic tested with Jest identities. |

## 4. Bounded Yarn support (only if the prettier pool is wanted)

| Topic | Proposal |
|---|---|
| Generation | **Yarn Classic 1.22.x only**, pinned in the QB image. Berry is refused, as are a repository's `yarnPath` and plugins (never executed) and Plug'n'Play. |
| Command | `yarn install --frozen-lockfile --non-interactive --registry https://registry.npmjs.org/` behind the same DEPS proxy (registry.npmjs.org only). |
| Registry | `registry.yarnpkg.com` URLs in the lockfile are an explicit, logged mapping to registry.npmjs.org (same package content). Any other host is refused, with no egress change. |
| Integrity | sha512 `integrity` lines are verified. **Decision needed:** 2017 lockfiles have only SHA-1 URL fragments. Accepting them is weaker integrity (SHA-1 is collision-broken). If refused, the 21 prettier tasks become incompatible and Proposal A has no eligible task. |
| Fingerprint | The manifest fingerprint adds `yarn.lock`, `.yarnrc`, `.yarnrc.yml` and `packageManager` to package.json and `.npmrc`. |
| Lifecycle | Root lifecycle scripts refused (as for npm). Dependency scripts run contained, as `npm ci` does today. Native builds stay unknown without a toolchain. |
| Restrictions kept | Workspaces, git/file/link/portal/patch deps and non-npm registries refused. Immutable install only. |

## 5. What is not proposed

Mocha, Karma, QUnit, Vitest, services (xvfb, browser, Redis), Yarn Berry, workspaces, git dependencies, unpinned installs, network-policy changes, hidden-test rewriting or test conversion.

## 6. Order of work if accepted

1. Reviewer + Arshad choose the scope:
   - (a) the Jest adapter only, for the immutable-js technical smoke;
   - (b) Jest plus Yarn Classic, with the SHA-1 decision;
   - (c) stop at this report.
2. A separate product PR implements the accepted part, with the regression set above. It is reviewed on its own.
3. Re-run `qualify.mjs` and `proposal-a-audit.mjs` on that PR's actual QB SHA, then `shortlist.mjs` unchanged.
4. KAN-111: empty and gold patch validation on the independent grader.
