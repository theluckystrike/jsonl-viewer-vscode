'use strict';
// Loads the bundled extension with a stub vscode module and checks what it registers.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

test('activate registers the custom editor and both commands', () => {
  const dist = path.join(__dirname, '..', 'dist', 'extension.js');
  if (!fs.existsSync(dist)) require('child_process').execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'build.js')]);
  const reg = { editors: [], commands: [] };
  const vscode = {
    window: { registerCustomEditorProvider: (id, p, o) => { reg.editors.push([id, p, o]); return { dispose() {} }; } },
    commands: { registerCommand: id => { reg.commands.push(id); return { dispose() {} }; } },
    Uri: class {},
  };
  const orig = Module._load;
  Module._load = function (req, ...rest) { return req === 'vscode' ? vscode : orig.call(this, req, ...rest); };
  try {
    delete require.cache[dist];
    const ext = require(dist);
    const ctx = { subscriptions: [] };
    ext.activate(ctx);
    assert.deepStrictEqual(reg.editors.map(e => e[0]), ['jsonlViewer.viewer']);
    assert.strictEqual(reg.editors[0][2].webviewOptions.retainContextWhenHidden, false);
    assert.deepStrictEqual(reg.commands.sort(), ['jsonlViewer.getStarted', 'jsonlViewer.open']);
    assert.strictEqual(ctx.subscriptions.length, 3);
    const pkg = require('../package.json');
    assert.strictEqual(pkg.contributes.customEditors[0].viewType, 'jsonlViewer.viewer');
    for (const c of pkg.contributes.commands) assert.ok(reg.commands.includes(c.command), c.command);
  } finally { Module._load = orig; }
});
