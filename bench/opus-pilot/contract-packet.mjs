#!/usr/bin/env node
// KAN-117 review 10635 step 1: build the CLEAN AUTHORING PACKET for axios-5892's QB contract, for an independent fresh
// author. It contains ONLY: the allowed original task text (agent store), the pinned starting repository and its
// visible test command/files, QB's contract and check schema documentation, and generic execution constraints.
// It never contains hidden tests, the gold patch, candidate solutions, the KAN-117 diagnostic thread, the exception
// list or its rationale, or any grading outcome. The packet is written OUTSIDE the repository (dataset task text is
// not republished); only the hash manifest is committed. Every packet file is run through QB's leak check against the
// hidden material (counts only) and the build refuses on any hit.
//   node bench/opus-pilot/contract-packet.mjs --store=bench/public/out --out=<dir outside the repo> [--manifest=<file>]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const arg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const store = arg('store'); const out = arg('out');
if (!store || !out) { console.error('usage: contract-packet.mjs --store=<bench/public/out> --out=<dir outside the repo> [--manifest=<file>]'); process.exit(2); }
if (path.resolve(out).startsWith(`${ROOT}${path.sep}`)) { console.error('refusing: the packet holds dataset task text and must be written outside the repository'); process.exit(2); }

const ENV = JSON.parse(fs.readFileSync(path.join(HERE, 'mocha', 'axios-5892.env.json'), 'utf8'));
const rows = (s) => fs.readFileSync(path.join(store, s, 'swe-bench-multilingual.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const agentRow = rows('agent').find((r) => r.task_id === ENV.task_id);
const vaultRow = rows('vault').find((r) => r.task_id === ENV.task_id);
if (!agentRow || !vaultRow) { console.error('task rows missing from the store'); process.exit(3); }
const extra = Object.keys(agentRow).filter((k) => !['task_id', 'problem_statement'].includes(k));
if (extra.length) { console.error(`unexpected agent-store fields: ${extra.join(', ')}`); process.exit(3); }

const files = {};
files['TASK.md'] = `# Task (the original issue text, exactly as the agent receives it)\n\n${agentRow.problem_statement}\n`;
files['REPOSITORY.md'] = [
  '# Starting repository (pinned)', '',
  '- Repository: https://github.com/axios/axios',
  `- Starting commit (base): \`${ENV.base_commit}\` — work only from this commit; do not look at later history, pull requests or issues.`,
  ...(arg('prepare-base') ? [
    '- **Already checked out in `./axios`** (one commit, no remote), with only the runtime dependencies installed (`npm ci --omit=dev --ignore-scripts`, prepared by the controller). **Do not fetch, clone or install anything**; work offline.', ''] : [
    '- Fetch it with no history beyond that commit:', '',
    '```', 'git init axios && cd axios', `git fetch --depth 1 https://github.com/axios/axios ${ENV.base_commit}`, 'git checkout FETCH_HEAD', '```', '']),
  '## Visible tests QB runs (a disclosed subset of the repository\'s tests)', '',
  `- Command: \`${ENV.test_argv.join(' ')} <files>\` (Mocha ${ENV.mocha_version}, Node 24)`,
  '- Files:', ...ENV.test_files.map((f) => `  - \`${f}\``), '',
  '- Not run by QB here:', ...ENV.omitted.map((o) => `  - ${o.what} (${o.why})`), '',
].join('\n');
files['CONSTRAINTS.md'] = [
  '# Generic execution constraints (identical for every arm)', '',
  '- Code under test runs in a sandbox with **no network access**, no credentials, a read-only dependency tree installed from the repository\'s own lockfile, Node 24.',
  '- QB\'s executable checks run in their own sandbox stage on a fresh, read-only checkout of the candidate, with the same dependencies; each check is a call into a repository module (see CHECKS.md). They cannot start processes, open network connections to other hosts, or run shell commands.',
  '- Checks that cannot express a requirement must not be faked: mark the criterion as not checkable by the available adapters and say why.',
  '- Time: QB\'s verification stage has a shared cap of 10 minutes.', '',
].join('\n');
const doc = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
files['CHECKS.md'] = `# QB executable checks: registry and documentation\n\n## docs/verify/executable-checks.md\n\n${doc('docs/verify/executable-checks.md')}\n\n## verify/checks/registry.js (the adapter registry, source)\n\n\`\`\`js\n${doc('verify/checks/registry.js')}\n\`\`\`\n`;
if (Number(arg('version') || '1') >= 3) files['RESEARCH_SCENARIOS.md'] = [
  '# Scenario checks in this research contract (qb-checks/3)', '',
  'Besides the data adapters, this research contract may use `scenario` checks (see CHECKS.md, "scenario"): a short CommonJS module, at most 8 KiB, exporting `async ({ require, assert }) => {}` that throws when the criterion is not met.', '',
  '- **Review:** a scenario is code. A human reviewer approves its exact source (by sha256) before the contract is frozen; any later change needs a new review.',
  '- **Where it runs:** QB\'s check stage, on a fresh read-only checkout of the candidate with its installed dependencies, no network, no credentials, one child process per check, 10 seconds per check.',
  '- **What it may use:** `require` resolves files inside the repository (and its node_modules) and Node built-ins **except** child_process, worker_threads, cluster, net, tls, dgram, http, https, http2, inspector and vm. Not allowed in the source: dynamic `import()`, process control, `eval`, `Function(`, `globalThis`.',
  '- **How to write it:** from TASK.md and the base repository\'s public behaviour only. It must pass when the requirement is met and throw when it is not; a scenario that cannot fail tests nothing.',
  '- **Outcomes:** a throw is `fail`; a scenario that cannot load, exports no function, escapes, uses a forbidden module or exceeds its time is `error`.',
  '- ES modules: on Node 24.22.3 a scenario\'s `require` loaded a small synthetic ES module graph (synchronous, no top-level await). That does not prove every ES module graph loads; one with top-level await, for example, cannot be loaded with `require`. If a scenario errors while loading, report it in `ambiguity_flags` rather than working around it.', ''].join('\n');
files['CONTRACT_SCHEMA.md'] = `# QB task contract: schema and an example\n\n## intent/schema.js\n\n\`\`\`js\n${doc('intent/schema.js')}\n\`\`\`\n\n## docs/verify/scope-policy.md\n\n${doc('docs/verify/scope-policy.md')}\n\n## docs/verify/test-oracle.md\n\n${doc('docs/verify/test-oracle.md')}\n\n## intent/requirements.js (traceability: every part of the request must be quoted; source)\n\n\`\`\`js\n${doc('intent/requirements.js')}\n\`\`\`\n\n## verify/policy.js (how constraint_policy and scope are validated and enforced; source)\n\n\`\`\`js\n${doc('verify/policy.js')}\n\`\`\`\n\n## verify/preservation.js (the exact \`preserves\` format; source)\n\n\`\`\`js\n${doc('verify/preservation.js')}\n\`\`\`\n\n## Example contract (docs/demo/clamp-contract.json; an unrelated toy task)\n\n\`\`\`json\n${doc('docs/demo/clamp-contract.json')}\`\`\`\n`;
files['AUTHOR_INSTRUCTIONS.md'] = [
  '# Instructions for the contract author', '',
  'You are writing QB\'s **task contract** for the task in TASK.md, from the material in this folder only.', '',
  '1. **Use only** this folder and the pinned starting repository (REPOSITORY.md). **Do not** search the web, open the upstream repository\'s later commits, pull requests, issues or releases, or any benchmark/dataset site. Do not look for an existing fix or its tests.',
  '2. Quote each requirement from TASK.md (`requirements`: id + exact quote). Write `acceptance_criteria` that trace to those requirements (`requirement_ids`).',
  '3. For each behavioural criterion, write executable `checks` using ONLY the adapters in CHECKS.md, against the repository at the base commit. A behavioural requirement that these adapters cannot express **stays `kind: "behavioral"` with no check** (explicitly unresolved) and is explained in `ambiguity_flags`. Never mark it non_behavioral, never make it advisory, and never write a check that does not test the stated behaviour.',
  '4. Set `scope.allowed_changes` / `scope.protected_paths` from what the task needs (CONTRACT_SCHEMA.md, scope policy).',
  '5. Every part of TASK.md must lie inside some requirement `quote` (QB traceability, CONTRACT_SCHEMA.md: intent/requirements.js). Text that is not a requirement (issue-template headings, environment notes) still needs a requirement entry quoting it, with `disposition: "context"` and a `reason`.',
  '6. Validate before you finish: `node validate.cjs contract.json` (no dependencies; runs QB\'s traceability, constraint_policy/scope and preservation validators, copied unchanged into validators/). It must print `OK`. This helper is PARTIAL: it does not run the contract schema, the check registry (including scenario review) or the full contract state. The controller runs all of those after your contract is frozen and reports any failure back to you.',
  '7. Save the contract as `contract.json`, fill in EXPOSURE.md, and mark the contract **ready for review** (not approved). Do not run or tune it against any solution.', '',
  ...(arg('revise') ? ['## Revision task (packet v2)', '',
    '`previous-contract.json` is the contract another fresh author wrote from packet v1, after a disclosed FORMAT-ONLY repair by the (answer-exposed) controller; its `format_repair` field lists exactly what changed. Two questions remain that only an author may answer:',
    '- **Q1 (traceability):** `node validate.cjs previous-contract.json` lists TASK.md text that no requirement quotes. For each span, add a requirement quoting it: a real requirement (then cover it with a criterion), or `disposition: "context"` with a reason.',
    '- **Q2 (AC-5):** the controller removed AC-5\'s descriptive `preserves` (it named no test file); AC-5 is decided by its bound check. Confirm, or instead name the test files it preserves.',
    ...(Number(arg('version') || '1') >= 3 ? ['- **Q3 (behavioural checks):** with `scenario` checks now available (RESEARCH_SCENARIOS.md), write checks for the behavioural criteria that previously had none, where a scenario can express them; keep any that still cannot be expressed behavioural and unresolved, with the reason in `ambiguity_flags`. You may revise those criteria\'s wording only to make them testable, keeping their meaning and requirement links.'] : []),
    `Change nothing else${Number(arg('version') || '1') >= 3 ? ' beyond Q1-Q3' : ''}. Write the result as contract.json.`, ''] : []),
].join('\n');
files['EXPOSURE.md'] = [
  '# Author exposure declaration (fill in)', '',
  '- Author (person or tool, and its configuration): ',
  '- Date/time (UTC): ',
  '- Packet hash (from MANIFEST.json `packet_sha256`): ',
  '- Before or while writing, did you see any of: the upstream fix or its pull request, the benchmark\'s hidden or added tests, any other model\'s or person\'s solution, QB\'s KAN-117 discussion, grading results? (yes/no for each, with details): ',
  '- Web access during authoring (none / describe): ',
  '- Anything else used besides this folder and the pinned repository: ',
  '',
].join('\n');

// leak check over every file (counts only): hidden test names, gold-patch lines, test-patch lines
const { leakCheck } = require(path.join(ROOT, 'lib/research/agent-bundle.js'));
const leaks = {};
for (const [f, t] of Object.entries(files)) {
  const l = leakCheck(f === 'TASK.md' ? t : t, vaultRow);
  if (Object.keys(l).length) leaks[f] = l;
}
// TASK.md is the agent text itself: it must equal what the arm-A briefing carries (already leak-checked for 5892)
if (Object.keys(leaks).length) { console.error(`refused: packet leak check found hidden material: ${JSON.stringify(leaks)}`); process.exit(4); }

fs.mkdirSync(out, { recursive: true });
const VERSION = arg('version') || '1';
const manifest = { schema: 'qb-contract-packet/1', packet_version: VERSION, task: ENV.key, task_id: ENV.task_id, base_commit: ENV.base_commit, built_from_qb_commit: null,
  approved_by: 'KAN-117 review 10635 step 1', contents_rule: 'task text + pinned repo/visible tests + contract/check schema docs + generic constraints only',
  excluded: ['hidden tests', 'gold patch', 'candidate solutions', 'KAN-117 diagnostic thread', 'exception list and rationale', 'grading outcomes'],
  leak_check: 'passed (QB lib/research/agent-bundle.js leakCheck: hidden test names, gold-patch lines, test-patch lines; counts only)',
  files: {} };
if (arg('revise')) files['previous-contract.json'] = fs.readFileSync(arg('revise'), 'utf8');
// runnable local validation (review 10638): QB's dependency-free validators copied UNCHANGED, plus a tiny runner
for (const [dst, src] of [['validators/requirements.cjs', 'intent/requirements.js'], ['validators/policy.cjs', 'verify/policy.js'], ['validators/preservation.cjs', 'verify/preservation.js']]) files[dst] = doc(src);
files['validate.cjs'] = [
  "// Runs QB's traceability, constraint_policy/scope and preservation validators (copied unchanged) on a contract file.",
  "const fs = require('fs'); const c = JSON.parse(fs.readFileSync(process.argv[2] || 'contract.json', 'utf8'));",
  "const errs = [...require('./validators/requirements.cjs').validateTraceability(c).errors, ...require('./validators/policy.cjs').policyErrors(c), ...require('./validators/preservation.cjs').preservationErrors(c)];",
  "const unchecked = (c.acceptance_criteria || []).filter((a) => a.kind === 'behavioral' && !a.preserves && !(c.checks || []).some((k) => k.ac_id === a.id)).map((a) => a.id);",
  "for (const e of errs) console.log('ERROR ' + e);",
  "if (unchecked.length) console.log('NOTE behavioural criteria with no executable check (they stay unresolved): ' + unchecked.join(', '));",
  "console.log(errs.length ? errs.length + ' error(s)' : 'OK');", ''].join('\n');
for (const [f, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(out, f)), { recursive: true }); fs.writeFileSync(path.join(out, f), t); manifest.files[f] = sha(t); }
try { manifest.built_from_qb_commit = (await import('node:child_process')).execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* none */ }
// review after 10644: the pinned base is prepared BEFORE authoring, so the author needs no network at all
if (arg('prepare-base')) {
  const { execFileSync: x } = await import('node:child_process');
  const dir = path.join(out, 'axios');
  fs.mkdirSync(dir, { recursive: true });
  const g = (...a) => x('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim();
  g('init', '-q'); g('fetch', '-q', '--depth', '1', 'https://github.com/axios/axios', ENV.base_commit); g('checkout', '-q', 'FETCH_HEAD');
  const head = g('rev-parse', 'HEAD'); const tree = g('rev-parse', 'HEAD^{tree}'); const commits = Number(g('rev-list', '--all', '--count'));
  if (head !== ENV.base_commit || commits !== 1 || g('remote')) { console.error('base checkout is not the pinned single commit without remotes'); process.exit(5); }
  x('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: dir, stdio: 'ignore' });
  const nm = x('sh', ['-c', 'find node_modules -name package.json -maxdepth 3 | LC_ALL=C sort | xargs cat | shasum -a 256 | cut -c1-64'], { cwd: dir, encoding: 'utf8' }).trim();
  const pkgs = x('sh', ['-c', 'ls node_modules | wc -l'], { cwd: dir, encoding: 'utf8' }).trim();
  manifest.base_checkout = { dir: 'axios', commit: head, tree, commits, remotes: 0, dependencies: 'npm ci --omit=dev --ignore-scripts (runtime only; dev tooling and lifecycle scripts skipped)', node_modules_top_level_entries: Number(pkgs), node_modules_package_json_sha256: nm };
}
manifest.packet_sha256 = sha(JSON.stringify({ files: manifest.files, base_checkout: manifest.base_checkout || null }));
const mtext = `${JSON.stringify(manifest, null, 2)}\n`;
fs.writeFileSync(path.join(out, 'MANIFEST.json'), mtext);
if (arg('manifest')) fs.writeFileSync(arg('manifest'), mtext);
console.log(JSON.stringify({ out, packet_sha256: manifest.packet_sha256, files: Object.keys(files) }, null, 1));
