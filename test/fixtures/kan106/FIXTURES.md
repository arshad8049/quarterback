# KAN-106 fixtures: what each one is (senior 10690, 10694)

| File | Label | Use |
| --- | --- | --- |
| `b2416ebc-initial.json`, `b2416ebc-repair.json` | **observed** (owner's timed Qwen smoke b2416ebc, model-authored fields only) | negative / diagnostic: must stay rejected |
| `b2416ebc-errors.json` | observed validator errors (QB eaa3882) and timings | diagnostic |
| `b2416ebc-structural-only.json` | **structural-only** (was `b2416ebc-corrected.json`) | passes the repair-shape rules of 10677 (AC-6/AC-7 removed, R-1/R-6 cited) but is NOT a faithful executable checklist: its checks call the exported class `Serializer` with `args: []` and never call `asNumber`, the identical call expects 0 and 12.5, and numeric preservation is "enforced" by `allowed_changes`. Since 10690 it is rejected by the check-fidelity rules. |
| `pinned-api-honest.json` | **human-reviewed, faithful to the pinned repository** (`pinned-fast-json-stringify/`) | the truthful checklist: `call_sequence` on `new Serializer()` calling `asNumber`, expecting the strings it really returns; AC-1/AC-2 have NO check (capability gap: no registry adapter asserts that a method call throws) |
| `faithful-draft.json` | **synthetic API** (assumes `lib/serializer.js` exports a plain function `asNumber` returning numbers; the pinned repository does not) | structural tests only; never evidence about the pinned repository |
| `passage-draft.json` | **synthetic** (the eba7015e draft as a passage-citing model would write it); since 10690 its checks are the pinned-API `call_sequence` checks of `pinned-api-honest.json` (its inherited checks called the class `Serializer` with `args: []`) | passage-ID mechanics |
| `eba7015e-*`, `malformed-draft.json`, `smoke-errors.json` | observed drafts and errors from earlier smokes (10668–10674) | diagnostic |
| `pinned-api-throws.json` | **human-reviewed, faithful to the pinned repository** (10694) | `pinned-api-honest.json` plus CHK-1/CHK-2: `call_sequence` steps with `throws: { message_includes: "cannot be converted to a number" }` on `new Serializer().asNumber("")` and `("   ")`, the number-conversion error of the pinned source (07d7196). Recorded as `qb-checks/2.1`. |
| `pinned-fast-json-stringify/serializer-07d7196.js` | **pinned source** (07d7196, fast-json-stringify 7.2.1, MIT) | the source both pinned-API fixtures were built from; the guard-removed version the tests derive from it is a **SYNTHETIC mutation**, not necessarily the owner's original repository base. Before any owner smoke, record the target repository's actual HEAD and confirm its API matches. |
