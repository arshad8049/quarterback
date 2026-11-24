'use strict';
// The results as public annotations (artifacts need a signed-in session).
const fs = require('fs'); const path = require('path');
const dir = process.argv[2];
const get = (f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch (e) { return null; } };
const note = (t, x) => console.log(`::notice title=${t}::${String(x).replace(/%/g, '%25').replace(/\r/g, '').replace(/\n/g, '%0A')}`);
const env = get('environment.json');
if (env) { const e = JSON.parse(env); const c = (n) => ((e.docker && e.docker.Components) || []).find((x) => x.Name === n)?.Version || null; note('kan96 environment', JSON.stringify({ ...e, docker: { engine: c('Engine'), containerd: c('containerd'), runc: c('runc'), init: c('docker-init') } })); } else note('kan96 environment', 'missing');
note('kan96 summary', get('summary.json') || 'missing (the batch did not finish)');
const rows = (get('iterations.jsonl') || '').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const short = (r) => `${r.i}:${r.stage ? r.stage.state : 'error'}/ex${r.stage ? r.stage.exit_code : '?'}/insp=${r.outcome.inspect_oom}/cg=${r.cgroup.oom_kill}(base ${r.cgroup.baseline ?? '?'})/ev=${r.outcome.docker_oom_event ? 1 : 0}/reads=${r.sample.reads ?? 0}/clean=${r.cleanup.complete}`;
for (let k = 0; k < rows.length; k += 25) note(`kan96 iterations ${k + 1}-${Math.min(k + 25, rows.length)}`, rows.slice(k, k + 25).map(short).join('\n'));
for (const r of rows.filter((x) => x.disagree).slice(0, 3)) note(`kan96 disagreement ${r.i}`, JSON.stringify(r).slice(0, 3500));
const agree = rows.find((x) => !x.disagree && x.cgroup.delta > 0); if (agree) note(`kan96 agreeing example ${agree.i}`, JSON.stringify(agree).slice(0, 3500));
