/**
 * KAN-106, senior decision 10719 (on 10713 / 613e0d1): one prompt correction before the smoke.
 *
 * system.md said "An expectation the shown code cannot produce is wrong". With the base (buggy)
 * source in the excerpts that treats today's behaviour as the desired behaviour: the requested
 * fix (empty / whitespace strings throw) is exactly what the base code cannot produce yet.
 * The corrected rule: the user's request decides NEW behaviour; the working-tree source grounds the
 * API shape and the behaviour the request explicitly keeps. A requested change is never rejected or
 * weakened because the base cannot produce it. No model calls: the model is faked.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { mockFetch, ollamaReply } = require('../helpers/mocks');

const FIX = path.join(__dirname, '..', 'fixtures', 'kan106');
const read = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');
const REQUEST = read('request.txt').trim();
const THROWS = read('pinned-api-throws.json');
const PINNED = read('pinned-fast-json-stringify/serializer-07d7196.js');
const GUARD = "    // reject blank strings, which Number() would coerce to 0\n    if (typeof i === 'string' && i.trim() === '') {\n      throw new Error(`The value \"${i}\" cannot be converted to a number.`)\n    }\n";
const BASE = PINNED.replace(GUARD, '');
const SYSTEM = fs.readFileSync(path.join(__dirname, '..', '..', 'intent', 'prompts', 'system.md'), 'utf8');

async function produce(replies, src) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kan106-10719-'));
  const files = { 'package.json': '{"name":"pinned","type":"commonjs"}', 'lib/serializer.js': src, 'test/asNumber.test.js': "'use strict'\n" };
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  let i = 0;
  const m = mockFetch(async () => ollamaReply(replies[Math.min(i++, replies.length - 1)]));
  try {
    const s = await require('../../intent/session').compileIntent(REQUEST, { repoPath: dir });
    return { s, calls: m.calls.length, prompts: m.calls.map((c) => JSON.parse(c.init.body).messages.at(-1).content) };
  } finally { m.restore(); fs.rmSync(dir, { recursive: true, force: true }); }
}

describe('10719: the request decides NEW behaviour; the source grounds API shape and preserved behaviour', () => {
  test('the prompt no longer says an expectation the shown code cannot produce is wrong', () => {
    assert.doesNotMatch(SYSTEM, /cannot produce is wrong/);
  });
  test('the prompt states the distinction: requested changes are new behaviour, the source grounds API shape and preserved behaviour', () => {
    assert.match(SYSTEM, /request decides NEW behaviour/);
    assert.match(SYSTEM, /never reject or weaken a requested change because the shown code does not do it yet/i);
    assert.match(SYSTEM, /excerpts ground the API shape .* and the behaviour the request keeps unchanged/);
  });
  test('the general prompt still carries no task values', () => {
    assert.doesNotMatch(SYSTEM, /asNumber|cannot be converted|Serializer/);
  });
  test('through the producer: on the BASE source (no guard yet), the requested throw checks are accepted, not refused', async () => {
    const { s, calls, prompts } = await produce([THROWS], BASE);
    assert.ok(!prompts[0].includes("i.trim() === ''"), 'the model sees the base code, which cannot throw for a blank string yet');
    assert.equal(s.state, 'finalized', (s.errors || []).join('\n'));
    assert.equal(calls, 1);
  });
});
