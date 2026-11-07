'use strict';
// 0.2.0: hide and resize columns, CSV export of the visible columns, any file as JSON Lines.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { validateWebviewMessage } = require('../src/core/protocol');
const { JsonlDoc } = require('../src/core/doc');
const { tempDir, harness } = require('./helpers');

const T = tempDir('rk5');
test.after(() => T.cleanup());
const root = path.join(__dirname, '..');

async function started(file, host) {
  const h = harness(new JsonlDoc({ path: file }), host);
  h.session.start();
  const init = await h.next(m => m.type === 'init');
  return { ...h, init };
}

test('export message: hidden column names pass validation, junk is dropped', () => {
  assert.deepStrictEqual(validateWebviewMessage({ type: 'export', format: 'csv', hidden: ['a', 'b c'] }), { type: 'export', format: 'csv', hidden: ['a', 'b c'] });
  assert.deepStrictEqual(validateWebviewMessage({ type: 'export', format: 'csv', hidden: [] }), { type: 'export', format: 'csv' });
  assert.deepStrictEqual(validateWebviewMessage({ type: 'export', format: 'csv', hidden: [1, 2] }), { type: 'export', format: 'csv' });
  assert.deepStrictEqual(validateWebviewMessage({ type: 'export', format: 'csv', hidden: 'a' }), { type: 'export', format: 'csv' });
  assert.deepStrictEqual(validateWebviewMessage({ type: 'export', format: 'json', hidden: new Array(1001).fill('x') }), { type: 'export', format: 'json' });
});

test('CSV export leaves out hidden columns; JSON Lines keeps whole records', async () => {
  const f = T.file('people.jsonl');
  fs.writeFileSync(f, ['{"id":1,"name":"Ada","email":"a@x.io","ctx":{"ms":5}}', '{"id":2,"name":"Bo","email":"b@x.io","ctx":{"ms":9}}'].join('\n') + '\n');
  const files = {};
  const host = {
    openWriter: async (format, name) => { let s = ''; files[format] = { name }; return { label: name, write: async x => { s += x; }, close: async () => { files[format].text = s; } }; },
    info: () => {},
  };
  const { session, next } = await started(f, host);
  await session.handle({ type: 'export', format: 'csv', hidden: ['email', 'ctx'] });
  await next(m => m.type === 'job' && m.kind === 'export' && m.state === 'done');
  assert.deepStrictEqual(files.csv.text.trim().split('\r\n'), ['id,name', '1,Ada', '2,Bo']);
  await session.handle({ type: 'export', format: 'jsonl', hidden: ['email'] });
  await next(m => m.type === 'job' && m.kind === 'export' && m.state === 'done');
  assert.match(files.jsonl.text, /"email":"a@x.io"/);
  // hiding every column falls back to all columns, so the file is never empty
  await session.handle({ type: 'export', format: 'csv', hidden: ['id', 'name', 'email', 'ctx'] });
  await next(m => m.type === 'job' && m.kind === 'export' && m.state === 'done');
  assert.strictEqual(files.csv.text.split('\r\n')[0], 'id,name,email,ctx');
  session.dispose();
});

test('a plain log opened as JSON Lines reports that no sampled line is JSON', async () => {
  const f = T.file('server.log');
  fs.writeFileSync(f, '2026-11-07 10:00:01 INFO start\n2026-11-07 10:00:02 WARN slow\n');
  const { session, init } = await started(f);
  assert.strictEqual(init.sampled, 2);
  assert.strictEqual(init.sampledOk, 0);
  assert.strictEqual(init.columns.length, 0);
  assert.strictEqual(init.count, 2);
  session.dispose();
});

test('a .log file of JSON lines opens as a table', async () => {
  const f = T.file('app.log');
  fs.writeFileSync(f, '{"level":"info","msg":"start"}\n{"level":"error","msg":"boom","ms":812}\n');
  const { session, init } = await started(f);
  assert.strictEqual(init.sampledOk, 2);
  assert.deepStrictEqual(init.columns.map(c => c.name), ['level', 'msg', 'ms']);
  session.dispose();
});

test('package: Open as JSON Lines is in the Explorer menu for logs and in the Command Palette for any file', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.ok(pkg.contributes.commands.some(c => c.command === 'jsonlViewer.openAny'));
  const ex = pkg.contributes.menus['explorer/context'].find(m => m.command === 'jsonlViewer.openAny');
  assert.match(ex.when, /log\|json\|txt/);
  assert.ok(pkg.contributes.menus.commandPalette.some(m => m.command === 'jsonlViewer.openAny'));
  assert.ok(pkg.contributes.menus['editor/title/context'].some(m => m.command === 'jsonlViewer.openAny'));
});

test('webview: column chooser, resize handle, and state that remembers both', () => {
  const src = fs.readFileSync(path.join(root, 'src/webview/main.js'), 'utf8');
  assert.match(src, /btn\('Columns'/);
  assert.match(src, /'resizer'/);
  assert.match(src, /hidden: \[\.\.\.S\.hidden\]/);
  assert.match(src, /userW/);
  // rows for bad lines keep their width when no column is shown (a plain log opened as JSON Lines)
  assert.match(src, /function contentWidth\(\) \{ return Math\.max\(totalWidth\(\), S\.gutterW \+ 300/);
  assert.match(src, /r\._wide\.style\.width = Math\.max\(300, contentWidth\(\) - S\.gutterW\)/);
  const css = fs.readFileSync(path.join(root, 'media/webview.css'), 'utf8');
  assert.match(css, /\.cell\[hidden\] \{ display: none/);
});

test('README documents the new features', () => {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.match(readme, /Columns/);
  assert.match(readme, /Open as JSON Lines/);
});
