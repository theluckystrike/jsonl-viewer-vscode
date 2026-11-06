'use strict';
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { createSession, JsonlDoc } = require('./core/protocol');
const { TooBigError } = require('./core/doc');
const { buildHtml } = require('./html');
const L = require('./core/limits');
const { createRatingPrompt } = require('./rate');
const { registerSupport, commandUris, showLinks } = require('./support');

let rating = { success() {} };

const VIEW_TYPE = 'jsonlViewer.viewer';
const TEXT_SYNC_LIMIT = 50 * 1024 * 1024; // VS Code does not sync larger text files to extensions

class JsonlEditorProvider {
  constructor(context) { this.context = context; }

  openCustomDocument(uri) { return { uri, dispose() {} }; }

  async resolveCustomEditor(document, panel) {
    const uri = document.uri;
    const ctx = this.context;
    const dist = vscode.Uri.joinPath(ctx.extensionUri, 'dist');
    const media = vscode.Uri.joinPath(ctx.extensionUri, 'media');
    // Command links are limited to the two support commands and the settings page (footer "Hide" link).
    panel.webview.options = { enableScripts: true, localResourceRoots: [dist, media], enableCommandUris: commandUris('jsonlViewer') };
    panel.webview.html = buildHtml({
      cspSource: panel.webview.cspSource,
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.js')).toString(),
      styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'webview.css')).toString(),
      title: path.posix.basename(uri.path),
      showSupportLinks: showLinks(vscode, 'jsonlViewer'),
    });

    const makeDoc = () => new JsonlDoc({ path: uri.fsPath });
    let doc;
    if (uri.scheme === 'file') doc = makeDoc();
    else doc = await remoteDoc(uri);

    let counted = false; // one success per opened tab, for the rating prompt
    const post = m => {
      panel.webview.postMessage(m).then(undefined, () => {});
      if (!counted && m && m.type === 'init' && !m.error) { counted = true; rating.success(); }
    };
    const session = createSession({
      doc,
      post,
      host: {
        makeDoc,
        copy: text => vscode.env.clipboard.writeText(text),
        info: text => vscode.window.showInformationMessage(text),
        openAsText: () => vscode.commands.executeCommand('vscode.openWith', uri, 'default'),
        openLine: (line, text, d) => openLine(uri, line, text, d),
        openWriter: (format, name) => openWriter(uri, format, name),
      },
    });
    panel.webview.onDidReceiveMessage(m => session.handle(m));
    session.start();

    // Live tail: fs.watch plus a slow poll while the tab is visible (some file systems drop events).
    let timer = null, watcher = null, poll = null;
    const changed = () => { clearTimeout(timer); timer = setTimeout(() => session.onFileChange(), 300); };
    const tailOn = () => vscode.workspace.getConfiguration('jsonlViewer').get('liveTail', true);
    if (uri.scheme === 'file' && !doc.gz) {
      try { watcher = fs.watch(uri.fsPath, { persistent: false }, changed); watcher.on('error', () => {}); } catch { /* polling still works */ }
      poll = setInterval(() => { if (panel.visible && tailOn()) session.onFileChange(); }, 2000);
    }
    panel.onDidDispose(() => {
      clearTimeout(timer);
      clearInterval(poll);
      if (watcher) watcher.close();
      session.dispose();
    });
  }
}

async function remoteDoc(uri) {
  const name = path.posix.basename(uri.path);
  const st = await vscode.workspace.fs.stat(uri);
  if (st.size > L.MAX_REMOTE_BYTES) {
    const err = new TooBigError(st.size, L.MAX_REMOTE_BYTES, 'This remote file');
    const p = Promise.reject(err);
    p.catch(() => {});
    return { name, format: 'jsonl', open: () => p, whenDone: p, close: async () => {}, count: 0 };
  }
  const bytes = await vscode.workspace.fs.readFile(uri);
  return new JsonlDoc({ bytes, name });
}

async function openLine(uri, line, text, doc) {
  const canOpenFile = uri.scheme === 'file' && !doc.gz && doc.size <= TEXT_SYNC_LIMIT;
  if (canOpenFile) {
    const td = await vscode.workspace.openTextDocument(uri);
    const ln = Math.min(line - 1, td.lineCount - 1);
    const range = td.lineAt(ln).range;
    await vscode.window.showTextDocument(td, { viewColumn: vscode.ViewColumn.Beside, selection: range, preview: true });
    return;
  }
  // Big or packed files: open the one line as a JSON document.
  let content = text;
  try { content = JSON.stringify(JSON.parse(text), null, 2); } catch { /* keep the raw line */ }
  const td = await vscode.workspace.openTextDocument({ content, language: 'json' });
  await vscode.window.showTextDocument(td, { viewColumn: vscode.ViewColumn.Beside, preview: true });
  vscode.window.setStatusBarMessage(`Line ${line} of ${path.posix.basename(uri.path)}`, 5000);
}

async function openWriter(uri, format, name) {
  const filters = { csv: { CSV: ['csv'] }, json: { JSON: ['json'] }, jsonl: { 'JSON Lines': ['jsonl'] } }[format];
  const dir = vscode.Uri.joinPath(uri, '..');
  const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.joinPath(dir, name), filters, saveLabel: 'Export' });
  if (!target) return null;
  if (target.scheme === 'file') {
    const ws = fs.createWriteStream(target.fsPath);
    const failed = new Promise((_, rej) => ws.on('error', rej));
    failed.catch(() => {});
    return {
      label: path.basename(target.fsPath),
      write: s => Promise.race([failed, new Promise(res => { if (ws.write(s)) res(); else ws.once('drain', res); })]),
      close: () => Promise.race([failed, new Promise(res => ws.end(res))]),
    };
  }
  const parts = [];
  return {
    label: path.posix.basename(target.path),
    write: async s => { parts.push(Buffer.from(s, 'utf8')); },
    close: () => vscode.workspace.fs.writeFile(target, Buffer.concat(parts)),
  };
}

function activate(context) {
  rating = createRatingPrompt({ vscode, context, extensionId: 'zovo.jsonl-viewer', section: 'jsonlViewer', message: (n) => `JSONL Viewer has opened ${n} files for you. A rating helps other people find it.` });
  registerSupport({ vscode, context, prefix: 'jsonlViewer', selfId: 'zovo.jsonl-viewer' });
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, new JsonlEditorProvider(context), {
      supportsMultipleEditorsPerDocument: true,
      webviewOptions: { retainContextWhenHidden: false },
    }),
    vscode.commands.registerCommand('jsonlViewer.open', async (uri) => {
      const target = uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri;
      if (!target) return vscode.window.showInformationMessage('Open or select a .jsonl or .ndjson file first.');
      await vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE);
    }),
    vscode.commands.registerCommand('jsonlViewer.getStarted', () =>
      vscode.commands.executeCommand('workbench.action.openWalkthrough', 'zovo.jsonl-viewer#jsonlViewer.start', false)),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
