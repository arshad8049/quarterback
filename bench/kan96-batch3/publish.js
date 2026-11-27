'use strict';
// KAN-96 batch 3: annotations readable without a token (environment, summary, every row).
const fs = require('fs'); const path = require('path'); const dir = process.argv[2];
const get = (f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return null; } };
const note = (t, x) => console.log(`::notice title=${t}::${String(x).replace(/%/g, '%25').replace(/\r/g, '').replace(/\n/g, '%0A')}`);
const env = get('environment.json'); note('kan96b3 environment', env ? JSON.stringify({ ...JSON.parse(env), config: undefined }) : 'missing');
const sum = get('summary.json'); note('kan96b3 summary', sum ? JSON.stringify(JSON.parse(sum)) : 'missing (the batch did not finish)');
const rows = (get('iterations.jsonl') || '').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const steps = (r) => ((r.ev && r.ev.steps) || []).map((s) => s.join('@')).join(' ');
const short = (r) => `${r.i} ${r.case} gate=${r.ev ? r.ev.gate : '?'} obs=${r.ev ? r.ev.observer : '?'} base=${r.ev ? r.ev.baseline : '?'} last=${r.ev ? r.ev.last : '?'} final=${r.ev && r.ev.final ? 1 : 0} rr=${r.ev ? r.ev.rereads : '?'} insp=${r.oom_killed}/ex${r.exit_code} out="${(r.stdout || '').slice(0, 70).replace(/\n/g, '|')}"${r.stdin_exact !== undefined ? ` stdin=${r.stdin_exact ? 1 : 0}` : ''} => ${r.state}/${r.oom_signal} why=${r.oom_unavailable || '-'} gms=${r.ev ? r.ev.gate_ms : '?'} act=${r.ev ? r.ev.observer_active_ms : '?'} wall=${r.wall_ms} clean=${r.cleanup.complete ? 1 : 0}/o${r.cleanup.observers_live}/g${r.cleanup.gates_live}${r.error ? ` ERROR ${r.error.slice(0, 200)}` : ''} [${steps(r)}]`;
for (let k = 0; k < rows.length; k += 10) note(`kan96b3 rows ${k + 1}-${Math.min(k + 10, rows.length)}`, rows.slice(k, k + 10).map(short).join('\n'));
