// KAN-117 10650: the text-free contract overlay rebuilds the EXACT contract or refuses. Toy data only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const O = require('../../lib/research/contract-overlay');
const PS = 'Header value is not lower-cased.\nPlease make it case-insensitive.\n';
const C = { id: 'c', raw_request: PS.trim(), requirements: [{ id: 'R-1', quote: 'Header value is not lower-cased.' }, { id: 'R-2', quote: 'Please make it case-insensitive.' }, { id: 'R-3', implied: true, text: 'x', reason: 'y' }], goal: 'g' };
const sha = (c) => crypto.createHash('sha256').update(`${JSON.stringify(c, null, 2)}\n`).digest('hex');

test('the overlay holds no task text and rebuilds the exact contract (sha256 equal)', () => {
  const ov = O.makeOverlay(C, PS);
  const s = JSON.stringify(ov);
  assert.ok(!s.includes('lower-cased') && !s.includes('case-insensitive'));
  assert.deepEqual(O.rebuildContract(ov, PS, sha(C)).contract, C);
});
test('the rebuild refuses a different task text, a tampered overlay or the wrong frozen hash', () => {
  const ov = O.makeOverlay(C, PS);
  assert.throws(() => O.rebuildContract(ov, PS.replace('Header', 'Heaver'), sha(C)), /overlay: rebuilt contract sha256/);
  assert.throws(() => O.rebuildContract({ ...ov, goal: 'G' }, PS, sha(C)), /overlay/);
  assert.throws(() => O.rebuildContract(ov, PS, 'f'.repeat(64)), /overlay/);
  assert.throws(() => O.makeOverlay({ ...C, requirements: [{ id: 'R-9', quote: 'not in the text' }] }, PS), /quote not in the task text/);
});
