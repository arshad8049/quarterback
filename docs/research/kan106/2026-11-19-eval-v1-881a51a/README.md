# KAN-106 eight-request evaluation v1, batch 20261119T200955Z: sanitized evidence

**A diagnostic, not a reliability rate. The staged L1 prototype FAILED its progression thresholds** (senior review KAN-106 10765). It is not accepted for beta, merge or default enable, and no repeat live batch is authorized.

- **Not a completed coding task:** every run used `--agent dry-run`, so no agent changed any code.
- **Not senior-approved beforehand:** the owner ran the batch before the senior had reviewed the revised package (10762). It is kept as diagnostic evidence.
- **The eight requests are now known development cases, not a fresh validation set.**

## Revisions: generation vs analysis
| | Revision | What |
|---|---|---|
| **Generation** | `881a51a1149ccfcc1a757aefe0b17ea79fa3ef9e` (freeze v2) | The QB code, launcher and flags that produced every run record here. Owner-run once, 2026-11-19 20:09:57Z to 20:14:15Z, no retries. |
| **Analysis v3** | `f907d978744166e95b14a3fa1a8ba27106e68643` (freeze v3, scoring only) | `score.js` with one corrected constant (`scores-v3-f907d97.json`). |
| **Analysis v4** | freeze v4, labels only (10770); the commit is named in KAN-106 | `agent_launched` replaced by `adapter_attempt_recorded` (same value) and `coding_agent_launched` (from the recorded agent type: `false` for every run here, since all are dry-run). Every result, count and summary is identical to v3 (`scores-freeze-v4.json`; tested). |

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

## Results (mechanical: `scores-v3-f907d97.json` = `scores-freeze-v4.json` apart from labels; semantic: ruled by the senior in 10765 and 10770, recorded in `semantic-review-ruled.json`)
| Item | Result | L1 | Mechanical | Semantic |
|---|---|---|---|---|
| S1-slug | checklist | 44.4 s | pass | **acceptable**: represented, with sampled executable coverage |
| S2-formatter | checklist | 25.1 s | **fail**: the correct control fails both checks | **failure**: changed argument shapes |
| S3-percent | checklist | 48.0 s | pass | **failure**: the required message is missing |
| S4-parsebool | checklist | 40.5 s | pass; `lib/defaults.js` protected, wrong-scope refused | **acceptable** |
| S5-clock | checklist | 42.2 s | pass | **acceptable**: represented, with sampled executable coverage |
| S6-money | checklist | 36.9 s | pass; requested tests (AC-4) unresolved, as allowed | **acceptable**; requested-test adequacy human-reviewed |
| U1-userrepo | **intended refusal** | 0.01 s | BLOCKED, unsupported constructor, 0 model calls | refused for the right reason |
| U2-roundto | **not refused** | 13.6 s | a finalized checklist | **fails**: invented behaviour; the unchanged base passes both checks |

**Reviewed outcome (senior, 10770):** 4/6 supported checklists acceptable under the declared rubric, with sampled-coverage limits on S1/S5, generalization limits on any finite examples, and requested-test adequacy still human-reviewed on S6. S2 and S3 are failures. Intended refusals 1/2. Mechanical controls 5/6. This is a small developer-authored diagnostic, **not** a population reliability estimate, a completed coding-task success rate, or beta qualification.

**Against the predeclared thresholds:**
1. **6/6 supported semantically correct: FAILED,** at most 4/6. This is a ceiling, not an accepted 4/6 success rate.
2. **No incorrect acceptance of the supplied controls, and no protected-scope weakening:** met, **for this control set only**. S3 passes every control while missing its required message, so the controls did not cover every requirement. This is not "zero semantic false acceptance".
3. **2/2 intended refusals: FAILED,** 1/2.
4. **Latency:** median 41.3 s, max 48.0 s, 6/6 timings. That meets this diagnostic's targets. It is not a production guarantee or a controlled speedup.

**S1/S5, ruled in 10770: accepted as "represented, with sampled executable coverage".** `R-2` quotes the general rule verbatim ("make slugify() turn each run of spaces into a single dash," / "make formatClock() show hours once the time reaches one hour,") and `AC-1` links to it. The criterion text, `required_behavior` and the check carry only the stated example. No unannounced extra test (for example 3600) was demanded after the batch. Showing the general rule more prominently is KAN-107 work.

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
| `scores-freeze-v4.json` (labels-only analysis), `semantic-review-ruled.json` (the senior's ruling) | **added after first publication** (10770); not batch files |
| `runs/<run_id>/manifest.json` | **redacted**: `repo.path` and `config.repo` (local paths) replaced; all other fields unchanged, including `request`, `qb_revision`, `repo.base_sha`, `models`, `agent`, `config` flags, `outcome` and artifact sha256s |
| `runs/<run_id>/events.jsonl` | **filtered**: the `run.started` and `contract.grounding` lines (local paths) removed; every other line verbatim, including `l1.timings` and `run.usage` |
| `batch.json` | **redacted**: `settings.child_env.QB_RUNS_DIR` replaced by `<OUT>/runs` |
| `ollama-qwen-entry.json` | **extracted**: only the qwen entry of the tag listing, with the original files' hashes |

Not published: the per-item logs, because they hold local paths. `semantic-review-proposed.json` is the junior's proposal and is kept unchanged; the ruling is in `semantic-review-ruled.json`.

## Re-score offline (one command, no model)
From a QB checkout at the analysis v4 commit or later (on `kan106-staged-l1`):
```
node bench/kan106-eval-v1/score.js --batch-dir docs/research/kan106/2026-11-19-eval-v1-881a51a --out /tmp/kan106-rescore.json && cmp /tmp/kan106-rescore.json docs/research/kan106/2026-11-19-eval-v1-881a51a/scores-freeze-v4.json
```
This reproduces `scores-freeze-v4.json` **byte for byte**. (At `f907d97` exactly, the same command reproduces `scores-v3-f907d97.json`.) It verifies every record against its frozen item and every artifact against its sha256, then runs the generated checks, unchanged, with the real check runner on each item's base and controls. `test/unit/kan106-eval-v1-pack.test.js` runs the same check, plus the hashes and the no-private-path scan.
