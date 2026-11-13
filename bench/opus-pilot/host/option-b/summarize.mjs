// Summarise the Option B wiring test: what the action passed to the CLI, and where the synthetic dummy value
// appears on disk afterwards (paths only, never contents). Writes option-b-report.json.
import fs from 'node:fs'; import path from 'node:path';
const [outFile, dummy, actionOutcome, ...roots] = process.argv.slice(2);
const dir = path.join(process.env.RUNNER_TEMP || '/tmp', 'kan113-option-b');
const calls = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^call-\d+\.json$/.test(f)).sort().map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))) : [];
const hits = [];
const walk = (d, depth = 0) => { if (depth > 6) return; let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const e of es) { const a = path.join(d, e.name); if (e.isSymbolicLink()) continue; if (e.isDirectory()) { if (!['node_modules', '.git'].includes(e.name)) walk(a, depth + 1); }
    else { try { const st = fs.statSync(a); if (st.size < 5e6 && fs.readFileSync(a).includes(dummy)) hits.push(a); } catch {} } } };
if (dummy) for (const r of roots) walk(r);
const rep = { action_step_outcome: actionOutcome, cli_calls: calls.length, calls, dummy_found_in_files: hits.map((h) => h.replace(process.env.HOME || '~', '~')),
  version_probe_calls: fs.existsSync(path.join(dir, 'calls.txt')) ? fs.readFileSync(path.join(dir, 'calls.txt'), 'utf8').split('\n').filter(Boolean).length : 0 };
fs.writeFileSync(outFile, JSON.stringify(rep, null, 2) + '\n'); console.log(JSON.stringify({ cli_calls: rep.cli_calls, dummy_found_in_files: rep.dummy_found_in_files.length }));
