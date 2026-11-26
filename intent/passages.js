/**
 * intent/passages.js — the request as numbered passages (KAN-106).
 *
 * The intent compiler is shown the request split into passages with stable ids (P1…Pn). A
 * requirement cites the passages it relies on (`passage_ids`) instead of retyping a quote, and
 * QB copies the exact source text (intent/compiler.js; re-derived and checked by
 * intent/requirements.js). A local model retyping a clause ("Keep the behavior for string '0'"
 * for `string "0",`) was the main cause of rejected drafts (KAN-106 smoke 9e0d3257).
 *
 * Split rule (deterministic, from the request text alone):
 *   - a passage ends after `.` `!` `?` `;` or `,` when the next character is whitespace or the end
 *     of the request (closing quotes/brackets right after the mark stay with it: `"stop."`);
 *   - a passage also ends at a line break;
 *   - no split inside ( ) [ ] { } or `backticks`, so `clamp(5, 0, 3)` stays whole;
 *   - a mark not followed by whitespace never splits: `lib/serializer.js`, `Serializer.asNumber()`,
 *     `node:test`, `1,000`, `v1.2.3`;
 *   - each passage is trimmed; whitespace between passages belongs to none (it is never a token
 *     for traceability). Passages therefore tile the request: their union is every non-space
 *     character, so "every passage cited" is the same as "the whole request covered".
 * Clause-level passages keep traceability fine-grained: a requirement that cites only the
 * sentence's first clause leaves the rest uncovered, exactly as a short quote would.
 */

const MARKS = new Set(['.', '!', '?', ';', ',']);
const CLOSERS = new Set(['"', "'", ')', ']', '}', '»', '”', '’']);
const OPEN = { '(': ')', '[': ']', '{': '}' };
const CLOSE = new Set(Object.values(OPEN));
const ID = /^P([1-9]\d{0,3})$/;

/** @returns {Array<{ id: string, text: string, start: number, end: number }>} offsets into `request` */
function splitPassages(request) {
  const text = String(request ?? '');
  const cuts = [];               // exclusive end offsets of passages
  let depth = 0;
  let tick = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '`') { tick = !tick; continue; }
    if (tick) continue;
    if (OPEN[ch]) { depth++; continue; }
    if (CLOSE.has(ch)) { if (depth > 0) depth--; continue; }
    if (ch === '\n') { cuts.push(i); continue; }
    if (depth > 0 || !MARKS.has(ch)) continue;
    let j = i + 1;
    while (j < text.length && CLOSERS.has(text[j])) j++;
    if (j === text.length || /\s/.test(text[j])) { cuts.push(j); i = j - 1; }
  }
  cuts.push(text.length);
  const out = [];
  let from = 0;
  for (const cut of cuts) {
    let s = from, e = cut;
    while (s < e && /\s/.test(text[s])) s++;
    while (e > s && /\s/.test(text[e - 1])) e--;
    if (e > s) out.push({ id: `P${out.length + 1}`, text: text.slice(s, e), start: s, end: e });
    from = cut;
  }
  return out;
}

/** The passage list as shown to the compiler: one "Pn: <exact text>" line each. */
function passageListing(passages) {
  return passages.map((p) => `${p.id}: ${p.text}`).join('\n');
}

/**
 * The source span a requirement's `passage_ids` select.
 * @returns {{ ok: true, ids: string[], text: string, start: number, end: number } | { ok: false, error: string }}
 *   `error` is phrased for the requirement id (the caller prefixes it).
 */
function resolvePassageIds(passages, passageIds) {
  if (!Array.isArray(passageIds)) return { ok: false, error: 'passage_ids must be a list of passage ids such as ["P1"]' };
  if (!passageIds.length) return { ok: false, error: 'passage_ids is empty' };
  const range = passages.length ? `P1–P${passages.length}` : 'none';
  const idx = [];
  for (const raw of passageIds) {
    const m = typeof raw === 'string' ? ID.exec(raw.trim()) : null;
    const n = m ? Number(m[1]) : NaN;
    if (!(n >= 1 && n <= passages.length)) return { ok: false, error: `cites unknown passage ${JSON.stringify(raw)} (the request has passages ${range})` };
    if (!idx.includes(n)) idx.push(n);
  }
  idx.sort((a, b) => a - b);
  for (let k = 1; k < idx.length; k++) {
    if (idx[k] !== idx[k - 1] + 1) {
      return { ok: false, error: `cites passages ${idx.map((n) => `P${n}`).join(', ')}, which are not adjacent; cite adjacent passages, or use one requirement per passage` };
    }
  }
  const first = passages[idx[0] - 1], last = passages[idx[idx.length - 1] - 1];
  return { ok: true, ids: idx.map((n) => `P${n}`), start: first.start, end: last.end, text: '' };
}

/** resolvePassageIds against the request text itself, with the exact source text filled in. */
function resolveInRequest(request, passageIds) {
  const r = resolvePassageIds(splitPassages(request), passageIds);
  if (r.ok) r.text = String(request).slice(r.start, r.end);
  return r;
}

module.exports = { splitPassages, passageListing, resolvePassageIds, resolveInRequest };
