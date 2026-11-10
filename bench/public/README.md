# KAN-110: public datasets, compatibility and a leak-safe task boundary

Card: KAN-110 ([Opus pilot 1/6]), epic KAN-109. Free preparation only: no model calls, no agents, no paid infrastructure, no test-runner conversion. Run on 2026-11-10 against Quarterback `main` at `784e721`.

## Result in one paragraph

All three datasets were imported at pinned revisions and **1,938 JavaScript/TypeScript tasks** were inventoried. **None is compatible with Quarterback as it is today:**
- QB executes and parses **node:test only**;
- it installs dependencies only from an **npm lockfile v2/v3**, without workspaces, root install scripts or git/file dependencies;
- its sandbox reaches **only the npm registry**, on **Node 24**.

The public tasks use Mocha, Jest, QUnit, Karma or Vitest; yarn, pnpm or old npm lockfiles; often Node 10–16; and sometimes xvfb, a browser or Redis.

Following the card, **nothing was selected**. Instead there is a compatibility report and the smallest explicit adapter proposal (below). Arshad decides the scope.

## Commands (exact)

From `bench/`, with Node 20 or newer:

```bash
npm ci                                  # installs hyparquet 1.17.1 (pinned, MIT, no dependencies)
node public/import.mjs --download       # fetch pinned raw files if missing, verify SHA-256, split into stores
node public/qualify.mjs                 # read each repository at base_commit; judge against QB 784e721 rules
node public/adapters.mjs                # blocker tags and smallest adapter sets
node public/shortlist.mjs               # apply the frozen selection rule (selects nothing today)
node public/dictionary.mjs              # regenerate FIELDS.md from field-policy.mjs
```

Tests: `node --test test/unit/kan110-public-import.test.js` from the repository root (22 tests).

**Network:**
- `qualify.mjs` makes read-only GETs to GitHub. A token from `git credential fill` is used if present and is sent to GitHub hosts only; about 1,750 API calls for a cold run.
- It makes anonymous manifest requests to ghcr.io and Docker Hub.
- Responses are cached in `public/cache/`.

**Not committed** (gitignored): `public/raw/` (original data), `public/out/` (the four stores) and `public/cache/`. Task content is not republished.

## Pinned sources

| Source | HF revision | Used | Rows | Raw file SHA-256 |
|---|---|---|---|---|
| ScaleAI/SWE-bench_Pro | `2d52cb3df914a3fcf80c7f66738b3a88ae37fc50` | `default` = **V2**, test | 642 | `1067f72c1f43bbc578276888625db3b836cebb535546c9eaf824c5d5dd104a7f` |
| (same) `v1` (paper, 731) and `hard` (51) | same | hashed only | — | in `sources.json` |
| SWE-bench/SWE-bench_Multilingual | `846e647b9f33c0b51b739d005d13d85493c9af09` | default, test | 300 | `92abca7cb527b41a9f66d03a26ce441ff7319e3a49f985998fd56be4bb9b08b2` |
| AmazonScience/SWE-PolyBench | `d56445f9940eae4e9d2974ec66820c2f1d7754e6` | full `test.csv` | 2,110 | `17ad661b20e9af1e2067fbbc2e2658a21137d56693570d1d07f966d8bc0408b7` |
| scaleapi/SWE-bench_Pro-os (Pro harness: run scripts, task.toml, environment) | git `66f92766bba642462d4bbe5479e83f91f9211862` | read per task | — | (GitHub commit) |

**Pro version (decision for Arshad):** V2 `default` is proposed and used, labelled V2. It is never mixed with v1 or the paper's denominators.

**Licences:**
- Multilingual and PolyBench datasets: MIT.
- Pro harness: MIT.
- Task content of all three comes from upstream repositories under their own licences, so it is kept local and not republished.

## Counts by source

| Source | JS/TS tasks | Compatible | Incompatible | Unknown | Duplicates |
|---|---|---|---|---|---|
| Pro V2 (js 145, ts 4) | 149 | 0 | 149 | 0 | 0 |
| Multilingual (js 26, ts 17) | 43 | 0 | 43 | 0 | 0 |
| PolyBench (js 1,017, ts 729) | 1,746 | 0 | 1,738 | 8 | 0 |

**Notes:**
- **Unknown** = 8 three.js tasks whose test entry runs under Node 16 through `test/` with no identifiable framework. QB would run `npm test` with no validated reporter.
- **Duplicates:** none, within or across datasets. The only shared repository is three.js (Multilingual 3, PolyBench 18), with no shared PR and no shared base commit.
- **Shared snapshots:** 205 PolyBench tasks share a base commit with another task but are different changes. They are kept and marked `same_base_as`.

**Per-task reasons** are in `manifest/candidates.json`, one task per line. Each task records:
- QB's detected runner and test plan;
- QB's dependency plan;
- the actual runner from the scripts and the grading command;
- lockfiles and their version, and the package manager;
- Node hints;
- services;
- image digest and architecture (all 192 Pro and Multilingual images: `linux/amd64`; PolyBench builds from its Dockerfile);
- Pro resource needs (1 CPU, 4096 MB, 10240 MB storage, 3000 s timeout);
- deduplication keys and leak counters.

**Blocker frequency** (a task can have several):

| Blocker | Tasks |
|---|---|
| Mocha | 1,557 |
| Node < 20 | 1,290 |
| yarn lockfile | 1,193 |
| npm lockfile v1 | 420 |
| Jest | 307 |
| xvfb | 208 |
| No lockfile | 205 |
| No root test script | 93 |
| Unidentified runner | 58 |
| Browser | 55 |
| Redis | 38 |
| git/file deps | 37 |
| Karma | 21 |
| Root lifecycle scripts | 15 |
| pnpm | 10 |
| QUnit | 9 |
| tap | 6 |
| Vitest | 5 |
| npm workspaces | 4 |
| Jasmine | 2 |

Only 5 tasks have a single blocker.

## Adapter proposal (revised after review 10539)

The first estimate here (Jest + Yarn "unlocks 216 tasks") was **wrong**. `deps-plan.sh` stops at a missing `package-lock.json`, so Yarn-only projects were never checked for workspaces, lifecycle scripts or git/file/link dependencies.

The revised static audit reads each `yarn.lock` and the Yarn configuration, and checks every restriction independently (`proposal-a.mjs`, `proposal-a-audit.mjs`, `manifest/proposal-a.json`).

**Result under a bounded Proposal A (Jest runner + Yarn Classic):**

| Source | Eligible (static) | Unknown | Incompatible |
|---|---|---|---|
| Pro | 0 | 0 | 149 |
| Multilingual | 0 | 2 | 41 |
| PolyBench | 21 | 38 | 1,687 |

- **Multilingual unknowns:** the 2 immutable-js tasks.
- **PolyBench eligible:** 21 prettier tasks from 2017 (Jest 18/19). They need SHA-1-only integrity accepted and the yarnpkg mirror mapped.
- **Runtime:** unverified for every task.

**Proposal A is a possible product extension, not a proven fix.** It gives no cross-source coverage. Full per-repository detail, the immutable-js feasibility check and the bounded adapter specification are in [PROPOSAL-A.md](PROPOSAL-A.md).

## Normalized boundary (agent / controller / vault / quarantine)

Defined per column in `field-policy.mjs`; rendered in [FIELDS.md](FIELDS.md).

**Agent packet:** `task_id` (opaque `qbt_…`, a one-way hash), `problem_statement`, and for Pro the published `requirements` and `interface`. Identical for both arms.

**Controller:** dataset revision, repo, base_commit, the instance ID (answer-bearing) and image/setup.

**Vault:** patch, test_patch, every spelling of F2P/P2P/F2F, eval scripts, test commands and selected test files.

**Quarantine:**
- hints_text;
- solution size/shape fields and modified_nodes;
- task categories;
- the HARD label (derived from historical model results);
- PolyBench `pull_number`;
- the legacy Pro Docker Hub tag;
- any column not in the policy (fail closed).

**Leak handling in agent text** (`leak.mjs`):
- Removes the instance ID, the fix SHA (Pro embeds it in the instance ID), links to the same repository's PRs, commits, compares and SHA-pinned files, and `#<fixing PR>`.
- Nothing else is rewritten; each redaction is counted per task.
- **Result:**
  - Pro: 0 redactions;
  - Multilingual: 6 tasks, 7 links;
  - PolyBench: 109 tasks, 146 links.
- **Screening flag:** in 77 tasks (Pro 12, PolyBench 65), the agent text already quotes at least one added line of the reference fix. This is a flag, not proof of leakage: an issue can quote code. Under the frozen rule a flagged task is excluded unless a reviewer who will not author contracts records it as a false positive. The reasons are preserved, and the gold lines are never shown to contract authors.

**Contamination rule:** this import was done in a context that processed vault material programmatically. Only counts and runner names were printed, but under KAN-110's separation rule this context must not author blinded contracts (KAN-112).

## Frozen eligibility and sampling rule

`shortlist-rule.json`, frozen 2026-11-10 before any run. Seed `d45275d4…efc22` = SHA-256 of the three pinned revisions.

**Eligible:**
- compatible on the QB commit actually used;
- not a duplicate;
- agent text quotes none of the gold fix;
- no services and no Node < 20;
- Arshad's prior exposure recorded and clear.

**Order:** by SHA-256(seed | task_id) within each source, one task per repository first, two per source. A shortfall is filled round-robin and reported. Labels, difficulty, size and any model or QB result are never used.

**Today it selects nothing** (`manifest/shortlist.json`).

## Arshad's prior exposure

No commits, issues or PRs by `arshad8049` in any of the 20 repositories. `facebook/docusaurus` was checked at its new name, `meta/docusaurus`.

Absence of public commits is not evidence about exposure. `prior_exposure_arshad` is **unknown** (`null`) until Arshad records it on KAN-110, and the frozen rule treats unknown as ineligible.

## Not claimed

- No task is shown to be hard, runnable or correctly graded; that's KAN-111.
- "Compatible" would be static only.
- No model or QB run happened.
