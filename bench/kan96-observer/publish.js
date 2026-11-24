'use strict';
const fs = require('fs'); const path = require('path'); const dir = process.argv[2];
const get = (f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return null; } };
const note = (t, x) => console.log(`::notice title=${t}::${String(x).replace(/%/g, '%25').replace(/\r/g, '').replace(/\n/g, '%0A')}`);
note('kan96o environment', (get('environment.json') || 'missing').replace(/\n\s*/g, ' '));
const sum = get('summary.json'); note('kan96o summary', sum ? JSON.stringify(JSON.parse(sum)) : 'missing (the batch did not finish)');
const rows = (get('iterations.jsonl') || '').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const step = (r) => ((r.observer && r.observer.steps) || []).map((s) => s.join('@')).join(' ');
const short = (r) => `${r.i} ${r.case} armed=${r.armed ? 1 : 0} last=${r.observer ? r.observer.last : '?'} final=${r.observer && r.observer.final ? 1 : 0} insp=${r.inspect ? r.inspect.OOMKilled : '?'}/ex${r.inspect ? r.inspect.ExitCode : '?'} out="${(r.stdout || '').replace(/\n/g, '|')}" => ${r.decision ? `${r.decision.state}/${r.decision.oom_signal}` : `error ${r.error}`} why=${(r.observer && r.observer.unavailable) || '-'} act=${r.observer ? r.observer.observer_active_ms : '?'} clean=${r.cleanup.complete ? 1 : 0} [${step(r)}]`;
// the annotation list is limited per step: all rows in few notices, plus the full rows that need a look
for (let k = 0; k < rows.length; k += 10) note(`kan96o rows ${k + 1}-${Math.min(k + 10, rows.length)}`, rows.slice(k, k + 10).map(short).join('\n'));
