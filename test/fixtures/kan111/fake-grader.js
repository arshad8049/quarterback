#!/usr/bin/env node
// Test-only stand-in for grade_report.py: writes grade.json per the scenario. Argv: <script> <instance> <log> <required> <out> <mode>
const fs = require('fs'); const path = require('path');
const sc = JSON.parse(fs.readFileSync(process.env.FAKE_DOCKER_SCENARIO, 'utf8'));
const [, , , , out, mode] = process.argv.slice(1); // [script, instance, log, required, out, mode]
const label = path.basename(path.dirname(out)).replace(/^\d+-/, '').replace(/-\d+$/, '');
const g = (sc.grade && (sc.grade[label] || sc.grade.default)) || { exit: 0, accepted: true };
if (g.exit) { process.stderr.write('fake grader crash'); process.exit(g.exit); }
fs.writeFileSync(out, JSON.stringify(g.raw !== undefined ? g.raw : { official: { log_gate: 'ok', resolution: mode === 'empty' ? 'RESOLVED_NO' : 'RESOLVED_FULL' }, acceptance: { mode, accepted: g.accepted, reasons: g.accepted ? [] : ['fixture: not accepted'] } }));
process.stdout.write(JSON.stringify({ accepted: g.accepted }));
