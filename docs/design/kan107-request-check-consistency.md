# KAN-107: request-to-check consistency (implemented offline per 10771; not merged)

**Goal:** QB cannot silently replace a supported customer example with a different check. It also keeps stated rules and says plainly what it does not check.

This is a narrow safeguard. It is not natural-language proof or automatic approval, and it makes no benchmark claim.

* It does not qualify the beta (KAN-44).
* It does not replace KAN-105 (protection-preservation integration) or KAN-96 (failure classification).

## Module and where it runs

**`intent/request-examples.js`** (no eval; no repository code executed). Exports:

* `LIMITS`, `valueErrors`, `argsErrors`;
* `parseLiteral`, `parseArgs`;
* `extractExamples`;
* `exampleErrors`, `exampleMapping`.

**Inputs:** only the contract's `raw_request` and QB's own `api_grounding`. Never model text, model assertions, check shapes or allowed files.

* **`intent/contract-state.js`:** `exampleErrors` runs in the **last** validation stage, next to traceability, so earlier-stage errors are not hidden. It is also included in `laterStageErrors`, which the single legacy correction receives.
    * One place therefore covers every producer: the legacy draft, its correction, staged assembly, and `--contract-file`.
* **`intent/api-grounding.js`:** `groundApi` records `default.ctor_args` per class.
    * It is the 10758 bounded static eligibility reading (`staged.js constructorArgs`), applied to the class's own constructor source: `none`, `appears_optional` or `required_or_unknown`.
    * It is **not** a proof that construction succeeds.
    * It is recorded because a contract's grounding carries no source text, and because a short file's export excerpt can hide the constructor.
* **`intent/staged.js`:**
    * bounded literal schema;
    * the same limits in `validateFacts`;
    * request-quoted message fragments;
    * pre-generation stops;
    * `ctor_args` taken from the grounding.
* **`intent/oracle-view.js`:** the "Request examples" approval block.

## Supported shapes (Q1, decision 2, correction E)

**An example** is `name(<literals>)` or `Receiver.name(<literals>)`, followed in the same clause by:

* `returns` / `return` / `returning` / `should|must|still|will|to return` and **one literal**; or
* `throws` / `throw` / `throwing` / … optionally followed by `a <Class>Error` and/or `whose message includes "<text>"` / `whose message is "<text>"`.

It counts as a **requirement** only when the request frames it as wanted:

* an intent word earlier in its sentence (`make`, `so`, `should`, `must`, `keep`, `still`, `ensure`, `for example`, …); or
* `should`/`must`/`still`/`to` on the verb.

A bare **description** is recorded as unsupported, shown at approval, and never enforced. Example: QB-30 PW-01's "w.format(0) returns 'count=%d' instead of 'count=0'" describes the current bug.

**Q1 (three contrasting fixtures):**

* "make greeting() return 'x'" is a **checked zero-argument example**;
* "Update greeting() … so greeting("Arshad") returns …": the first `greeting()` is a **name mention** (no result follows it);
* "make join() return '' for an empty array" is **conditional prose**: unsupported, not zero arguments.

There is no blanket empty-parentheses exemption.

**Literals:**

* double- or single-quoted strings (JSON escapes), numbers, `true`, `false`, `null`, arrays;
* `[]` is one empty-array argument; `["a","b"]` is one array; `"1"` is not `1`.

**One set of limits (E),** used by parsing, the staged fact schema and `validateFacts`:

| Limit | Value |
| --- | --- |
| Nesting depth **per argument value** (the outer argument list is not a level) | 3 |
| Items per array | 16 |
| Arguments | 8 |
| Characters per string | 1,000 |
| Bytes per argument list and per value | 1,024 |

* This is stricter than the registry's 4 KiB per JSON value.
* A test feeds identical samples to parsing and to staged validation and requires the same accept/refuse result.
* **Round trip:** `[[]]`, a 16-item array, `[["a","b"]]`, nested arrays and a default-class method with array arguments **run through the real check runner** as one argument. The flattened forms really are different calls and fail there.
* No claim of compatibility with every adapter is made from JSON acceptance alone.

**Unsupported (recorded, shown at approval, never certified):**

* prose values and conditional prose;
* identifiers or variables (call signatures such as `percent(part, whole)` are kept only for condition binding);
* expressions and template strings;
* **objects (Q3)**: recognized and reported; staged generation refuses them and never coerces them;
* `undefined`, values beyond the limits;
* multi-step sequences;
* bare descriptions.

A request with no supported examples is still valid.

## Targets (Q2, correction B)

**Module.** Taken from:

1. the path in the example's own sentence; otherwise
2. the request's paths, excluding ones it says not to change; narrowed only by QB's grounding when several are named; otherwise
3. the one grounded module that defines the name.

Several candidates, or no module at all, is an **L1 clarify/refuse error**. The check is never used to choose.

**Default-class methods** are resolved from QB-computed grounding only. All of these are required:

* the default class has the method;
* any receiver equals the class name;
* `ctor_args` is `none` or `appears_optional`.

Missing grounding, an ungrounded or mismatched receiver, an ineligible constructor, or a name that is both an export and a method are each an L1 error.

**A matching check** is a `call_sequence` step on a **fresh instance**: constructed with `new` and no arguments, with **no earlier step on that instance** (no setup or mutation in between). Sequences stay unsupported in v1.

## Comparison (decisions 1, 6; correction C)

An example is satisfied by a check on the same module + export/method, with **deep-equal arguments** (nesting and types kept) and the same semantics:

* **returns:** a deep-equal expected value;
* **throws:** a throw check, and the **exact** message when one is stated.

**L1 errors:**

* **contradicted:** a check for the **same target and arguments** asserts something else. This fails **even if another check is correct** (C).
* **changed argument shape:** only when the requested case is missing (C). Example: `CHK-1 changes the argument shape of the request's example first([])`.
* **misplaced:** the example's result appears only under other arguments: `has no check with those arguments (CHK-1 calls greeting("test") instead)`.
* **uncovered:** no check at all.

A correct example check plus unrelated extra checks is allowed (C), even when an extra check resembles the flattened shape.

## Messages and error classes (decision 3, correction A, D)

**Call-example messages** are bound to that **case**: module, target, typed arguments, throw and message together.

* If `f(0)` checks the wrong message while only `f(-1)` checks the requested text, that fails.

**Conditional messages** (S3, "When whole is 0 it must throw an error whose message includes …") keep the condition.

* **Binding:** it is bound, with provenance (`condition_span`, `signature_span`), to one parameter of the **one** call signature the request writes (`percent(part, whole)`, so `whole` is argument 2 of 2, value `0`).
* **Satisfied only by** a throw check at arguments meeting the condition. A throw at unrelated arguments cannot certify it.
* **Unbindable:** an unbindable condition (no signature names the parameter, or the value is not a literal) is **refused**. The fix is to state it as a call example.
* There is no symbolic-condition engine.

**"Includes":** `message_includes` must be the **exact** stated fragment.

* An invented longer superstring is an error, since it could reject correct code.
* A missing message, wrong text, or the text returned instead of thrown are all errors.

**"Is":** **message equality** is distinguished from inclusion.

* No adapter checks equality, so it is shown as `equality_not_checked`; only inclusion runs.

**Error classes** (`RangeError`) are recorded as such and shown `error_class: not_checked`, even when the throw and message checks pass.

* `message_includes` checks text, never error identity.
* The whole requirement is never claimed verified.

**Staged path:** the request-quoted fragment is offered **exactly**, bound to its one target (a new export included). It is appended after the source fragments so their numbers do not move. The model still picks by number.

## Underspecified behaviour and proposed defaults (Q4, decision 4, correction D)

**Underspecified passages.** A **small, documented** qualifier list flags a passage that names a call but whose sentence states no example, message or returns/throws result:

* `properly`, `correctly`, `gracefully`, `as expected`;
* `right` after `work`/`handle`.

It is regression-tested both ways. There is no claim to detect arbitrary ambiguity; broader rules arrive only as reviewed changes.

* **Staged path:** stop **before any model call** (U2: 0 calls).
* **Legacy path or a supplied contract:** a check citing such a passage must also cite a proposed default `D-n` whose text **states exactly that call and result**.
    * The default is checked with the same extractor.
    * It is shown in the approval view's proposed-defaults section and in the mapping, and is hashed into the approval.
    * A meaningless `D-n` citation is an error.
    * No new default-inference system.

## General rules (decision 5)

A behaviour passage that names a call and states something beyond its examples must stay a cited, non-context requirement. Examples: S1 "turn each run of spaces into a single dash", S5, S3's general rounding rule.

* Legacy drafts that quote it clause by clause are accepted when **every** overlapping requirement is cited and none is context.
* Otherwise: `general rule … is not retained`.
* The approval view shows it as retained, with executable coverage **only sampled** by its examples.

## Integration and budgets (decision 7)

| Path | Behaviour |
| --- | --- |
| **Legacy** | Example errors reach the **one** existing correction (KAN-103/104). A contradictory correction stops invalid after exactly 2 calls; a fixing correction finalizes. No new loop. |
| **`--contract-file`** (`qb.js`) | Refused **as supplied** (BLOCKED, exit 2). The file bytes are unchanged, no model call is made, and the checks are never corrected to fit. |
| **Staged** | <ul><li>**Pre-generation stops**, with 0 calls: an underspecified passage; an object or out-of-bounds example literal for a call target.</li><li>**Fact repair:** one per requirement (an object argument means 2 calls, then invalid).</li><li>**Post-assembly:** refusal through `contractState`, with no extra call (e.g. S2's flattened facts mean 2 calls, then invalid).</li></ul> |
| **Protection** | <ul><li>The S4 shape keeps `lib/defaults.js` in `protected_paths` while its examples are enforced.</li><li>The KAN-105 conflict (a requested file protected) still rejects.</li><li>The KAN-105 integration itself remains separate open work.</li></ul> |
| **Approval** | Flattening an approved example check voids the approval hash, **and** the changed contract is rejected. |

## Approval view

**Block:** "Request examples (KAN-107: what your request states → the check that runs it)".

* **Row format:** `EX-n <excerpt> -> <module> <target>(<args JSON>) returns|throws … -> CHK-n (status; notes)`.
* **Notes:** error class NOT CHECKED, message equality NOT CHECKED, the bound condition → argument.
* **Other rows:**
    * `MSG-n` rows for conditional messages;
    * `RULE` rows (retained, coverage sampled / NOT RETAINED);
    * `D-n (QB-proposed, not in your request)` rows;
    * `UNSUPPORTED (not checked)` rows with their reason.

## Known unsupported shapes (v1)

* Prose values ("an empty string") and conditional prose ("for an empty array", "for an unknown id").
* Bare descriptions without an intent word.
* Variables, expressions, template strings, objects, `undefined`.
* Literals beyond the limits.
* Multi-step or stateful sequences, and instance receivers QB has not grounded.
* Conditions not of the form "when <parameter of a request signature> is <literal>".
* Error classes (`not_checked`) and message equality (`equality_not_checked`).
* Any input beyond the stated examples.
* S2's change sentence stays unsupported prose; only its keep example `join(["a","b"])` is enforced, and that alone refuses S2's recorded checklist.

## Tests

**`test/unit/kan107-consistency.test.js`**, offline with a faked model and `QB_OLLAMA_URL` pointed at a dead port. KAN-106's eight cases are used as known regressions only.

**Red:** `8d1ee96`, 82 unique tests. 6 passed; 76 failed:

* **35 failed only because the module did not exist** (one not-yet-built API, not 35 independent defects);
* **41 failed on real pre-fix behaviour** (`docs/research/kan107/red-evidence.md`).

**Green:** 85 tests; the 3 added during implementation are below. Existing tests changed:

* **KAN-104:** the "not stopped at L1 (validator gap)" test and its TODO are replaced by one test requiring rejection. The pre-fix acceptance is cited at `d19865e`.
