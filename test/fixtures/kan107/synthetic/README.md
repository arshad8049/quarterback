# Synthetic fixtures (KAN-107, senior 10812)

**Hand-made. Not model output, not observations, and not evidence that a model produces a correct checklist.**

| File | What it is |
|---|---|
| `consistent-scope-first-draft.json` | `test/fixtures/kan106/faithful-draft.json` (itself hand-written) with one defect: AC-6 lost its `adds_tests` binding. Its scope is consistent: the requested files are allowed, only `package.json` is protected, and kept behaviours are requirements with checks. Used as a first draft that the one correction can fix **without removing a protection**. |

The recorded Qwen first drafts (`test/fixtures/kan106/malformed-draft.json`, `eba7015e-initial.json`) are unchanged and remain negative cases: they protect `lib/**/*`, `test/**/*` or `test/**` for behaviour constraints, so a correction that drops the protection is refused and QB blocks.
