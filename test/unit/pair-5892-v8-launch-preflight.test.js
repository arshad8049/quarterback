// KAN-114 10697: the v8 launch route preflight (offline). Two stages, each a pure check on a diff:
//   promote: fast-forward the authorized launch branch to the reviewed v8 commit; must NOT touch the request file
//            (so the push cannot queue a live run) and must not change protections/workflow beyond the reviewed set
//   launch:  one commit that changes ONLY the request file, mode=pair, citing the senior's go-ahead
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const P = require(path.join(ROOT, 'bench/opus-pilot/launch-preflight.js'));
const REQ = 'bench/opus-pilot/mocha/pair-live-request.txt';

test('promote: a fast-forward that does not touch the request file passes', () => {
  const r = P.promoteProblems({ fastForward: true, changed: ['lib/pilot/pair.js', 'bench/opus-pilot/pair.mjs'] });
  assert.deepEqual(r, []);
});

test('promote: touching the request file, a non-fast-forward, or an empty diff is refused', () => {
  assert.match(P.promoteProblems({ fastForward: true, changed: ['lib/pilot/pair.js', REQ] }).join(' '), /request file/);
  assert.match(P.promoteProblems({ fastForward: false, changed: ['lib/pilot/pair.js'] }).join(' '), /fast-forward/);
  assert.match(P.promoteProblems({ fastForward: true, changed: [] }).join(' '), /nothing to promote/);
});

test('promote: changing the live workflow is refused unless it equals the frozen v8 hash', () => {
  const wf = '.github/workflows/pair-5892-live.yml';
  assert.match(P.promoteProblems({ fastForward: true, changed: [wf], workflowMatchesFreeze: false }).join(' '), /live workflow/);
  assert.deepEqual(P.promoteProblems({ fastForward: true, changed: [wf], workflowMatchesFreeze: true }), []);
});

test('launch: exactly the request file, mode=pair, citing an approval comment id', () => {
  assert.deepEqual(P.launchProblems({ changed: [REQ], request: 'mode=pair\n# KAN-112 10699: ONE v8 engineering pair\n' }), []);
  assert.match(P.launchProblems({ changed: [REQ, 'lib/pilot/pair.js'], request: 'mode=pair\n# 10699\n' }).join(' '), /only the request file/);
  assert.match(P.launchProblems({ changed: [REQ], request: 'mode=smoke\n# 10699\n' }).join(' '), /mode=pair/);
  assert.match(P.launchProblems({ changed: [REQ], request: 'mode=pair\n# no approval\n' }).join(' '), /approval comment id/);
});

test('freeze: v8 has zero drift in this checkout and the driver and live workflow are the frozen ones', () => {
  const f = P.freezeCheck(ROOT);
  assert.equal(f.version, 'pair-5892-freeze-v8');
  assert.deepEqual(f.drift, []);
  assert.equal(f.files, 53);
  assert.equal(f.driver_uses_v8, true);
  assert.equal(f.live_workflow_frozen, true);
  assert.equal(f.same_as_v7.shared && f.same_as_v7.arm_a && f.same_as_v7.arm_b, true);
});
