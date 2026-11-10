# KAN-110: immutable-js no-agent feasibility (review 10541)

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
