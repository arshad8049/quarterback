# Branches

## Policy
- **`main` is the only long-lived branch.** The live site deploys from it (Cloudflare).
- **One branch per card,** named `kanNN-short-topic` (for example `kan71-dev-requalify`). A
  branch that depends on another unmerged branch is reviewed as a dependent PR. It is merged
  only after the branch it depends on.
- **Branches reach main through a pull request with a merge commit.** A branch under review
  is never rebased or force-pushed. Jira evidence and exact-commit CI runs cite its SHAs, and
  rewriting the history would leave them pointing at commits that are no longer on any branch.
- **Delete a branch once its PR merges.** GitHub's "Automatically delete head branches"
  setting does this for you.
- **`gh-pages`** is the generated preview site
  (https://arshad8049.github.io/quarterback/, noindex). It is never merged into main.

## Open branches (2026-11-08)
| Branch | Card | Base | Merge when |
|---|---|---|---|
| `kan105-impossible-scope` | KAN-105, In Review | main (PR #23 merged; 2 review commits after it) | follow-up PR reviewed. Trial merge with main: 960 pass, 0 fail |
| `kan71-dev-requalify` → `kan74-dev-r2-tooling` → `kan76-pipefail` | KAN-71/74/76, Accepted in Jira | main (a stack: each contains the one before) | reviewed as one PR from `kan76-pipefail`. "Accepted" is not merge approval. Trial merge: 953 pass, 0 fail |
| `kan75-checker-replay` | KAN-75, Accepted | `kan71-dev-requalify` | after the stack. Trial merge: 961 pass, 0 fail |
| `docs-bench-refresh` | bench docs (85b04fb) | `kan71-dev-requalify` | after the stack; its docs commit describes the kan71 state and is not on main |
| `kan73-compile-rate`, `kan99-scenario-checks` | KAN-73, KAN-99, In Progress | main | when the cards finish |
| `kan70-fy04-reference` | KAN-70, Pending | main | when the card finishes |
| `real-run` | none (owner's branch) | main | the owner decides |

## Archive
The branch clean-up of 2026-11-08 (owner-approved) deleted 11 branches, after rechecking each against `origin/main`:
- merged, no unique patches: `kan103-l1-contract-repair` 6fe0d38 (#19), `kan104-l1-malformed-json` c6a7bb5 (#20), `kan103-104-review-fixes` ef57874 (#21), `kan106-l1-live-eval` 75f9cd8 (#22), `qb30-gh-runner` 308ff2a (#17), `readme-beta-testers` 9c36a91 (#18), plus the local-only `docs-refresh` 6b37cae, `qb31-runner-preflight` f747418 (#16) and `repo-branch-policy` c17f824 (#15);
- not for merging: `trial-merge-qb30-main` c136b2a (0 unique patches) and `kan76-control-v1` e5b9926 (2 control commits, tagged `archive/kan76-control-v1`).

Earlier: the branch clean-up of 2026-10-16 deleted 17 GitHub branches:
- 14 already merged into main;
- `phase-4-evaluation`, which is contained in `qb30-gh-runner` and tagged
  `archive/phase-4-evaluation`;
- `qb31-walkthrough-accepted`, which is contained in `qb31-runner-preflight`;
- `hero-run-local`, a local test merge, archived.

The owner keeps a bundle of every ref, an inventory of each branch with its full SHA, and the
draft classifications in two copies outside the repository
(`quaterback-archive-2026-10-16`). The restore was tested: all 66 refs match.
