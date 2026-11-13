/**
 * KAN-113 review 10600 §5: the fake/qualification-only paths can never satisfy a live approval.
 * No Docker, no model, no credentials.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const P = require('../../lib/sandbox/agent-profile');
const { runAgentSandboxed } = require('../../agent/runner');
const FAKE = path.join(ROOT, 'bench', 'opus-pilot', 'host', 'fake-cli', 'fake-claude.sh');
const profile = (route = 'test-only-route') => ({ ...P.profileFromConfig(P.loadReviewed()), auth_route: route });
const fakeStream = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kan113sep-'));
  const r = spawnSync('sh', [FAKE, '-p', ...P.buildAgentArgs(profile())], { cwd: d, input: 'x\n', encoding: 'utf8' }); fs.rmSync(d, { recursive: true, force: true }); return r.stdout; };

describe('KAN-113 10600: fake output can never be live evidence', () => {
  test('a synthetic (fake-CLI) stream is a policy violation by default', () => {
    const c = P.classifyAttempt({ stdout: fakeStream() }, profile());
    assert.equal(c.outcome, 'policy_violation'); assert.match(c.reasons.join(' '), /synthetic/);
  });
  test('only an explicit qualification flag accepts it, and then only as plumbing', () => {
    const c = P.classifyAttempt({ stdout: fakeStream() }, profile(), { allowSynthetic: true });
    assert.equal(c.outcome, 'verified'); assert.equal(c.synthetic, true);
  });
  test('one synthetic line mixed into an otherwise real-looking stream is still a violation', () => {
    const lines = fakeStream().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const mixed = lines.map((e, i) => { if (i > 0) delete e.qb_fake_cli; return JSON.stringify(e); }).join('\n') + '\n';
    assert.equal(P.classifyAttempt({ stdout: mixed }, profile()).outcome, 'policy_violation');
  });
});

describe('KAN-113 10600: qualification-only options are refused on the live path', () => {
  const blockedRun = async (opts) => { let called = false;
    const r = await runAgentSandboxed('t', '/r', { agentProfile: profile(), approvedAuthRoutes: ['test-only-route'], runSandboxed: async () => { called = true; return { status: 'blocked', sandbox: null }; }, ...opts });
    return { r, called }; };
  for (const opt of [{ noCredentials: true }, { qualificationOnly: true }, { allowSynthetic: true }]) {
    test(`runAgentSandboxed refuses ${Object.keys(opt)[0]} with a pilot profile, before any sandbox`, async () => {
      const { r, called } = await blockedRun(opt);
      assert.equal(r.pilot_outcome, 'preflight_refused'); assert.equal(called, false); assert.match(r.error, /qualification-only/);
    });
  }
  test('checkProfile refuses a fake or qualification auth route even if someone lists it as approved', () => {
    for (const route of ['qualification-fake-cli', 'fake', 'Qualification']) {
      const errs = P.checkProfile(profile(route), { imagePin: '2.1.322', approved: [route] });
      assert.ok(errs.some((e) => /qualification-only|fake/.test(e)), `${route}: ${errs}`);
    }
  });
  test('a pilot run refuses an overridden agent image (QB_SANDBOX_AGENT_IMAGE), so the fake image cannot be used live', () => {
    const r = spawnSync(process.execPath, ['-e', `
      process.env.QB_SANDBOX_AGENT_IMAGE = 'qb-kan113-fake-cli:qualify';
      const { runAgentSandboxed } = require(${JSON.stringify(path.join(ROOT, 'agent', 'runner.js'))});
      const P = require(${JSON.stringify(path.join(ROOT, 'lib', 'sandbox', 'agent-profile.js'))});
      runAgentSandboxed('t', '/r', { agentProfile: { ...P.profileFromConfig(P.loadReviewed()), auth_route: 'r' }, approvedAuthRoutes: ['r'],
        runSandboxed: async () => { console.log('SANDBOX_CALLED'); return { status: 'blocked', sandbox: null }; } })
        .then((x) => console.log(JSON.stringify({ o: x.pilot_outcome, e: x.error })));`], { encoding: 'utf8' });
    assert.doesNotMatch(r.stdout, /SANDBOX_CALLED/); assert.match(r.stdout, /preflight_refused/); assert.match(r.stdout, /agent image/);
  });
  test('the pipeline refuses noCredentials unless qualificationOnly is also set', () => {
    const src = fs.readFileSync(path.join(ROOT, 'lib', 'sandbox', 'pipeline.js'), 'utf8');
    assert.match(src, /o\.noCredentials === true && o\.qualificationOnly !== true/);
  });
  test('the live entry point never forwards qualification options to the sandbox', async () => {
    let seen; await runAgentSandboxed('t', '/r', { runSandboxed: async (o) => { seen = o; return { status: 'blocked', sandbox: null }; } });
    for (const k of ['noCredentials', 'qualificationOnly', 'allowSynthetic']) assert.equal(seen[k], undefined, k);
  });
});
