# Linux x86_64 run 1 (2026-11-10): `npm run build`, original evidence

Workflow run https://github.com/arshad8049/quarterback/actions/runs/42869533603 (artifact `kan110-feasibility-linux-x64`, id 13788443869).

- **Raw evidence:** every file here except `2005.sanitized-view.json` is byte-identical to the downloaded artifact. That includes `2005.json`, whose `stages.probe.output` holds raw ELF bytes from a probe mistake: the probe ran the native esbuild binary through `node`.
- **`2005.sanitized-view.json`:** a separate, readable view. Only the esbuild probe lines are replaced by an explanation.

**Correction (review 10544):** comment 10543 said npm 11.19.1 "didn't run dependency install scripts". That was wrong.
- esbuild 0.18.20's published `bin/esbuild` is a Node script (`#!/usr/bin/env node`, checked in the registry tarball).
- In this run it was a native ELF binary, which only esbuild's `postinstall` (`install.js`) produces.
- So the install scripts **did run**; npm's "not yet covered by allowScripts" message was a warning. Run 2 records the effective policy explicitly.
