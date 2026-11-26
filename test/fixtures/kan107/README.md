# KAN-107 fixtures (10835 split branch)

| File | Label | Use |
| --- | --- | --- |
| `build.js` | **hand-written** builder | raw contracts for short requests; every request, source and check in `kan107-*.test.js` is hand-written for KAN-107 (no benchmark tests, gold patches or hidden tests) |
| `../kan104/contradictory-check-draft.json` (on main) | **hand-written** contradictory correction | `greeting("test")` expecting `"Hello, Arshad!"`: refused at L1 since KAN-107 |
| `../kan106/malformed-draft.json` | **observed** Qwen first draft (KAN-106, unchanged since 0f8849e) | negative: protects `lib/**/*` and `test/**/*` for behaviour constraints; a correction that drops them is refused |
| `../kan106/eba7015e-initial.json` | **observed** Qwen first draft (smoke eba7015e, unchanged since dca5df1) | negative: protects `test/**` for a behaviour constraint |
| `../kan106/passage-draft.json`, `../kan106/faithful-draft.json` | **synthetic** corrections (KAN-106, hand-written) | used only as the corrections that drop a protection |
| `../kan106/request.txt`, `../kan106/pinned-fast-json-stringify/`, `../kan106/export-mutations/` | foundation fixtures (see their own READMEs) | passages, request targets, grounding, ctor_args |

The KAN-107 synthetic positive `synthetic/consistent-scope-first-draft.json` (10812) is **not** on this branch: its only defect is a missing `adds_tests` binding, which only KAN-106's scope validator detects, and it cites passages without quotes, which only KAN-106's passage-ID wiring fills in. On main it is not a meaningful positive. The S4-shaped positives in `kan107-default-path.test.js` cover a correction that keeps a genuine protection.
