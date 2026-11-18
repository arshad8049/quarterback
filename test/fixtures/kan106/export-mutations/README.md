# Export-mutation fixtures (KAN-106, senior 10710)

**Synthetic** sources, written for the regression tests of `intent/api-grounding.js`. They are not from
any real repository and carry no answers. Each one mutates or widens what the check runner can reach
through an export (`ns[name]`, or `ns.default[name]`), so QB's static inventory must be `unknown` and
an absence-based refusal must be declined:

| File | Why the inventory is unknown |
| --- | --- |
| `static-assign.js` | `S.extra = …` on the exported class binding |
| `object-assign.js` | `Object.assign(S, …)` passes the exported binding to a call |
| `reassigned-declaration.js` | the exported function declaration is reassigned |
| `class-self-mutation.js` | the exported class expression assigns to its own name inside a method (reachable once that method has run) |
| `esm-default-object.mjs` | an ESM default object: its properties are reachable through the runner's default fallback |
| `esm-default-class-assign.mjs` | `S.extra = …` on an ESM default class |
| `plain-class-control.js` | **control**: an unmutated exported class stays `known` (method confusion is still refused) |
