/**
 * KAN-106 10758: the frozen eight-request evaluation package (bench/kan106-eval-v1). Offline only: no model,
 * and the staged prototype is NOT run on the eight frozen requests (not even with a faked model), so they
 * cannot be tuned to it. The scorer is exercised on a separate TEST-ONLY item built from the asNumber fixture
 * and the published 69e576f5 contract.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const EVAL = path.join(ROOT, 'bench', 'kan106-eval-v1');
const ITEMS = path.join(EVAL, 'items');
const IDS = ['S1-slug', 'S2-formatter', 'S3-percent', 'S4-parsebool', 'S5-clock', 'S6-money', 'U1-userrepo', 'U2-roundto'];
const item = (id) => JSON.parse(fs.readFileSync(path.join(ITEMS, id, 'item.json'), 'utf8'));
const FREEZE = JSON.parse(fs.readFileSync(path.join(EVAL, 'FREEZE.json'), 'utf8'));
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

describe('the frozen set', () => {
  test('eight items in the frozen order: six supported (finalize), two unsupported/ambiguous (refuse)', () => {
    assert.deepEqual(fs.readdirSync(ITEMS).sort(), IDS);
    assert.deepEqual(FREEZE.order, IDS);
    assert.deepEqual(IDS.map((id) => item(id).expected), ['finalize', 'finalize', 'finalize', 'finalize', 'finalize', 'finalize', 'refuse', 'refuse']);
  });
  test('the supported items cover the 10758 categories', () => {
    const cats = IDS.slice(0, 6).map((id) => item(id).category).join(' | ');
    for (const re of [/function/, /default-class method/, /new export/, /explicit protection/, /preservation/, /added tests/]) assert.match(cats, re);
  });
  test('asNumber and its paraphrases are not reused', () => {
    for (const id of IDS) {
      const all = [fs.readFileSync(path.join(ITEMS, id, 'request.txt'), 'utf8'), ...fs.readdirSync(path.join(ITEMS, id, 'base', 'lib')).map((f) => fs.readFileSync(path.join(ITEMS, id, 'base', 'lib', f), 'utf8'))].join('\n');
      assert.doesNotMatch(all, /asNumber|Serializer|cannot be converted to a number|whitespace/i, id);
    }
  });
  test('every supported item freezes its requirements, controls (correct + at least one wrong) and scope; every refusal item states what a safe refusal is', () => {
    for (const id of IDS) {
      const m = item(id);
      assert.deepEqual(m.never_compiler_inputs, ['controls/', 'reference.test.js', 'item.json'], id);
      if (m.expected === 'refuse') { assert.ok(m.refusal, id); assert.equal(fs.existsSync(path.join(ITEMS, id, 'controls')), false, id); continue; }
      assert.ok(m.requirements.length >= 2, id);
      const controls = fs.readdirSync(path.join(ITEMS, id, 'controls'));
      assert.ok(controls.includes('correct') && controls.some((c) => c.startsWith('wrong-')), id);
      assert.deepEqual(Object.keys(m.control_expect).sort(), ['base', ...controls].sort(), id);
      assert.ok(m.scope.must_allow.length >= 1, id);
    }
    assert.deepEqual(item('S4-parsebool').scope.must_protect, ['lib/defaults.js']);
  });
});

describe('offline control validation (hand-written reference tests, no model)', () => {
  test('every control behaves as frozen; the committed offline-control-results.json is reproduced', () => {
    const { validate } = require('../../bench/kan106-eval-v1/validate-controls');
    const r = validate();
    assert.equal(r.all_match, true, JSON.stringify(r.items.filter((x) => Object.values(x.controls).some((c) => !c.matches_expectation)), null, 1));
    for (const it of r.items) assert.equal(it.base_own_suite, 'pass', it.id);
    const committed = JSON.parse(fs.readFileSync(path.join(EVAL, 'offline-control-results.json'), 'utf8'));
    assert.deepEqual(committed.items.map((x) => [x.id, x.controls]), r.items.map((x) => [x.id, x.controls]));
  });
});

describe('materialize and freeze', () => {
  test('materialize: base/ only, one commit each, and the commit SHAs equal the frozen ones', () => {
    const out = tmp('kan106-mat-');
    try {
      const shas = require('../../bench/kan106-eval-v1/materialize').materialize(path.join(out, 'r'));
      assert.deepEqual(shas, FREEZE.base_shas);
      for (const id of IDS) {
        const dir = path.join(out, 'r', id);
        assert.equal(fs.existsSync(path.join(dir, 'controls')) || fs.existsSync(path.join(dir, 'reference.test.js')) || fs.existsSync(path.join(dir, 'item.json')), false, id);
        assert.equal(spawnSync('git', ['rev-list', '--count', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim(), '1', id);
      }
    } finally { fs.rmSync(out, { recursive: true, force: true }); }
  });
  test('check-freeze: the committed package matches FREEZE.json (every item file and harness file)', () => {
    const { check, current } = require('../../bench/kan106-eval-v1/check-freeze');
    assert.deepEqual(check(), []);
    assert.deepEqual(Object.keys(current()).sort(), Object.keys(FREEZE.files).sort());
  });
  test('the frozen settings: one run per item, no reruns, the staged profile and its budgets', () => {
    assert.equal(FREEZE.model, 'qwen2.5-coder:14b');
    assert.deepEqual(FREEZE.flags, ['--agent', 'dry-run', '--no-llm-context', '--l1-profile', 'qwen-14b-staged', '--deadline', '15']);
    const { l1Budget } = require('../../lib/budget');
    const b = l1Budget({ profile: 'qwen-14b-staged' });
    assert.equal(b.ms, FREEZE.budgets.l1_total_ms);
    assert.equal(b.per_call_ms, FREEZE.budgets.per_call_ms);
    assert.equal(FREEZE.budgets.max_model_minutes, (8 * FREEZE.budgets.l1_total_ms) / 60_000);
    assert.equal(FREEZE.runs_per_item, 1);
  });
});

describe('run-batch.sh (not run: inspected, and its refusals exercised without a model)', () => {
  const SH = path.join(EVAL, 'run-batch.sh');
  const y = fs.readFileSync(SH, 'utf8');
  test('one pass over the frozen order, the exact frozen command, no retry loop, evidence under ~/qb-evidence', () => {
    assert.match(y, /^ITEMS=\(S1-slug S2-formatter S3-percent S4-parsebool S5-clock S6-money U1-userrepo U2-roundto\)$/m);
    assert.match(y, /QB_MODEL=\$MODEL node qb\.js "\$\(cat bench\/kan106-eval-v1\/items\/\$id\/request\.txt\)" --repo "\$OUT\/repos\/\$id" --agent dry-run --no-llm-context --l1-profile qwen-14b-staged --deadline 15 /);
    assert.equal((y.match(/node qb\.js/g) || []).length, 1);
    assert.equal((y.match(/^for id in \$ITEMS; do$/gm) || []).length, 1);
    const code = y.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    assert.doesNotMatch(code, /\b(while|until)\b|--agent claude|ANTHROPIC|CLAUDE_CODE/);
    assert.match(y, /OUT=~\/qb-evidence\/kan106-eval-v1\//);
    assert.equal(spawnSync('zsh', ['-n', SH]).status, 0);
  });
  test('refuses before any run without the frozen SHA, or at a different SHA', () => {
    let r = spawnSync('zsh', [SH], { encoding: 'utf8' });
    assert.equal(r.status, 2); assert.match(r.stdout, /usage/);
    r = spawnSync('zsh', [SH, '0'.repeat(40)], { encoding: 'utf8' });
    assert.equal(r.status, 2); assert.match(r.stdout, /Nothing was run/);
  });
});

describe('score.js on a TEST-ONLY item (asNumber fixture + the published 69e576f5 contract), not an eval item', () => {
  const FIX = path.join(__dirname, '..', 'fixtures', 'kan106');
  const PINNED = fs.readFileSync(path.join(FIX, 'pinned-fast-json-stringify/serializer-07d7196.js'), 'utf8');
  const GUARD = "    // reject blank strings, which Number() would coerce to 0\n    if (typeof i === 'string' && i.trim() === '') {\n      throw new Error(`The value \"${i}\" cannot be converted to a number.`)\n    }\n";
  const BASE = PINNED.replace(GUARD, '');
  const PACK = path.join(ROOT, 'docs', 'research', 'kan106', '2026-11-18-staged-69e576f5');
  const { scoreItem, summarize } = require('../../bench/kan106-eval-v1/score');
  const w = (root, rel, body) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), body); };
  function itemsRoot({ mustProtect = [], scopeControl = false } = {}) {
    const root = tmp('kan106-score-items-');
    const d = path.join(root, 'ASN');
    w(d, 'base/package.json', '{"name":"pinned","type":"commonjs"}'); w(d, 'base/lib/serializer.js', BASE); w(d, 'base/test/asNumber.test.js', "'use strict'\n");
    w(d, 'controls/correct/lib/serializer.js', PINNED);
    w(d, 'controls/wrong-trunc/lib/serializer.js', PINNED.replace("return '' + num", "return '' + Math.trunc(num)"));
    w(d, 'controls/wrong-passes-all/lib/serializer.js', PINNED.replace('// fast cast to number', '// fast cast to number (cosmetic edit: passes every check by design)'));
    if (scopeControl) { w(d, 'controls/wrong-scope/lib/serializer.js', PINNED); w(d, 'controls/wrong-scope/package.json', '{"name":"changed"}'); }
    w(d, 'item.json', JSON.stringify({ id: 'ASN', category: 'test-only', expected: 'finalize', requirements: [{ id: 'r', text: 'x' }],
      scope: { must_allow: ['lib/serializer.js'], must_protect: mustProtect }, ...(scopeControl ? { scope_controls: { 'wrong-scope': 'refused by protected paths' } } : {}) }));
    w(root, 'REF/item.json', JSON.stringify({ id: 'REF', category: 'test-only', expected: 'refuse', requirements: [], scope: { must_allow: [], must_protect: [] } }));
    return root;
  }
  const run = (withContract = true) => ({
    manifest: { run_id: 'fake', qb_revision: 'fake', outcome: withContract ? 'DRY_RUN' : 'BLOCKED', models: { intent: 'qwen2.5-coder:14b' }, agent: { type: 'dry-run' } },
    staged: JSON.parse(fs.readFileSync(path.join(PACK, 'contract-staged.json'), 'utf8')),
    contract: withContract ? JSON.parse(fs.readFileSync(path.join(PACK, 'contract.json'), 'utf8')) : null,
    timings: JSON.parse(fs.readFileSync(path.join(PACK, 'l1-timings.event.json'), 'utf8')).data,
  });

  test('a finalized checklist: controls run unchanged; correct passes, base is distinguished, a wrong control that passes everything is flagged', () => {
    const root = itemsRoot();
    try {
      const s = scoreItem('ASN', run(), { itemsRoot: root });
      assert.equal(s.structural, 'finalized');
      assert.equal(s.correct_passes_all, true);
      assert.equal(s.base_distinguished, true);
      assert.equal(s.controls['wrong-trunc'].all_checks_pass, false);
      assert.deepEqual(s.incorrect_acceptance, ['wrong-passes-all']);
      assert.equal(s.mechanical_pass, false);
      assert.equal(s.semantic, null, 'semantic review is never decided by the script');
      assert.deepEqual(s.unresolved.map((x) => x.id), ['AC-9']);
      assert.equal(s.l1_ms, 84462);
      assert.deepEqual(s.model.replies, ['qwen2.5-coder:14b']);
      assert.equal(s.repairs, 0);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  test('scope: a required protection missing from the checklist, and a scope control not refused, are both reported', () => {
    const root = itemsRoot({ mustProtect: ['package.json'], scopeControl: true });
    try {
      const s = scoreItem('ASN', run(), { itemsRoot: root });
      assert.deepEqual(s.scope.missing_allow, []);
      assert.deepEqual(s.scope.missing_protect, ['package.json']);
      assert.equal(s.scope.scope_controls['wrong-scope'].refused_by_protected_paths, false);
      assert.equal(s.incorrect_acceptance.includes('wrong-scope'), false, 'a scope control is judged by scope, not checks');
      assert.deepEqual(summarize([s]).supported.protected_scope_weakened, ['ASN']);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  test('a refusal item: no finalized checklist is a safe refusal; a finalized one is not; counted separately', () => {
    const root = itemsRoot();
    try {
      const refused = scoreItem('REF', run(false), { itemsRoot: root });
      const finalized = scoreItem('REF', run(true), { itemsRoot: root });
      assert.equal(refused.safe_refusal, true);
      assert.equal(finalized.safe_refusal, false);
      const sum = summarize([refused, finalized]);
      assert.deepEqual([sum.unsupported.total, sum.unsupported.safe_refusals, sum.supported.total], [2, 1, 0]);
      assert.match(sum.note, /never in a combined percentage/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
