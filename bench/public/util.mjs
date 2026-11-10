// KAN-110 helpers with no dependencies (unit-tested from test/unit/kan110-public-import.test.js).
import crypto from 'node:crypto';

/** Opaque, deterministic task ID. One-way: it reveals nothing of the instance ID (which can embed the fix). */
export const opaqueId = (source, instanceId) => 'qbt_' + crypto.createHash('sha256').update(`kan110|${source}|${instanceId}`).digest('hex').slice(0, 12);

/** RFC 4180 CSV (quoted fields may contain commas, quotes and newlines). */
export function parseCsv(text) {
  const rows = []; let row = []; let field = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = ''; rows.push(row); row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows;
  return body.filter((r) => r.length > 1 || r[0] !== '').map((r) => {
    if (r.length !== head.length) throw new Error(`CSV row has ${r.length} fields, header has ${head.length}`);
    return Object.fromEntries(head.map((h, k) => [h, r[k]]));
  });
}

