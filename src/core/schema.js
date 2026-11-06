'use strict';
// Columns from the top-level keys of the first records, with type and fill %, and table cells.
const L = require('./limits');

const VALUE_COL = '(value)'; // column for records that are not objects

function kindOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  const t = typeof v;
  if (t === 'number') return Number.isInteger(v) ? 'int' : 'float';
  if (t === 'boolean') return 'bool';
  if (t === 'string') return 'string';
  return 'object';
}

/** Parse one line. Returns {ok:true, value} or {ok:false, error}. */
function parseLine(text) {
  try { return { ok: true, value: JSON.parse(text) }; } catch (e) { return { ok: false, error: shortError(e) }; }
}

function shortError(e) {
  return String(e && e.message || e).replace(/^JSON\.parse: /, '').slice(0, 160);
}

/**
 * Build columns from parsed values (bad lines are skipped).
 * Returns [{name, type, fill, kinds}] where fill is 0..100 (share of records with a non-null value).
 */
function inferColumns(values) {
  const cols = new Map();
  let n = 0;
  const add = (name, v) => {
    let c = cols.get(name);
    if (!c) { c = { name, kinds: {}, present: 0 }; cols.set(name, c); }
    const k = kindOf(v);
    c.kinds[k] = (c.kinds[k] || 0) + 1;
    if (v !== null) c.present++;
  };
  for (const v of values) {
    n++;
    if (v && typeof v === 'object' && !Array.isArray(v)) { for (const key of Object.keys(v)) add(key, v[key]); }
    else add(VALUE_COL, v);
  }
  return [...cols.values()].map(c => ({
    name: c.name,
    type: typeName(c.kinds),
    fill: n ? Math.round((c.present / n) * 1000) / 10 : 0,
    kinds: c.kinds,
  }));
}

function typeName(kinds) {
  const ks = Object.keys(kinds).filter(k => k !== 'null');
  if (!ks.length) return 'null';
  if (ks.length === 1) return ks[0];
  if (ks.every(k => k === 'int' || k === 'float')) return 'float';
  return 'mixed';
}

/** Short display text for a cell. Returns null for JSON null and undefined for a missing key. */
function cellText(v) {
  if (v === undefined) return undefined;
  if (v === null) return null;
  let s;
  if (typeof v === 'string') s = v;
  else if (typeof v === 'object') s = JSON.stringify(v);
  else s = String(v);
  return s.length > L.CELL_CHARS ? s.slice(0, L.CELL_CHARS) + '…' : s;
}

/** One table row for the webview. rec = {i, line, text, truncated, len}. */
function tableRow(rec, columns) {
  const row = { i: rec.i, line: rec.line };
  if (rec.truncated) {
    row.trunc = rec.len;
    row.preview = rec.text.slice(0, L.CELL_CHARS);
    return row;
  }
  const p = parseLine(rec.text);
  if (!p.ok) {
    row.bad = p.error;
    row.preview = rec.text.slice(0, L.CELL_CHARS);
    return row;
  }
  const v = p.value;
  const isObj = v && typeof v === 'object' && !Array.isArray(v);
  row.cells = columns.map(c => cellText(isObj ? (Object.prototype.hasOwnProperty.call(v, c.name) ? v[c.name] : undefined) : c.name === VALUE_COL ? v : undefined));
  row.kinds = columns.map(c => {
    const x = isObj ? (Object.prototype.hasOwnProperty.call(v, c.name) ? v[c.name] : undefined) : c.name === VALUE_COL ? v : undefined;
    return x === undefined ? 'missing' : kindOf(x);
  });
  if (isObj) {
    let extra = 0;
    for (const k of Object.keys(v)) if (!columns.some(c => c.name === k)) extra++;
    if (extra) row.extra = extra;
  }
  return row;
}

/** Does the column set look like a chat dataset? Returns the chat shape or ''. */
function chatShape(columns) {
  const by = new Map(columns.map(c => [c.name, c]));
  for (const k of ['messages', 'conversations', 'conversation', 'contents', 'chat', 'dialog']) {
    const c = by.get(k);
    if (c && c.kinds.array) return 'messages';
  }
  if (by.has('role') && (by.has('content') || by.has('parts') || by.has('text'))) return 'turns';
  if (by.has('type') && by.has('message')) return 'turns'; // agent session logs: {type, message:{role, content}}
  if (by.has('prompt') && (by.has('completion') || by.has('response') || by.has('chosen'))) return 'messages';
  return '';
}

module.exports = { inferColumns, tableRow, cellText, kindOf, parseLine, chatShape, VALUE_COL };
