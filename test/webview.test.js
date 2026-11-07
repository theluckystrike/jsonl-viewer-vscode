'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { buildHtml } = require('../src/html');
const { pathString, filterPath } = require('../src/core/jsonpath');
const { parsePath } = require('../src/core/filter');
const M = require('../src/webview/math');

const root = path.join(__dirname, '..');

test('CSP: no remote scripts, nonce on the script, title escaped', () => {
  const html = buildHtml({ cspSource: 'vscode-resource:', scriptUri: 'a.js', styleUri: 'a.css', title: '<b>"x".jsonl', nonce: 'n0nce' });
  const csp = html.match(/content="([^"]+)"/)[1];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'nonce-n0nce'/);
  assert.doesNotMatch(csp, /https?:|unsafe-inline|unsafe-eval/);
  assert.ok(html.includes('&lt;b&gt;&quot;x&quot;.jsonl'));
  assert.ok(!html.includes('<b>"x"'));
});

test('webview code never writes HTML strings and makes no network calls', () => {
  for (const f of ['src/webview/main.js', 'src/core/chat.js', 'src/core/jsonpath.js']) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/, f);
    assert.doesNotMatch(src, /fetch\(|XMLHttpRequest|WebSocket|https?:\/\//, f);
  }
  for (const f of fs.readdirSync(path.join(root, 'src/core'))) {
    const src = fs.readFileSync(path.join(root, 'src/core', f), 'utf8');
    assert.doesNotMatch(src, /require\(['"](https?|net|dgram|tls)['"]\)|fetch\(/, f);
  }
});

test('JSONPath strings, and they read back in the filter language', () => {
  assert.strictEqual(pathString([]), '$');
  assert.strictEqual(pathString(['messages', 2, 'content']), '$.messages[2].content');
  assert.strictEqual(pathString(['key with spaces', 'dotted.key', "it's"]), "$['key with spaces']['dotted.key']['it\\'s']");
  for (const segs of [['a', 0, 'b'], ['odd key', 3], ['x-y', 'z']]) assert.deepStrictEqual(parsePath(filterPath(segs)), segs);
});

test('grid math: scroll maps to rows past the browser height limit', () => {
  const rows = 5000000, h = 24, vh = 600;
  const top = M.rowToScroll(4000000, rows, h, vh);
  assert.strictEqual(M.scrollToRow(top, rows, h, vh).first, 4000000);
  assert.deepStrictEqual(M.pagesFor(150, 450, 200), [0, 1, 2]);
  assert.deepStrictEqual(M.nextSort(null, 2), { col: 2, dir: 'asc' });
});

test('auto-size resizes the table stage, so the last column is never cut off', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'webview', 'main.js'), 'utf8');
  const body = src.slice(src.indexOf('function autoSize('), src.indexOf('// ---------- body ----------'));
  assert.ok(/buildHeader\(\);\s*(\/\/[^\n]*\n\s*)*layout\(\);\s*}/.test(body), body);
});
