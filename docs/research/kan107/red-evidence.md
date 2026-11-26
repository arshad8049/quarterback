# KAN-107 red evidence (pre-fix)

**Where it was recorded:** offline (`QB_OLLAMA_URL` pointed at a dead port), with a faked model.

## Before the tests were written: `d19865e`

Every negative fixture was **`finalized`** by the validators of that time, which shows the gap. Those were the 12 "today's validators accept it" tests, all passing.

## Red commit: `8d1ee969d3ae96245d40bd3713bfa3c6d6dbf7c8`

**82 unique tests:** 6 passed, 76 failed.

* **35** failed only because `intent/request-examples.js` did not exist yet. That is **one not-yet-built API**, not independent semantic defects.
* **41** failed on real pre-fix behaviour:

| Test | What happened |
| --- | --- |
| rejected: KAN-104 historical greeting mismatch: greeting("test") expects "Hello, Arshad!" | expected 'invalid', got 'finalized' |
| rejected: return "Error" versus throw | expected 'invalid', got 'finalized' |
| rejected: missing example: no check for toF(100) | expected 'invalid', got 'finalized' |
| rejected: Q1: the clear zero-argument example "make greeting() return 'x'" has no check | expected 'invalid', got 'finalized' |
| rejected: zero arguments versus ONE empty array | expected 'invalid', got 'finalized' |
| rejected: two strings versus ONE string array | expected 'invalid', got 'finalized' |
| rejected: nested arrays spread into two arguments | expected 'invalid', got 'finalized' |
| rejected: correction C: a contradictory check for the SAME target and args fails even next to a correct one | expected 'invalid', got 'finalized' |
| rejected: required message ABSENT on a new export (KAN-106 S3 checklist, known regression) | expected 'invalid', got 'finalized' |
| rejected: required message WRONG on a new export | expected 'invalid', got 'finalized' |
| rejected: required message returned as a string instead of thrown | expected 'invalid', got 'finalized' |
| rejected: correction A: the right message at UNRELATED args (whole is 1, not 0) cannot certify the condition | expected 'invalid', got 'finalized' |
| rejected: correction A: an invented SUPERSTRING is not the requested fragment | expected 'invalid', got 'finalized' |
| rejected: correction A: wrong CASE: f(0) checks the wrong message while only f(-1) checks the requested text | expected 'invalid', got 'finalized' |
| rejected: correction A: invented superstring on an explicit call example | expected 'invalid', got 'finalized' |
| rejected: Q2: duplicate export names: the example cannot be tied to one module | expected 'invalid', got 'finalized' |
| rejected: decision 5: general rule dropped to context, only its example kept (S1 shape, known regression) | expected 'invalid', got 'finalized' |
| conditional message whose condition QB cannot bind is refused (no signature names the parameter) | no matching error (the contract was accepted) |
| rejected: invented expected values with no stated behaviour | no matching error (the contract was accepted) |
| rejected: a meaningless D-n citation does not bless the invented value | no matching error (the contract was accepted) |
| rejected: the KAN-106 S2 flattened checks (args [] and ["a", "b"]), with REAL grounding (known regression) | no matching error (the contract was accepted) |
| rejected: missing grounding: a receiver QB has not grounded is never resolved from the checks or allowed files | no matching error (the contract was accepted) |
| rejected: a receiver that is not the grounded default class | no matching error (the contract was accepted) |
| rejected: a constructor the bounded static reading cannot clear (10758: stored dependency dereferenced) | no matching error (the contract was accepted) |
| rejected: ambiguous grounding: two request-named modules both define the method | no matching error (the contract was accepted) |
| rejected: not a fresh instance: a setup/mutation step before the example call (sequences unsupported in v1) | no matching error (the contract was accepted) |
| legacy path: a contradictory draft gets the ONE existing correction (which sees the example error); a contradictory correction stops invalid with no extra call | expected 2, got 1 |
| legacy path: the correction that fixes the example finalizes (two calls) | no matching error (the contract was accepted) |
| CLI --contract-file: a contradictory supplied contract is BLOCKED as supplied and the file is never rewritten | expected 2, got 1 |
| loadContractFile: the supplied checks are not corrected to fit | expected 'invalid', got 'finalized' |
| approval view: each request example as excerpt -> target(args) outcome -> check id | no matching error (the contract was accepted) |
| approval hash: flattening an approved example check voids the approval AND the contract is rejected | expected 'invalid', got 'finalized' |
| one empty-array argument: the fake model states args [[]]; the checklist keeps ONE argument and it runs | expected 'finalized', got 'invalid' |
| zero arguments for the request example first([]) is refused after assembly (changed shape); no extra repair call | expected 'invalid', got 'finalized' |
| an object-literal example tied to a target is refused BEFORE generation (no call) | expected 0, got 1 |
| S2 (known regression): ONE array argument on a default-class method is expressible, checked and runs | expected 'finalized', got 'invalid' |
| S2 (known regression): the recorded flattened facts (args [] and ["a", "b"]) are refused | expected 'invalid', got 'finalized' |
| S3 (known regression): the request-quoted message is offered (exact text) for the NEW export and lands in the check at the bound condition | no matching error (the contract was accepted) |
| S3: the right message at unrelated args (whole is 3) is refused after assembly | expected 'invalid', got 'finalized' |
| U2 (known regression): an underspecified change stops BEFORE any model call; nothing invented | expected 0, got 1 |
| explicit rounding: the fake model drops an argument of the stated example roundTo(-2.5, 0): refused | expected 'invalid', got 'finalized' |

**Passing at red: 6** (controls that already held):

* round trip through the REAL check runner: array, nested, empty-array and method arguments at the limits run as ONE argument
* accepted: correct call_sequence checks on a fresh instance, with REAL grounding (static eligibility, not a proof that construction succeeds)
* legacy path: the faithful greeting draft finalizes with ONE model call
* protection preserved: the KAN-105 conflict still rejects a draft whose examples are correct but whose scope protects the requested file
* an object argument is refused by the schema after the one fact repair, never coerced (Q3)
* explicit rounding: the fake model states the request example exactly: finalized

## Exposed by the existing suite during implementation (`npm test` before the final fixes)

These existing tests failed and led to two design fixes and one ordering fix. The fixed behaviour is pinned by 3 tests added to the KAN-107 file.

| Existing test | What it showed | Fix |
| --- | --- | --- |
| QB-30 PW-01 (`qb30-oracle-contract`) | The bug report "w.format(0) returns 'count=%d' instead of 'count=0'" describes the **current** value. It was read as a requirement. | **Intent marker:** a bare description is unsupported and never enforced. |
| QB-14 traceability (VAD) and the QB-31 clamp demo | Legacy drafts quote a rule **clause by clause**, so retention needed per-clause overlap. | Retained when every overlapping requirement is cited and none is context. |
| QB-13 T-002 and KAN-106 L1-eval categories | Running in the first validation stage hid the later stages' errors. | The rule moved to the last stage, and into `laterStageErrors`. |
| KAN-104 "NOT stopped at L1 (validator gap)" | Asserted the old bug. | Converted to require rejection (pre-fix acceptance cited above). |
