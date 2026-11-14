# Proposed product follow-ups (separate scope, NOT approved, NOT implemented)

Review 10545, item 5. These are proposals for **separate product cards**, to be taken up only after KAN-111 shows the tasks and grader are viable. Nothing here is implemented. No Yarn, and no broad runner support.

## P1. Reproducible QB sandbox images

- **Problem (observed):** the content tag `qb-sandbox-agent:c-4b166ca34296ddda` stood for Node 24.21.0 on one host (built about five weeks earlier) and for Node 24.22.2 / npm 11.19.1 on another (built fresh). QB's tag hashes QB's own files, not the `node:24-bookworm-slim` base digest.
- **Proposal:**
  - pin `FROM node:24-bookworm-slim@sha256:<digest>` in the sandbox Dockerfiles;
  - include the base digest in the content tag;
  - record the image id and base digest in every run manifest;
  - `qb doctor` reports them.
- **Regression tests:** the tag changes when the base digest changes; a manifest without a base digest is refused.

## P2. Explicit npm install-script policy in QB's install stage

- **Problem (observed):** npm 11.19.1 runs dependency install scripts by default (`ignore-scripts=false`, non-strict `allow-scripts`). Unlisted packages only produce a warning. QB inherits whatever the bundled npm version does.
- **Proposal:** QB sets the policy explicitly in `deps-install.sh`. For example, keep scripts enabled as today, but pass the setting explicitly and record it, or adopt an allowlist. Record the effective setting in the run manifest.
  - Changing the default behaviour (e.g. disabling scripts) is a separate decision with compatibility impact (`microtime`, `esbuild`), and is not proposed silently.
- **Regression tests:** the recorded policy equals the configured one; a run whose effective npm policy differs from the recorded one fails closed.

## P3. Exact-version Jest support (only after KAN-111 shows viable tasks)

- **Scope:** exactly the versions and runners exercised in the KAN-110 feasibility runs:
  - Jest **27.2.0** with `testRunner: jest-jasmine2` (task 2006);
  - Jest **29.6.4** with `jest-jasmine2` (task 2005).

  Nothing else. Other versions are refused before any model call.
- **Design constraints** (PROPOSAL-A.md, reviews 10541 and 10545):
  - the report is validated, untrusted input;
  - the pre-test build command is part of the approved contract;
  - both arms keep the same default checks.
- **Fail-closed results:**
  - a duplicate test identity → unresolved, unless a validated disambiguation (e.g. file + ancestorTitles + title + location) is proven stable across runs;
  - a `focused` suite status → unresolved until its cause is understood (KAN-110 run 3 evidence).
- **Regression tests:** real pinned Jest executions inside the sandbox, not only hand-written JSON.
