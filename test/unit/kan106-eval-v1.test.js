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
  test('the frozen settings: one run per item, no reruns, the staged profile, its budgets passed explicitly (10761)', () => {
    assert.equal(FREEZE.model, 'qwen2.5-coder:14b');
    assert.deepEqual(FREEZE.flags, ['--agent', 'dry-run', '--no-llm-context', '--no-llm-verify', '--l1-profile', 'qwen-14b-staged', '--l1-budget', '420', '--deadline', '15']);
    const { l1Budget } = require('../../lib/budget');
    const b = l1Budget({ flagMs: 420 * 1000, profile: 'qwen-14b-staged' });
    assert.equal(b.ms, FREEZE.budgets.l1_total_ms);
    assert.equal(b.per_call_ms, FREEZE.budgets.per_call_ms);
    assert.equal(FREEZE.budgets.l1_budget_sum_minutes, (8 * FREEZE.budgets.l1_total_ms) / 60_000);
    assert.match(FREEZE.budgets.note, /wall time .* setup and scoring/);
    assert.equal(FREEZE.runs_per_item, 1);
  });
});

describe('run-batch.sh (not run: inspected, and its refusals exercised without a model)', () => {
  const SH = path.join(EVAL, 'run-batch.sh');
  const y = fs.readFileSync(SH, 'utf8');
  test('preflight, then ONE batch.js call (one pass, pinned child settings: kan106-eval-v1-10761.test.js), then scoring; no retry loop', () => {
    const code = y.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    assert.equal((code.match(/node bench\/kan106-eval-v1\/batch\.js "\$OUT" "\$EXPECTED_SHA"/g) || []).length, 1);
    assert.doesNotMatch(code, /node qb\.js/, 'the shell never launches QB itself');
    assert.doesNotMatch(code, /\b(while|until|for)\b|--agent claude|ANTHROPIC|CLAUDE_CODE|ollama pull/);
    assert.match(code, /node bench\/kan106-eval-v1\/score\.js --batch-dir "\$OUT" --out "\$OUT\/scores\.json"/);
    assert.match(y, /OUT=~\/qb-evidence\/kan106-eval-v1\//);
    assert.equal(spawnSync('zsh', ['-n', SH]).status, 0);
    const b = fs.readFileSync(path.join(EVAL, 'batch.js'), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    assert.doesNotMatch(b, /\b(while|until)\b|retry|--agent claude|ANTHROPIC|CLAUDE_CODE|\/api\/(pull|chat|generate)/);
    assert.equal((b.match(/for \(const id of items\)/g) || []).length, 1);
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
  const { scoreItem, summarize, expectFrom } = require('../../bench/kan106-eval-v1/score');
  const crypto = require('crypto');
  const BASE_SHA = 'b'.repeat(40);
  const REQUEST = 'test-only request (ASN fixture)';
  const w = (root, rel, body) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), body); };
  function itemsRoot({ mustProtect = [], scopeControl = false } = {}) {
    const root = tmp('kan106-score-items-');
    const d = path.join(root, 'ASN');
    w(d, 'base/package.json', '{"name":"pinned","type":"commonjs"}'); w(d, 'base/lib/serializer.js', BASE); w(d, 'base/test/asNumber.test.js', "'use strict'\n");
    w(d, 'controls/correct/lib/serializer.js', PINNED);
    w(d, 'controls/wrong-trunc/lib/serializer.js', PINNED.replace("return '' + num", "return '' + Math.trunc(num)"));
    w(d, 'controls/wrong-passes-all/lib/serializer.js', PINNED.replace('// fast cast to number', '// fast cast to number (cosmetic edit: passes every check by design)'));
    if (scopeControl) { w(d, 'controls/wrong-scope/lib/serializer.js', PINNED); w(d, 'controls/wrong-scope/package.json', '{"name":"changed"}'); }
    w(d, 'request.txt', REQUEST + '\n');
    w(d, 'item.json', JSON.stringify({ id: 'ASN', category: 'test-only', expected: 'finalize', requirements: [{ id: 'r', text: 'x' }],
      scope: { must_allow: ['lib/serializer.js'], must_protect: mustProtect }, ...(scopeControl ? { scope_controls: { 'wrong-scope': 'refused by protected paths' } } : {}) }));
    w(root, 'REF/request.txt', REQUEST + '\n');
    w(root, 'REF/item.json', JSON.stringify({ id: 'REF', category: 'test-only', expected: 'refuse', requirements: [], scope: { must_allow: [], must_protect: [] },
      refusal_evidence: { decision: 'unsupported_call_shape', target: 'Nothing', reason_includes: 'constructor', max_model_calls: 0 } }));
    return root;
  }
  const EXPECT = { ...expectFrom({ qbRevision: 'f'.repeat(40) }), base_shas: { ASN: BASE_SHA, REF: BASE_SHA } };
  /** The published 69e576f5 replies/contract as a run record, re-labelled with this batch's identity (10761). */
  function record(withContract = true) {
    const runs = tmp('kan106-score-runs-');
    const id = crypto.randomUUID();
    const dir = path.join(runs, id);
    fs.mkdirSync(path.join(dir, 'artifacts'), { recursive: true });
    const artifacts = {};
    const put = (name, file) => { const buf = fs.readFileSync(path.join(PACK, file)); const h = crypto.createHash('sha256').update(buf).digest('hex'); fs.writeFileSync(path.join(dir, 'artifacts', h + '.json'), buf); artifacts[name] = { name, sha256: h, path: `artifacts/${h}.json`, bytes: buf.length }; };
    put('contract-staged', 'contract-staged.json');
    if (withContract) put('contract', 'contract.json');
    const ev = JSON.parse(fs.readFileSync(path.join(PACK, 'l1-timings.event.json'), 'utf8'));
    ev.data.l1_budget = { ...ev.data.l1_budget, source: '--l1-budget' };
    fs.writeFileSync(path.join(dir, 'events.jsonl'), JSON.stringify(ev) + '\n');
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ run_id: id, qb_revision: EXPECT.qb_revision, request: REQUEST,
      repo: { base_sha: BASE_SHA }, outcome: withContract ? 'DRY_RUN' : 'BLOCKED', outcome_reason: withContract ? null : 'staged_l1_invalid: something else',
      models: { intent: 'qwen2.5-coder:14b' }, agent: { type: 'dry-run' }, config: { ...EXPECT.config }, attempts: [], artifacts }));
    return { runs, entry: { run_id: id, exit_code: withContract ? 0 : 2, signal: null } };
  }
  const scored = (id, withContract, root) => {
    const r = record(withContract);
    try { return scoreItem(id, r.entry, { runsRoot: r.runs, itemsRoot: root, expect: EXPECT }); } finally { fs.rmSync(r.runs, { recursive: true, force: true }); }
  };

  test('a finalized checklist: controls run unchanged; correct passes, base is distinguished, a wrong control that passes everything is flagged', () => {
    const root = itemsRoot();
    try {
      const s = scored('ASN', true, root);
      assert.deepEqual(s.problems, []);
      assert.equal(s.result, 'checklist');
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
      const s = scored('ASN', true, root);
      assert.deepEqual(s.scope.missing_allow, []);
      assert.deepEqual(s.scope.missing_protect, ['package.json']);
      assert.equal(s.scope.scope_controls['wrong-scope'].refused_by_protected_paths, false);
      assert.equal(s.incorrect_acceptance.includes('wrong-scope'), false, 'a scope control is judged by scope, not checks');
      assert.deepEqual(summarize([s]).supported.protected_scope_weakened, ['ASN']);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  test('a refusal item: a finalized checklist is not refused; a block for an undeclared reason is not an intended refusal; counted separately', () => {
    const root = itemsRoot();
    try {
      const blocked = scored('REF', false, root);
      const finalized = scored('REF', true, root);
      assert.equal(blocked.result, 'blocked_other_reason');
      assert.equal(finalized.result, 'not_refused');
      const sum = summarize([blocked, finalized]);
      assert.deepEqual([sum.unsupported.total, sum.unsupported.intended_refusals, sum.unsupported.blocked_other_reason, sum.unsupported.not_refused, sum.supported.total], [2, 0, 1, 1, 0]);
      assert.match(sum.note, /never in a combined percentage/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
