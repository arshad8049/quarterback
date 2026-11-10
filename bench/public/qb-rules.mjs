// KAN-110: Quarterback's admission rules, ported from the QB source at main 784e721 so a task
// can be judged from files fetched at its base commit without running anything.
//   detectTestRunner  ← context/detector.js detectTestRunner (same order, same keys)
//   testPlan          ← context/test-plan.js testPlan (VALIDATED = node-test only)
//   depsPlan          ← sandbox/scripts/deps-plan.sh (lockfile v2/v3, no workspaces,
//                       no file:/link:/git deps, no root lifecycle scripts)
//   egress            ← lib/sandbox/egress.js DEPS = registry.npmjs.org only; no services
//   runtime           ← sandbox/agent/Dockerfile FROM node:24-bookworm-slim
// plus actualRunner(): what the repository's tests really run, which QB's detector can miss
// (e.g. ts-jest, karma), because "JS does not imply node:test".

export const QB_SOURCE = { repo: 'arshad8049/quarterback', commit: '784e721', runtime: 'node:24-bookworm-slim', validated_runners: ['node-test'] };

/** context/detector.js detectTestRunner, given package.json and (optionally) test/ file heads. */
export function detectTestRunner(pkg, testFileHeads = []) {
  if (pkg) {
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    if (all.vitest) return 'vitest';
    if (all.jest) return 'jest';
    if (all.mocha) return 'mocha';
    if (all.jasmine) return 'jasmine';
    if (pkg.scripts) {
      const testCmd = pkg.scripts.test || '';
      if (/vitest/.test(testCmd)) return 'vitest';
      if (/jest/.test(testCmd)) return 'jest';
      if (/mocha/.test(testCmd)) return 'mocha';
      if (/node:test|node --test/.test(testCmd)) return 'node-test';
    }
    for (const head of testFileHeads.slice(0, 6)) if (/require\(['"]node:test['"]\)/.test(head.slice(0, 400))) return 'node-test';
  }
  return null; // pytest/go detection irrelevant for JS candidates
}

/** context/test-plan.js testPlan (no .quarterback.json case; a present one is reported separately). */
export function testPlan(pkg, testFileHeads = []) {
  const runner = detectTestRunner(pkg, testFileHeads);
  if (runner && runner !== 'node-test') return { status: 'not_run', reason: 'unsupported_runner', runner };
  if (!pkg || !pkg.scripts || typeof pkg.scripts.test !== 'string' || !pkg.scripts.test.trim()) return { status: 'not_run', reason: 'no_test_command', runner };
  return { status: 'run', runner, command: ['npm', 'test'] };
}

const LIFECYCLE = ['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare', 'postprepare'];

/** sandbox/scripts/deps-plan.sh, given package.json and the parsed package-lock.json (or null). */
export function depsPlan(pkg, lock) {
  if (pkg == null) return { status: 'skip', reason: 'no package.json' };
  if (typeof pkg !== 'object' || Array.isArray(pkg)) return { status: 'blocked', reason: 'setup_unsupported_project', detail: 'package.json is not a JSON object' };
  if (lock == null) return { status: 'blocked', reason: 'setup_missing_lockfile' };
  const lv = Number(lock.lockfileVersion || 0);
  if (lv !== 2 && lv !== 3) return { status: 'blocked', reason: 'setup_unsupported_project', detail: `lockfileVersion ${lv} (need 2 or 3)` };
  if (pkg.workspaces) return { status: 'blocked', reason: 'setup_unsupported_project', detail: 'npm workspaces' };
  const local = Object.values(lock.packages || {}).filter((v) => v && (v.link === true || /^(file:|git|github:|link:)/.test(v.resolved || ''))).length;
  if (local) return { status: 'blocked', reason: 'setup_unsupported_project', detail: `${local} file:/link:/git dependencies` };
  const scripts = Object.keys(pkg.scripts || {}).filter((k) => LIFECYCLE.includes(k));
  if (scripts.length) return { status: 'blocked', reason: 'setup_unsupported_project', detail: `root lifecycle script(s): ${scripts.join(',')}` };
  return { status: 'ready' };
}

// Test frameworks, most specific first. Task runners (gulp/grunt/make/turbo/nx/lerna) delegate:
// they are reported but do not decide the framework on their own.
const FRAMEWORKS = [
  ['node-test', /\bnode\b[^&|;\n]*\s--test\b|node:test/],
  ['vitest', /\bvitest\b/], ['jest', /\bjest\b|ts-jest|react-scripts test|craco test|--runInBand\b/], ['mocha', /\bmocha\b|_mocha\b|\bnyc mocha\b/],
  ['karma', /\bkarma\b/], ['jasmine', /\bjasmine\b/], ['ava', /\bava\b/], ['tap', /\btap\b|\btape\b/], ['uvu', /\buvu\b/],
  ['playwright', /\bplaywright test\b/], ['cypress', /\bcypress\b/], ['qunit', /\bqunit\b/], ['lab', /\blab\b -/],
];
const DELEGATORS = /\b(gulp|grunt|make|turbo|nx|lerna|bazel|yarn workspaces|ng test)\b/;

/** Frameworks named in a command string (grading command or script). */
export function frameworksIn(cmd) {
  if (!cmd) return [];
  return FRAMEWORKS.filter(([, re]) => re.test(cmd)).map(([n]) => n);
}

/** Follow package.json "test" through npm/yarn/pnpm run indirections (depth 4) and name frameworks. */
export function actualRunnerFromScripts(pkg) {
  const scripts = (pkg && pkg.scripts) || {};
  const seen = new Set(); const found = new Set(); const delegators = new Set();
  const walk = (name, d) => {
    if (d > 4 || seen.has(name) || typeof scripts[name] !== 'string') return; seen.add(name);
    const cmd = scripts[name];
    frameworksIn(cmd).forEach((f) => found.add(f));
    const dm = DELEGATORS.exec(cmd); if (dm) delegators.add(dm[1]);
    for (const m of cmd.matchAll(/(?:npm run|npm run-script|yarn run|yarn|pnpm run|pnpm|bun run)\s+([\w:.@/-]+)/g)) walk(m[1], d + 1);
    for (const m of cmd.matchAll(/run-(?:s|p|all)\s+((?:[\w:.*-]+\s*)+)/g)) m[1].trim().split(/\s+/).forEach((n) => {
      if (n.includes('*')) { const re = new RegExp('^' + n.replace(/[.]/g, '\\.').replace(/\*/g, '.*') + '$'); Object.keys(scripts).filter((k) => re.test(k)).forEach((k) => walk(k, d + 1)); } else walk(n, d + 1);
    });
  };
  walk('test', 0);
  return { frameworks: [...found], delegators: [...delegators], has_test_script: typeof scripts.test === 'string' && !!scripts.test.trim() };
}

const SERVICES = [
  ['redis', /\bredis(-server)?\b/i], ['mongodb', /\bmongo(d|db)?\b/i], ['postgres', /\bpostgres(ql)?\b|\bpsql\b/i], ['mysql', /\bmysql(d)?\b|\bmariadb\b/i],
  ['elasticsearch', /\belasticsearch\b/i], ['xvfb', /\bxvfb\b/i], ['browser', /\bchrom(e|ium)\b|\bfirefox\b|\bpuppeteer\b|playwright install|\bselenium\b/i],
  ['docker-in-docker', /\bdocker (run|compose)\b|docker-compose/i],
];
export function servicesIn(text) { return text ? SERVICES.filter(([, re]) => re.test(text)).map(([n]) => n) : []; }

/** Node major version hints from engines, .nvmrc/.node-version and a Dockerfile/script. */
export function nodeHints({ pkg, nvmrc, nodeVersion, dockerfile, script }) {
  const h = {};
  if (pkg && pkg.engines && pkg.engines.node) h.engines = String(pkg.engines.node);
  if (nvmrc) h.nvmrc = nvmrc.trim().split('\n')[0];
  if (nodeVersion) h.node_version_file = nodeVersion.trim().split('\n')[0];
  const df = /FROM\s+(?:[\w./-]+\/)?node:([\w.-]+)/i.exec(dockerfile || '') || /nvm (?:install|use)\s+v?([\d.]+)/i.exec((dockerfile || '') + '\n' + (script || ''))
    || /NODE_VERSION[= ]v?([\d.]+)/i.exec(dockerfile || '');
  if (df) h.image_or_setup = df[1];
  return h;
}

/** Package manager evidence: lockfiles in the root tree, the packageManager field, grading commands. */
export function packageManager({ rootFiles, pkg, commands }) {
  const lock = { npm: rootFiles.has('package-lock.json') || rootFiles.has('npm-shrinkwrap.json'), yarn: rootFiles.has('yarn.lock'), pnpm: rootFiles.has('pnpm-lock.yaml'), bun: rootFiles.has('bun.lockb') || rootFiles.has('bun.lock') };
  const declared = pkg && typeof pkg.packageManager === 'string' ? pkg.packageManager.split('@')[0] : null;
  const used = new Set(); for (const c of commands) { if (/\byarn\b/.test(c || '')) used.add('yarn'); if (/\bpnpm\b/.test(c || '')) used.add('pnpm'); if (/\bnpm (ci|install|i|run|test)\b|\bnpx\b/.test(c || '')) used.add('npm'); }
  return { lockfiles: Object.entries(lock).filter(([, v]) => v).map(([k]) => k), declared, used_by_setup_or_grader: [...used] };
}

/**
 * Classification against QB at 784e721. Returns { status: compatible|incompatible|unknown, reasons[] }.
 * compatible = every QB admission rule passes AND the actual runner is node:test AND no services.
 * It is a static result: runnable compatibility (Node 24 install, real test run) is KAN-111's job.
 */
export function classify(f) {
  const reasons = [];
  if (f.fetch_error) return { status: 'unknown', reasons: [`could not read the repository at base_commit: ${f.fetch_error}`] };
  if (f.quarterback_json) reasons.push('repository has a .quarterback.json (not expected upstream; needs manual review)');
  if (!f.pkg_present) reasons.push('no package.json at the repository root');
  const plan = f.test_plan;
  if (plan.status === 'not_run' && plan.reason === 'unsupported_runner') reasons.push(`QB refuses: detected runner ${plan.runner} (QB executes node:test only)`);
  if (plan.status === 'not_run' && plan.reason === 'no_test_command') reasons.push('QB refuses: no package.json "test" script');
  const actual = new Set([...f.runner_from_scripts.frameworks, ...f.runner_from_grader]);
  const nonNode = [...actual].filter((r) => r !== 'node-test');
  if (nonNode.length) reasons.push(`actual test runner ${nonNode.join('+')} (from ${f.runner_from_grader.length ? 'grading command' : 'package.json scripts'}); QB would not parse it`);
  if (f.deps_plan.status === 'blocked') reasons.push(`QB sandbox refuses dependencies: ${f.deps_plan.reason}${f.deps_plan.detail ? ' (' + f.deps_plan.detail + ')' : ''}`);
  if (f.services.length) reasons.push(`needs services not available in the QB sandbox: ${f.services.join(', ')}`);
  if (reasons.length) return { status: 'incompatible', reasons };
  if (!actual.has('node-test')) return { status: 'unknown', reasons: ['no test framework identified; QB would run `npm test` without a validated reporter'] };
  return { status: 'compatible', reasons: ['all QB 784e721 admission rules pass statically; runnable compatibility on Node 24 not yet verified (KAN-111)'] };
}
