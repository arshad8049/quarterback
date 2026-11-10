/**
 * KAN-111 review 10561 (correction 1): the installed environment must equal the reviewed lock, judged from the
 * installed distributions' metadata (importlib.metadata), not from `pip freeze` text. swebench is installed from
 * a LOCAL wheel (the disclosed source-build exception), which pip records as a direct reference
 * (direct_url.json; `pip freeze` shows `swebench @ file:///…whl`), so a `name==version` freeze parse loses it.
 * These tests build fake site-packages directories of .dist-info folders: nothing is installed, no network.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CHECK = path.join(__dirname, '..', '..', 'bench', 'public', 'grader', 'immutable-offline-v1', 'installed-set-check.py');
const H = (c) => c.repeat(64);
const WHEEL = 'swebench-5.0.2-py3-none-any.whl';
const LOCKED = [['swebench', '5.0.2', H('a')], ['setuptools', '75.6.0', H('b')], ['charset_normalizer', '3.5.2', H('c')], ['PyYAML', '6.0.3', H('d')]];

function site({ dists = LOCKED.map(([n, v]) => [n, v]), direct = { swebench: { url: `file:///w/built/${WHEEL}`, archive_info: { hashes: { sha256: H('e') } } } }, extra = [] } = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kan111-site-'));
  const sp = path.join(d, 'site'); fs.mkdirSync(sp);
  for (const [n, v] of [...dists, ...extra]) {
    const di = path.join(sp, `${n.replace(/-/g, '_')}-${v}.dist-info`); fs.mkdirSync(di, { recursive: true });
    fs.writeFileSync(path.join(di, 'METADATA'), `Metadata-Version: 2.1\nName: ${n}\nVersion: ${v}\n`);
    if (direct[n]) fs.writeFileSync(path.join(di, 'direct_url.json'), JSON.stringify(direct[n]));
  }
  fs.writeFileSync(path.join(d, 'requirements.lock'), '# lock\n' + LOCKED.map(([n, v, h]) => `# source: x\n${n}==${v} --hash=sha256:${h}`).join('\n') + '\n');
  fs.writeFileSync(path.join(d, 'rebuilt.sha256'), `${H('e')}  ${WHEEL}\n`);
  return d;
}
const check = (d) => spawnSync('python3', ['-I', CHECK, path.join(d, 'requirements.lock'), path.join(d, 'rebuilt.sha256'), `--path=${path.join(d, 'site')}`], { encoding: 'utf8' });
const done = (d) => fs.rmSync(d, { recursive: true, force: true });

describe('KAN-111 installed-set-check.py (installed metadata, not pip freeze)', () => {
  test('swebench installed from a local wheel (direct reference) is matched by name and version; provenance is reported', () => {
    const d = site(); const r = check(d);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const rep = JSON.parse(r.stdout);
    assert.equal(rep.installed_equals_lock, true); assert.equal(rep.distributions, LOCKED.length);
    assert.equal(rep.swebench.version, '5.0.2'); assert.equal(rep.swebench.direct_url, `file:///w/built/${WHEEL}`);
    assert.equal(rep.swebench.direct_url_sha256, H('e')); assert.equal(rep.swebench.rebuilt_wheel_sha256, H('e'));
    done(d);
  });
  test('names are compared normalised (PyYAML/pyyaml, charset_normalizer/charset-normalizer)', () => {
    const d = site({ dists: [['swebench', '5.0.2'], ['setuptools', '75.6.0'], ['charset-normalizer', '3.5.2'], ['pyyaml', '6.0.3']] });
    assert.equal(check(d).status, 0); done(d);
  });
  for (const [why, opts] of [
    ['a version differs', { dists: [['swebench', '5.0.2'], ['setuptools', '75.6.0'], ['charset_normalizer', '9.9.9'], ['PyYAML', '6.0.3']] }],
    ['a locked distribution is missing', { dists: [['swebench', '5.0.2'], ['setuptools', '75.6.0'], ['PyYAML', '6.0.3']] }],
    ['an unlocked distribution is installed', { extra: [['requests', '2.0.0']] }],
    ['swebench was not installed from the local rebuilt wheel (no direct_url.json)', { direct: {} }],
    ['swebench direct reference is not the rebuilt wheel file', { direct: { swebench: { url: 'https://example.invalid/swebench-5.0.2-py3-none-any.whl' } } }],
    ['the recorded wheel hash differs from the rebuilt wheel', { direct: { swebench: { url: `file:///w/built/${WHEEL}`, archive_info: { hashes: { sha256: H('f') } } } } }],
    ['a locked PyPI distribution was installed by direct reference', { direct: { swebench: { url: `file:///w/built/${WHEEL}` }, setuptools: { url: 'file:///tmp/setuptools.whl' } } }],
    ['the same distribution is installed twice', { extra: [['PyYAML', '5.0.0']] }],
  ]) {
    test(`fails closed when ${why}`, () => { const d = site(opts); const r = check(d); assert.notEqual(r.status, 0, r.stdout); done(d); });
  }
});
