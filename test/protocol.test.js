'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { validateWebviewMessage } = require('../src/core/protocol');
const { JsonlDoc } = require('../src/core/doc');
const { tempDir, makeSamples, harness } = require('./helpers');

const T = tempDir('proto');
test.before(() => makeSamples(T.dir));
test.after(() => T.cleanup());

test('validateWebviewMessage accepts good messages and drops bad ones', () => {
  assert.deepStrictEqual(validateWebviewMessage({ type: 'getRows', reqId: 1, start: 0, count: 200, extra: 'x' }), { type: 'getRows', reqId: 1, start: 0, count: 200 });
  assert.strictEqual(validateWebviewMessage({ type: 'getRows', reqId: 1, start: 0, count: 201 }), null);
  assert.strictEqual(validateWebviewMessage({ type: 'getRows', reqId: 1, start: -1, count: 1 }), null);
  assert.strictEqual(validateWebviewMessage({ type: 'getRecords', reqId: 1, start: 0, count: 101 }), null);
  assert.deepStrictEqual(validateWebviewMessage({ type: 'search', text: 'x' }), { type: 'search', text: 'x', filter: '' });
  assert.strictEqual(validateWebviewMessage({ type: 'search', text: 5 }), null);
  assert.deepStrictEqual(validateWebviewMessage({ type: 'sort', col: null }), { type: 'sort', col: null, dir: null });
  assert.strictEqual(validateWebviewMessage({ type: 'sort', col: 'a', dir: 'up' }), null);
  assert.strictEqual(validateWebviewMessage({ type: 'export', format: 'xml' }), null);
  assert.strictEqual(validateWebviewMessage({ type: 'openLine', index: 1.5 }), null);
  assert.strictEqual(validateWebviewMessage({ type: 'gotoLine', line: 0 }), null);
  assert.strictEqual(validateWebviewMessage({ type: 'nope' }), null);
  assert.strictEqual(validateWebviewMessage(null), null);
  assert.strictEqual(validateWebviewMessage('ready'), null);
});

async function started(file, host) {
  const h = harness(new JsonlDoc({ path: file }), host);
  h.session.start();
  const init = await h.next(m => m.type === 'init');
  return { ...h, init };
}

test('init, rows, records and the bad-line pass', async () => {
  const { session, next, init } = await started(T.file('mixed-edge.jsonl'));
  assert.strictEqual(init.format, 'jsonl');
  assert.ok(init.columns.some(c => c.name === 'emoji'));
  await next(m => m.type === 'bad' && m.done);
  assert.strictEqual(session.state.bad.count, 3);
  await session.handle({ type: 'getRows', reqId: 5, start: 0, count: 200 });
  const rows = await next(m => m.type === 'rows' && m.reqId === 5);
  assert.strictEqual(rows.rows.length, session.state.doc.count);
  assert.deepStrictEqual(rows.rows.filter(r => r.bad).map(r => r.line), [7, 9, 13]);
  await session.handle({ type: 'getRecords', reqId: 6, start: 3, count: 1 });
  const rec = await next(m => m.type === 'records' && m.reqId === 6);
  assert.strictEqual(rec.records[0].value.deep.child.child.level, 3);
  await session.handle({ type: 'showBad' });
  const v = await next(m => m.type === 'view');
  assert.strictEqual(v.count, 3);
  await session.handle({ type: 'clearView' });
  await next(m => m.type === 'view' && m.count === session.state.doc.count);
  await session.handle({ type: 'nextBad', after: 0 });
  const f = await next(m => m.type === 'found');
  assert.strictEqual(f.line, 7);
  await session.handle({ type: 'gotoLine', line: 3 });
  assert.strictEqual((await next(m => m.type === 'found')).pos, -1);
  await session.dispose();
});

test('search with text and filter, then sort, then cancel', async () => {
  const { session, next } = await started(T.file('app-logs.ndjson'));
  await session.handle({ type: 'search', text: 'timeout', filter: 'level == error and ctx.ms >= 0' });
  const v = await next(m => m.type === 'view');
  const done = await next(m => m.type === 'job' && m.state === 'done');
  assert.strictEqual(v.count, 224); // grep -c "upstream timeout" in the generated file
  assert.strictEqual(done.matches, v.count);
  await session.handle({ type: 'getRows', reqId: 1, start: 0, count: 200 });
  const rows = await next(m => m.type === 'rows');
  const colMsg = session.state.columns.findIndex(c => c.name === 'msg');
  assert.ok(rows.rows.every(r => r.cells[colMsg] === 'upstream timeout'));
  await session.handle({ type: 'sort', col: 'ts', dir: 'desc' });
  const sv = await next(m => m.type === 'view' && m.sort);
  assert.strictEqual(sv.count, v.count);
  await session.handle({ type: 'getRecords', reqId: 2, start: 0, count: 2 });
  const recs = (await next(m => m.type === 'records')).records;
  assert.ok(recs[0].value.ts > recs[1].value.ts);
  // a bad filter is reported, not thrown
  await session.handle({ type: 'search', text: '', filter: 'level ==' });
  assert.match((await next(m => m.type === 'job' && m.state === 'error')).message, /Add a value/);
  // cancel stops a search early
  const p = session.handle({ type: 'search', text: 'zzz-not-there', filter: '' });
  await session.handle({ type: 'cancel' });
  await p;
  const j = await next(m => m.type === 'job' && m.kind === 'search' && (m.state === 'cancelled' || m.state === 'done'));
  assert.ok(j.state === 'cancelled' || j.matches === 0);
  await session.dispose();
});

test('export CSV, JSON and JSON Lines of a filtered view', async () => {
  const files = {};
  const host = {
    openWriter: async (format, name) => { let s = ''; files[format] = { name }; return { label: name, write: async x => { s += x; }, close: async () => { files[format].text = s; } }; },
    info: () => {},
  };
  const { session, next } = await started(T.file('eval-results.jsonl'), host);
  await session.handle({ type: 'search', text: '', filter: 'score == 0' });
  const v = await next(m => m.type === 'view');
  for (const format of ['csv', 'json', 'jsonl']) {
    await session.handle({ type: 'export', format });
    await next(m => m.type === 'job' && m.kind === 'export' && m.state === 'done');
  }
  assert.strictEqual(files.csv.name, 'eval-results-filtered.csv');
  const csvLines = files.csv.text.trim().split('\r\n');
  assert.strictEqual(csvLines[0], 'id,input,expected,output,score,latency_ms,tags,model');
  assert.strictEqual(csvLines.length, v.count + 1);
  assert.match(csvLines[1], /,0,\d+,"\[""/);
  const arr = JSON.parse(files.json.text);
  assert.strictEqual(arr.length, v.count);
  assert.ok(arr.every(r => r.score === 0));
  assert.strictEqual(files.jsonl.text.trim().split('\n').length, v.count);
  await session.dispose();
});

test('live tail: appended lines arrive as grew, a partial line is completed, truncation resets', async () => {
  const file = T.file('live.jsonl');
  fs.writeFileSync(file, '{"n":1}\n{"n":2}\n');
  let made = 0;
  const host = { makeDoc: () => { made++; return new JsonlDoc({ path: file }); } };
  const { session, next } = await started(file, host);
  await next(m => m.type === 'bad' && m.done);
  fs.appendFileSync(file, '{"n":3}\n{"n":');
  await session.onFileChange();
  let g = await next(m => m.type === 'grew');
  assert.deepStrictEqual([g.count, g.from], [4, 2]);
  fs.appendFileSync(file, '4}\n');
  await session.onFileChange();
  g = await next(m => m.type === 'grew');
  assert.deepStrictEqual([g.count, g.from], [4, 3]);
  assert.strictEqual(g.size, fs.statSync(file).size, 'grew carries the new file size for the stats line');
  await session.handle({ type: 'getRecords', reqId: 9, start: 3, count: 1 });
  assert.strictEqual((await next(m => m.type === 'records' && m.reqId === 9)).records[0].value.n, 4);
  // a filtered view picks up new matches
  await session.handle({ type: 'search', text: '', filter: 'n >= 3' });
  assert.strictEqual((await next(m => m.type === 'view')).count, 2);
  fs.appendFileSync(file, '{"n":5}\n{"n":0}\n');
  await session.onFileChange();
  g = await next(m => m.type === 'grew');
  assert.strictEqual(g.count, 3);
  assert.strictEqual(g.total, 6);
  // the file is replaced by a shorter one
  fs.writeFileSync(file, '{"n":9}\n');
  await session.onFileChange();
  await next(m => m.type === 'reset');
  const init = await next(m => m.type === 'init');
  assert.strictEqual(init.count, 1);
  assert.strictEqual(made, 1);
  await session.dispose();
});

test('a fatal open error is posted and repeated on ready', async () => {
  const h = harness(new JsonlDoc({ path: T.file('does-not-exist.jsonl') }));
  await h.session.start();
  const e = await h.next(m => m.type === 'error' && m.fatal);
  assert.match(e.message, /Could not open/);
  await h.session.handle({ type: 'ready' });
  await h.next(m => m.type === 'error' && m.fatal);
});

test('openLine and copy call the host', async () => {
  const calls = [];
  const host = { openLine: async (line, text) => calls.push(['open', line, text]), copy: async t => calls.push(['copy', t]) };
  const { session } = await started(T.file('mixed-edge.jsonl'), host);
  await session.handle({ type: 'openLine', index: 1 });
  await session.handle({ type: 'copy', text: '$.a' });
  await session.handle({ type: 'openLine', index: 999 });
  assert.strictEqual(calls[0][1], 2);
  assert.match(calls[0][2], /emoji/);
  assert.deepStrictEqual(calls[1], ['copy', '$.a']);
  assert.strictEqual(calls.length, 2);
  await session.dispose();
});
