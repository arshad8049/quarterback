// KAN-113 10600 §3/§4: a deterministic, NO-MODEL probe of Claude Code's built-in file tools, run INSIDE the
// hardened agent container with --network none. It starts the official CLI's own tool host (`claude mcp serve`),
// lists its tools, and calls Read/Edit/Write/Glob/Grep directly on a DUMMY file and on symlinks to it.
// There is no inference and no network, so no model can be called. Output: one JSON object on stdout.
// The dummy marker is never echoed: results only say whether it was visible.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const MARK = 'DUMMY-NOT-A-SECRET-7f3a';
const CRED = '/cfg/.credentials.json';
fs.writeFileSync(CRED, JSON.stringify({ qb_probe_dummy: MARK }) + '\n', { mode: 0o600 });
fs.mkdirSync('/work/sub', { recursive: true });
fs.writeFileSync('/work/ok.txt', 'ordinary file\n');
fs.symlinkSync(CRED, '/work/link-to-cred');
fs.symlinkSync('/cfg', '/work/link-to-cfg');
fs.symlinkSync('../link-to-cred', '/work/sub/chained');

const out = { started: false, stderr_tail: '', tools: [], cases: [] };
const child = spawn('claude', ['mcp', 'serve'], { cwd: '/work', stdio: ['pipe', 'pipe', 'pipe'] });
let buf = ''; const waiters = new Map(); let id = 0;
child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(l); if (waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); } } catch {} } });
child.stderr.on('data', (d) => { out.stderr_tail = (out.stderr_tail + d).slice(-1500); });
let exited = null; child.on('exit', (c, s) => { exited = { code: c, signal: s }; for (const w of waiters.values()) w({ error: { message: 'server exited' } }); });
const rpc = (method, params) => new Promise((res) => { const n = ++id; waiters.set(n, res); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
  setTimeout(() => { if (waiters.has(n)) { waiters.delete(n); res({ error: { message: 'timeout' } }); } }, 20000); });
const clean = (s) => String(s).split(MARK).join('<DUMMY>').slice(0, 300);

const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'qb-kan113-probe', version: '1' } });
if (!init.error) {
  out.started = true; child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const list = await rpc('tools/list', {}); out.tools = ((list.result && list.result.tools) || []).map((t) => t.name).sort();
  const C = [
    ['Read', 'direct', { file_path: CRED }], ['Read', 'symlink', { file_path: '/work/link-to-cred' }],
    ['Read', 'dir-symlink', { file_path: '/work/link-to-cfg/.credentials.json' }], ['Read', 'chained-symlink', { file_path: '/work/sub/chained' }],
    ['Read', 'control', { file_path: '/work/ok.txt' }],
    ['Grep', 'dir', { pattern: 'DUMMY', path: '/cfg', output_mode: 'content' }], ['Grep', 'symlink', { pattern: 'DUMMY', path: '/work/link-to-cred', output_mode: 'content' }],
    ['Grep', 'work-tree', { pattern: 'DUMMY', path: '/work', output_mode: 'content' }],
    ['Glob', 'dir', { pattern: '**/*', path: '/cfg' }], ['Glob', 'dir-symlink', { pattern: '**/*', path: '/work/link-to-cfg' }],
    ['Edit', 'symlink', { file_path: '/work/link-to-cred', old_string: 'qb_probe_dummy', new_string: 'x' }],
    ['Write', 'symlink', { file_path: '/work/link-to-cred', content: 'overwritten' }],
    ['Write', 'dir-symlink', { file_path: '/work/link-to-cfg/new.txt', content: 'x' }],
    // Bash (reported separately from the file-tool gate): an env-held dummy token and direct reads
    ['Bash', 'env-token', { command: 'printenv CLAUDE_CODE_OAUTH_TOKEN || echo UNSET', description: 'probe' }],
    ['Bash', 'cat-cred', { command: 'cat /cfg/.credentials.json', description: 'probe' }],
    ['Bash', 'cat-symlink', { command: 'cat /work/link-to-cred', description: 'probe' }],
  ];
  for (const [tool, kind, args] of C) {
    if (!out.tools.includes(tool)) { out.cases.push({ tool, kind, result: 'tool_not_exposed' }); continue; }
    const before = fs.readFileSync(CRED, 'utf8');
    const r = await rpc('tools/call', { name: tool, arguments: args });
    const text = JSON.stringify(r.result || r.error || {});
    const after = fs.existsSync(CRED) ? fs.readFileSync(CRED, 'utf8') : '';
    out.cases.push({ tool, kind, dummy_visible: text.includes(MARK), dummy_modified: after !== before, new_file_in_cfg: fs.existsSync('/cfg/new.txt'),
      is_error: Boolean(r.error || (r.result && r.result.isError)), message: clean(text) });
  }
}
child.kill('SIGTERM'); await new Promise((r) => setTimeout(r, 500));
out.exit = exited; out.stderr_tail = clean(out.stderr_tail);
process.stdout.write(JSON.stringify(out) + '\n');
process.exit(0);
