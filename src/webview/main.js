'use strict';
/* global acquireVsCodeApi */
// JSONL Viewer webview. File content goes into the DOM through textContent only.
const M = require('./math');
const { chatTurns, chatMeta } = require('../core/chat');
const { pathString } = require('../core/jsonpath');

const vscode = acquireVsCodeApi();
const saved = vscode.getState() || {};
const ROW_H = 24;
const HEAD_H = 40;
const PAGE = 200;
const MAX_COLS = 300;
const NUMERIC = new Set(['int', 'float']);

const S = {
  name: document.getElementById('app').dataset.title || '',
  format: '',
  columns: [],
  widths: [],
  count: 0, // rows in the current view
  total: 0, // records in the file
  version: 0,
  cache: new Map(),
  pending: new Set(),
  reqId: 1,
  waiters: new Map(),
  mode: saved.mode || 'table',
  focus: -1,
  done: false,
  chat: '',
  bad: { count: 0, truncated: 0, done: false },
  sort: null,
  label: '',
  tail: false,
  follow: false,
  gutterW: 64,
  info: null,
  fatal: '',
  job: null,
};

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = String(text);
  return e;
}
function btn(text, title, cls) { const b = el('button', 'btn' + (cls ? ' ' + cls : ''), text); if (title) b.title = title; return b; }
function fmtN(n) { return Number(n).toLocaleString('en-US'); }
function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n, k = -1;
  do { v /= 1024; k++; } while (v >= 1024 && k < u.length - 1);
  return (v >= 100 ? v.toFixed(0) : v.toFixed(1)) + ' ' + u[k];
}
function fmtMs(ms) { return ms < 1000 ? `${Math.max(1, Math.round(ms))} ms` : `${(ms / 1000).toFixed(2)} s`; }
function post(m) { vscode.postMessage(m); }
function saveState() { vscode.setState({ mode: S.mode }); }

// ---------- layout ----------
const app = document.getElementById('app');
const toolbar = el('div', 'toolbar');
const title = el('span', 'title', S.name);
const fmtBadge = el('span', 'fmt');
const stats = el('span', 'stats');
const tabs = el('div', 'tabs');
tabs.setAttribute('role', 'tablist');
const tabTable = btn('Table', 'One row per record, one column per key (T)', 'tab');
const tabRecord = btn('Record', 'The selected record as a JSON tree (R)', 'tab');
const tabChat = btn('Chat', 'Messages as a conversation (C)', 'tab');
tabs.append(tabTable, tabRecord, tabChat);
const btnText = btn('Open as Text', 'Open the file in the normal text editor');
toolbar.append(title, fmtBadge, stats, el('span', 'spacer'), tabs, btnText);

const findbar = el('div', 'findbar');
const search = el('input', 'search');
search.type = 'search';
search.placeholder = 'Find text in any line';
search.setAttribute('aria-label', 'Find text');
search.spellcheck = false;
const filter = el('input', 'filter');
filter.placeholder = 'Filter: level == error and ctx.ms > 500';
filter.title = 'key == value, key != value, key > 5, key contains text, key =~ regex, key exists, key missing. Join with "and". Nested keys: a.b[0].c';
filter.setAttribute('aria-label', 'Filter');
filter.spellcheck = false;
const btnRun = btn('Find', 'Search the whole file (Enter)', 'primary');
const btnCancel = btn('Cancel', 'Stop the search');
btnCancel.hidden = true;
const jobText = el('span', 'jobtext');
const lineInput = el('input', 'lineinput');
lineInput.placeholder = 'Line #';
lineInput.setAttribute('aria-label', 'Go to line');
lineInput.inputMode = 'numeric';
const btnFollow = btn('Follow', 'Live tail: jump to new records as the file grows');
btnFollow.hidden = true;
const exportSel = el('select', 'export');
exportSel.setAttribute('aria-label', 'Export');
for (const [v, t] of [['', 'Export…'], ['csv', 'CSV'], ['json', 'JSON array'], ['jsonl', 'JSON Lines']]) { const o = el('option', null, t); o.value = v; exportSel.append(o); }
exportSel.title = 'Save the records in view (after Find and sort) to a file';
findbar.append(search, filter, btnRun, btnCancel, jobText, el('span', 'spacer'), lineInput, btnFollow, exportSel);

const banner = el('div', 'banner');
banner.hidden = true;
const bannerText = el('span', 'btext');
const bannerAct = btn('Show all', 'Clear the search, filter and sort', 'link');
banner.append(bannerText, bannerAct);

const main = el('div', 'main');
// table
const grid = el('div', 'grid');
grid.tabIndex = 0;
grid.setAttribute('role', 'grid');
const sizer = el('div', 'sizer');
const stage = el('div', 'stage');
const head = el('div', 'head');
const body = el('div', 'body');
stage.append(head, body);
sizer.append(stage);
grid.append(sizer);
// detail drawer for one cell
const drawer = el('div', 'drawer');
drawer.hidden = true;
const drawerBar = el('div', 'navbar');
const drawerTitle = el('span', 'navtitle');
const drawerCopy = btn('Copy value', 'Copy this value as JSON');
const drawerPath = btn('Copy JSONPath', 'Copy the JSONPath of this cell');
const drawerClose = btn('Close', 'Close (Esc)');
drawerBar.append(drawerTitle, el('span', 'spacer'), drawerPath, drawerCopy, drawerClose);
const drawerBody = el('div', 'tree');
drawer.append(drawerBar, drawerBody);
const tablePane = el('div', 'pane tablepane');
tablePane.append(grid, drawer);
// record and chat
const recPane = el('div', 'pane recpane');
const recBar = el('div', 'navbar');
const btnPrev = btn('◀ Prev', 'Previous record (←)');
const btnNext = btn('Next ▶', 'Next record (→)');
const recTitle = el('span', 'navtitle');
const btnCopyRec = btn('Copy JSON', 'Copy the record as formatted JSON');
const btnOpenLine = btn('Open line in editor', 'Open this line in the text editor');
const btnExpand = btn('Expand all', 'Open every level of the tree');
recBar.append(btnPrev, btnNext, recTitle, el('span', 'spacer'), btnExpand, btnCopyRec, btnOpenLine);
const recBody = el('div', 'recbody');
recPane.append(recBar, recBody);
const fatalBox = el('div', 'fatal');
fatalBox.hidden = true;
main.append(tablePane, recPane, fatalBox);

const status = el('div', 'status');
const statusLeft = el('span', 'left');
const statusMid = el('span', 'mid');
const badBtn = btn('', 'Show only the lines that are not valid JSON', 'link');
const nextBadBtn = btn('Next bad line', 'Jump to the next line that is not valid JSON', 'link');
badBtn.hidden = nextBadBtn.hidden = true;
const badText = el('span', 'badtext');
statusMid.append(badText, badBtn, nextBadBtn);
const statusRight = el('span', 'right');
status.append(statusLeft, statusMid, statusRight);
const toast = el('div', 'toast');
toast.hidden = true;
app.append(toolbar, findbar, banner, main, status, toast);
// The host renders the Sponsor and More free viewers line (or leaves it out when the setting hides it).
const supportLine = document.getElementById('zovo-support');
if (supportLine) status.append(supportLine);

let toastTimer = null;
function flash(text) {
  toast.textContent = text;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 1800);
}
function copy(text, what) { post({ type: 'copy', text }); flash(what ? `Copied ${what}` : 'Copied'); }

// ---------- modes ----------
function setMode(mode) {
  if (mode === 'chat' && !S.chat) mode = S.mode === 'chat' ? 'table' : S.mode;
  S.mode = mode;
  tabTable.classList.toggle('on', mode === 'table');
  tabRecord.classList.toggle('on', mode === 'record');
  tabChat.classList.toggle('on', mode === 'chat');
  tabTable.setAttribute('aria-selected', String(mode === 'table'));
  tabRecord.setAttribute('aria-selected', String(mode === 'record'));
  tabChat.setAttribute('aria-selected', String(mode === 'chat'));
  tablePane.hidden = mode !== 'table' || !!S.fatal;
  recPane.hidden = mode === 'table' || !!S.fatal;
  btnExpand.hidden = mode !== 'record';
  saveState();
  if (mode === 'table') { layout(); if (S.focus >= 0) ensureVisible(S.focus); grid.focus(); }
  else { if (S.focus < 0 && S.count) S.focus = 0; showRecord(); }
  updateStatus();
}
tabTable.addEventListener('click', () => setMode('table'));
tabRecord.addEventListener('click', () => setMode('record'));
tabChat.addEventListener('click', () => setMode('chat'));
btnText.addEventListener('click', () => post({ type: 'openAsText' }));

// ---------- header ----------
function typeLabel(c) { return `${c.type} · ${c.fill}%`; }
function totalWidth() { return S.gutterW + S.widths.reduce((a, b) => a + b, 0); }
function shownCols() { return Math.min(S.columns.length, MAX_COLS); }

function buildHeader() {
  head.textContent = '';
  const corner = el('div', 'cell gutter corner', 'line');
  head.append(corner);
  for (let c = 0; c < shownCols(); c++) {
    const col = S.columns[c];
    const h = el('div', 'cell hcell');
    h.style.width = S.widths[c] + 'px';
    const top = el('div', 'hrow');
    top.append(el('span', 'hname', col.name));
    const arrow = el('span', 'sort', S.sort && S.sort.col === col.name ? (S.sort.dir === 'asc' ? '▲' : '▼') : '');
    top.append(arrow);
    const sub = el('div', 'hsub');
    sub.append(el('span', 'htype t-' + col.type, col.type), el('span', 'hfill' + (col.fill < 100 ? ' part' : ''), col.fill + '%'));
    h.append(top, sub);
    const kinds = Object.entries(col.kinds || {}).map(([k, n]) => `${k} ${fmtN(n)}`).join(', ');
    h.title = `${col.name}\n${typeLabel(col)} filled in the first records sampled\n${kinds}\nClick to sort the whole view`;
    h.addEventListener('click', () => {
      const cur = S.sort && S.sort.col === col.name ? { col: c, dir: S.sort.dir } : null;
      const next = M.nextSort(cur, c);
      flash(next ? 'Sorting…' : 'Back to file order');
      post(next ? { type: 'sort', col: col.name, dir: next.dir } : { type: 'sort', col: null, dir: null });
    });
    head.append(h);
  }
  head.style.width = totalWidth() + 'px';
}

function setColumns(columns, chat) {
  S.columns = columns || [];
  S.chat = chat || '';
  tabChat.disabled = !S.chat;
  tabChat.title = S.chat ? 'Messages as a conversation (C)' : 'No messages, role/content or prompt keys found in the first records';
  S.widths = S.columns.slice(0, MAX_COLS).map(c => M.autoWidth(c.name, typeLabel(c), []));
  S.autoSized = false;
  buildHeader();
}

function autoSize(rows) {
  if (S.autoSized || !rows.length) return;
  S.autoSized = true;
  for (let c = 0; c < shownCols(); c++) {
    const samples = [];
    for (const r of rows) if (r.cells && typeof r.cells[c] === 'string') samples.push(r.cells[c].slice(0, 60));
    S.widths[c] = M.autoWidth(S.columns[c].name, typeLabel(S.columns[c]), samples);
  }
  buildHeader();
}

// ---------- body ----------
const rowPool = [];
let rafPending = false;
function schedule() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => { rafPending = false; render(); });
}

function layout() {
  S.gutterW = M.gutterWidth(Math.max(S.total, 1) * 1.1);
  document.documentElement.style.setProperty('--gutter-w', S.gutterW + 'px');
  const bodyH = Math.min(S.count * ROW_H, M.MAX_BODY_PX);
  sizer.style.height = (HEAD_H + bodyH) + 'px';
  const w = totalWidth();
  sizer.style.width = w + 'px';
  stage.style.width = w + 'px';
  head.style.width = w + 'px';
  render();
}

function viewportBodyH() { return Math.max(0, grid.clientHeight - HEAD_H); }

function visibleRange() {
  const vh = viewportBodyH();
  const { first, shift } = M.scrollToRow(grid.scrollTop, S.count, ROW_H, vh);
  const count = Math.ceil((vh + shift) / ROW_H) + 1;
  return { first, last: Math.min(S.count - 1, first + count - 1), shift };
}

function makeRow() {
  const r = el('div', 'row');
  r._g = el('div', 'cell gutter');
  r.append(r._g);
  r._cells = [];
  r._wide = el('div', 'cell wide');
  return r;
}

function fillCells(r, n) {
  r._wide.remove();
  while (r._cells.length < n) { const d = el('div', 'cell'); r.append(d); r._cells.push(d); }
  while (r._cells.length > n) r._cells.pop().remove();
}

function render() {
  if (S.mode !== 'table' || S.fatal) return;
  stage.style.height = Math.min(grid.clientHeight, HEAD_H + Math.min(S.count * ROW_H, M.MAX_BODY_PX)) + 'px';
  const { first, last, shift } = visibleRange();
  const n = S.count ? Math.max(0, last - first + 1) : 0;
  while (rowPool.length < n) { const r = makeRow(); rowPool.push(r); body.append(r); }
  body.style.transform = `translateY(${-shift}px)`;
  const cols = shownCols();
  const missing = [];
  for (let k = 0; k < rowPool.length; k++) {
    const r = rowPool[k];
    if (k >= n) { r.hidden = true; continue; }
    r.hidden = false;
    const pos = first + k;
    r._pos = pos;
    const page = S.cache.get(Math.floor(pos / PAGE));
    const row = page ? page[pos % PAGE] : undefined;
    r.classList.toggle('focus', pos === S.focus);
    r._g.textContent = row ? fmtN(row.line) : '';
    if (!row) {
      fillCells(r, cols);
      for (let c = 0; c < cols; c++) { const d = r._cells[c]; d.className = 'cell pending'; d.textContent = ''; d.style.width = S.widths[c] + 'px'; }
      missing.push(pos);
      r.classList.remove('badrow', 'truncrow');
      continue;
    }
    r.classList.toggle('badrow', !!row.bad);
    r.classList.toggle('truncrow', !!row.trunc);
    if (row.bad || row.trunc) {
      fillCells(r, 0);
      r.append(r._wide);
      r._wide.style.width = Math.max(300, totalWidth() - S.gutterW) + 'px';
      r._wide.textContent = row.bad
        ? `Bad JSON (${row.bad})   ${row.preview}`
        : `Line is ${fmtBytes(row.trunc)}, over the 5 MB display limit. Open the line in the editor to see it.   ${row.preview}`;
      continue;
    }
    fillCells(r, cols);
    for (let c = 0; c < cols; c++) {
      const d = r._cells[c];
      d._c = c;
      d.style.width = S.widths[c] + 'px';
      const v = row.cells[c];
      const kind = row.kinds[c];
      d.className = 'cell k-' + kind + (NUMERIC.has(kind) ? ' num' : '');
      d.textContent = v === null || v === undefined ? '' : v;
    }
  }
  if (missing.length) request(missing[0], missing[missing.length - 1]);
}

function request(first, last) {
  for (const p of M.pagesFor(first, last, PAGE)) {
    const key = S.version + ':' + p;
    if (S.cache.has(p) || S.pending.has(key)) continue;
    S.pending.add(key);
    post({ type: 'getRows', reqId: S.reqId++, start: p * PAGE, count: PAGE });
  }
}

function dropPagesFrom(pos) {
  const p0 = Math.floor(pos / PAGE);
  for (const p of [...S.cache.keys()]) if (p >= p0) S.cache.delete(p);
  for (const k of [...S.pending]) if (Number(k.split(':')[1]) >= p0) S.pending.delete(k);
  for (const k of [...recCache.keys()]) if (k >= pos) recCache.delete(k);
}

grid.addEventListener('scroll', schedule);
window.addEventListener('resize', schedule);

function ensureVisible(pos) {
  const vh = viewportBodyH();
  const { first, last } = visibleRange();
  if (pos <= first || pos >= last) grid.scrollTop = M.rowToScroll(Math.max(0, pos - Math.floor(vh / ROW_H / 2)), S.count, ROW_H, vh);
}

function setFocus(pos, scroll) {
  if (!S.count) { S.focus = -1; return; }
  S.focus = Math.max(0, Math.min(S.count - 1, pos));
  if (S.mode === 'table') { if (scroll) ensureVisible(S.focus); render(); } else showRecord();
  updateStatus();
}

function rowAt(target) {
  const rowEl = target.closest && target.closest('.row');
  return rowEl && rowEl._pos !== undefined ? rowEl : null;
}

body.addEventListener('mousedown', e => {
  const r = rowAt(e.target);
  if (!r) return;
  grid.focus();
  setFocus(r._pos, false);
  const cell = e.target.closest('.cell');
  if (cell && cell._c !== undefined && !cell.classList.contains('gutter')) openDrawer(r._pos, cell._c);
});
body.addEventListener('dblclick', e => { const r = rowAt(e.target); if (r) { setFocus(r._pos); setMode('record'); } });

grid.addEventListener('keydown', e => {
  const moves = { ArrowUp: -1, ArrowDown: 1, PageUp: -20, PageDown: 20 };
  if (e.key === 'Home') { e.preventDefault(); return setFocus(0, true); }
  if (e.key === 'End') { e.preventDefault(); return setFocus(S.count - 1, true); }
  if (e.key === 'Enter' && S.focus >= 0) { e.preventDefault(); return setMode('record'); }
  if (e.key === 'Escape') { drawer.hidden = true; return; }
  const m = moves[e.key];
  if (!m) return;
  e.preventDefault();
  setFocus(S.focus < 0 ? 0 : S.focus + m, true);
});

// ---------- records (record view, chat view, drawer) ----------
const recCache = new Map();
function getRecords(start, count) {
  const all = [];
  let missing = false;
  for (let p = start; p < Math.min(S.count, start + count); p++) { const r = recCache.get(p); if (!r) { missing = true; break; } all.push(r); }
  if (!missing) return Promise.resolve(all);
  const reqId = S.reqId++;
  const version = S.version;
  post({ type: 'getRecords', reqId, start, count });
  return new Promise(res => S.waiters.set(reqId, { res, version }));
}

function onRecords(m) {
  const w = S.waiters.get(m.reqId);
  S.waiters.delete(m.reqId);
  if (m.version !== S.version) { if (w) w.res(null); return; }
  if (recCache.size > 400) recCache.clear();
  for (const r of m.records) recCache.set(r.pos, r);
  if (w) w.res(m.records);
}

let drawerState = null;
async function openDrawer(pos, c) {
  const col = S.columns[c];
  const recs = await getRecords(pos, 1);
  if (!recs || !recs[0] || S.focus !== pos) return;
  const r = recs[0];
  drawer.hidden = false;
  drawerBody.textContent = '';
  drawerTitle.textContent = `Line ${fmtN(r.line)} · ${col.name}`;
  if (r.value === undefined) { drawerBody.append(el('div', 'note', r.bad ? 'This line is not valid JSON.' : 'This line is too long to show here.')); drawerState = null; return; }
  const isObj = r.value && typeof r.value === 'object' && !Array.isArray(r.value);
  const v = isObj ? r.value[col.name] : col.name === '(value)' ? r.value : undefined;
  const segs = col.name === '(value)' ? [] : [col.name];
  drawerState = { v, segs };
  if (v === undefined) { drawerBody.append(el('div', 'note', 'This record has no such key.')); return; }
  drawerBody.append(tree(v, segs, 0, col.name, 3));
}
drawerClose.addEventListener('click', () => { drawer.hidden = true; });
drawerCopy.addEventListener('click', () => { if (drawerState) copy(typeof drawerState.v === 'string' ? drawerState.v : JSON.stringify(drawerState.v, null, 2), 'value'); });
drawerPath.addEventListener('click', () => { if (drawerState) copy(pathString(drawerState.segs), pathString(drawerState.segs)); });

// JSON tree. Children are built when a node is opened, so huge records stay fast.
function tree(value, segs, depth, key, openDepth) {
  const node = el('div', 'node');
  const line = el('div', 'nline');
  node.append(line);
  const isArr = Array.isArray(value);
  const isObj = value !== null && typeof value === 'object';
  const tog = el('span', 'tog', isObj ? '▸' : '');
  line.append(tog);
  if (key !== undefined && key !== null) {
    const k = el('span', typeof key === 'number' ? 'key idx' : 'key', typeof key === 'number' ? key : key);
    line.append(k, el('span', 'colon', ': '));
  }
  const pathBtn = el('button', 'pbtn', '⧉');
  pathBtn.title = 'Copy JSONPath ' + pathString(segs);
  pathBtn.addEventListener('click', e => { e.stopPropagation(); copy(pathString(segs), pathString(segs)); });
  if (!isObj) {
    line.append(valueSpan(value), pathBtn);
    return node;
  }
  const keys = isArr ? null : Object.keys(value);
  const n = isArr ? value.length : keys.length;
  line.append(el('span', 'summary', isArr ? `[${fmtN(n)}]` : `{${fmtN(n)}}`), pathBtn);
  const kids = el('div', 'kids');
  kids.hidden = true;
  node.append(kids);
  let built = 0;
  const STEP = 300;
  const buildMore = () => {
    const more = kids.querySelector(':scope > .more');
    if (more) more.remove();
    const end = Math.min(n, built + STEP);
    for (let i = built; i < end; i++) {
      const k = isArr ? i : keys[i];
      kids.append(tree(value[k], segs.concat([k]), depth + 1, k, openDepth));
    }
    built = end;
    if (built < n) {
      const b = btn(`Show ${fmtN(Math.min(STEP, n - built))} more of ${fmtN(n - built)}`, null, 'link more');
      b.addEventListener('click', buildMore);
      kids.append(b);
    }
  };
  const toggle = (open) => {
    if (open && !built) buildMore();
    kids.hidden = !open;
    tog.textContent = open ? '▾' : '▸';
    node._open = open;
  };
  node._toggle = toggle;
  line.addEventListener('click', () => toggle(kids.hidden));
  if (depth < openDepth && n <= 200) toggle(true);
  return node;
}

function valueSpan(v) {
  if (v === null) return el('span', 'v-null', 'null');
  if (typeof v === 'string') {
    const s = el('span', 'v-str');
    const LIMIT = 3000;
    if (v.length > LIMIT) {
      s.textContent = JSON.stringify(v.slice(0, LIMIT)).slice(0, -1) + '…"';
      const more = btn(`show all ${fmtN(v.length)} chars`, null, 'link inline');
      more.addEventListener('click', e => { e.stopPropagation(); s.textContent = JSON.stringify(v); });
      const wrap = el('span');
      wrap.append(s, more);
      return wrap;
    }
    s.textContent = JSON.stringify(v);
    return s;
  }
  if (typeof v === 'number') return el('span', 'v-num', String(v));
  if (typeof v === 'boolean') return el('span', 'v-bool', String(v));
  return el('span', null, String(v));
}

function expandAll(root) {
  let budget = 3000;
  const walk = (n) => {
    if (budget-- <= 0) return;
    if (n._toggle && !n._open) n._toggle(true);
    for (const k of n.querySelectorAll(':scope > .kids > .node')) walk(k);
  };
  for (const n of root.querySelectorAll(':scope > .tree > .node, :scope > .node')) walk(n);
}
btnExpand.addEventListener('click', () => expandAll(recBody));

let shown = null; // the record in the record view
let showSeq = 0;
async function showRecord() {
  if (S.mode === 'table' || S.fatal) return;
  const seq = ++showSeq;
  if (!S.count) { recTitle.textContent = 'No records'; recBody.textContent = ''; shown = null; return; }
  if (S.focus < 0) S.focus = 0;
  const turnsMode = S.mode === 'chat' && S.chat === 'turns';
  const span = turnsMode ? 50 : 1;
  const start = turnsMode ? Math.floor(S.focus / span) * span : S.focus;
  const recs = await getRecords(start, span);
  if (!recs || seq !== showSeq) return;
  recBody.textContent = '';
  const r = recs[0];
  shown = r;
  btnPrev.disabled = start <= 0;
  btnNext.disabled = start + span >= S.count;
  if (turnsMode) {
    recTitle.textContent = `Records ${fmtN(start + 1)}–${fmtN(start + recs.length)} of ${fmtN(S.count)} · lines ${fmtN(r.line)}–${fmtN(recs[recs.length - 1].line)}`;
    const list = el('div', 'chat');
    for (const x of recs) {
      if (x.value === undefined) { list.append(el('div', 'note bad', `Line ${fmtN(x.line)}: ${x.bad ? 'not valid JSON' : 'too long to show'}`)); continue; }
      const ct = chatTurns(x.value);
      if (!ct) { list.append(el('div', 'note', `Line ${fmtN(x.line)}: no message`)); continue; }
      for (const t of ct.turns) list.append(bubble(t, x.line, x.pos === S.focus));
    }
    recBody.append(list);
    const f = list.querySelector('.bubble.focus');
    if (f) f.scrollIntoView({ block: 'center' });
    return;
  }
  recTitle.textContent = `Record ${fmtN(S.focus + 1)} of ${fmtN(S.count)} · line ${fmtN(r.line)}`;
  if (r.value === undefined) {
    const box = el('div', 'badbox');
    box.append(el('div', 'note bad', r.bad ? `Line ${fmtN(r.line)} is not valid JSON: ${r.bad}` : `Line ${fmtN(r.line)} is ${fmtBytes(r.len)}. Only the first part is shown. Open the line in the editor to see all of it.`));
    box.append(el('pre', 'raw', r.raw || ''));
    recBody.append(box);
    return;
  }
  if (S.mode === 'chat') {
    const ct = chatTurns(r.value);
    if (ct) {
      const meta = chatMeta(r.value, ct.key);
      if (meta.length) {
        const chips = el('div', 'chips');
        for (const [k, v] of meta) { const c = el('span', 'chip'); c.append(el('b', null, k), el('span', null, ' ' + v)); chips.append(c); }
        recBody.append(chips);
      }
      const list = el('div', 'chat');
      for (const t of ct.turns) list.append(bubble(t));
      recBody.append(list);
      return;
    }
    recBody.append(el('div', 'note', 'This record has no messages. It is shown as a tree.'));
  }
  const wrap = el('div', 'tree');
  wrap.append(tree(r.value, [], 0, null, 2));
  recBody.append(wrap);
}

function clipText(text, cls) {
  const LIMIT = 20000;
  const pre = el('div', cls);
  if (text.length <= LIMIT) { pre.textContent = text; return pre; }
  pre.textContent = text.slice(0, LIMIT) + '…';
  const more = btn(`Show all ${fmtN(text.length)} characters`, null, 'link');
  more.addEventListener('click', () => { pre.textContent = text; more.remove(); });
  const box = el('div');
  box.append(pre, more);
  return box;
}

function bubble(t, line, focus) {
  const known = ['system', 'user', 'assistant', 'tool', 'developer'];
  const b = el('div', 'bubble r-' + (known.includes(t.role) ? t.role : 'other') + (focus ? ' focus' : ''));
  const head = el('div', 'role', t.role + (t.name ? ` · ${t.name}` : '') + (line ? ` · line ${fmtN(line)}` : ''));
  b.append(head);
  if (!t.parts.length) b.append(el('div', 'empty', '(empty)'));
  for (const p of t.parts) {
    if (p.kind === 'text') b.append(clipText(p.text, 'txt'));
    else if (p.kind === 'thinking') {
      const d = el('details', 'thinking');
      d.append(el('summary', null, 'Thinking'), clipText(p.text, 'txt'));
      b.append(d);
    } else if (p.kind === 'tool_call') {
      const box = el('div', 'toolbox');
      box.append(el('div', 'toolname', `Tool call · ${p.name}`), clipText(p.text, 'code'));
      b.append(box);
    } else if (p.kind === 'tool_result') {
      const box = el('div', 'toolbox result');
      box.append(el('div', 'toolname', 'Tool result' + (p.name ? ` · ${p.name}` : '')), clipText(p.text, 'code'));
      b.append(box);
    } else if (p.kind === 'image') b.append(el('div', 'image', `Image: ${p.text}`));
    else b.append(clipText(p.text, 'code'));
  }
  return b;
}

function step(d) {
  if (!S.count) return;
  const span = S.mode === 'chat' && S.chat === 'turns' ? 50 : 1;
  const base = span > 1 ? Math.floor(Math.max(0, S.focus) / span) * span : S.focus;
  setFocus(base + d * span);
}
btnPrev.addEventListener('click', () => step(-1));
btnNext.addEventListener('click', () => step(1));
btnCopyRec.addEventListener('click', () => {
  if (!shown) return;
  copy(shown.value !== undefined ? JSON.stringify(shown.value, null, 2) : shown.raw || '', 'record');
});
btnOpenLine.addEventListener('click', () => { if (shown) post({ type: 'openLine', index: shown.i }); });

window.addEventListener('keydown', e => {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT')) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (S.mode !== 'table' && (e.key === 'ArrowLeft' || e.key === 'k')) { e.preventDefault(); step(-1); }
  else if (S.mode !== 'table' && (e.key === 'ArrowRight' || e.key === 'j')) { e.preventDefault(); step(1); }
  else if (e.key === 't') setMode('table');
  else if (e.key === 'r') setMode('record');
  else if (e.key === 'c' && S.chat) setMode('chat');
  else if (e.key === '/') { e.preventDefault(); search.focus(); }
});

// ---------- find, filter, jobs ----------
function runSearch() { post({ type: 'search', text: search.value, filter: filter.value }); jobText.classList.remove('err'); jobText.textContent = 'Searching…'; }
btnRun.addEventListener('click', runSearch);
search.addEventListener('keydown', e => { if (e.key === 'Enter') runSearch(); if (e.key === 'Escape') btnCancel.click(); });
filter.addEventListener('keydown', e => { if (e.key === 'Enter') runSearch(); if (e.key === 'Escape') btnCancel.click(); });
btnCancel.addEventListener('click', () => post({ type: 'cancel' }));
bannerAct.addEventListener('click', () => { search.value = ''; filter.value = ''; post({ type: 'clearView' }); });
lineInput.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  const n = Number(lineInput.value.replace(/[,\s]/g, ''));
  if (Number.isInteger(n) && n >= 1) post({ type: 'gotoLine', line: n });
});
btnFollow.addEventListener('click', () => {
  S.follow = !S.follow;
  btnFollow.classList.toggle('on', S.follow);
  if (S.follow) setFocus(S.count - 1, true);
});
exportSel.addEventListener('change', () => {
  const f = exportSel.value;
  exportSel.value = '';
  if (f) post({ type: 'export', format: f });
});
badBtn.addEventListener('click', () => post({ type: 'showBad' }));
nextBadBtn.addEventListener('click', () => post({ type: 'nextBad', after: S.focus }));

function onJob(m) {
  const running = m.state === 'running';
  btnCancel.hidden = !running;
  btnRun.disabled = running && m.kind === 'search';
  jobText.classList.toggle('err', m.state === 'error');
  const pct = m.total ? ` ${Math.floor((m.done / m.total) * 100)}%` : '';
  if (m.state === 'error') jobText.textContent = m.message;
  else if (m.kind === 'search') {
    if (running) jobText.textContent = `Searching${pct} · ${fmtN(m.matches)} found`;
    else if (m.state === 'cancelled') jobText.textContent = `Stopped · ${fmtN(m.matches)} found so far`;
    else jobText.textContent = m.ms !== undefined ? `${fmtN(m.matches)} found in ${fmtMs(m.ms)}` : '';
  } else if (m.kind === 'sort') jobText.textContent = running ? `Sorting${pct}` : m.state === 'cancelled' ? 'Sort stopped' : '';
  else if (m.kind === 'export') jobText.textContent = running ? `Exporting${pct}` : m.state === 'done' ? `Exported ${fmtN(m.written)} records` : 'Export stopped';
}

function onView(m) {
  S.version = m.version;
  S.count = m.count;
  S.label = m.label || '';
  S.sort = m.sort || null;
  S.cache.clear();
  S.pending.clear();
  recCache.clear();
  buildHeader();
  showBanner();
  grid.scrollTop = 0;
  S.focus = S.count ? 0 : -1;
  layout();
  if (S.mode !== 'table') showRecord();
  updateStatus();
}

function showBanner() {
  const parts = [];
  if (S.info && S.info.capped) parts.push(S.info.capped);
  const active = S.label || S.sort;
  if (active) {
    let t = S.label ? `${fmtN(S.count)} of ${fmtN(S.total)} records match ${S.label}.` : '';
    if (S.sort) t += `${t ? ' ' : ''}Sorted by ${S.sort.col} (${S.sort.dir === 'asc' ? 'ascending' : 'descending'}).`;
    parts.push(t);
  }
  banner.hidden = !parts.length;
  bannerText.textContent = parts.join(' ');
  bannerAct.hidden = !active;
}

// ---------- status ----------
function updateStatus() {
  if (S.fatal) { statusLeft.textContent = ''; return; }
  if (S.focus >= 0 && S.count) {
    const page = S.cache.get(Math.floor(S.focus / PAGE));
    const row = page && page[S.focus % PAGE];
    statusLeft.textContent = `Record ${fmtN(S.focus + 1)} of ${fmtN(S.count)}` + (row ? ` · line ${fmtN(row.line)}` : '');
  } else statusLeft.textContent = S.count ? '' : (S.done ? 'No records' : '');
  const b = S.bad;
  const checking = !b.done && S.total ? ` (checking ${Math.floor((b.checked / Math.max(1, S.total)) * 100)}%)` : '';
  badBtn.hidden = !b.count;
  nextBadBtn.hidden = !b.count;
  badBtn.textContent = b.count ? `${fmtN(b.count)} bad line${b.count === 1 ? '' : 's'}` : '';
  badText.textContent = (b.count ? '' : b.done ? 'All lines are valid JSON' : '') + (b.truncated ? ` · ${fmtN(b.truncated)} over 5 MB` : '') + checking;
}

function updateStats(p) {
  S.total = p.count;
  const size = S.info ? (S.info.format === 'gzip' ? `${S.info.sizeText} gz` : S.info.sizeText) : '';
  stats.textContent = `${fmtN(p.count)} records · ${size}`;
  if (!p.done) {
    const pct = p.size ? ` ${Math.floor((p.bytes / p.size) * 100)}%` : '';
    statusRight.textContent = `Indexing${pct}…`;
  } else statusRight.textContent = `Indexed in ${fmtMs(p.ms)}`;
}

// ---------- messages ----------
window.addEventListener('message', ev => {
  const m = ev.data;
  if (!m || typeof m.type !== 'string') return;
  switch (m.type) {
    case 'init': {
      S.info = m;
      S.fatal = '';
      fatalBox.hidden = true;
      S.format = m.format;
      fmtBadge.textContent = m.format === 'gzip' ? 'JSONL.GZ' : m.format.toUpperCase();
      S.tail = m.tail;
      btnFollow.hidden = !m.tail;
      S.done = m.done;
      S.version = m.viewVersion;
      S.count = m.viewCount;
      S.label = m.viewLabel || '';
      S.sort = m.sort;
      S.bad = m.bad;
      S.cache.clear();
      S.pending.clear();
      recCache.clear();
      setColumns(m.columns, m.chat);
      updateStats(m);
      showBanner();
      if (S.focus >= S.count) S.focus = S.count - 1;
      if (S.focus < 0 && S.count) S.focus = 0;
      setMode(S.mode === 'chat' && !S.chat ? 'table' : (saved.mode ? S.mode : (S.chat === 'messages' ? 'chat' : 'table')));
      break;
    }
    case 'progress': {
      const grew = !S.label && !S.sort && m.viewCount !== S.count;
      S.done = m.done;
      if (m.capped && S.info) { S.info.capped = m.capped; showBanner(); }
      updateStats(m);
      if (grew) {
        const old = S.count;
        S.count = m.viewCount;
        dropPagesFrom(Math.floor(old / PAGE) * PAGE);
        layout();
      }
      updateStatus();
      break;
    }
    case 'columns':
      setColumns(m.columns, m.chat);
      S.cache.clear();
      S.pending.clear();
      layout();
      break;
    case 'rows': {
      S.pending.delete(m.version + ':' + Math.floor(m.start / PAGE));
      if (m.version !== S.version) break;
      S.cache.set(Math.floor(m.start / PAGE), m.rows);
      if (S.cache.size > 60) { const far = [...S.cache.keys()].sort((a, b) => Math.abs(b - S.focus / PAGE) - Math.abs(a - S.focus / PAGE))[0]; S.cache.delete(far); }
      autoSize(m.rows);
      schedule();
      updateStatus();
      break;
    }
    case 'records': onRecords(m); break;
    case 'job': onJob(m); break;
    case 'view': onView(m); break;
    case 'bad': S.bad = m; updateStatus(); break;
    case 'grew': {
      const old = S.count;
      S.total = m.total;
      S.count = m.count;
      dropPagesFrom(Math.min(m.from, old));
      if (S.info && typeof m.size === 'number' && S.info.format !== 'gzip') { S.info.size = m.size; S.info.sizeText = fmtBytes(m.size); }
      updateStats({ ...S.info, count: m.total, done: true, ms: S.info ? S.info.ms : 0 });
      if (S.count > old) flash(`${fmtN(S.count - old)} new record${S.count - old === 1 ? '' : 's'}`);
      layout();
      if (S.follow) setFocus(S.count - 1, true);
      else if (S.mode !== 'table' && S.focus >= m.from) showRecord();
      showBanner();
      updateStatus();
      break;
    }
    case 'reset':
      S.cache.clear(); S.pending.clear(); recCache.clear();
      S.count = 0; S.focus = -1;
      flash('The file was replaced. Reloading.');
      layout();
      break;
    case 'found':
      if (m.pos < 0) flash(m.what === 'line' ? `Line ${fmtN(m.line)} is blank, past the end, or not in this view` : 'No bad lines in this view');
      else { setFocus(m.pos, true); if (m.wrapped) flash('Back at the first bad line'); }
      break;
    case 'error':
      if (m.fatal) {
        S.fatal = m.message;
        fatalBox.hidden = false;
        fatalBox.textContent = '';
        fatalBox.append(el('div', 'ftitle', 'JSONL Viewer cannot show this file'), el('div', null, m.message));
        const b = btn('Open as Text', null, 'primary');
        b.addEventListener('click', () => post({ type: 'openAsText' }));
        fatalBox.append(b);
        tablePane.hidden = recPane.hidden = true;
      } else { jobText.classList.add('err'); jobText.textContent = m.message; }
      break;
  }
});

setMode(S.mode);
post({ type: 'ready' });
