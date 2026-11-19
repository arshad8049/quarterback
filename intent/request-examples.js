/**
 * intent/request-examples.js: request-to-check consistency (KAN-107; senior 10766, approved 10771).
 *
 * QB must not silently replace a supported customer example with a different check. From the ORIGINAL
 * request text only (contract.raw_request; never model text), and QB's own static grounding
 * (contract.api_grounding; never model assertions, check shapes or allowed files), this module:
 *
 *   - extracts literal call examples: `name(<literals>)` / `Receiver.name(<literals>)` followed in the same
 *     clause by returns|returning|… <literal>, or throws|throwing|… [a <Class>] [whose message includes|is "<text>"];
 *   - extracts request-quoted error-message requirements that are not part of a call example (S3: "When whole
 *     is 0 it must throw an error whose message includes …"), keeping the condition and binding it, with
 *     provenance, to one parameter of one call signature written in the request (`percent(part, whole)`), or
 *     reporting it as unbound (refused);
 *   - records general rules (a behaviour passage beyond its examples) and underspecified passages (a SMALL
 *     vague-qualifier list; no claim to detect arbitrary ambiguity);
 *   - records unsupported shapes (prose values, conditional prose, variables, expressions, objects, templates,
 *     out-of-bounds literals), never guessed and never certified;
 *   - checks a contract: every supported example tied to ONE target needs a check making that exact call (module
 *     + export/method + argument structure + return/throw semantics + exact message); contradictions, changed
 *     argument shapes, misplaced and missing examples, wrong messages, untied targets, dropped rules and invented
 *     behaviour for an underspecified passage are L1 errors (contract-state.js);
 *   - maps each item for the approval view (oracle-view.js): request excerpt -> target(args) outcome -> check.
 *
 * Literals are parsed without eval. ONE set of limits (LIMITS) is shared by parsing, the staged fact schema
 * (staged.js) and its validation; it is stricter than the check registry's 4 KiB per JSON value.
 *
 * Not claimed: semantic correctness of a contract that passes. Prose expectations, sequences, objects, error
 * CLASSES (no adapter checks error identity; shown as not_checked) and message EQUALITY (only inclusion runs;
 * shown as equality_not_checked) are not verified, nor is any input beyond the stated examples.
 */
const { isDeepStrictEqual: deq } = require('util');
const { splitPassages } = require('./passages');

const LIMITS = Object.freeze({ depth: 3, items: 16, args: 8, bytes: 1024, string: 1000 });
const show = (v) => JSON.stringify(v);
const bytes = (v) => Buffer.byteLength(JSON.stringify(v) ?? '');
const argText = (args) => args.map((a) => JSON.stringify(a)).join(', ');

// ── literals ─────────────────────────────────────────────────────────────────

class LitError extends Error {}

/** Limit errors for ONE value (an argument or an expected value); depth counts arrays inside that value. */
function valueErrors(v, at = 'value') {
  const e = [];
  const walk = (x, d) => {
    if (x === null || typeof x === 'boolean') return;
    if (typeof x === 'string') { if (x.length > LIMITS.string) e.push(`${at}: a string longer than ${LIMITS.string} characters`); return; }
    if (typeof x === 'number') { if (!Number.isFinite(x)) e.push(`${at}: not a finite number`); return; }
    if (Array.isArray(x)) {
      if (d + 1 > LIMITS.depth) { e.push(`${at}: nesting depth over ${LIMITS.depth}`); return; }
      if (x.length > LIMITS.items) e.push(`${at}: more than ${LIMITS.items} items in one array`);
      x.forEach((y) => walk(y, d + 1));
      return;
    }
    if (x && typeof x === 'object') { e.push(`${at}: object literals are unsupported in v1`); return; }
    e.push(`${at}: not JSON (${typeof x})`);
  };
  walk(v, 0);
  if (bytes(v) > LIMITS.bytes) e.push(`${at}: larger than ${LIMITS.bytes} bytes`);
  return [...new Set(e)];
}
/** Limit errors for an argument LIST: count, each value, and the total size. */
function argsErrors(args) {
  if (!Array.isArray(args)) return ['args: not a list'];
  const e = [];
  if (args.length > LIMITS.args) e.push(`more than ${LIMITS.args} arguments`);
  args.forEach((a, i) => e.push(...valueErrors(a, `argument ${i + 1}`)));
  if (bytes(args) > LIMITS.bytes) e.push(`the arguments are larger than ${LIMITS.bytes} bytes`);
  return [...new Set(e)];
}

const skipWs = (s, i) => { while (i < s.length && /\s/.test(s[i])) i++; return i; };
const ESC = { '"': '"', "'": "'", '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
function readString(s, i) {
  const q = s[i];
  let out = '';
  for (let j = i + 1; j < s.length; j++) {
    const ch = s[j];
    if (ch === q) return { value: out, end: j + 1 };
    if (ch === '\\') {
      const n = s[j + 1];
      if (n === 'u' && /^[0-9a-fA-F]{4}$/.test(s.slice(j + 2, j + 6))) { out += String.fromCharCode(parseInt(s.slice(j + 2, j + 6), 16)); j += 5; continue; }
      if (n in ESC) { out += ESC[n]; j++; continue; }
      throw new LitError('an unsupported escape in a string');
    }
    if (ch === '\n') break;
    out += ch;
  }
  throw new LitError('an unterminated string');
}
const NUM = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?(?![\w$])/y;
const WORD = /[A-Za-z_$][\w$]*/y;
/** One literal at s[i]; `depth` = arrays already open around it within the same value. */
function readValue(s, i, depth = 0) {
  i = skipWs(s, i);
  const ch = s[i];
  if (ch === '"' || ch === "'") return readString(s, i);
  if (ch === '`') throw new LitError('template strings are unsupported');
  if (ch === '{') throw new LitError('object literals are unsupported in v1');
  if (ch === '[') {
    if (depth + 1 > LIMITS.depth) throw new LitError(`nesting depth over ${LIMITS.depth}`);
    const out = [];
    let j = skipWs(s, i + 1);
    if (s[j] === ']') return { value: out, end: j + 1 };
    for (;;) {
      const r = readValue(s, j, depth + 1);
      out.push(r.value);
      if (out.length > LIMITS.items) throw new LitError(`more than ${LIMITS.items} items in one array`);
      j = skipWs(s, r.end);
      if (s[j] === ',') { j++; continue; }
      if (s[j] === ']') return { value: out, end: j + 1 };
      throw new LitError(/[+\-*/%<>=!&|?]/.test(s[j] || '') ? 'expressions are unsupported' : 'not a literal array');
    }
  }
  NUM.lastIndex = i;
  const n = NUM.exec(s);
  if (n) return { value: Number(n[0]), end: i + n[0].length };
  WORD.lastIndex = i;
  const w = WORD.exec(s);
  if (w) {
    const end = i + w[0].length;
    if (w[0] === 'true') return { value: true, end };
    if (w[0] === 'false') return { value: false, end };
    if (w[0] === 'null') return { value: null, end };
    if (w[0] === 'undefined' || w[0] === 'NaN' || w[0] === 'Infinity') throw new LitError(`${w[0]} is not JSON`);
    throw new LitError(`${w[0]} is an identifier or variable, not a literal`);
  }
  throw new LitError('not a literal');
}
/** A whole text as ONE literal: { ok, value } or { ok: false, reason }. No eval. */
function parseLiteral(text) {
  const s = String(text ?? '');
  try {
    const r = readValue(s, 0, 0);
    const rest = skipWs(s, r.end);
    if (rest < s.length) throw new LitError(/[+\-*/%<>=!&|?]/.test(s[rest]) ? 'expressions are unsupported' : 'trailing text after the literal');
    const e = valueErrors(r.value);
    if (e.length) throw new LitError(e.join('; '));
    return { ok: true, value: r.value };
  } catch (e) { if (e instanceof LitError) return { ok: false, reason: e.message }; throw e; }
}
/** The text between a call's parentheses as an argument list: { ok, value } or { ok: false, reason }. */
function parseArgs(text) {
  const s = String(text ?? '');
  if (!s.trim()) return { ok: true, value: [] };
  try {
    const out = [];
    let j = 0;
    for (;;) {
      const r = readValue(s, j, 0);
      out.push(r.value);
      j = skipWs(s, r.end);
      if (j >= s.length) break;
      if (s[j] === ',') { j++; continue; }
      throw new LitError(/[+\-*/%<>=!&|?]/.test(s[j]) ? 'expressions are unsupported' : 'not a literal argument list');
    }
    const e = argsErrors(out);
    if (e.length) throw new LitError(e.join('; '));
    return { ok: true, value: out };
  } catch (e) { if (e instanceof LitError) return { ok: false, reason: e.message }; throw e; }
}

// ── request structure ────────────────────────────────────────────────────────

const EXT = '(?:c|m)?js|jsx|ts|tsx|json';
const PATH_G = new RegExp(`\`?((?:[A-Za-z0-9_@-][A-Za-z0-9_.@-]*\\/)*[A-Za-z0-9_@-][A-Za-z0-9_.@-]*\\.(?:${EXT}))\`?(?![A-Za-z0-9_/])`, 'g');
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'function', 'return', 'catch', 'typeof', 'new', 'await', 'e', 'i']);
const CALL_G = /(?:\b([A-Za-z_$][\w$]*)\.)?\b([A-Za-z_$][\w$]*)\s*\(/g;
const NAME_MENTION = /\b[A-Za-z_$][\w$]*\s*\(/;

/** Index of the ')' closing the '(' at `open` (quotes and brackets respected), or -1. */
function closeParen(s, open) {
  let depth = 0; let q = null;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (q) { if (ch === '\\') { i++; continue; } if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { q = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') { depth--; if (depth === 0) return ch === ')' ? i : -1; }
  }
  return -1;
}
/** Sentences: cut after . ! ? followed by whitespace or the end, outside quotes and brackets. */
function sentences(s) {
  const out = []; let from = 0; let depth = 0; let q = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { if (ch === '\\') { i++; continue; } if (ch === q) q = null; continue; }
    if (ch === '"' || ch === '`') { q = ch; continue; }
    if (ch === "'" && (i === 0 || !/\w/.test(s[i - 1]))) { q = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
    else if (depth === 0 && /[.!?\n]/.test(ch) && (i + 1 === s.length || /\s/.test(s[i + 1]))) { out.push({ start: from, end: i + 1 }); from = i + 1; }
  }
  if (from < s.length && s.slice(from).trim()) out.push({ start: from, end: s.length });
  return out.map((x) => { let a = x.start; while (a < x.end && /\s/.test(s[a])) a++; return { start: a, end: x.end, text: s.slice(a, x.end) }; });
}
const RET = /^\s+(?:(?:that|which)\s+)?(?:still\s+|should\s+|must\s+|will\s+|to\s+)?(?:returns?|returning)\b/i;
const THR = /^\s+(?:(?:that|which)\s+)?(?:still\s+|should\s+|must\s+|will\s+|to\s+)?(?:throws?|throwing|raises?|raising)\b/i;
const GAP = /^\s+with\s+no\s+arguments?\b/i;
const CLASS = /^\s+(?:an?\s+)?(?:([A-Z][\w$]*(?:Error|Exception))|error|exception)\b/;
const MSG = /^\s*,?\s*(?:whose\s+message|with\s+(?:a\s+|an\s+|the\s+)?(?:error\s+)?message|and\s+(?:its|the)\s+message)\s+(?:(includes|including|contains|containing)|(is|equals|equal\s+to|of))?\s*(?=["'])/i;
const OK_END = /^\s*(?:$|[.,;:!?()]|(?:instead|and|but|rather|so|as\s+before|as\s+today|again|too|also|today|now|unchanged)\b)/i;
const COND_END = /^\s*(?:for|when|if|given|unless|once|after|before|while|with|on|in\s+case|whenever)\b/i;
const LOCATION = /^in\s+`?[\w./@-]+`?\s*,$/i;
// A call example is a REQUIREMENT only when the request frames it as wanted. A bare statement ("w.format(0) returns
// 'count=%d' instead of 'count=0'" in a bug report, QB-30 PW-01) may describe the CURRENT behaviour: it is recorded
// as unsupported (shown at approval, never enforced) instead of being turned into a check for the bug.
const INTENT = /\b(?:make|makes|making|so|should|must|keep|keeps|still|ensure|expect|expected|want|wants|need|needs|change|update|fix|for\s+example|e\.g\.|such\s+that|to\s+(?:return|throw))\b/i;
const VERB_INTENT = /\b(?:still|should|must|will|to)\s/i;
const PROTECT = /^(?:do\s+not|don't|never)\s+(?:change|modify|edit|touch)\b/i;
const VAGUE = /\b(properly|correctly|gracefully|as\s+expected)\b|\b(?:works?|handles?)\b[^.]*?\b(right)\b/i;
const STATED = /\b(?:returns?|returning|throws?|throwing|raises?)\b/i;

/** Message clause after a throw: { mode, fragment, span, end } or null. */
function readMessage(s, i) {
  const m = MSG.exec(s.slice(i));
  if (!m) return null;
  const q = i + m[0].length;
  try {
    const r = readString(s, q);
    return { mode: m[2] ? 'equals' : m[1] ? 'includes' : 'equals', fragment: r.value, span: [q, r.end], end: r.end };
  } catch { return null; }
}

/**
 * Everything QB reads from the request text: { examples, messages, rules, underspecified, unsupported, signatures }.
 * `examples`: [{ id, passage_id, sentence_index, span, excerpt, call, receiver, name, args, outcome, expected,
 *   error_class, message: { mode: 'includes'|'equals', fragment, span } | null, message_includes, kept }]
 */
function extractExamples(request, { statements = false } = {}) {
  const s = String(request ?? '');
  const passages = splitPassages(s);
  const sents = sentences(s);
  const passageAt = (i) => (passages.find((p) => i >= p.start && i < p.end) || passages[passages.length - 1] || { id: 'P1' }).id;
  const sentenceAt = (i) => Math.max(0, sents.findIndex((x) => i >= x.start && i < x.end));
  const examples = []; const unsupported = []; const signatures = []; const consumed = [];
  const skip = (what, start, end, reason, kind, name = null) => unsupported.push({ passage_id: passageAt(start), excerpt: s.slice(start, end).trim(), reason, kind, name });
  CALL_G.lastIndex = 0;
  let m;
  while ((m = CALL_G.exec(s)) !== null) {
    const [, receiver, name] = m;
    if (KEYWORDS.has(name)) continue;
    const start = m.index;
    const open = start + m[0].length - 1;
    const close = closeParen(s, open);
    if (close < 0) continue;
    const argsSrc = s.slice(open + 1, close);
    const call = `${receiver ? `${receiver}.` : ''}${name}(${argsSrc})`;
    // a call signature written in the request: identifiers only (`percent(part, whole)`)
    const params = argsSrc.split(',').map((x) => x.trim());
    if (argsSrc.trim() && params.every((x) => /^[A-Za-z_$][\w$]*$/.test(x)) && !params.some((x) => ['true', 'false', 'null'].includes(x))) signatures.push({ name, params, span: [start, close + 1] });
    let j = close + 1;
    const gap = GAP.exec(s.slice(j)); if (gap) j += gap[0].length;
    const ret = RET.exec(s.slice(j)); const thr = ret ? null : THR.exec(s.slice(j));
    if (!ret && !thr) continue;   // a name mention ("Update greeting() so …"), not an example
    j += (ret || thr)[0].length;
    const args = parseArgs(argsSrc);
    if (!args.ok) {
      const kind = /identifier|variable/.test(args.reason) ? 'variable' : 'literal';
      skip(call, start, Math.min(s.length, j + 40), `the arguments are not supported literals (${args.reason})`, kind, name);
      continue;
    }
    const ex = { receiver: receiver || null, name, call, args: args.value, outcome: ret ? 'returns' : 'throws', expected: undefined, error_class: null, message: null };
    if (ret) {
      let v;
      try { v = readValue(s, j, 0); } catch (e) {
        if (!(e instanceof LitError)) throw e;
        const objectish = /object|template|depth|items/.test(e.message);
        skip(call, start, Math.min(s.length, j + 40), objectish ? `the result is not a supported literal (${e.message})` : 'the result is prose, not a literal value', objectish ? 'literal' : 'prose', name);
        continue;
      }
      const ve = valueErrors(v.value, 'the result');
      if (ve.length) { skip(call, start, v.end, ve.join('; '), 'literal', name); continue; }
      ex.expected = v.value; j = v.end;
    } else {
      const c = CLASS.exec(s.slice(j)); if (c) { ex.error_class = c[1] || null; j += c[0].length; }
      const msg = readMessage(s, j); if (msg) { ex.message = { mode: msg.mode, fragment: msg.fragment, span: msg.span }; j = msg.end; }
    }
    const rest = s.slice(j);
    const sentHere = sents[sentenceAt(start)] || { start: 0 };
    if (!statements && !INTENT.test(s.slice(sentHere.start, start)) && !VERB_INTENT.test(s.slice(close + 1, close + 1 + (ret || thr)[0].length + (gap ? gap[0].length : 0)))) {
      skip(call, start, Math.min(s.length, j + 20), 'stated as a description (it may be the current behaviour), not as the requested result: QB does not enforce it; write "make … return …" if it is the requirement', 'described', name);
      continue;
    }
    if (!OK_END.test(rest)) {
      skip(call, start, Math.min(s.length, j + 40), COND_END.test(rest) ? 'conditional prose: the result depends on a condition that is not a literal call' : 'trailing prose after the result', 'prose', name);
      continue;
    }
    const sent = sents[sentenceAt(start)] || { text: s };
    examples.push({ id: `EX-${examples.length + 1}`, passage_id: passageAt(start), sentence_index: sentenceAt(start), span: [start, j], excerpt: s.slice(start, j).trim(),
      ...ex, message_includes: ex.message && ex.message.mode === 'includes' ? ex.message.fragment : null,
      kept: /^\s*(?:keep|preserve|retain|maintain)\b/i.test(sent.text) || /\bstill\s+(?:returns?|returning|throws?|throwing)\b/i.test(s.slice(close + 1, j)) });
    consumed.push([start, j]);
    CALL_G.lastIndex = j;
  }

  // request-quoted message requirements outside call examples (S3), with their condition
  const messages = [];
  const callNamesIn = (t) => [...t.matchAll(CALL_G)].map((x) => x[2]).filter((x) => !KEYWORDS.has(x));
  sents.forEach((sent, si) => {
    const re = /\b(?:throws?|throw|throwing|raises?)\b/gi;
    let t;
    while ((t = re.exec(sent.text)) !== null) {
      const at = sent.start + t.index;
      if (consumed.some(([a, b]) => at >= a && at < b)) continue;
      let j = at + t[0].length;
      const c = CLASS.exec(s.slice(j)); let cls = null; if (c) { cls = c[1] || null; j += c[0].length; }
      const msg = readMessage(s, j);
      if (!msg) continue;
      const before = s.slice(sent.start, at);
      const cm = /\b(when|if)\s+(?:the\s+)?([A-Za-z_$][\w$]*)\s+(?:is\s+equal\s+to|is|equals|===?)\s+/i.exec(before);
      let condition = null;
      if (cm) {
        const vs = sent.start + cm.index + cm[0].length;
        let lit = null;
        try { lit = readValue(s, vs, 0); } catch (e) { if (!(e instanceof LitError)) throw e; }
        const textEnd = lit ? lit.end : sent.start + cm.index + (before.slice(cm.index).search(/,|\s+(?:it|then)\b/) >= 0 ? before.slice(cm.index).search(/,|\s+(?:it|then)\b/) : before.length - cm.index);
        const text = s.slice(sent.start + cm.index, textEnd).trim();
        const sigs = signatures.filter((g) => g.params.includes(cm[2]));
        if (!lit) condition = { text, param: cm[2], bound: false, reason: 'the condition value is not a literal' };
        else if (sigs.length !== 1) condition = { text, param: cm[2], value: lit.value, bound: false, reason: sigs.length ? 'several call signatures in the request name that parameter' : 'no call signature in the request names that parameter' };
        else condition = { text, param: cm[2], value: lit.value, index: sigs[0].params.indexOf(cm[2]), arity: sigs[0].params.length, name: sigs[0].name, bound: true, signature_span: sigs[0].span, condition_span: [sent.start + cm.index, textEnd] };
      } else if (/\b(?:when|if|unless|for)\b/i.test(before)) {
        condition = { text: before.trim().replace(/,?\s*(?:it\s+)?(?:must|should)?\s*$/i, ''), bound: false, reason: 'the condition is not of the form "when <parameter> is <literal>"' };
      }
      let name = condition && condition.bound ? condition.name : null;
      if (!name) {
        const here = [...new Set(callNamesIn(sent.text))];
        const prev = si > 0 ? [...new Set(callNamesIn(sents[si - 1].text))] : [];
        name = here.length === 1 ? here[0] : !here.length && prev.length === 1 ? prev[0] : null;
      }
      messages.push({ id: `MSG-${messages.length + 1}`, passage_id: passageAt(at), sentence_index: si, span: msg.span, excerpt: sent.text.trim(), fragment: msg.fragment, mode: msg.mode, error_class: cls, condition, name });
      consumed.push([at, msg.end]);
    }
  });

  // underspecified passages and general rules
  const exampleIn = (p) => examples.some((e) => e.span[0] >= p.start && e.span[0] < p.end) || messages.some((x) => x.span[0] >= p.start && x.span[0] < p.end);
  const underspecified = []; const rules = [];
  for (const p of passages) {
    const text = p.text.trim();
    if (LOCATION.test(text) || PROTECT.test(text) || !NAME_MENTION.test(text) || exampleIn(p)) continue;
    const sent = sents.find((x) => p.start >= x.start && p.start < x.end) || { start: p.start, end: p.end, text };
    const vague = VAGUE.exec(text);
    const sentenceStates = examples.some((e) => e.sentence_index === sents.indexOf(sent)) || messages.some((x) => x.sentence_index === sents.indexOf(sent)) || STATED.test(sent.text);
    if (vague && !sentenceStates) { underspecified.push({ passage_id: p.id, excerpt: text, qualifier: (vague[1] || vague[2]).replace(/\s+/g, ' ') }); continue; }
    rules.push({ passage_id: p.id, text });
  }
  return { examples, messages, rules, underspecified, unsupported, signatures };
}

// ── targets: QB-computed grounding only ──────────────────────────────────────

function requestPaths(request) {
  const { requestTargets } = require('./request-targets');
  const negated = new Set(requestTargets(request).ignored.filter((x) => x.why === 'negated').map((x) => x.path));
  return [...new Set([...String(request).matchAll(PATH_G)].map((x) => x[1]))].filter((p) => !negated.has(p));
}
const ELIGIBLE = new Set(['none', 'appears_optional']);
/**
 * One target for an item ({ receiver, name, sentence_index }): { ok, target } or { ok: false, why }.
 * Never uses the contract's checks or allowed files to choose (10771 Q2, B).
 */
function resolveTarget(item, request, grounding, sents) {
  const mods = grounding && Array.isArray(grounding.modules) ? grounding.modules : [];
  const sentence = (sents[item.sentence_index] || { text: '' }).text;
  const here = [...new Set([...sentence.matchAll(PATH_G)].map((x) => x[1]))];
  const all = requestPaths(request);
  const defines = (m) => m && m.status === 'known' && (item.receiver
    ? m.default && m.default.kind === 'class' && m.default.methods.includes(item.name)
    : (m.default && m.default.kind === 'class' && m.default.methods.includes(item.name)) || m.named.some((x) => x.name === item.name) || (m.default && m.default.kind === 'function' && m.default.name === item.name));
  let cands = here.length ? here : all;
  if (cands.length > 1) {
    const narrowed = cands.filter((p) => defines(mods.find((x) => x.path === p)));
    if (narrowed.length !== 1) return { ok: false, why: `${cands.join(' and ')} could each be meant${narrowed.length > 1 ? `, and QB's grounding shows ${narrowed.length} of them define ${item.name}` : ''}; say which module` };
    cands = narrowed;
  }
  if (!cands.length) {
    const definers = mods.filter(defines);
    if (definers.length !== 1) return { ok: false, why: 'the request names no module for it; say which file' };
    cands = [definers[0].path];
  }
  const module = cands[0];
  const m = mods.find((x) => x.path === module);
  const known = m && m.status === 'known';
  const cls = known && m.default && m.default.kind === 'class' ? m.default : null;
  const asMethod = (why) => {
    if (!ELIGIBLE.has(cls.ctor_args)) return { ok: false, why: `the constructor of ${cls.name || 'the default class'} in ${module} may need arguments QB cannot supply (bounded static eligibility reading, 10758: ${cls.ctor_args || 'unknown'}; not a proof either way)` };
    return { ok: true, target: { module, kind: 'method', export: 'default', method: item.name, class: cls.name || null, label: `${module} new ${cls.name || 'default'}().${item.name}`, why } };
  };
  if (item.receiver) {
    if (!known) return { ok: false, why: `QB has no grounding for ${item.receiver} in ${module}` };
    if (!cls || !cls.methods.includes(item.name)) return { ok: false, why: `QB's grounding of ${module} shows no default class with an instance method ${item.name}` };
    if (cls.name && item.receiver !== cls.name) return { ok: false, why: `the receiver ${item.receiver} is not ${module}'s default class ${cls.name}` };
    return asMethod('grounded default-class method');
  }
  if (known) {
    const isMethod = Boolean(cls && cls.methods.includes(item.name));
    const named = m.named.some((x) => x.name === item.name);
    const isDefaultFn = m.default && m.default.kind === 'function' && m.default.name === item.name;
    if (isMethod && (named || isDefaultFn)) return { ok: false, why: `${module} has both an export and a class method named ${item.name}` };
    if (isMethod) return asMethod('grounded default-class method');
    if (named || isDefaultFn) return { ok: true, target: { module, kind: 'function', export: named ? item.name : 'default', label: `${module} ${item.name}` } };
  }
  return { ok: true, target: { module, kind: 'function', export: item.name, label: `${module} ${item.name}` } };
}

/** The calls a contract's checks make on a target. call_sequence: only a step on a FRESH instance (constructed
 *  with new and no arguments, no earlier step on that instance): sequences are unsupported in v1. */
function callsOn(target, checks) {
  const out = [];
  for (const k of checks) {
    const p = (k && k.params) || {};
    if (target.kind === 'function' && (k.adapter === 'call_returns' || k.adapter === 'call_throws') && p.module === target.module && p.export === target.export && Array.isArray(p.args)) {
      out.push({ check: k, args: p.args, kind: k.adapter === 'call_throws' ? 'throws' : 'returns', expect: p.expect, message: p.message_includes ?? null });
    }
    if (target.kind === 'method' && k.adapter === 'call_sequence' && p.module === target.module && p.export === 'default') {
      const used = new Set();
      for (const st of p.steps || []) {
        const inst = (p.instances || {})[st.on];
        const fresh = inst && inst.construct === 'new' && deq(inst.args, []) && !used.has(st.on);
        used.add(st.on);
        if (fresh && st.method === target.method && Array.isArray(st.args)) out.push({ check: k, args: st.args, kind: st.throws ? 'throws' : st.expect !== undefined ? 'returns' : 'none', expect: st.expect, message: (st.throws && st.throws.message_includes) ?? null });
      }
    }
  }
  return out;
}
function shapeVariants(args) {
  const v = [];
  if (args.length === 1 && Array.isArray(args[0])) v.push(args[0]);
  v.push(args.flat(1), args.flat(Infinity), [args]);
  return v.filter((x) => !deq(x, args));
}
const claimOf = (x) => (x.outcome === 'throws'
  ? `throws${x.error_class ? ` a ${x.error_class}` : ''}${x.message ? ` an error whose message ${x.message.mode === 'equals' ? 'is' : 'includes'} ${show(x.message.fragment)}` : ''}`
  : `returns ${show(x.expected)}`);
const callOf = (t, args) => `${t.kind === 'method' ? `${t.method}` : t.export === 'default' ? 'default' : t.export}(${argText(args)})`;
function checkCall(k) {
  const p = (k && k.params) || {};
  if (k.adapter === 'call_sequence') { const st = (p.steps || []).find((x) => x.expect !== undefined || x.throws) || {}; return `${st.method}(${argText(st.args || [])}) ${st.throws ? 'throws' : `returns ${show(st.expect)}`}`; }
  if (k.adapter === 'call_throws') return `${p.export}(${argText(p.args || [])}) throws`;
  return `${p.export}(${argText(p.args || [])}) returns ${show(p.expect)}`;
}

// ── the contract analysis ─────────────────────────────────────────────────────

function analyse(c) {
  const request = typeof c?.raw_request === 'string' ? c.raw_request : '';
  if (!request.trim()) return { errors: [], rows: [] };
  const rx = extractExamples(request);
  const sents = sentences(request);
  const checks = Array.isArray(c.checks) ? c.checks.filter(Boolean) : [];
  const acs = Array.isArray(c.acceptance_criteria) ? c.acceptance_criteria.filter(Boolean) : [];
  const reqs = Array.isArray(c.requirements) ? c.requirements.filter(Boolean) : [];
  const grounding = c.api_grounding || null;
  const errors = []; const rows = [];

  for (const ex of rx.examples) {
    const claim = claimOf(ex);
    const row = { id: ex.id, source: 'request', passage_id: ex.passage_id, excerpt: `${ex.call} ${claim}`, outcome: ex.outcome, args: ex.args, expected: ex.expected, message: ex.message,
      error_class: ex.error_class, error_class_status: ex.error_class ? 'not_checked' : null,
      message_status: ex.message ? (ex.message.mode === 'equals' ? 'equality_not_checked' : 'checked') : null, target: null, check_id: null, status: null };
    rows.push(row);
    const r = resolveTarget(ex, request, grounding, sents);
    if (!r.ok) { row.status = 'ambiguous_target'; errors.push(`the request's example ${ex.call} ${claim} (${ex.passage_id}) cannot be tied to one target: ${r.why}`); continue; }
    const t = r.target; row.target = t.label; row.call = callOf(t, ex.args);
    const cands = callsOn(t, checks);
    const sat = (k) => (ex.outcome === 'returns' ? k.kind === 'returns' && deq(k.expect, ex.expected) : k.kind === 'throws' && (!ex.message || k.message === ex.message.fragment));
    const exact = cands.filter((k) => deq(k.args, ex.args));
    const bad = exact.filter((k) => !sat(k));
    if (bad.length) {
      row.status = 'contradicted'; row.check_id = bad[0].check.id;
      for (const k of bad) {
        if (ex.outcome === 'throws' && k.kind === 'throws' && ex.message) {
          row.status = 'message_wrong';
          errors.push(`the request requires an error message including ${show(ex.message.fragment)} for ${ex.call} (${ex.passage_id}): ${k.check.id} ${k.message === null ? 'checks no message' : k.message.includes(ex.message.fragment) ? `uses message_includes ${show(k.message)}, a longer text than requested: use the exact fragment` : `uses message_includes ${show(k.message)}`}`);
        } else {
          errors.push(`${k.check.id} contradicts the request's example ${ex.call} ${claim} (${ex.passage_id}): it ${k.kind === 'throws' ? 'expects a throw' : k.kind === 'returns' ? `expects ${show(k.expect)}` : 'asserts no result'} for the same call`);
        }
      }
      continue;
    }
    const good = exact.find(sat);
    if (good) { row.status = 'checked'; row.check_id = good.check.id; continue; }
    const shaped = cands.find((k) => shapeVariants(ex.args).some((v) => deq(v, k.args)));
    if (shaped) {
      row.status = 'shape_changed'; row.check_id = shaped.check.id;
      errors.push(`${shaped.check.id} changes the argument shape of the request's example ${ex.call} ${claim} (${ex.passage_id}): it calls ${callOf(t, shaped.args)} with ${shaped.args.length} argument(s), the request passes ${ex.args.length}: ${argText(ex.args) || 'none'} (nesting is never flattened)`);
      continue;
    }
    const placed = cands.find((k) => (ex.outcome === 'returns' ? k.kind === 'returns' && deq(k.expect, ex.expected) : k.kind === 'throws' && (!ex.message || k.message === ex.message.fragment)));
    if (placed) {
      row.status = 'misplaced'; row.check_id = placed.check.id;
      errors.push(`the request's example ${ex.call} ${claim} (${ex.passage_id}) has no check with those arguments (${placed.check.id} calls ${callOf(t, placed.args)} instead)`);
      continue;
    }
    row.status = 'uncovered';
    errors.push(`the request's example ${ex.call} ${claim} (${ex.passage_id}) has no executable check: add a check that makes exactly this call on ${t.label}`);
  }

  for (const msg of rx.messages) {
    const req = `the request requires an error message including ${show(msg.fragment)} (${msg.passage_id}${msg.condition ? `: ${show(msg.condition.text)}` : ''})`;
    const row = { id: msg.id, source: 'request', passage_id: msg.passage_id, excerpt: msg.excerpt, outcome: 'throws', message: { mode: msg.mode, fragment: msg.fragment },
      condition: msg.condition, error_class: msg.error_class, error_class_status: msg.error_class ? 'not_checked' : null,
      message_status: msg.mode === 'equals' ? 'equality_not_checked' : 'checked', target: null, check_id: null, status: null };
    rows.push(row);
    if (msg.condition && !msg.condition.bound) { row.status = 'condition_unresolved'; errors.push(`${req}: its condition cannot be bound to the arguments of one call (${msg.condition.reason}); state it as a call example, e.g. name(…) throws an error whose message includes ${show(msg.fragment)}`); continue; }
    if (!msg.name) { row.status = 'ambiguous_target'; errors.push(`${req} cannot be tied to one target: the sentence names no single call`); continue; }
    const r = resolveTarget({ receiver: null, name: msg.name, sentence_index: msg.sentence_index }, request, grounding, sents);
    if (!r.ok) { row.status = 'ambiguous_target'; errors.push(`${req} cannot be tied to one target: ${r.why}`); continue; }
    row.target = r.target.label;
    const cond = msg.condition;
    const inCase = callsOn(r.target, checks).filter((k) => !cond || (k.args.length === cond.arity && deq(k.args[cond.index], cond.value)));
    const throwsIn = inCase.filter((k) => k.kind === 'throws');
    const right = throwsIn.find((k) => k.message === msg.fragment);
    const wrong = throwsIn.filter((k) => k.message !== msg.fragment);
    if (right && !wrong.some((k) => k.message !== null)) { row.status = 'checked'; row.check_id = right.check.id; continue; }
    row.status = 'message_wrong';
    if (throwsIn.length) {
      const k = wrong.find((x) => x.message !== null) || wrong[0];
      row.check_id = k.check.id;
      errors.push(`${req}: ${k.check.id} ${k.message === null ? 'checks no message' : k.message.includes(msg.fragment) ? `uses message_includes ${show(k.message)}, a longer text than requested: use the exact fragment` : `uses message_includes ${show(k.message)}`}`);
    } else {
      const elsewhere = callsOn(r.target, checks).find((k) => k.kind === 'throws' && k.message === msg.fragment);
      const returning = inCase.find((k) => k.kind === 'returns');
      errors.push(`${req}: no check ${cond ? `calls ${r.target.label} with ${cond.param} = ${show(cond.value)} (argument ${cond.index + 1} of ${cond.arity}) and` : ''} asserts that it throws${elsewhere ? ` (${elsewhere.check.id} asserts it for (${argText(elsewhere.args)}), which does not meet the condition)` : ''}${returning ? ` (${returning.check.id} expects a return value instead)` : ''}`);
    }
  }

  // decision 5: general rules stay reviewable requirements
  const norm = (x) => String(x || '').replace(/\s+/g, ' ').replace(/[\s,.;:]+$/, '').trim();
  const covers = (r, p) => (Array.isArray(r.passage_ids) && r.passage_ids.includes(p.passage_id)) || (norm(r.quote || r.text).includes(norm(p.text)) && norm(p.text).length > 0);
  // a requirement quoting part of the passage (legacy drafts quote clause by clause) overlaps it
  const overlaps = (r, p) => covers(r, p) || (() => { const q = norm(r.quote || r.text); return q.length >= 8 && norm(p.text).includes(q); })();
  const cited = (r) => acs.some((a) => Array.isArray(a.requirement_ids) && a.requirement_ids.includes(r.id));
  for (const p of rx.rules) {
    const over = reqs.filter((r) => overlaps(r, p));
    const kept = over.length > 0 && over.every((r) => r.disposition !== 'context' && cited(r));
    rows.push({ id: p.passage_id, source: 'request', passage_id: p.passage_id, excerpt: p.text, status: kept ? 'rule_retained (executable coverage sampled by the examples)' : 'rule_not_retained' });
    if (!kept) errors.push(`general rule ${p.passage_id} ${show(p.text)} is not retained: cite it as a requirement of an acceptance criterion (its examples sample it; they do not replace it)`);
  }

  // decision 4 / correction D: underspecified passages; proposed defaults concretely linked
  const defaults = new Map((Array.isArray(c.proposed_defaults) ? c.proposed_defaults : []).filter((d) => d && typeof d.id === 'string').map((d) => [d.id, d]));
  const statesCheck = (d, k) => {
    const p = k.params || {};
    const st = k.adapter === 'call_sequence' ? (p.steps || []).find((x) => x.expect !== undefined || x.throws) : null;
    const name = st ? st.method : p.export; const args = st ? st.args : p.args;
    const outcome = st ? (st.throws ? 'throws' : 'returns') : k.adapter === 'call_throws' ? 'throws' : 'returns';
    const expect = st ? st.expect : p.expect;
    return extractExamples(String(d.text || ''), { statements: true }).examples.some((e) => e.name === name && deq(e.args, args) && e.outcome === outcome && (outcome === 'throws' || deq(e.expected, expect)));
  };
  for (const u of rx.underspecified) {
    const rids = new Set(reqs.filter((r) => covers(r, { passage_id: u.passage_id, text: u.excerpt })).map((r) => r.id));
    for (const a of acs.filter((x) => Array.isArray(x.requirement_ids) && x.requirement_ids.some((id) => rids.has(id)))) {
      const ds = a.requirement_ids.filter((id) => /^D-/.test(id));
      for (const k of checks.filter((x) => x.ac_id === a.id)) {
        if (!ds.length) { errors.push(`${u.passage_id} ${show(u.excerpt)} states no expected behaviour (only "${u.qualifier}"): ${k.id} (${a.id}) expects ${checkCall(k)}, which the request never states. QB will not invent it as your requirement: clarify the request, or propose it as a default D-n that states exactly this call and result, for your explicit approval`); continue; }
        const linked = ds.find((id) => defaults.has(id) && statesCheck(defaults.get(id), k));
        rows.push({ id: linked || ds[0], source: 'proposed_default', passage_id: u.passage_id, excerpt: defaults.has(ds[0]) ? defaults.get(linked || ds[0]).text : ds[0], check_id: k.id, status: linked ? 'proposed default: needs your explicit approval' : 'not_stated' });
        if (!linked) errors.push(`${a.id} cites ${ds.join(', ')}, but ${ds.map((id) => `${id} ${show(defaults.has(id) ? defaults.get(id).text : '(missing)')}`).join('; ')} does not state the behaviour its check ${k.id} introduces (${checkCall(k)}): a default must state exactly that call and result`);
      }
    }
  }
  for (const u of rx.unsupported) rows.push({ id: null, source: 'request', passage_id: u.passage_id, excerpt: u.excerpt, status: 'unsupported', reason: u.reason });
  return { errors, rows };
}

/** L1 errors for contract-state.js (empty when the contract has no request text). */
const exampleErrors = (c) => analyse(c).errors;
/** The approval mapping rows (request excerpt -> target -> check, with statuses). */
const exampleMapping = (c) => analyse(c).rows;

module.exports = { LIMITS, valueErrors, argsErrors, parseLiteral, parseArgs, extractExamples, exampleErrors, exampleMapping, sentences };
