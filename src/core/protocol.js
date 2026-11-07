'use strict';
// Message protocol between the webview and the extension host, and the session that serves it.
// Kept free of the vscode module so it can be tested in plain Node.
//
// webview -> host: ready, getRows, getRecords, search, cancel, sort, clearView, showBad,
//                  nextBad, gotoLine, export, openLine, copy, openAsText
// host -> webview: init, progress, columns, rows, records, job, view, bad, grew, reset, error, found, toast

const L = require('./limits');
const { JsonlDoc, fmtBytes } = require('./doc');
const { inferColumns, tableRow, parseLine, chatShape, VALUE_COL, cellText } = require('./schema');
const { parseFilter, testFilter, getPath, FilterError } = require('./filter');
const { csvHeader, csvRow } = require('./exportfile');

const int = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const str = (v, max) => typeof v === 'string' && v.length <= max;

/** Validate a message from the webview. Returns a clean copy or null. */
function validateWebviewMessage(m) {
  if (!m || typeof m !== 'object' || typeof m.type !== 'string') return null;
  const BIG = 0xffffffff;
  switch (m.type) {
    case 'ready': case 'cancel': case 'clearView': case 'showBad': case 'openAsText':
      return { type: m.type };
    case 'getRows':
      return int(m.reqId, 0, BIG) && int(m.start, 0, BIG) && int(m.count, 1, L.PAGE) ? { type: m.type, reqId: m.reqId, start: m.start, count: m.count } : null;
    case 'getRecords':
      return int(m.reqId, 0, BIG) && int(m.start, 0, BIG) && int(m.count, 1, 100) ? { type: m.type, reqId: m.reqId, start: m.start, count: m.count } : null;
    case 'search':
      return str(m.text || '', 2000) && str(m.filter || '', 2000) ? { type: m.type, text: m.text || '', filter: m.filter || '' } : null;
    case 'sort':
      if (m.col === null) return { type: m.type, col: null, dir: null };
      return str(m.col, 1000) && (m.dir === 'asc' || m.dir === 'desc') ? { type: m.type, col: m.col, dir: m.dir } : null;
    case 'nextBad':
      return int(m.after, -1, BIG) ? { type: m.type, after: m.after } : null;
    case 'gotoLine':
      return int(m.line, 1, BIG) ? { type: m.type, line: m.line } : null;
    case 'export':
      if (!['csv', 'json', 'jsonl'].includes(m.format)) return null;
      if (Array.isArray(m.hidden) && m.hidden.length && m.hidden.length <= 1000 && m.hidden.every(h => str(h, 1000))) return { type: m.type, format: m.format, hidden: m.hidden.slice() };
      return { type: m.type, format: m.format };
    case 'openLine':
      return int(m.index, 0, BIG) ? { type: m.type, index: m.index } : null;
    case 'copy':
      return str(m.text, 10 * 1024 * 1024) ? { type: m.type, text: m.text } : null;
    default:
      return null;
  }
}

const tick = () => new Promise(r => setImmediate(r));

/**
 * One open file. post(msg) sends to the webview. host = {
 *   openLine(line, text, doc), copy(text), openAsText(), openWriter(format, defaultName) -> {write, close, label} | null,
 *   info(text), makeDoc() -> JsonlDoc }
 */
function createSession({ doc, post, host = {} }) {
  const S = {
    doc,
    ready: false, // init sent
    columns: [],
    sampled: 0,
    chat: '',
    view: null, // null = all records, else Uint32Array of record indices
    viewLabel: '',
    viewVersion: 0,
    criteria: null, // {text, clauses} of the active search
    sort: null,
    job: null,
    bad: { ids: [], count: 0, truncated: 0, checked: 0, done: false },
    validating: null,
    error: '',
    disposed: false,
  };

  const viewCount = () => (S.view ? S.view.length : S.doc.count);
  const idAt = pos => (S.view ? S.view[pos] : pos);

  async function sample() {
    const n = Math.min(S.doc.count, L.SCHEMA_SAMPLE);
    const ids = Array.from({ length: n }, (_, i) => i);
    const recs = n ? await S.doc.readRecords(ids) : [];
    const values = [];
    for (const r of recs) { if (r.truncated) continue; const p = parseLine(r.text); if (p.ok) values.push(p.value); }
    S.columns = inferColumns(values);
    S.sampled = n;
    S.sampledOk = values.length;
    S.chat = chatShape(S.columns);
  }

  function initMsg() {
    const d = S.doc;
    return {
      type: 'init', name: d.name, format: d.format, size: d.size, sizeText: fmtBytes(d.size), unpacked: d.gz ? d.bytes : 0,
      columns: S.columns, chat: S.chat, sampled: S.sampled || 0, sampledOk: S.sampledOk || 0, count: d.count, done: d.done, ms: d.indexMs, capped: d.capped, tail: d.canTail,
      viewCount: viewCount(), viewVersion: S.viewVersion, viewLabel: S.viewLabel, sort: S.sort, bad: badMsg(), error: S.error,
      limits: { line: L.MAX_LINE_BYTES, file: L.MAX_FILE_BYTES, page: L.PAGE },
    };
  }

  function badMsg() {
    const b = S.bad;
    return { count: b.count, truncated: b.truncated, checked: b.checked, done: b.done };
  }

  async function start() {
    try {
      await S.doc.open({
        onProgress: p => { if (S.ready && !S.disposed) post({ type: 'progress', ...p, viewCount: viewCount() }); },
      });
    } catch (e) {
      S.error = e.code === 'TOO_BIG' ? e.message : 'Could not open the file: ' + e.message;
      post({ type: 'error', fatal: true, message: S.error });
      return;
    }
    await sample();
    S.ready = true;
    post(initMsg());
    try { await S.doc.whenDone; } catch (e) { post({ type: 'error', message: 'Reading stopped: ' + e.message }); }
    if (S.disposed) return;
    if (S.sampled < Math.min(S.doc.count, L.SCHEMA_SAMPLE)) { await sample(); post({ type: 'columns', columns: S.columns, chat: S.chat, sampled: S.sampled, sampledOk: S.sampledOk }); }
    post({ type: 'progress', ...S.doc.progress(), capped: S.doc.capped, viewCount: viewCount() });
    validate(0);
  }

  /** Background pass that parses every line to count bad and truncated lines. */
  function validate(from) {
    if (S.validating) S.validating.cancelled = true;
    const tok = { cancelled: false };
    S.validating = tok;
    const b = S.bad;
    if (from === 0) { b.ids = []; b.count = 0; b.truncated = 0; }
    else {
      while (b.ids.length && b.ids[b.ids.length - 1] >= from) { b.ids.pop(); b.count--; }
    }
    b.checked = from;
    b.done = false;
    (async () => {
      let last = 0;
      await scan(from, S.doc.count, (rec) => {
        if (rec.truncated) { if (rec.i >= from) b.truncated++; return; }
        try { JSON.parse(rec.text); } catch { b.count++; if (b.ids.length < 1e6) b.ids.push(rec.i); }
      }, tok, (done) => {
        b.checked = done;
        const now = Date.now();
        if (now - last > 300) { last = now; post({ type: 'bad', ...badMsg() }); }
      });
      if (tok.cancelled || S.disposed) return;
      b.checked = S.doc.count;
      b.done = true;
      post({ type: 'bad', ...badMsg() });
    })().catch(e => post({ type: 'error', message: 'Line check stopped: ' + e.message }));
  }

  /** Read records [from, to) (or the positions of ids) in batches and call fn(rec). Yields between batches. */
  async function scan(from, to, fn, tok, onProgress, ids) {
    const BATCH = 2000;
    // to === Infinity: every record, following the index while it is still being built
    const follow = to === Infinity;
    for (let p = from; ; p += BATCH) {
      if (follow) {
        while (p >= S.doc.count && !S.doc.done && !tok.cancelled && !S.disposed) {
          await Promise.race([S.doc.whenDone.catch(() => {}), new Promise(r => setTimeout(r, 50))]);
        }
        to = S.doc.count;
      }
      if (p >= to) break;
      if (tok.cancelled || S.disposed) return false;
      const n = Math.min(BATCH, to - p);
      const batch = new Array(n);
      for (let k = 0; k < n; k++) batch[k] = ids ? ids[p + k] : p + k;
      const recs = await S.doc.readRecords(batch);
      for (const r of recs) fn(r);
      if (onProgress) onProgress(p + n);
      await tick();
    }
    return true;
  }

  function setView(view, label) {
    S.view = view;
    S.viewLabel = label;
    S.viewVersion++;
    post({ type: 'view', count: viewCount(), version: S.viewVersion, label, sort: S.sort, criteria: S.criteria ? { text: S.criteria.text, filter: S.criteria.filter } : null });
  }

  /** Record count, or an estimate from the bytes read so far while indexing. */
  function estTotal() {
    const d = S.doc;
    if (d.done || !d.size || !d.bytes || d.gz) return d.count;
    return Math.max(d.count, Math.round(d.count * d.size / d.bytes));
  }

  function cancelJob() { if (S.job) S.job.cancelled = true; }

  function matcher(text, clauses) {
    const q = text.toLowerCase();
    return (rec) => {
      if (q && !rec.text.toLowerCase().includes(q)) return false;
      if (!clauses) return true;
      if (rec.truncated) return false;
      const p = parseLine(rec.text);
      return p.ok && testFilter(clauses, p.value);
    };
  }

  async function search(text, filter) {
    let clauses = null;
    try { clauses = parseFilter(filter); } catch (e) {
      post({ type: 'job', kind: 'search', state: 'error', message: e instanceof FilterError ? e.message : String(e.message) });
      return;
    }
    cancelJob();
    S.sort = null;
    if (!text && !clauses) { S.criteria = null; setView(null, ''); post({ type: 'job', kind: 'search', state: 'done', matches: S.doc.count }); return; }
    const tok = { cancelled: false };
    S.job = tok;
    const test = matcher(text, clauses);
    let out = new Uint32Array(1024), n = 0, last = 0;
    const t0 = Date.now();
    const ok = await scan(0, Infinity, (rec) => {
      if (!test(rec)) return;
      if (n === out.length) { if (n >= L.MAX_VIEW) return; const g = new Uint32Array(n * 2); g.set(out); out = g; }
      out[n++] = rec.i;
    }, tok, (done) => {
      const now = Date.now();
      if (now - last > 150) { last = now; post({ type: 'job', kind: 'search', state: 'running', done, total: estTotal(), matches: n }); }
    });
    const total = S.doc.count;
    if (S.disposed) return;
    if (S.job === tok) S.job = null;
    if (!ok && S.job && S.job !== tok) return; // replaced by a newer job
    S.criteria = { text, filter, clauses };
    const label = describe(text, filter) + (ok ? '' : ' (stopped early)');
    setView(out.slice(0, n), label);
    post({ type: 'job', kind: 'search', state: ok ? 'done' : 'cancelled', matches: n, total, ms: Date.now() - t0 });
  }

  function describe(text, filter) {
    const parts = [];
    if (text) parts.push(`text "${text}"`);
    if (filter) parts.push(`filter ${filter}`);
    return parts.join(' and ');
  }

  async function sort(col, dir) {
    cancelJob();
    if (!S.doc.done) { post({ type: 'job', kind: 'sort', state: 'running', done: 0, total: estTotal() }); await S.doc.whenDone.catch(() => {}); }
    if (!col) { S.sort = null; return S.criteria ? search(S.criteria.text, S.criteria.filter) : setView(null, ''); }
    const total = viewCount();
    if (total > L.MAX_SORT) {
      post({ type: 'job', kind: 'sort', state: 'error', message: `Sort works on up to ${L.MAX_SORT.toLocaleString('en-US')} records. Filter first.` });
      return;
    }
    const tok = { cancelled: false };
    S.job = tok;
    const ids = S.view ? S.view : null;
    const keys = new Array(total);
    let k = 0, last = 0;
    const path = col === VALUE_COL ? [] : [col];
    const ok = await scan(0, total, (rec) => {
      let v;
      if (!rec.truncated) { const p = parseLine(rec.text); if (p.ok) v = path.length ? getPath(p.value, path) : p.value; }
      keys[k++] = { i: rec.i, g: v === undefined || v === null ? 2 : typeof v === 'number' ? 0 : 1, v: typeof v === 'number' ? v : v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v) };
    }, tok, (done) => {
      const now = Date.now();
      if (now - last > 150) { last = now; post({ type: 'job', kind: 'sort', state: 'running', done, total }); }
    }, ids);
    if (S.job === tok) S.job = null;
    if (!ok || S.disposed) { post({ type: 'job', kind: 'sort', state: 'cancelled' }); return; }
    const sign = dir === 'desc' ? -1 : 1;
    keys.sort((a, b) => {
      if (a.g !== b.g) return a.g - b.g; // missing and null always last
      if (a.v < b.v) return -sign;
      if (a.v > b.v) return sign;
      return a.i - b.i;
    });
    const out = new Uint32Array(keys.length);
    for (let q = 0; q < keys.length; q++) out[q] = keys[q].i;
    S.sort = { col, dir };
    setView(out, S.viewLabel || '');
    post({ type: 'job', kind: 'sort', state: 'done', total });
  }

  async function getRows(m) {
    const total = viewCount();
    const end = Math.min(total, m.start + m.count);
    const ids = [];
    for (let p = m.start; p < end; p++) ids.push(idAt(p));
    const version = S.viewVersion;
    const recs = ids.length ? await S.doc.readRecords(ids) : [];
    post({ type: 'rows', reqId: m.reqId, version, start: m.start, rows: recs.map(r => tableRow(r, S.columns)) });
  }

  async function getRecords(m) {
    const total = viewCount();
    const end = Math.min(total, m.start + m.count);
    const ids = [];
    for (let p = m.start; p < end; p++) ids.push(idAt(p));
    const recs = ids.length ? await S.doc.readRecords(ids) : [];
    let budget = L.RECORD_SEND_BYTES + 3 * 1024 * 1024;
    const out = recs.map((r, k) => {
      const base = { pos: m.start + k, i: r.i, line: r.line, len: r.len };
      if (r.truncated || r.text.length > L.RECORD_SEND_BYTES || budget <= 0) {
        return { ...base, big: true, raw: r.text.slice(0, Math.max(0, Math.min(64 * 1024, budget))) };
      }
      budget -= r.text.length;
      const p = parseLine(r.text);
      return p.ok ? { ...base, value: p.value } : { ...base, bad: p.error, raw: r.text };
    });
    post({ type: 'records', reqId: m.reqId, version: S.viewVersion, start: m.start, records: out });
  }

  function posOf(id) {
    if (!S.view) return id < S.doc.count ? id : -1;
    for (let p = 0; p < S.view.length; p++) if (S.view[p] === id) return p;
    return -1;
  }

  function nextBad(after) {
    // after is a view position; find the next bad record shown after it
    const bad = S.bad.ids;
    if (!bad.length) return post({ type: 'found', what: 'bad', pos: -1 });
    if (!S.view) {
      let lo = 0, hi = bad.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (bad[mid] <= after) lo = mid + 1; else hi = mid; }
      const id = lo < bad.length ? bad[lo] : bad[0];
      return post({ type: 'found', what: 'bad', pos: id, line: S.doc.index.lineOf(id), wrapped: lo >= bad.length });
    }
    const set = new Set(bad);
    for (let k = 1; k <= S.view.length; k++) {
      const p = (after + k) % S.view.length;
      if (set.has(S.view[p])) return post({ type: 'found', what: 'bad', pos: p, line: S.doc.index.lineOf(S.view[p]), wrapped: p <= after });
    }
    post({ type: 'found', what: 'bad', pos: -1 });
  }

  async function doExport(format, hidden) {
    const hide = new Set(hidden || []);
    let cols = S.columns.filter(c => !hide.has(c.name));
    if (!cols.length) cols = S.columns;
    if (!host.openWriter) return;
    const base = S.doc.name.replace(/\.gz$/i, '').replace(/\.(jsonl|ndjson|jsonlines)$/i, '');
    const w = await host.openWriter(format, `${base}${S.view ? '-filtered' : ''}.${format}`);
    if (!w) return;
    cancelJob();
    if (!S.doc.done) await S.doc.whenDone.catch(() => {});
    const tok = { cancelled: false };
    S.job = tok;
    const total = viewCount();
    let written = 0, skipped = 0, first = true, last = 0;
    let buf = '';
    const flush = async () => { if (buf) { const s = buf; buf = ''; await w.write(s); } };
    try {
      if (format === 'csv') buf += csvHeader(cols);
      if (format === 'json') buf += '[\n';
      let stopped = false;
      for (let pos = 0; pos < total && !stopped; pos += 2000) {
        if (tok.cancelled || S.disposed) { stopped = true; break; }
        const n = Math.min(2000, total - pos);
        const ids = new Array(n);
        for (let k = 0; k < n; k++) ids[k] = idAt(pos + k);
        const recs = await S.doc.readRecords(ids);
        for (const rec of recs) {
          if (rec.truncated) { skipped++; continue; }
          const p = parseLine(rec.text);
          if (!p.ok) { skipped++; continue; }
          if (format === 'csv') buf += csvRow(p.value, cols, VALUE_COL);
          else if (format === 'jsonl') buf += rec.text + '\n';
          else { buf += (first ? '  ' : ',\n  ') + rec.text; first = false; }
          written++;
        }
        if (buf.length > 1024 * 1024) await flush();
        const now = Date.now();
        if (now - last > 200) { last = now; post({ type: 'job', kind: 'export', state: 'running', done: pos + n, total }); }
        await tick();
      }
      if (stopped) {
        await w.close();
        if (S.job === tok) S.job = null;
        post({ type: 'job', kind: 'export', state: 'cancelled', written });
        return;
      }
      if (format === 'json') buf += first ? ']\n' : '\n]\n';
      await flush();
      await w.close();
      if (S.job === tok) S.job = null;
      post({ type: 'job', kind: 'export', state: 'done', total, written, skipped });
      if (host.info) host.info(`Saved ${written.toLocaleString('en-US')} records to ${w.label}${skipped ? ` (${skipped} bad or truncated lines skipped)` : ''}.`);
    } catch (e) {
      if (S.job === tok) S.job = null;
      post({ type: 'job', kind: 'export', state: 'error', message: 'Export failed: ' + e.message });
    }
  }

  async function onFileChange() {
    if (!S.ready || S.disposed) return;
    let r;
    try { r = await S.doc.tail(); } catch (e) { return; }
    if (!r) return;
    if (r === 'reset') return reset();
    const { from, count } = r;
    if (S.sampled < L.SCHEMA_SAMPLE && count > S.sampled) {
      await sample();
      post({ type: 'columns', columns: S.columns, chat: S.chat });
    }
    if (S.view && S.criteria) {
      const test = matcher(S.criteria.text, S.criteria.clauses);
      let arr = Array.from(S.view);
      if (arr.length && arr[arr.length - 1] >= from) arr = arr.filter(id => id < from);
      const keepFrom = arr.length;
      await scan(from, count, rec => { if (test(rec)) arr.push(rec.i); }, { cancelled: false });
      S.view = Uint32Array.from(arr);
      post({ type: 'grew', count: viewCount(), from: Math.min(keepFrom, viewCount()), total: count, size: S.doc.size });
    } else if (S.view) {
      // a sorted view of all records: new records go at the end
      const arr = Array.from(S.view).filter(id => id < from);
      for (let i = from; i < count; i++) arr.push(i);
      S.view = Uint32Array.from(arr);
      post({ type: 'grew', count: viewCount(), from: Math.max(0, viewCount() - (count - from)), total: count, size: S.doc.size });
    } else {
      post({ type: 'grew', count, from, total: count, size: S.doc.size });
    }
    validate(Math.min(from, S.bad.checked));
  }

  async function reset() {
    cancelJob();
    if (S.validating) S.validating.cancelled = true;
    await S.doc.close();
    if (!host.makeDoc) return;
    S.doc = host.makeDoc();
    S.view = null; S.viewLabel = ''; S.criteria = null; S.sort = null; S.viewVersion++;
    S.bad = { ids: [], count: 0, truncated: 0, checked: 0, done: false };
    S.ready = false;
    post({ type: 'reset' });
    await start();
  }

  async function handle(raw) {
    const m = validateWebviewMessage(raw);
    if (!m || S.disposed) return;
    if (m.type === 'ready') { if (S.ready) post(initMsg()); else if (S.error) post({ type: 'error', fatal: true, message: S.error }); return; }
    if (!S.ready) return;
    try {
      switch (m.type) {
        case 'getRows': return await getRows(m);
        case 'getRecords': return await getRecords(m);
        case 'search': return await search(m.text, m.filter);
        case 'cancel': return cancelJob();
        case 'sort': return await sort(m.col, m.dir);
        case 'clearView': cancelJob(); S.criteria = null; S.sort = null; return setView(null, '');
        case 'showBad': {
          cancelJob(); S.criteria = null; S.sort = null;
          return setView(Uint32Array.from(S.bad.ids), `${S.bad.ids.length.toLocaleString('en-US')} bad lines`);
        }
        case 'nextBad': return nextBad(m.after);
        case 'gotoLine': {
          const id = S.doc.index.recordOfLine(m.line);
          if (id < 0) return post({ type: 'found', what: 'line', pos: -1, line: m.line });
          return post({ type: 'found', what: 'line', pos: posOf(id), line: m.line });
        }
        case 'export': return await doExport(m.format, m.hidden);
        case 'openLine': {
          if (m.index >= S.doc.count) return;
          const [rec] = await S.doc.readRecords([m.index]);
          if (host.openLine) await host.openLine(rec.line, rec.text, S.doc);
          return;
        }
        case 'copy': if (host.copy) await host.copy(m.text); return;
        case 'openAsText': if (host.openAsText) await host.openAsText(); return;
      }
    } catch (e) {
      post({ type: 'error', message: e.message });
    }
  }

  async function dispose() {
    S.disposed = true;
    cancelJob();
    if (S.validating) S.validating.cancelled = true;
    await S.doc.close();
  }

  return { start, handle, onFileChange, dispose, state: S, cellText };
}

module.exports = { validateWebviewMessage, createSession, JsonlDoc };
