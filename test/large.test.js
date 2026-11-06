'use strict';
// Speed test on a generated 40 MB file. The file lives in a temp folder and is deleted in teardown.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { JsonlDoc } = require('../src/core/doc');
const { tempDir, harness } = require('./helpers');

const T = tempDir('large');
const file = T.file('speed-40mb.jsonl');
test.before(() => {
  const fd = fs.openSync(file, 'w');
  let size = 0, i = 0;
  while (size < 40 * 1024 * 1024) {
    const lines = [];
    for (let k = 0; k < 5000; k++, i++) lines.push(JSON.stringify({ i, ts: 1700000000000 + i * 37, level: i % 50 ? 'info' : 'error', msg: 'generated line ' + i, ctx: { a: i % 7, b: 'x'.repeat(i % 40) } }));
    const chunk = lines.join('\n') + '\n';
    fs.writeSync(fd, chunk);
    size += Buffer.byteLength(chunk);
  }
  fs.closeSync(fd);
});
test.after(() => T.cleanup());

test('40 MB: first page under 1 s, full index, search, then teardown', async () => {
  const size = fs.statSync(file).size;
  assert.ok(size >= 40 * 1024 * 1024 && size < 50 * 1024 * 1024);
  const t0 = Date.now();
  const h = harness(new JsonlDoc({ path: file }));
  h.session.start();
  const init = await h.next(m => m.type === 'init');
  await h.session.handle({ type: 'getRows', reqId: 1, start: 0, count: 200 });
  await h.next(m => m.type === 'rows');
  const firstPage = Date.now() - t0;
  await h.session.state.doc.whenDone;
  const indexMs = h.session.state.doc.indexMs;
  const count = h.session.state.doc.count;
  const t1 = Date.now();
  await h.session.handle({ type: 'search', text: '', filter: 'level == error' });
  const v = await h.next(m => m.type === 'view');
  const searchMs = Date.now() - t1;
  const heapMb = process.memoryUsage().heapUsed / 1024 / 1024;
  console.log(`# 40 MB speed: ${count} records, first page ${firstPage} ms, full index ${indexMs} ms, filter ${searchMs} ms (${v.count} matches), heap ${heapMb.toFixed(0)} MB`);
  assert.ok(init.count >= 200);
  assert.ok(firstPage < 1000, `first page took ${firstPage} ms`);
  assert.strictEqual(v.count, Math.ceil(count / 50));
  await h.session.dispose();
});
