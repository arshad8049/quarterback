# KAN-107: request-to-check consistency (implemented offline per 10771, 10805 and 10812)

**Goal:** QB cannot silently replace a supported customer example with a different check. It also keeps stated rules and says plainly what it does not check.

This is a narrow safeguard. It is not natural-language proof or automatic approval, and it makes no benchmark claim.

* It does not qualify the beta (KAN-44).
* It does not replace KAN-105 (protection-preservation integration) or KAN-96 (failure classification).

## On the 10835 split branches (kan107-foundation -> kan107-consistency)

This document describes the fix as built on `kan107-consistency-design` (2150ab6), which also carries the KAN-106 staged prototype. The split branch for review keeps the same rules on the **default path only**:

* `intent/staged.js` is not on the branch, so everything below that names it (staged fact schema, staged stop before a model call) stays with the prototype.
* `constructorArgs` lives in `intent/ctor-args.js`, copied verbatim from `staged.js`, so `api-grounding.js` does not load the prototype.
* `laterStageErrors` (KAN-106 10677) is not on main, so the single correction receives the example errors only when the earlier stages pass. The corrected draft is still validated in full, so nothing is accepted that the combined branch would refuse.
* The compiler attaches QB's grounding to each draft, but the model is **not** shown it: there are no grounding excerpts or passage listings in the prompt, and no `system.md` change.

### Grounding and the approval boundary (senior 10847)

`api_grounding` can decide whether a contract is valid, so it is never trusted as carried (`intent/grounding-binding.js`). QB does two things:

* **It binds the grounding to approval.** When the field is present, `approvedContent` includes `groundingIdentity(api_grounding)`. That covers each module's path, sha256, bytes, status, reason, format, named exports, and the default export's kind, name, form, methods, accessors, statics and `ctor_args`. Editing any of these after approval voids the approval (a tamper test per field).
    * These are every field that affects validation or target selection (`resolveTarget` reads path, status, the default export's kind, name, methods and `ctor_args`, and the named exports). Executable checks never read the grounding: they run `contract.checks`.
    * **Not bound, and not authenticated by approval:** the excerpts (line ranges, truncation, symbol, source) and `default.ctor_stores`. They are **provenance**: `groundApi` uses them to compute `ctor_args` from the working tree when it produces the grounding. On a contract nothing reads them. A test shows that changing them changes no validation, target, gate or check, and a tripwire fails if new code reads them (senior 10867). If code ever uses one of them to decide something, it must be added to `groundingIdentity` with a tamper test in the same change.
    * When the field is absent, nothing is hashed. Contracts and approvals from before KAN-107 keep their hash (pinned in a test) and are never migrated.
* **It recomputes the grounding before each decision.** QB runs `groundApi` on the target repository's working tree before:
    * a `--contract-file` is used;
    * the agent CLI uses a stored contract;
    * `qb.js` runs the pipeline.

  If the grounding the contract carries differs from the recomputed one, the contract is refused. The difference may come from an edit, from a caller writing the field, or from the repository changing since the grounding was recorded. Nothing runs, and the approval is not reused.
    * This holds in every agent mode, `--agent manual` included (senior 10867): manual is not permission to reuse an approval against a different source.
    * The message gives the way out: regenerate the contract from the current repository (`qb` with the request and `--repo`, without `--contract-file`, writes a new `proposed-contract.json`), review it, and approve it again (`--contract-file <that file>`, or `qb-agent --approve-contract`).
* **How `--contract-file` is handled:**
    * A grounding written in the file is the caller's claim. It is compared with QB's recomputation and never used as proof.
    * If the file has no grounding, QB attaches its own, prints the example mapping, and the approval then binds it.
    * `proposed-contract.json` records QB's grounding, so a later run detects drift since the review.
* **Old approvals are not migrated.** A contract approved before KAN-107 has no grounding and is left without one. Its class-method examples are refused (fail-closed).
* **The check is against the approved starting state.** Every recomputation runs before the agent: in `qb.js` before `runPipeline`, in the agent CLI before `orchestrate`. Nothing after the agent (the repair loop, context refresh, verification) recomputes it. The run's own edits are the resulting patch, never pre-run drift (senior 10867, pinned in `test/unit/kan107-10867.test.js`).

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

It counts as a **requirement** only when an explicit positive clause asks for it (polarity; senior 10805, ruling 1). This replaces the first version's "any intent word earlier in the sentence", which enforced the bug value in "fix the bug where f(1) returns 2 instead of 3" and the forbidden value in "do not make f(1) return 2".

**Enforced:**

* an imperative that directly governs it: `make|ensure|keep|preserve|retain|maintain` f(1) return 3;
* `f(1) should|must (still) return 3`; `change f(1) to return 3`; `I want f(1) to return 3`;
* an edit instruction followed by `so` / `so that` ("update f so f(1) returns 3"), unless the words in between are a description of their own ("fix f, it rounds down so …");
* a build instruction (`make|create|add|implement|write|ensure`) followed by `for example`, also in the next sentence;
* a list sharing one of these ("make f(1) return 3 and f(2) return 4").

**Not enforced** (recorded as unsupported, shown at approval with the wording to use instead, never turned into a check):

| Reading | Example |
| --- | --- |
| current behaviour | "fix the bug where f(1) returns 2", "f(1) returns 2 today", "Actual: f(1) returns 2" |
| negated | "do not make f(1) return 2", "never …", "rather than f(1) returning 2" |
| condition or question | "make sure that if f(1) returns 2 …", "should f(1) return 2?" |
| unresolved | a bare "f(1) returns 2." (v1 limitation), "f(1) still returns 2.", "fix f, for example f(1) returns 2." |
| two different results for the same call (**L1 error**: QB asks which is wanted; staged stops before any model call; 10812) | "Make f(1) return 3. Make f(1) return 2." |

**Clauses:** `;`, `but`, `while` and similar start a new clause, so "f(1) returns 2 today; make f(1) return 3" enforces only 3. **Quoted error messages** outside a call example follow the same rule.

**Limits:** this is a short list of wordings, not an understanding of intent. A positive request in other words is shown as not enforced, so its check is reviewed by the human and not by QB. A deliberately misleading sentence can still be misread.

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

Several candidates, or no resolvable module, is an **L1 clarify/refuse error** that asks "Which file contains f?". The check and the allowed files are never used to choose.

**A request that names no file** is not invalid in itself (senior 10805, ruling 3). If QB's own grounding holds exactly one module that defines the name, that module is used. Today `groundApi` reads only the modules a request names, so such a request normally has no grounding and QB asks. That is a limitation of the producer, not a ban on no-file requests; v1 adds no repository-wide discovery.

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
* Bare descriptions, and any positive wording outside the list above (polarity).
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
