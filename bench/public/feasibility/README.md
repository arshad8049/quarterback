# KAN-110: immutable-js no-agent feasibility (review 10541)

**Results by platform:**
- `results/darwin-arm64/`: run of 2026-11-10 on Apple Silicon (below). Preserved unchanged.
- `results/linux-x64/`: native Linux x86_64 run of 2026-11-10 on a standard GitHub-hosted `ubuntu-24.04` runner. Workflow `.github/workflows/kan110-feasibility.yml` at `8cf32bb` on this branch only; run https://github.com/arshad8049/quarterback/actions/runs/42869533603. Results below.

## Native Linux x86_64 result: install succeeds, build fails on network access. Path stopped at the build.

| | Task 2006 (`qbt_00b20b1b0285`) | Task 2005 (`qbt_9b9a5da937c9`) |
|---|---|---|
| Install (`npm ci`, QB DEPS proxy) | **succeeded**: exit 0, 15.6 s; 1,063 packages; node_modules 677 MiB; deps-check ok | **succeeded**: exit 0, 15.5 s; 979 packages; 686 MiB; deps-check ok |
| Native modules | `microtime` loads (linux-x64 N-API prebuild) | `microtime` loads; `@esbuild/linux-x64` present |
| **Build (`npm run build`)** | **failed, exit 1, after 3.6 s.** Rollup produced `dist/immutable.js` and `dist/immutable.es.js`, then `build:stats` (`node ./resources/dist-stats.mjs`) failed: `fetch failed … getaddrinfo EAI_AGAIN bundlephobia.com` (no network in the sandbox) | **failed, exit 1, after 2.7 s.** Same: dist bundles created, then `build:stats` failed on `bundlephobia.com` |
| Build peak memory (cgroup) | 277 MiB (limit 4 GiB) | 260 MiB |
| Jest list / run | not run (stopped at first failure) | not run |
| Jest version (installed) | 27.2.0 | 29.6.4 |

**Host and identity:**
- **Runner:** GitHub-hosted `ubuntu24` image `20261101.360.1`, `Linux 7.0.0-1017-azure x86_64`, 4 vCPU, 16.8 GB RAM (15.8 GB available), 92 GB free disk, Docker 28.0.4 (amd64), cgroup v2.
- **QB:** commit `8cf32bb`; sandbox code identical to `main` `784e721bfe18`; QB admission **ok** (peak 9.81 GB vs 15.3 GB available).
- **Images:** agent/install image `qb-sandbox-agent:c-4b166ca34296ddda` = `sha256:0070713b058152b9b4c36263fbd8ec9aac39c173a58293905777bbffd6a89894` (amd64); tools image `sha256:4865d422dd6e3686fb493e0249507de391096f8ad5e0be45e2902e8ccc3c19db`. The Node base image digest wasn't captured: `docker image inspect node:24-bookworm-slim` found no local tag after QB's build.
- **In the sandbox:** Node v24.22.2, npm 11.19.1.

**Findings:**
1. **The cause is network access in the build, not the platform.** `build:stats` reports bundle sizes from bundlephobia.com. Everything Jest needs (`dist/`) was built before it. QB's sandbox correctly has no network.
2. **The same QB image tag is not the same environment.** Both platforms used `qb-sandbox-agent:c-4b166ca34296ddda`, but the arm64 copy (built about five weeks ago) has Node v24.21.0, and the x86_64 copy (built fresh on the runner) has Node v24.22.2 and npm 11.19.1. QB's content tag doesn't pin the `node:24-bookworm-slim` base digest.
3. **npm 11.19.1 didn't run dependency install scripts.** It warned: "install scripts not yet covered by allowScripts": `microtime` (both tasks) and `esbuild` (2005). So the x86_64 install success isn't only because the linux-x64 prebuild exists: the scripts were skipped. The arm64 failure came from an older npm that did run them. The ARM and x86_64 install results are therefore not a clean architecture comparison.
4. **A probe mistake of mine:** it ran the native esbuild binary through `node`. That output was removed from `2005.json`; `@esbuild/linux-x64` is installed.

**Smallest next step (needs approval; nothing changed):** use an **approved pre-test command that omits `build:stats`**, instead of `npm run build`. No network change. The pre-test command would be part of the approved contract, as PROPOSAL-A requires.
- 2006: `npm run build:clean && npm run build:dist && npm run build:esm && npm run build:copy && npm run build:prepare`.
- 2005: `npm run build:clean && npm run build:dist && npm run build:types && npm run build:prepare`.

Then the pinned `jest --listTests` and Jest run on the same runner.

**Separately, for review:** pin the base image digest in QB's image identity, and decide QB's policy on npm's new install-script default. Both are outside this card's scope.

## Run 2 plan (review 10544): approved offline build

**Source inspection at both exact bases (2026-11-10, read from raw.githubusercontent.com at the base commit):**
- **Build chain:** `npm run build` = `run-s build:*`, which runs the `build:*` scripts in definition order. There are **no pre/post build hooks** at either base.
  - 2006 (`493afba6`): `build:clean, build:dist, build:esm, build:copy, build:prepare, build:stats`.
  - 2005 (`77434b3c`): `build:clean, build:dist, build:types, build:prepare, build:stats`.
- **`build:stats` is last at both:** `node ./resources/dist-stats.mjs`.
  - 2006: 1,766 bytes, sha256 `2d54aa8d58747e7c…`. 2005: 2,073 bytes, sha256 `09f568cfee313753…`.
  - It only **reads** `dist/immutable.js` and `dist/immutable.min.js`, fetches bundlephobia.com, and prints size comparisons. It writes no file, and no later step or test reads anything from it.
- **Tests use the build output:** `jest.config.js` uses `resources/jestResolver.js`. With `CI` set (our stage sets `CI=1`), it resolves `immutable` to `pkg.main` = `dist/immutable.js`, produced by `build:dist`. Without `CI`, it uses `src/Immutable.js`.
- **Approved offline build:** every `build:*` step except `build:stats`, as exact `npm run <script>` commands in the same order, stopping at the first failure.
  - 2006: `npm run build:clean && npm run build:dist && npm run build:esm && npm run build:copy && npm run build:prepare`.
  - 2005: `npm run build:clean && npm run build:dist && npm run build:types && npm run build:prepare`.
- **Guard:** before building, a check inside the sandbox refuses to run if package.json's `build:*` list, its `build` script or the absence of pre/post hooks differ from what was inspected. It was tested against both real package.json files (accepted) and tampered copies (refused, exit 9).
- **What a pass proves:** base-project feasibility under this disclosed adjusted build. **Not** gold/empty grading, QB Jest support or Opus performance.

**Environment freeze (in the workflow, before execution):**
- `docker pull node:24-bookworm-slim` and record its digest;
- build QB's images and prove the agent image's first layers equal that base's layers;
- record Node, npm, `ignore-scripts` and npm's script settings from inside the image.

This is a **new environment**: run 1's image was on an ephemeral runner and can't be reused.

**Grader (KAN-111), unchanged for now:**
- The independent grader's command for these tasks runs the full `npm run build` (including `build:stats`) and then `npx jest <files>`. If the grader runs without network, its build will fail the same way.
- Any adaptation needs separate review before KAN-111, and must apply equally to the empty patch, the gold patch and both candidate arms. No silent benchmark edits.
- The grader's `CI` setting decides whether tests exercise `dist/` or `src/`, so it must be recorded and matched.

**Proposed product follow-ups (separate, not part of this card):**
1. Pin the base image digest in QB's sandbox image identity. The tag `c-4b166ca34296ddda` stood for Node 24.21.0 on one machine and 24.22.2/npm 11.19.1 on another.
2. Make QB's npm install-script policy explicit (e.g. a fixed `ignore-scripts`/allowlist setting), rather than inheriting whatever the bundled npm version defaults to.

Neither ARM-vs-x86_64 causation nor platform reliability is established, because Node, npm and the script defaults also differed between the runs.

**Native x86_64 run (prepared, same script, unchanged QB sandbox):**

```bash
node bench/public/feasibility/immutable-feasibility.cjs --preflight   # host, memory, Docker, image digests, QB admission; runs no stage
node bench/public/feasibility/immutable-feasibility.cjs 2006 2005     # stops at the first failure: install → build → jest list → jest
```

The script writes to `results/<os>-<arch>/`, so it never overwrites another platform's results. After a failed install it doesn't build. After a failed build, or zero listed tests, it doesn't run Jest.


Preparation evidence only. This is not a scored pilot and not KAN-111 reference validation. No agent or model ran. No hidden benchmark tests or gold patches were used. No `npx` download fallback, no new egress, no image change, no host execution of repository scripts.

## Result: both tasks fail at dependency install in the current QB sandbox image. Path stopped.

| | Task 2006 (`qbt_00b20b1b0285`) | Task 2005 (`qbt_9b9a5da937c9`) |
|---|---|---|
| Base commit / tree | `493afba6ec17d9c999dc5a15ac80c71c6bdba1c3` / `9b55941f…` | `77434b3cbbc8ee21206f4cc6965e1c9b09cc92b6` / `7cd8bc84…` |
| Seed (trusted snapshot) | completed, 0.25 s | completed, 0.23 s |
| Dependency plan (`deps-plan.sh`) | ready (lockfile v2, no workspaces, no lifecycle scripts, no git deps) | ready |
| **Install (`npm ci`, QB DEPS proxy)** | **failed, exit 1, after 69.2 s** | **failed, exit 1, after 85.6 s** |
| Cause | `microtime@3.0.0` install script `node-gyp-build` found no prebuilt binary for linux-arm64, fell back to `node-gyp rebuild`, and failed: "Could not find any Python installation to use" | Same (`microtime@3.0.0`). No other package failed. `esbuild` was not the cause. |
| Build (`npm run build`) | not run (install failed) | not run |
| Jest list / run (pinned `node_modules/.bin/jest`) | not run | not run |
| Node / npm / node-gyp in the sandbox | v24.21.0 / bundled / v12.4.0 | same |
| Jest version (from the lockfile; not executed) | 27.2.0 | 29.6.4 (+ `jest-jasmine2`) |
| Resources | Install stage limit 6 GiB (QB `stageMemoryLimit('deps')`), no network except the DEPS proxy; peak memory not instrumented (QB's own install stage was run unchanged); wall 72.6 s | Same; wall 88.4 s |
| Cleanup | 0 containers, 0 networks, 0 volumes left | Same |

## Environment (exact)

- **Host:** macOS on Apple Silicon (`darwin/arm64`), Docker Desktop 28.1.1, Linux VM `aarch64`, cgroup v2, 8.2 GB VM memory.
- **QB sandbox code:** identical to `main` `784e721` (`git diff 784e721 -- lib sandbox agent verify context` is empty at both run commits, `3d8743d` and `01da18f`).
- **Images (content-addressed by QB, not rebuilt):**
  - agent/install image `qb-sandbox-agent:c-4b166ca34296ddda`, id `sha256:f385bf4637f75ff2c31f031b557f4ccca70358ed8acc58228d0d3d44b694827e` (linux/arm64, `node:24-bookworm-slim` + socat, git, ca-certificates, curl; no Python, make or compiler);
  - tools image `sha256:a7379242949e75db0712a40e33c7b57072e90caeff69cefd408f8a8dad720b6d` (arm64).
- **QB admission:** not used to gate this run. Admission is a whole-run check sized for an agent run (about 11.1 GiB free), which this 8 GB VM can't satisfy. Only the seed and dependency stages ran, each under QB's own per-stage memory limit (seed 2.75 GiB, deps 6 GiB). This is disclosed, not hidden.

## Why it fails here, and what that does not prove

`microtime@3.0.0` (a required devDependency of immutable-js, used by its benchmarks) ships N-API prebuilds for `linux-x64`, `linux-arm` (32-bit), `darwin-x64` and `win32-x64`, but **not `linux-arm64`**. The package listing was read from the npm registry tarball, not executed.

So on this arm64 host, the install compiles, and QB's image has no toolchain.

On QB's validated platform (Linux x86_64 with Docker Engine), `node-gyp-build` would find `prebuilds/linux-x64/node-napi.node` and probably need no compiler. **That is a hypothesis, not a result:** it has not been run there. The upstream grader images (Node 20 with build-essential) passing would not prove the Node 24 QB sandbox either.

## Smallest next step (needs approval; nothing changed)

1. **No product change (preferred):** run this same script, unchanged, on QB's validated platform (Linux x86_64, Docker Engine, 16 GB). For example the GitHub Codespace profile used for the QB-31 walkthrough. That's not local hardware, so it needs Arshad's OK; it's within the free quota, not paid. Expected effect: `microtime` uses its linux-x64 prebuild and `esbuild` its `@esbuild/linux-x64` package. Then the build and the pinned Jest run as specified here.
2. **Only if arm64 hosts must work (separate reviewed scope):**
   - a toolchain (`python3`, `make`, `g++`) in the **dependency-install stage image only**;
   - with `npm_config_nodedir=/usr/local`, so node-gyp uses the image's bundled Node headers instead of downloading them (no egress change);
   - agent and verification images unchanged.
3. **Not recommended:** skipping `microtime`'s install script. That changes dependency semantics for one package, and QB's policy shouldn't special-case packages.

## Exact commands

From the repository root, with Docker running:

```bash
node bench/public/feasibility/immutable-feasibility.cjs 2006 2005
```

**What the script does:**
1. **Host:** `git fetch --depth 1 https://github.com/immutable-js/immutable-js.git <base>`, then `git checkout --detach FETCH_HEAD`, and verifies HEAD.
2. **QB, unchanged:** `createWorkspace` → `ws.seed` → `prepareDeps`:
   - `deps-plan.sh`;
   - `npm ci --no-audit --no-fund --registry=https://registry.npmjs.org/` behind the DEPS proxy;
   - `deps-check.sh`.
3. **Then, in QB's hardened workload container** (no network, memory limit, read-only deps):
   - `base-prep.sh`;
   - a version probe;
   - `npm run build`;
   - `node_modules/.bin/jest --ci --listTests`;
   - `node_modules/.bin/jest --ci --runInBand --json --outputFile=/out/jest.json`.

**Outputs:**
- `results/<task>.json`: stages, images, limits and findings.
- `results/<task>-npm-ci.log`: the tail of npm's output. No credentials are present: the sandbox mounts none.
