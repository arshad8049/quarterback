/**
 * lib/short-text.js — a reason short enough for the terminal, never cut mid-word (KAN-106, 10677).
 * A text within the limit is returned whole. A longer one is cut at the last clause boundary (": ",
 * "; ", " (", ", ") or, failing that, the last space before the limit, and says that the full text
 * is in the run record. The run record always keeps the full text.
 */
function shortText(text, max = 240) {
  const t = String(text ?? '');
  if (t.length <= max) return t;
  const head = t.slice(0, max);
  const cuts = [': ', '; ', ' (', ', '].map((b) => head.lastIndexOf(b)).filter((i) => i >= max / 2);
  const at = cuts.length ? Math.max(...cuts) : head.lastIndexOf(' ');
  return `${(at > 0 ? head.slice(0, at) : head).trimEnd()} (full text in the run record)`;
}

module.exports = { shortText };
