'use strict';
const test = require('node:test');
const assert = require('node:assert');
const pkg = require('../package.json');

test('manifest: id, 30 unique keywords, editor selectors, engine', () => {
  assert.strictEqual(`${pkg.publisher}.${pkg.name}`, 'zovo.zovo-jsonl-viewer');
  assert.strictEqual(pkg.displayName, 'JSONL Viewer & NDJSON Viewer (JSONL Table)');
  assert.strictEqual(pkg.keywords.length, 30);
  assert.strictEqual(new Set(pkg.keywords).size, 30);
  const pats = pkg.contributes.customEditors[0].selector.map(s => s.filenamePattern);
  for (const p of ['*.jsonl', '*.ndjson', '*.jsonlines', '*.jsonl.gz']) assert.ok(pats.includes(p), p);
  assert.strictEqual(pkg.engines.vscode, '^1.90.0');
  assert.strictEqual(pkg.license, 'MIT');
});
