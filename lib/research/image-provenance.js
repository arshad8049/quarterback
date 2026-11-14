/**
 * lib/research/image-provenance.js — KAN-117 (review 10609): a retrievable, immutable record of the
 * three QB images (agent, tools, proxy) for reuse across jobs and arms.
 *
 *   - each base image is pulled and recorded by repo digest (a mutable tag alone is refused)
 *   - built-from proof: the base's RootFS layer chain is a prefix of the built image's chain
 *   - each built image is saved (`docker save`) and its tar is hashed; the image id is the
 *     content-addressed config digest, so a later `docker load` must reproduce the SAME id
 */

const SCHEMA = 'qb-kan117-image-provenance/1';
const DIGEST = /@sha256:[0-9a-f]{64}$/;
const ID = /^sha256:[0-9a-f]{64}$/;

function builtFrom(baseLayers, imageLayers) {
  if (!Array.isArray(baseLayers) || !baseLayers.length || !Array.isArray(imageLayers)) return false;
  return baseLayers.every((l, i) => imageLayers[i] === l);
}

/**
 * @param {object} o { qbCommit, claudeVersion, docker, bases:{name:{ref,digest,id,layers}},
 *   images:{name:{ref,id,layers,tar,tar_sha256,tar_bytes}}, dockerfiles:{name:sha256}, buildStages? }
 */
function provenanceRecord(o) {
  const bad = (m) => { throw new Error(`image provenance: ${m}`); };
  const images = {};
  for (const [name, im] of Object.entries(o.images || {})) {
    const base = (o.bases || {})[name];
    if (!base) bad(`${name}: no base recorded`);
    if (!DIGEST.test(base.digest || '')) bad(`${name}: base ${base.ref} has no repo digest (a mutable tag alone is not provenance)`);
    if (!ID.test(im.id || '')) bad(`${name}: image id`);
    if (!/^[0-9a-f]{64}$/.test(im.tar_sha256 || '')) bad(`${name}: saved tar sha256`);
    images[name] = { ref: im.ref, id: im.id, base_ref: base.ref, base_digest: base.digest, base_id: base.id,
      built_from_base: builtFrom(base.layers, im.layers), layers: (im.layers || []).length,
      tar: im.tar, tar_sha256: im.tar_sha256, tar_bytes: im.tar_bytes, dockerfile_sha256: (o.dockerfiles || {})[name] || null };
    if (!images[name].built_from_base) bad(`${name}: the base layer chain is not a prefix of the image (not built from the recorded base)`);
  }
  if (!Object.keys(images).length) bad('no images');
  return { schema: SCHEMA, qb_commit: o.qbCommit, claude_version: o.claudeVersion || null, docker: o.docker || null,
    images, build_stages: o.buildStages || {},
    retention: 'GitHub Actions artifact (public repository; retention-days 90). Rebuilding is NOT equivalent (apt/npm resolve at build time): reuse means docker load of these tars.' };
}

/** Problems with a loaded set ({name:{id,tar_sha256}}); empty = the same images. */
function verifyLoaded(prov, loaded) {
  const out = [];
  for (const [name, im] of Object.entries(prov.images)) {
    const l = loaded[name];
    if (!l) { out.push(`${name}: not loaded`); continue; }
    if (l.tar_sha256 !== im.tar_sha256) out.push(`${name}: tar sha256 ${l.tar_sha256} != recorded ${im.tar_sha256}`);
    if (l.id !== im.id) out.push(`${name}: loaded id ${l.id} != recorded ${im.id}`);
  }
  return out;
}

module.exports = { SCHEMA, builtFrom, provenanceRecord, verifyLoaded };
