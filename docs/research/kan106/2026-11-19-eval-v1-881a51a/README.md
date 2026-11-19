# KAN-106 eight-request evaluation v1, batch 20261119T200955Z: sanitized evidence

**A diagnostic, not a reliability rate. The staged L1 prototype FAILED its progression thresholds** (senior review KAN-106 10765). It is not accepted for beta, merge or default enable, and no repeat live batch is authorized.

- **Not a completed coding task:** every run used `--agent dry-run`, so no agent changed any code.
- **Not senior-approved beforehand:** the owner ran the batch before the senior had reviewed the revised package (10762). It is kept as diagnostic evidence.
- **The eight requests are now known development cases, not a fresh validation set.**

## Revisions: generation vs analysis
| | Revision | What |
|---|---|---|
| **Generation** | `881a51a1149ccfcc1a757aefe0b17ea79fa3ef9e` (freeze v2) | The QB code, launcher and flags that produced every run record here. Owner-run once, 2026-11-19 20:09:57Z to 20:14:15Z, no retries. |
| **Analysis** | `f907d978744166e95b14a3fa1a8ba27106e68643` (freeze v3, scoring only) | `score.js` with one corrected constant. |

**Analysis erratum, accepted in 10765 (not a new experiment):**
- The v2 scorer expected a completed dry run to exit 0.
- `qb.js` exits 0 only on verdict `pass`, and a dry run's verdict is `no-diff`, so it exits 1. The v2 scorer therefore marked all seven completed runs `invalid_record`. That output is kept unchanged as `scores.json`.
- `scores-v3-f907d97.json` is the corrected analysis of the **same** records.
- No model was rerun; the requests and compiler are unchanged.

## Settings (from `batch.json`)
`qwen2.5-coder:14b`, full digest `9ec8897f747e246e970bc5cfdda85d22f1123dc2e3d34978a010a75968716849`, on `http://127.0.0.1:11434`. The digest matched before and after the batch (`ollama-qwen-entry.json`).

```
node qb.js "<request>" --repo <repo> --agent dry-run --no-llm-context --no-llm-verify --l1-profile qwen-14b-staged --l1-budget 420 --deadline 15
```

The child environment was built, not inherited. The items, requests and controls are in `bench/kan106-eval-v1/items/`; the base SHAs are in `base-shas.json` (equal to the freeze).

## Results (mechanical: `scores-v3-f907d97.json`; semantic: proposed by the junior, ruled by the senior in 10765)
| Item | Result | L1 | Mechanical | Semantic |
|---|---|---|---|---|
| S1-slug | checklist | 44.4 s | pass | **pending raw-contract review**; see S1/S5 below |
| S2-formatter | checklist | 25.1 s | **fail**: the correct control fails both checks | **incorrect**: changed argument shapes |
| S3-percent | checklist | 48.0 s | pass | **incorrect**: the required message is missing |
| S4-parsebool | checklist | 40.5 s | pass; `lib/defaults.js` protected, wrong-scope refused | correct |
| S5-clock | checklist | 42.2 s | pass | **pending raw-contract review**; see S1/S5 below |
| S6-money | checklist | 36.9 s | pass; requested tests (AC-4) unresolved, as allowed | correct; requested tests human-reviewed |
| U1-userrepo | **intended refusal** | 0.01 s | BLOCKED, unsupported constructor, 0 model calls | refused for the right reason |
| U2-roundto | **not refused** | 13.6 s | a finalized checklist | **fails**: invented behaviour; the unchanged base passes both checks |

**Against the predeclared thresholds:**
1. **6/6 supported semantically correct: FAILED,** at most 4/6. This is a ceiling, not an accepted 4/6 success rate.
2. **No incorrect acceptance of the supplied controls, and no protected-scope weakening:** met, **for this control set only**. S3 passes every control while missing its required message, so the controls did not cover every requirement. This is not "zero semantic false acceptance".
3. **2/2 intended refusals: FAILED,** 1/2.
4. **Latency:** median 41.3 s, max 48.0 s, 6/6 timings. That meets this diagnostic's targets. It is not a production guarantee or a controlled speedup.

**S1/S5 raw-contract finding (for the senior's ruling).** In both contracts the general rule survives as a reviewable requirement: `R-2` quotes it verbatim ("make slugify() turn each run of spaces into a single dash," / "make formatClock() show hours once the time reaches one hour,"), and `AC-1` traces to `R-2`. But the criterion text, `required_behavior` and the check carry only the stated example. Under 10765 this reads as **represented, with sampled check coverage**, not as the rule being checked.

## Three product gaps (recorded for KAN-107; the eight cases stay as regression/development cases)
1. **Array arguments (S2), a schema and support-design failure, not only a model mistake.**
    - `intent/staged.js` `factSchema` allows only scalar `args` items, so `join([])` (args `[[]]`) and `join(["a","b"])` (args `[["a","b"]]`) cannot be expressed. The model wrote `[]` (zero arguments) and `["a","b"]` (two strings).
    - S2 stays in the original denominator.
    - Needed: bounded structured literals, or an explicit refusal before generation, plus exact checking against the request's call examples.
2. **Request-sourced error messages (S3).**
    - Staged error fragments come only from existing source. `percent` is new, so its fragment list was empty, and the required "whole must not be zero" was dropped: CHK-3 only checks that it throws.
    - Needed: the request's own quoted message, bound to its source span and target.
3. **Invented behaviour for an underspecified request (U2).**
    - "Handle negative numbers properly" was not flagged. The model proposed two expected values, they became user requirements, and the unchanged code already passes them.
    - Needed: a bounded clarify/refuse route, with any model-proposed defaults kept separate and explicitly approved.

## Files
`HASHES.json` lists every published file with its sha256. For any file whose bytes differ from the original, it gives the original sha256 and exactly what changed.

| File | Status |
|---|---|
| `runs/<run_id>/artifacts/*` (raw fact replies in `contract-staged`, generated `contract`, and the dry-run `a1-*` records) | **byte-identical**: each file is named by its sha256 and matches the manifest |
| `scores.json` (v2 analysis, original), `scores-v3-f907d97.json` (corrected analysis), `runs.json` (run ids, exit codes), `base-shas.json`, `semantic-review-proposed.json` | byte-identical |
| `runs/<run_id>/manifest.json` | **redacted**: `repo.path` and `config.repo` (local paths) replaced; all other fields unchanged, including `request`, `qb_revision`, `repo.base_sha`, `models`, `agent`, `config` flags, `outcome` and artifact sha256s |
| `runs/<run_id>/events.jsonl` | **filtered**: the `run.started` and `contract.grounding` lines (local paths) removed; every other line verbatim, including `l1.timings` and `run.usage` |
| `batch.json` | **redacted**: `settings.child_env.QB_RUNS_DIR` replaced by `<OUT>/runs` |
| `ollama-qwen-entry.json` | **extracted**: only the qwen entry of the tag listing, with the original files' hashes |

Not published: the per-item logs, because they hold local paths. The semantic proposal predates the senior's ruling; this README records the ruling.

## Re-score offline (one command, no model)
From a QB checkout at `f907d978744166e95b14a3fa1a8ba27106e68643` or later (on `kan106-staged-l1`):
```
node bench/kan106-eval-v1/score.js --batch-dir docs/research/kan106/2026-11-19-eval-v1-881a51a --out /tmp/kan106-rescore.json && cmp /tmp/kan106-rescore.json docs/research/kan106/2026-11-19-eval-v1-881a51a/scores-v3-f907d97.json
```
This reproduces `scores-v3-f907d97.json` **byte for byte**. It verifies every record against its frozen item and every artifact against its sha256, then runs the generated checks, unchanged, with the real check runner on each item's base and controls. `test/unit/kan106-eval-v1-pack.test.js` runs the same check, plus the hashes and the no-private-path scan.
