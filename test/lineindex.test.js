'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { LineIndex, trimEnd } = require('../src/core/lineindex');

function build(text, chunk) {
  const buf = Buffer.from(text);
  const idx = new LineIndex();
  for (let o = 0; o < buf.length; o += chunk) idx.feed(buf.subarray(o, Math.min(buf.length, o + chunk)));
  return { idx, buf };
}
function lines(idx, buf) {
  const out = [];
  for (let i = 0; i < idx.count; i++) { const [s, e] = idx.range(i); out.push([idx.lineOf(i), buf.toString('utf8', s, trimEnd(buf, s, e))]); }
  return out;
}

test('records, blank lines and line numbers are the same for any chunk size', () => {
  const text = '{"a":1}\n\n  \n{"a":2}\r\n{"a":3}\n\t\n{"a":4}';
  const want = [[1, '{"a":1}'], [4, '{"a":2}'], [5, '{"a":3}'], [7, '{"a":4}']];
  for (const chunk of [1, 2, 3, 5, 7, 64]) {
    const { idx, buf } = build(text, chunk);
    assert.deepStrictEqual(lines(idx, buf), want, `chunk ${chunk}`);
  }
});

test('lineOf and recordOfLine are inverse, blank lines give -1', () => {
  const { idx } = build('{}\n\n{}\n\n\n{}\n', 4);
  assert.deepStrictEqual([0, 1, 2].map(i => idx.lineOf(i)), [1, 3, 6]);
  assert.strictEqual(idx.recordOfLine(3), 1);
  assert.strictEqual(idx.recordOfLine(2), -1);
  assert.strictEqual(idx.recordOfLine(99), -1);
});

test('feeding more bytes continues a partial last line (live tail)', () => {
  const idx = new LineIndex();
  idx.feed(Buffer.from('{"a":1}\n{"a":'));
  assert.strictEqual(idx.count, 2);
  assert.strictEqual(idx.hasContent, true);
  idx.feed(Buffer.from('2}\n\n{"a":3}\n'));
  const buf = Buffer.from('{"a":1}\n{"a":2}\n\n{"a":3}\n');
  assert.deepStrictEqual(lines(idx, buf), [[1, '{"a":1}'], [2, '{"a":2}'], [4, '{"a":3}']]);
});

test('empty input and whitespace-only input have no records', () => {
  assert.strictEqual(build('', 4).idx.count, 0);
  assert.strictEqual(build('\n\n \r\n\t', 2).idx.count, 0);
});

test('the offset array grows past its first size', () => {
  const text = '{}\n'.repeat(10000);
  const { idx } = build(text, 1000);
  assert.strictEqual(idx.count, 10000);
  assert.strictEqual(idx.starts[9999], 29997);
});
