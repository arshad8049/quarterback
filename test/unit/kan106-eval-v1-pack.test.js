/**
 * KAN-106 10765: the sanitized evidence pack of the eight-request batch 20261119T200955Z (generation 881a51a,
 * analysis f907d97). Offline: no model. Hashes, no private paths, the redactions are exactly the labelled ones,
 * and the one-command re-score reproduces the published corrected scores byte for byte.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { scoreBatchDir } = require('../../bench/kan106-eval-v1/score');

const PACK = path.join(__dirname, '..', '..', 'docs', 'research', 'kan106', '2026-11-19-eval-v1-881a51a');
const HASHES = JSON.parse(fs.readFileSync(path.join(PACK, 'HASHES.json'), 'utf8'));
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(PACK, f))).digest('hex');
const walk = (d, rel = '') => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name), path.posix.join(rel, e.name)) : [path.posix.join(rel, e.name)]));

test('every published file is in HASHES.json with its published sha256; only the labelled files differ from the original', () => {
  const files = walk(PACK).filter((f) => !['HASHES.json', 'README.md'].includes(f)).sort();
  assert.deepEqual(files, Object.keys(HASHES.files).sort());
  for (const [f, e] of Object.entries(HASHES.files)) {
    assert.equal(sha(f), e.published_sha256, f);
    if (/^runs\/[^/]+\/artifacts\//.test(f)) {
      assert.equal(e.changed, null, `${f} must be byte-identical`);
      assert.equal(path.basename(f, '.json'), e.published_sha256, `${f} is named by its sha256`);
    }
    if (e.original_sha256 && e.original_sha256 !== e.published_sha256) assert.ok(/^(batch\.json|runs\/[^/]+\/(manifest\.json|events\.jsonl))$/.test(f) && e.changed, `${f}: an undeclared change`);
  }
  for (const f of ['scores.json', 'scores-v3-f907d97.json', 'runs.json', 'base-shas.json', 'semantic-review-proposed.json']) assert.equal(HASHES.files[f].changed, null, f);
});

test('no private paths anywhere in the pack', () => {
  for (const f of walk(PACK)) assert.doesNotMatch(fs.readFileSync(path.join(PACK, f), 'utf8'), /\/Users\/|\/home\/|\/private\/var|\/var\/folders|qb-evidence\/kan106-eval-v1\/2026/, f);
});

test('generation 881a51a and analysis f907d97: the original v2 scores are kept, and re-scoring the pack offline reproduces the corrected scores byte for byte', () => {
  const runs = JSON.parse(fs.readFileSync(path.join(PACK, 'runs.json'), 'utf8'));
  for (const { run_id: id } of Object.values(runs)) {
    assert.equal(JSON.parse(fs.readFileSync(path.join(PACK, 'runs', id, 'manifest.json'), 'utf8')).qb_revision, '881a51a1149ccfcc1a757aefe0b17ea79fa3ef9e');
  }
  const original = JSON.parse(fs.readFileSync(path.join(PACK, 'scores.json'), 'utf8'));
  assert.equal(original.summary.supported.by_result.invalid_record, 6, 'the v2 analysis (exit-code erratum) is kept as it was');
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kan106-pack-')), 'rescore.json');
  try {
    fs.writeFileSync(out, JSON.stringify(scoreBatchDir(PACK), null, 2) + '\n');
    assert.equal(fs.readFileSync(out, 'utf8'), fs.readFileSync(path.join(PACK, 'scores-v3-f907d97.json'), 'utf8'));
  } finally { fs.rmSync(path.dirname(out), { recursive: true, force: true }); }
  const v3 = JSON.parse(fs.readFileSync(path.join(PACK, 'scores-v3-f907d97.json'), 'utf8'));
  assert.deepEqual(v3.batch_problems, []);
  assert.deepEqual(v3.items.map((x) => [x.id, x.result]), [['S1-slug', 'checklist'], ['S2-formatter', 'checklist'], ['S3-percent', 'checklist'], ['S4-parsebool', 'checklist'],
    ['S5-clock', 'checklist'], ['S6-money', 'checklist'], ['U1-userrepo', 'intended_refusal'], ['U2-roundto', 'not_refused']]);
});
