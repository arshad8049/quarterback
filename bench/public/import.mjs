#!/usr/bin/env node
// KAN-110 importer. Usage (from bench/):  node public/import.mjs
//
// 1. Verifies every pinned raw file in public/raw/<dataset>@<revision>/ against sources.json (SHA-256).
//    Missing raw files are downloaded from the pinned revision first (--download) and verified.
// 2. Reads the used files, keeps JavaScript/TypeScript rows, and splits each row into four stores
//    with field-policy.mjs (allowlist; unknown columns are quarantined).
// 3. Builds the agent packet from agent fields only, after leak redaction (leak.mjs).
// 4. Writes public/out/{agent,controller,vault,quarantine}/<source>.jsonl (gitignored: raw task
//    content is not republished) and public/manifest/import-summary.json (committed: counts only).
// No model calls, no network except the optional pinned download.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parquetReadObjects } from 'hyparquet';
import { POLICY, partition } from './field-policy.mjs';
import { answerIds, redact, goldOverlap } from './leak.mjs';
import { opaqueId, parseCsv } from './util.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RAW = path.join(HERE, 'raw');
const OUT = path.join(HERE, 'out');
const MANIFEST = path.join(HERE, 'manifest');
const SOURCES = JSON.parse(fs.readFileSync(path.join(HERE, 'sources.json'), 'utf8'));
const download = process.argv.includes('--download');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function rawPath(s, f) { return path.join(RAW, `${s.hf_dataset.replace('/', '_')}@${s.revision}`, f.path); }

async function ensure(s, f) {
  const p = rawPath(s, f);
  if (!fs.existsSync(p)) {
    if (!download) throw new Error(`missing ${p}; run with --download to fetch the pinned revision`);
    const url = `https://huggingface.co/datasets/${s.hf_dataset}/resolve/${s.revision}/${f.path}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download ${url}: HTTP ${res.status}`);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.from(await res.arrayBuffer()));
  }
  const buf = fs.readFileSync(p);
  const got = sha256(buf);
  if (got !== f.sha256 || buf.length !== f.bytes) throw new Error(`hash mismatch for ${s.hf_dataset}@${s.revision}/${f.path}: ${got} (${buf.length} bytes)`);
  return buf;
}

async function readRows(s, f, buf) {
  if (f.format === 'csv') return parseCsv(buf.toString('utf8'));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
  return parquetReadObjects({ file: ab });
}

function language(s, row) {
  const flt = s.js_filter;
  if (Array.isArray(flt.values)) return flt.values.includes(row[flt.field]) ? String(row[flt.field]).toLowerCase().replace('javascript', 'js').replace('typescript', 'ts') : null;
  return flt.values[row[flt.field]] || null;
}

const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
const norm = (v) => (typeof v === 'bigint' ? Number(v) : v);

export async function run() {
  const summary = { schema: 'qb-public-import-summary/1', generated_by: 'bench/public/import.mjs', sources: {} };
  for (const store of ['agent', 'controller', 'vault', 'quarantine']) fs.mkdirSync(path.join(OUT, store), { recursive: true });
  fs.mkdirSync(MANIFEST, { recursive: true });

  for (const s of SOURCES.sources) {
    const verified = [];
    let rows = null;
    for (const f of s.files) {
      const buf = await ensure(s, f);
      verified.push({ path: f.path, sha256: f.sha256, use: !!f.use });
      if (f.use) {
        rows = (await readRows(s, f, buf)).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, norm(v)])));
        if (f.rows != null && rows.length !== f.rows) throw new Error(`${s.source}: ${rows.length} rows, expected ${f.rows}`);
      }
    }
    const columns = Object.keys(rows[0] || {});
    const policyCols = Object.keys(POLICY[s.source]);
    const byLang = {}; const stores = { agent: [], controller: [], vault: [], quarantine: [] };
    const red = {}; let redactedTasks = 0; const overlap = { tasks_with_any: 0, tasks: 0 }; const unknown = new Set();
    const ids = new Set();

    for (const row of rows) {
      const lang = language(s, row);
      byLang[lang || 'other'] = (byLang[lang || 'other'] || 0) + 1;
      if (!lang) continue;
      const part = partition(s.source, row);
      part.unknown.forEach((u) => unknown.add(u));
      const task_id = opaqueId(s.source, row.instance_id);
      if (ids.has(task_id)) throw new Error(`opaque ID collision in ${s.source}`);
      ids.add(task_id);
      const aid = answerIds(s.source, { ...part.controller, pull_number: row.pull_number });
      const agent = { task_id };
      const taskRed = [];
      for (const [k, v] of Object.entries(part.agent)) {
        const r = redact(v, aid); agent[k] = r.text; taskRed.push(...r.redactions);
      }
      taskRed.forEach((r) => { red[r.kind] = (red[r.kind] || 0) + 1; });
      if (taskRed.length) redactedTasks++;
      const ov = goldOverlap(Object.values(agent).join('\n'), row.patch);
      overlap.tasks++; if (ov.found > 0) overlap.tasks_with_any++;

      stores.agent.push(agent);
      stores.controller.push({ ...part.controller, task_id, source: s.source, hf_dataset: s.hf_dataset, revision: s.revision, language: lang, language_upstream: part.controller.language ?? part.controller.repo_language ?? null,
        agent_redactions: taskRed.map((r) => r.kind), gold_overlap: ov });
      stores.vault.push({ task_id, source: s.source, ...part.vault });
      stores.quarantine.push({ task_id, source: s.source, ...part.quarantine });
    }
    for (const [store, list] of Object.entries(stores)) fs.writeFileSync(path.join(OUT, store, `${s.source}.jsonl`), jsonl(list));

    summary.sources[s.source] = {
      hf_dataset: s.hf_dataset, revision: s.revision, files_verified: verified,
      rows_total: rows.length, rows_by_language: byLang, js_ts_candidates: stores.agent.length,
      columns_seen: columns,
      columns_missing_from_policy: columns.filter((c) => !policyCols.includes(c)),
      policy_columns_absent_in_data: policyCols.filter((c) => !columns.includes(c)),
      unknown_columns_quarantined: [...unknown],
      agent_fields: [...new Set(stores.agent.flatMap((a) => Object.keys(a)))],
      redactions: { tasks_with_redactions: redactedTasks, by_kind: red },
      gold_overlap_report: overlap,
    };
  }
  fs.writeFileSync(path.join(MANIFEST, 'import-summary.json'), JSON.stringify(summary, null, 2) + '\n');
  return summary;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const s = await run();
  for (const [k, v] of Object.entries(s.sources)) console.log(k, 'rows', v.rows_total, 'js/ts', v.js_ts_candidates, JSON.stringify(v.rows_by_language), 'redacted tasks', v.redactions.tasks_with_redactions, JSON.stringify(v.redactions.by_kind), 'gold overlap', JSON.stringify(v.gold_overlap_report), 'missing-from-policy', JSON.stringify(v.columns_missing_from_policy), 'absent', JSON.stringify(v.policy_columns_absent_in_data));
}
