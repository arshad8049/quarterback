# KAN-107 revised design: request-to-check consistency (for review; nothing implemented)

**Goal:** QB cannot silently replace an expressible customer example with a different check.

This is a narrow consistency safeguard. It is not general natural-language correctness, it does not qualify the beta, and it does not replace KAN-44, KAN-105 (protection preservation) or KAN-96 (failure classification).

**Red tests:** `test/unit/kan107-consistency.test.js`, 72 tests, all offline with a faked model.

* 25 pass today. Every negative fixture is still `finalized` by today's validators, which shows the gap; every positive control is valid.
* 47 are `todo` and fail when run with `KAN107_RED=1`.

The KAN-106 eight requests appear only as **known development cases**, never as fresh validation.

## Module and where it runs

`intent/request-examples.js` (new), no eval, no repository code executed:

* `parseLiteral(text)`
* `extractExamples(request)`, which returns `{ examples, messages, rules, underspecified, unsupported }`
* `exampleErrors(contract)`
* `exampleMapping(contract)`

`exampleErrors` runs inside `contractState` (`intent/contract-state.js`), next to `checkFidelityErrors`. It reads the contract's own `raw_request` and QB's `api_grounding`, never model text. That one place covers every producer (decision 7).

## Supported input shapes (decisions 1, 2)

**An example** is a literal call in the request text, with its result in the same clause:

* `name(<literals>)` or `Receiver.name(<literals>)`;
* followed by `returns` / `return` / `should return` / `returning` / `still return(s)` and a literal;
* or by `throws` / `throw` / `should throw`, optionally with an error class and/or `whose message includes "<text>"`;
* the only gap allowed between call and verb is `with no argument(s)`;
* only the first value counts: `returns "a-b" instead of "a--b"` gives `"a-b"`.

**Literals:** double- or single-quoted strings with JSON escapes; numbers (sign, decimals, exponent); `true`, `false`, `null`; arrays.

* Limits: depth ≤ 3; ≤ 16 items per array; ≤ 1 KiB serialized per example (within the registry's 4 KiB).
* `[]` is one empty-array argument; `["a","b"]` is one array; `"1"` is not `1`.

**Not examples, recorded as `unsupported` and never guessed** (no error, no claim):

* `make|change|update|fix|have name()`: an empty `()` after an edit verb is a **name mention**, not a zero-argument call;
* a call or value followed by conditional prose (`for …`, `when …`, `if …`, `given …`), e.g. S2's "an empty string for an empty array" or U1's "null for an unknown id";
* prose values ("an empty string", "thirty seconds"), identifiers or variables (`percent(part, whole)`), expressions, template strings, objects, `undefined`, approximate or regex expectations;
* multi-step sequences ("after add(…), total() returns …").

## Matching rules (decisions 1, 2, 6)

**Target resolution.** An example is tied to exactly one target:

1. **Module:** the path in its own sentence ("In lib/x.js, …"); otherwise the request's only named module; otherwise the one grounded module that defines the name.
2. **Kind:**
    * a function export is checked with `call_returns` / `call_throws`, matched on `module` + `export`;
    * a **method of a default class** that `api_grounding` proves exists, with a provably no-argument constructor (the 10758 rule), is checked with `call_sequence`: `export: "default"`, `construct: "new"`, `args: []`, and a step on a **fresh instance** with that `method`.
3. **Not tied:** two candidate modules, a receiver QB cannot resolve, or a constructor that needs arguments make the example `ambiguous_target`. That is an L1 error naming the candidates (clarify or refuse), never silently certified.

**Comparison.** An example is satisfied only when module + export/method, the argument list (deep-equal, nesting and types preserved) and the semantics all match:

* `returns`: the expected value deep-equals the example's;
* `throws`: the check asserts a throw (`call_throws`, or a `throws` step).

**L1 errors, not warnings.** The message names the request excerpt, the target and the check id:

* **contradiction:** same target and args, but a different value, or returns where the request says throws (and vice versa). Example: `CHK-1 contradicts the request's example parsePort("70000") throws`.
* **changed argument shape:** a check whose args equal the example's args after spreading or flattening (`[]` for `[[]]`; `["a","b"]` for `[["a","b"]]`; nested arrays spread). Example: `CHK-1 changes the argument shape of the request's example first([])`.
* **misplaced:** the example's value expected under other args. Example: `the request's example greeting("Arshad") returns "Hello, Arshad!" has no check with those arguments (CHK-1 calls greeting("test"))`.
* **uncovered:** no check at all. Example: `the request's example toF(100) returns 212 has no executable check`.

Extra checks beyond the examples are allowed.

## Error messages and error classes (decision 3)

**Request-sourced messages.** A request-sourced message requirement is recorded as `{ span, fragment, target }`, e.g. S3's `"whole must not be zero"`.

* **Binding:** it binds to the call target named in its sentence; otherwise to the immediately preceding sentence's only target. If neither applies, it is an L1 error ("cannot be tied to one target").
* **New exports:** binding does not depend on the function existing, so S3's new `percent` keeps its message.
* **Satisfied when:** some throw check on that target has `message_includes` containing the fragment.
* **Errors:** absent, wrong text, or a `call_returns` returning the text all produce `requires an error message including "…"`.

**Error classes.** An error class (`RangeError`) is recorded as `error_class` and is **not** message text.

* No adapter checks error identity: `message_includes` checks message text only. The old draft's claim that it verifies a RangeError is removed.
* The approval mapping shows the throw as checked and `error_class: not_checked`.
* A contract may not claim a class is verified.

## Ambiguity and underspecified behaviour (decision 4)

**No literal examples is fine.** A request with none is valid: the rule is silent and the existing validators apply.

**Underspecified change passages.** `underspecified` is a **bounded list**, not a claim to solve ambiguity. It flags a `change` passage that names a target but states no example, no quoted value and no `return(s)`/`throw(s)` result, and whose behaviour is only a vague qualifier ("handle … properly / correctly / gracefully / as expected", "work right").

* **Staged path:** stop **before any model call**, as a clarification/refusal (as for 10758's U1). U2 would have stopped with 0 calls.
* **Legacy path, or a supplied contract:** a check citing such a passage must also cite a `proposed_defaults` entry (`D-n`, existing QB-17 mechanism). Defaults are shown in their own approval section and hashed into the approval. Otherwise the error is `P2 … states no expected behaviour: QB will not invent one as the user's requirement`.
* Model-proposed values are therefore never labelled as user requirements.

## General rules (decision 5)

A behaviour passage that names a target and states a rule beyond its examples must be cited by a criterion. Examples: S1 "turn each run of spaces into a single dash", S5 "show hours once the time reaches one hour".

* Downgrading it to `context` is an error: `general rule … is not retained`.
* The approval view shows it as **represented, executable coverage sampled by** `EX-n`/`CHK-n`. Passing examples is not shown as proof for every input.

## Integration (decision 7)

All paths below use `contractState`.

* **Legacy path** (`intent/compiler.js`): example errors join the existing **single** correction (KAN-103/104). The correction prompt receives them like other validator errors. There is no new call or recursive loop, and the corrected draft is validated from scratch. Requested protected paths still go through the existing `targetErrors` / KAN-105 checks on the correction, which this card does not change.
* **`--contract-file`:** refused **as supplied**; never rewritten or corrected to fit.
* **Staged path** (`intent/staged.js`):
    * **Before generation:**
        * extract examples;
        * stop with a refusal (not a flatten) when an example tied to a target exceeds the literal bounds, or when a passage is underspecified;
        * offer the request-sourced message fragments in the existing numbered fragment list, tagged `source: request` and bound to their target. The model still picks by number, so it never types a message.
    * **Fact schema:** `args` items become a **bounded literal**: a scalar, or an array to depth 3 with ≤ 16 items, written out non-recursively for Ollama's `format`. This is compatible with all adapters, since they spread `args` and already accept JSON ≤ 4 KiB.
    * **Budgets:** the per-requirement fact repair budget stays at **one**.
    * **After assembly:** the existing final `contractState` applies `exampleErrors`. There is no extra repair.
* **Approval view** (`intent/oracle-view.js`): a "Request examples" block, one row per example, in the form *request excerpt → module target(args) returns|throws value → CHK-n*, plus a status (`checked`, `error_class not_checked`, `proposed default D-n`, `unsupported: <reason>`). Human approval stays required; nothing is auto-approved.

## What it does NOT claim

* It checks only literal call examples, request-quoted error messages, and the retention of stated rules.
* A contract that passes is not "faithful" or semantically correct. Prose expectations, sequences, objects, error classes and every input beyond the stated examples are not verified.
* The underspecified list is a small heuristic and does not detect arbitrary ambiguity.
* S2's change sentence ("an empty string for an empty array") is prose, so it is unsupported. Only its keep example `join(["a","b"])` is checked, and that alone would have refused S2's recorded checklist.

## Acceptance tests (red now; `KAN107_RED=1` to run as real tests)

**Required fixtures, all present:**

* the historical greeting mismatch (the KAN-104 fixture);
* return `"Error"` versus throw;
* a missing example;
* zero args versus one empty array;
* two strings versus one string array;
* nested arrays;
* a correct default-class method;
* a required message absent, wrong, returned as a string, and correct, on a new export;
* U2 versus explicitly specified rounding, plus U2 with proposed defaults;
* duplicate export names, and their disambiguation;
* legitimate requests with no literal examples.

**Also covered:**

* literal bounds and refusals;
* the one-correction integration;
* `--contract-file` refused as supplied;
* the approval mapping;
* staged bounded args;
* staged S2, S3 and U2 behaviour with a fake model.

## Needs the senior's ruling

1. Empty `()` after an edit verb is a name mention (so `make greeting() return "x"` is **not** a zero-argument example). Is that the right default, or should it be ambiguous and need clarification?
2. Duplicate or unresolvable targets are an L1 **error** (clarify/refuse), not "shown as not checked". Is that acceptable?
3. Object literals are unsupported in v1: they are recorded, not checked, and refused in the staged schema. Is that acceptable?
4. The underspecified vague-qualifier list starts small (`properly`, `correctly`, `gracefully`, `as expected`, `right`). Should it be widened only with your review?
