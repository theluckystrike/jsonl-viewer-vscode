'use strict';
// A small filter language for records:
//   level == "error"     ctx.user.id != 7     score >= 0.5     msg contains timeout
//   tags[0] == smoke     error exists         error missing    level == error and score < 1
// Values are JSON when they parse (numbers, true, false, null, "quoted"), else plain text.

const OPS = ['==', '!=', '>=', '<=', '>', '<', '!contains', 'contains', 'exists', 'missing', '=~'];

class FilterError extends Error {}

/** Parse a key path such as a.b[2]["odd key"].c into segments. */
function parsePath(src) {
  const segs = [];
  let i = 0;
  const s = src.trim();
  if (s.startsWith('$')) i = 1;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '.') { i++; continue; }
    if (ch === '[') {
      const close = s.indexOf(']', i);
      if (close < 0) throw new FilterError(`Missing ] in "${src}"`);
      const inner = s.slice(i + 1, close).trim();
      if (/^\d+$/.test(inner)) segs.push(Number(inner));
      else if (/^(['"]).*\1$/.test(inner)) segs.push(inner.slice(1, -1));
      else throw new FilterError(`Use a number or a quoted key inside [ ] in "${src}"`);
      i = close + 1;
      continue;
    }
    let j = i;
    while (j < s.length && s[j] !== '.' && s[j] !== '[') j++;
    segs.push(s.slice(i, j));
    i = j;
  }
  if (!segs.length) throw new FilterError('Start with a key, for example: level == error');
  return segs;
}

function getPath(v, segs) {
  let cur = v;
  for (const k of segs) {
    if (cur === null || typeof cur !== 'object') return undefined;
    if (typeof k === 'number') { if (!Array.isArray(cur)) return undefined; cur = cur[k]; }
    else { if (!Object.prototype.hasOwnProperty.call(cur, k)) return undefined; cur = cur[k]; }
  }
  return cur;
}

function literal(raw) {
  const t = raw.trim();
  if (t === '') return '';
  try { return JSON.parse(t); } catch { /* plain text */ }
  if (/^'.*'$/.test(t)) return t.slice(1, -1);
  return t;
}

function parseClause(src) {
  const s = src.trim();
  // key op value, where op is a symbol or a word surrounded by spaces
  const m = s.match(/^(.+?)\s*(==|!=|>=|<=|=~|>|<)\s*(.*)$/) || s.match(/^(.+?)\s+(!contains|contains|exists|missing)(?:\s+(.*))?$/i);
  if (!m) throw new FilterError(`Could not read "${s}". Try: key == value, key contains text, key exists`);
  const op = m[2].toLowerCase();
  const rest = (m[3] || '').trim();
  if ((op === 'exists' || op === 'missing') && rest) throw new FilterError(`"${op}" takes no value`);
  if (op !== 'exists' && op !== 'missing' && rest === '') throw new FilterError(`Add a value after ${op}`);
  const clause = { path: parsePath(m[1]), op, value: literal(rest), raw: rest };
  if (op === '=~') {
    const rm = rest.match(/^\/(.*)\/([imsu]*)$/);
    try { clause.re = rm ? new RegExp(rm[1], rm[2]) : new RegExp(rest, 'i'); }
    catch (e) { throw new FilterError('Bad pattern: ' + e.message); }
  }
  if (op === 'contains' || op === '!contains') clause.needle = String(clause.value === null ? 'null' : typeof clause.value === 'object' ? JSON.stringify(clause.value) : clause.value).toLowerCase();
  return clause;
}

/** Parse "a == 1 and b contains x" into clauses. Empty input gives null (no filter). */
function parseFilter(src) {
  if (!src || !src.trim()) return null;
  if (src.length > 2000) throw new FilterError('The filter is too long');
  return src.split(/\s+and\s+/i).map(parseClause);
}

function asText(v) {
  if (v === undefined) return '';
  if (v === null) return 'null';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

function equal(a, b) {
  if (a === b) return true;
  if (a === undefined) return false;
  if (typeof a === 'object' || typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
  return asText(a) === asText(b);
}

function compare(a, b) {
  const na = typeof a === 'number' ? a : typeof a === 'string' && a.trim() !== '' ? Number(a) : NaN;
  const nb = typeof b === 'number' ? b : typeof b === 'string' && b.trim() !== '' ? Number(b) : NaN;
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  const sa = asText(a), sb = asText(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function testClause(c, rec) {
  const v = getPath(rec, c.path);
  switch (c.op) {
    case 'exists': return v !== undefined;
    case 'missing': return v === undefined;
    case '==': return equal(v, c.value);
    case '!=': return !equal(v, c.value);
    case 'contains': return v !== undefined && asText(v).toLowerCase().includes(c.needle);
    case '!contains': return v === undefined || !asText(v).toLowerCase().includes(c.needle);
    case '=~': return v !== undefined && c.re.test(asText(v));
    default: {
      if (v === undefined || v === null) return false;
      const d = compare(v, c.value);
      return c.op === '>' ? d > 0 : c.op === '>=' ? d >= 0 : c.op === '<' ? d < 0 : d <= 0;
    }
  }
}

function testFilter(clauses, rec) {
  for (const c of clauses) if (!testClause(c, rec)) return false;
  return true;
}

module.exports = { parseFilter, testFilter, parsePath, getPath, compare, FilterError, OPS };
