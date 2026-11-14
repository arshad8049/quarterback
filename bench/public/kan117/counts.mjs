// KAN-117: machine-readable recount of the public JS/TS inventory (bench/public/manifest/candidates.json).
// Reads ONLY the committed static classification; runs nothing; makes no claim that any task is runnable.
// Every task's classification reasons are mapped to a fixed blocker key. A reason that matches no rule
// becomes "unmapped" and makes the summary fail (exit 1), so a new reason cannot silently drop out.
//
//   node bench/public/kan117/counts.mjs [candidates.json] [--out file]
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Order matters only for readability; each reason must match exactly one rule.
export const RULES = [
  ['runner', /^QB refuses: detected runner \S+ \(QB executes node:test only\)$/],
  ['runner', /^actual test runner \S+ \(from (grading command|package\.json scripts)\); QB would not parse it$/],
  ['runner', /^no test framework identified; QB would run `npm test` without a validated reporter$/],
  ['deps', /^QB sandbox refuses dependencies: setup_(missing_lockfile|unsupported_project)( \(.+\))?$/],
  ['no_test_script', /^QB refuses: no package\.json "test" script$/],
  ['no_root_package', /^no package\.json at the repository root$/],
  ['services', /^needs services not available in the QB sandbox: .+$/],
];

export function blockersOf(task) {
  const keys = new Set(); const unmapped = [];
  for (const r of task.classification.reasons) {
    const hit = RULES.filter(([, re]) => re.test(r));
    if (hit.length !== 1) unmapped.push(r); else keys.add(hit[0][0]);
  }
  return { keys: [...keys].sort(), unmapped };
}

/** The runner the dataset's own grading command uses; else package.json scripts; else unknown. */
export function actualRunner(task) {
  const g = task.facts.runner_from_grader || [];
  if (g.length) return { runner: g.join('+'), from: 'grading_command' };
  const s = (task.facts.runner_from_scripts && task.facts.runner_from_scripts.frameworks) || [];
  if (s.length) return { runner: s.join('+'), from: 'package_scripts' };
  return { runner: 'unknown', from: 'none' };
}

const inc = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; return o; };
const subset = (keys, allowed) => keys.every((k) => allowed.includes(k));

// Upper bounds, NOT unlocked counts. "A" = blocked only by QB's runner and/or installer rules.
// "B" = A plus tasks whose only extra blocker is a missing package.json "test" script
// (a dataset grading command exists, but no agent-visible test command is documented in package.json).
export const BOUNDS = {
  A_runner_and_or_deps_only: ['runner', 'deps'],
  B_plus_no_test_script: ['runner', 'deps', 'no_test_script'],
};

export function summarize(doc) {
  const tasks = doc.tasks;
  const out = {
    schema: 'qb-kan117-counts/1',
    meaning: 'Static classification under the EXISTING QB rules (qb_source). "eligible" = no recorded blocker; bounds are candidate upper bounds, not dynamically validated counts.',
    input: { schema: doc.schema, qb_source: doc.qb_source, tasks: tasks.length },
    totals: { tasks: tasks.length, by_status: {}, statically_eligible_existing_rules: 0 },
    by_source: {}, by_runner: {}, by_source_runner: {}, blocker_sets: {}, bounds: {},
    pinned_image: {}, unmapped_reasons: [],
  };
  for (const name of Object.keys(BOUNDS)) out.bounds[name] = { allowed_blockers: BOUNDS[name], total: 0, by_source: {}, by_runner: {} };
  for (const t of tasks) {
    const { keys, unmapped } = blockersOf(t);
    for (const u of unmapped) out.unmapped_reasons.push({ task_id: t.task_id, reason: u });
    const { runner } = actualRunner(t);
    const src = t.source;
    inc(out.totals.by_status, t.classification.status);
    if (t.classification.status === 'compatible') out.totals.statically_eligible_existing_rules += 1;
    const s = out.by_source[src] || (out.by_source[src] = { total: 0, by_status: {}, services: 0, pinned_digest: 0 });
    s.total += 1; inc(s.by_status, t.classification.status);
    if ((t.facts.services || []).length) s.services += 1;
    const pinned = !!(t.facts.image && t.facts.image.digest);
    if (pinned) s.pinned_digest += 1;
    inc(out.by_runner, runner);
    inc(out.by_source_runner, `${src} | ${runner}`);
    inc(out.blocker_sets, keys.join('+') || 'none');
    for (const [name, allowed] of Object.entries(BOUNDS)) {
      if (keys.length && subset(keys, allowed)) {
        const b = out.bounds[name]; b.total += 1; inc(b.by_source, src); inc(b.by_runner, runner);
      }
    }
    if (pinned && !(t.facts.services || []).length) {
      inc(out.pinned_image, `${src} | ${runner} | deps:${t.facts.qb_deps_plan.status}`);
    }
  }
  out.unmapped_reasons.sort((a, b) => (a.task_id < b.task_id ? -1 : 1));
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const oi = args.indexOf('--out');
  const outFile = oi >= 0 ? args[oi + 1] : null;
  const inFile = args.find((a, i) => !a.startsWith('--') && (oi < 0 || i !== oi + 1))
    || fileURLToPath(new URL('../manifest/candidates.json', import.meta.url));
  const buf = fs.readFileSync(inFile);
  const res = summarize(JSON.parse(buf));
  res.input.file = path.relative(process.cwd(), inFile);
  res.input.sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const text = `${JSON.stringify(res, null, 2)}\n`;
  if (outFile) fs.writeFileSync(outFile, text); else process.stdout.write(text);
  if (res.unmapped_reasons.length) { console.error(`unmapped reasons: ${res.unmapped_reasons.length}`); process.exit(1); }
}
