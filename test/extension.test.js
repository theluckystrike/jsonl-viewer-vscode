'use strict';
// Loads the bundled extension with a stub vscode module and checks what it registers.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

test('activate registers the custom editor and all four commands', () => {
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
    assert.deepStrictEqual(reg.commands.sort(), ['jsonlViewer.getStarted', 'jsonlViewer.moreViewers', 'jsonlViewer.open', 'jsonlViewer.supportDeveloper']);
    assert.strictEqual(ctx.subscriptions.length, 5);
    const pkg = require('../package.json');
    assert.strictEqual(pkg.contributes.customEditors[0].viewType, 'jsonlViewer.viewer');
    for (const c of pkg.contributes.commands) assert.ok(reg.commands.includes(c.command), c.command);
  } finally { Module._load = orig; }
});

// ---------- support links (Sponsor, More free viewers) ----------
test('support: package.json has the sponsor field, the two commands and the setting', () => {
  const pkg = require('../package.json');
  const support = require('../src/support');
  assert.strictEqual(pkg.sponsor.url, 'https://github.com/sponsors/theluckystrike');
  assert.strictEqual(pkg.sponsor.url, support.sponsorUrl());
  const ids = pkg.contributes.commands.map(c => c.command);
  assert.ok(ids.includes('jsonlViewer.supportDeveloper') && ids.includes('jsonlViewer.moreViewers'));
  const cfg = Array.isArray(pkg.contributes.configuration) ? pkg.contributes.configuration : [pkg.contributes.configuration];
  const props = Object.assign({}, ...cfg.map(c => c.properties));
  assert.strictEqual(props['jsonlViewer.showSupportLinks'].default, true);
  assert.ok(support.otherProducts('zovo.zovo-jsonl-viewer').every(p => p.id !== 'zovo.zovo-jsonl-viewer'));
});

test('support: the footer shows by default and jsonlViewer.showSupportLinks=false hides it', async () => {
  const dist = path.join(__dirname, '..', 'dist', 'extension.js');
  const sample = path.join(__dirname, '..', 'samples', 'eval-results.jsonl');
  for (const [settings, shown] of [[{}, true], [{ showSupportLinks: false }, false]]) {
    let provider;
    const Uri = { joinPath: (u, ...p) => ({ path: path.posix.join(u.path, ...p), fsPath: path.join(u.fsPath, ...p) }) };
    const vscode = {
      Uri,
      window: { registerCustomEditorProvider: (id, p) => { provider = p; return { dispose() {} }; }, showInformationMessage: async () => {} },
      commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => {} },
      workspace: { getConfiguration: () => ({ get: (k, d) => (k in settings ? settings[k] : d) }) },
      env: { clipboard: { writeText: async () => {} } },
    };
    const orig = Module._load;
    Module._load = function (req, ...rest) { return req === 'vscode' ? vscode : orig.call(this, req, ...rest); };
    let dispose = () => {};
    try {
      delete require.cache[dist];
      require(dist).activate({ subscriptions: [], extensionUri: { path: '/ext', fsPath: '/ext' } });
      const webview = { cspSource: 'vscode-webview://t', options: null, html: '', asWebviewUri: u => ({ toString: () => 'vscode-webview://t' + u.path }), postMessage: () => Promise.resolve(true), onDidReceiveMessage: () => ({ dispose() {} }) };
      const panel = { webview, visible: false, onDidDispose: fn => { dispose = fn; return { dispose() {} }; } };
      await provider.resolveCustomEditor({ uri: { scheme: 'file', path: sample, fsPath: sample } }, panel);
      assert.strictEqual(/id="zovo-support"/.test(webview.html), shown, JSON.stringify(settings));
      assert.strictEqual(webview.html.includes('command:jsonlViewer.moreViewers'), shown);
      assert.deepStrictEqual(webview.options.enableCommandUris, ['jsonlViewer.supportDeveloper', 'jsonlViewer.moreViewers', 'workbench.action.openSettings']);
    } finally { dispose(); Module._load = orig; }
  }
});
