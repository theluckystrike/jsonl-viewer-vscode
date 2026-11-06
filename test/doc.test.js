'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const zlib = require('zlib');
const { JsonlDoc, TooBigError } = require('../src/core/doc');
const L = require('../src/core/limits');
const { inferColumns, tableRow, parseLine, chatShape } = require('../src/core/schema');
const { tempDir, makeSamples } = require('./helpers');

const T = tempDir('doc');
test.before(() => makeSamples(T.dir));
test.after(() => T.cleanup());

async function openAll(opts) { const d = new JsonlDoc(opts); await d.open(); await d.whenDone; return d; }

test('app-logs.ndjson: 30,000 records, format, first and last record', async () => {
  const d = await openAll({ path: T.file('app-logs.ndjson') });
  assert.strictEqual(d.count, 30000);
  assert.strictEqual(d.format, 'ndjson');
  const [a, z] = await d.readRecords([0, 29999]);
  assert.strictEqual(JSON.parse(a.text).ts, '2026-11-05T08:00:00.282Z');
  assert.strictEqual(z.line, 30000);
  assert.ok(JSON.parse(z.text).ctx);
  await d.close();
});

test('.jsonl.gz gives the same records as the plain file', async () => {
  const gz = await openAll({ path: T.file('logs.jsonl.gz') });
  const plain = await openAll({ path: T.file('app-logs.ndjson') });
  assert.strictEqual(gz.format, 'gzip');
  assert.strictEqual(gz.count, plain.count);
  const ids = [0, 1, 777, 29999];
  assert.deepStrictEqual((await gz.readRecords(ids)).map(r => r.text), (await plain.readRecords(ids)).map(r => r.text));
  assert.strictEqual(gz.canTail, false);
  await gz.close(); await plain.close();
});

test('in-memory bytes (remote files) and gz bytes', async () => {
  const text = '{"a":1}\n{"a":2}\n';
  const d = await openAll({ bytes: Buffer.from(text), name: 'x.jsonl' });
  assert.strictEqual(d.count, 2);
  const g = await openAll({ bytes: zlib.gzipSync(text), name: 'x.jsonl.gz' });
  assert.strictEqual((await g.readRecords([1]))[0].text, '{"a":2}');
});

test('damaged gzip is reported', async () => {
  fs.writeFileSync(T.file('bad.jsonl.gz'), Buffer.from('not gzip at all'));
  const d = new JsonlDoc({ path: T.file('bad.jsonl.gz') });
  await assert.rejects(d.open(), /damaged or not gzip/);
});

test('mixed-edge.jsonl: blank lines skipped, bad lines found, unicode kept, BOM dropped', async () => {
  const d = await openAll({ path: T.file('mixed-edge.jsonl') });
  const recs = await d.readRecords(Array.from({ length: d.count }, (_, i) => i));
  const bad = recs.filter(r => !parseLine(r.text).ok).map(r => r.line);
  assert.deepStrictEqual(bad, [7, 9, 13]);
  assert.strictEqual(recs.find(r => r.text.includes('emoji')).text.includes('👩🏽‍💻'), true);
  assert.ok(recs.some(r => r.len > 2 * 1000 * 1000 && !r.truncated));
  assert.ok(recs.every(r => !r.text.endsWith('\r')));
  fs.writeFileSync(T.file('bom.jsonl'), '﻿{"a":1}\n');
  const b = await openAll({ path: T.file('bom.jsonl') });
  assert.deepStrictEqual(JSON.parse((await b.readRecords([0]))[0].text), { a: 1 });
});

test('a line over 5 MB is cut and marked truncated', async () => {
  fs.writeFileSync(T.file('long.jsonl'), '{"a":1}\n{"big":"' + 'y'.repeat(L.MAX_LINE_BYTES + 100) + '"}\n{"a":3}\n');
  const d = await openAll({ path: T.file('long.jsonl') });
  const [x, y, z] = await d.readRecords([0, 1, 2]);
  assert.strictEqual(x.truncated, false);
  assert.strictEqual(y.truncated, true);
  assert.strictEqual(y.text.length, L.MAX_LINE_BYTES);
  assert.ok(y.len > L.MAX_LINE_BYTES);
  assert.strictEqual(z.text, '{"a":3}');
  assert.ok(tableRow(y, []).trunc > L.MAX_LINE_BYTES);
  fs.rmSync(T.file('long.jsonl'));
});

test('a file over the size limit gives a clear message', async () => {
  const old = L.MAX_FILE_BYTES;
  L.MAX_FILE_BYTES = 1000;
  try {
    const d = new JsonlDoc({ path: T.file('app-logs.ndjson') });
    await assert.rejects(d.open(), e => e instanceof TooBigError && /opens files up to/.test(e.message));
  } finally { L.MAX_FILE_BYTES = old; }
});

test('open() resolves early, before a big file is fully indexed', async () => {
  const d = new JsonlDoc({ path: T.file('app-logs.ndjson') });
  await d.open({ early: 200 });
  assert.ok(d.count >= 200);
  await d.whenDone;
  assert.strictEqual(d.count, 30000);
});

test('columns, types, fill % and chat detection', async () => {
  const vals = [{ a: 1, b: 'x', c: null }, { a: 2.5, b: 'y', d: [1] }, { a: 3, b: { z: 1 } }, [1, 2]];
  const cols = inferColumns(vals);
  const by = Object.fromEntries(cols.map(c => [c.name, c]));
  assert.deepStrictEqual(cols.map(c => c.name), ['a', 'b', 'c', 'd', '(value)']);
  assert.strictEqual(by.a.type, 'float');
  assert.strictEqual(by.b.type, 'mixed');
  assert.strictEqual(by.c.fill, 0);
  assert.strictEqual(by.a.fill, 75);
  assert.strictEqual(chatShape(inferColumns([{ messages: [{ role: 'user', content: 'x' }] }])), 'messages');
  assert.strictEqual(chatShape(inferColumns([{ role: 'user', content: 'x' }])), 'turns');
  assert.strictEqual(chatShape(cols), '');
  const row = tableRow({ i: 0, line: 1, text: '{"a":1,"b":"' + 'q'.repeat(400) + '","zz":1}', truncated: false, len: 10 }, cols);
  assert.strictEqual(row.cells[0], '1');
  assert.strictEqual(row.cells[1].length, L.CELL_CHARS + 1);
  assert.strictEqual(row.cells[2], undefined);
  assert.deepStrictEqual(row.kinds.slice(0, 3), ['int', 'string', 'missing']);
  assert.strictEqual(row.extra, 1);
  assert.match(tableRow({ i: 0, line: 4, text: '{bad', truncated: false, len: 4 }, cols).bad, /JSON|property|Expected/);
});
