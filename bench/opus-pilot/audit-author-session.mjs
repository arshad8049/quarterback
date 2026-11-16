#!/usr/bin/env node
// KAN-117 (senior, after 10644): audit a clean-author Claude Code session from its OWN transcript, offline.
// Reviews every tool call's input AND output (not just tool names), and what the session had available at start
// (connectors/MCP tools, inherited instructions, memory, skills, hooks). Flags: access outside the packet folder,
// any network command, any use of web or connector tools, and any excluded-material marker in a command or an output.
// If something cannot be established (an output missing or truncated), that is reported, not assumed clean.
//   node bench/opus-pilot/audit-author-session.mjs <transcript.jsonl> <packet dir> [--detail=<file outside the repo>]
import fs from 'node:fs';
import crypto from 'node:crypto';

const [file, packet] = process.argv.slice(2);
const detailArg = process.argv.find((a) => a.startsWith('--detail='));
if (!file || !packet) { console.error('usage: audit-author-session.mjs <transcript.jsonl> <packet dir> [--detail=<file>]'); process.exit(2); }
const raw = fs.readFileSync(file);
const PK = packet.replace(/\/$/, '');
const ownScratch = /^\/private\/tmp\/claude-\d+\/[^/]*qb-contract-packet[^/]*\//;
const EXCLUDED = [/quaterback/i, /bench\/public/, /\bvault\b/i, /\bgold(\s+patch)?\b/i, /test_patch/, /FAIL_TO_PASS|PASS_TO_PASS/, /\.claude\/projects/, /swe-?bench/i, /huggingface/i, /atlassian|jira/i];
const NETWORK = /\b(curl|wget|git\s+(fetch|clone|pull|ls-remote)|npm\s+(i|install|ci)|npx\s|pip\s+install|nc\s|ssh\s)\b|https?:\/\//;

const lines = raw.toString('utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const models = new Set(); const modes = new Set(); const cwds = new Set();
const calls = new Map(); const results = new Map(); const attachText = [];
for (const e of lines) {
  if (e.permissionMode) modes.add(e.permissionMode);
  if (e.cwd) cwds.add(e.cwd);
  const m = e.message || {};
  if (m.model) models.add(m.model);
  if (e.type === 'attachment') attachText.push(JSON.stringify(e).slice(0, 200000));
  const content = Array.isArray(m.content) ? m.content : [];
  for (const c of content) {
    if (c.type === 'tool_use') calls.set(c.id, { name: c.name, input: c.input || {} });
    if (c.type === 'tool_result') results.set(c.tool_use_id, { text: typeof c.content === 'string' ? c.content : JSON.stringify(c.content), is_error: !!c.is_error });
  }
}
const attach = attachText.join('\n');
const available = {
  mcp_tool_families: [...new Set((attach.match(/mcp__[A-Za-z0-9_-]+?__/g) || []).map((s) => s.replace(/__$/, '')))].sort(),
  web_tools_listed: /\bWebFetch\b|\bWebSearch\b/.test(attach),
  claude_md_loaded: /CLAUDE\.md/.test(attach), memory_loaded: /MEMORY\.md|auto-?memory/i.test(attach),
  skills_listed: (attach.match(/"skill[s]?"|available for use with the Skill tool|skill-creator|graphify|higgsfield/gi) || []).length > 0,
};
const flags = []; const detail = [];
let n = 0;
for (const [id, c] of calls) {
  n++;
  const inp = JSON.stringify(c.input); const res = results.get(id);
  const out = res ? res.text : null;
  const why = [];
  if (/^(WebFetch|WebSearch)$/.test(c.name)) why.push('web tool used');
  if (c.name.startsWith('mcp__')) why.push(`connector/MCP tool used: ${c.name}`);
  const paths = (inp.match(/(\/(Users|private|tmp|etc|var|opt|home)\/[^\s"'`;|&)]+|~\/[^\s"'`;|&)]+)/g) || []);
  for (const p of paths) if (!p.startsWith(PK) && !ownScratch.test(p)) why.push(`path outside the packet: ${p.slice(0, 120)}`);
  if (/(^|[\s;&|])cd\s+\.\.(\s|$|\/)/.test(inp) || /\.\.\/\.\./.test(inp)) why.push('relative path climbing above the packet');
  if (NETWORK.test(c.input.command || '')) why.push(`network command: ${String(c.input.command).match(NETWORK)[0]}`);
  for (const re of EXCLUDED) {
    if (re.test(inp)) why.push(`excluded marker in input: ${re}`);
    if (out && re.test(out)) why.push(`excluded marker in output: ${re}`);
  }
  if (res === undefined) why.push('no recorded output (cannot establish what was seen)');
  detail.push({ n, tool: c.name, input: (c.input.command || c.input.file_path || inp).slice(0, 2000), output: out === null ? null : out.slice(0, 4000), output_bytes: out ? out.length : 0, flags: why });
  if (why.length) flags.push({ n, tool: c.name, input: (c.input.command || c.input.file_path || inp).slice(0, 200), flags: why });
}
const report = {
  schema: 'qb-author-session-audit/1', transcript_sha256: crypto.createHash('sha256').update(raw).digest('hex'), packet: PK,
  models: [...models], permission_modes: [...modes], cwds: [...cwds], tool_calls: n, available, flags,
  verdict: flags.length ? 'FLAGGED: review each flag before accepting the checks' : 'no flags in commands or outputs',
  limits: 'Reviews the transcript only. It cannot rule out knowledge from model training data, and it trusts that the transcript is complete.',
};
if (detailArg) fs.writeFileSync(detailArg.slice(9), `${JSON.stringify(detail, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
