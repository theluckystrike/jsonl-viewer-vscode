'use strict';
// README screenshots from the real webview: html.js page (with its CSP), dist/webview.js, and the
// real session (protocol.js + doc.js) on the generated sample files, driven over CDP.
// Usage: node scripts/screenshot/live.js <cdpPort> <outDir> <scenario>
//   scenarios: chat-dark, table-dark, record-light, edge-dark
// Samples: node scripts/make-samples.js (writes samples/). Chrome: ~/bin/agent-chrome with AGENT_CHROME_HEADLESS=1.
const fs = require('fs');
const http = require('http');
const path = require('path');
const root = path.join(__dirname, '..', '..');
const cdpPort = process.argv[2], out = process.argv[3], scenario = process.argv[4];
const { buildHtml } = require(root + '/src/html');
const { validateWebviewMessage, createSession } = require(root + '/src/core/protocol');
const { JsonlDoc } = require(root + '/src/core/doc');
const DATA = process.env.SHOT_DATA || path.join(root, 'samples');

const THEMES = {
  dark: `--vscode-foreground:#cccccc;--vscode-descriptionForeground:#9d9d9d;--vscode-editor-background:#1f1f1f;--vscode-panel-border:#2b2b2b;--vscode-input-background:#313131;--vscode-input-foreground:#cccccc;--vscode-input-border:#3c3c3c;
  --vscode-badge-background:#616161;--vscode-badge-foreground:#f8f8f8;--vscode-button-background:#0078d4;--vscode-button-foreground:#fff;--vscode-button-secondaryBackground:#313131;--vscode-button-secondaryForeground:#ccc;--vscode-button-secondaryHoverBackground:#3c3c3c;
  --vscode-editor-selectionBackground:#264f78;--vscode-list-activeSelectionBackground:#04395e;--vscode-list-activeSelectionForeground:#fff;--vscode-focusBorder:#0078d4;--vscode-list-hoverBackground:#2a2d2e;--vscode-textLink-foreground:#4daafc;--vscode-errorForeground:#f85149;--vscode-editorWarning-foreground:#cca700;
  --vscode-charts-blue:#3794ff;--vscode-charts-green:#89d185;--vscode-charts-orange:#d18616;--vscode-charts-purple:#b180d7;--vscode-charts-yellow:#cca700;--vscode-notifications-background:#202020;
  --vscode-debugTokenExpression-name:#c586c0;--vscode-debugTokenExpression-string:#ce9178;--vscode-debugTokenExpression-number:#b5cea8;--vscode-debugTokenExpression-boolean:#4e94ce;`,
  light: `--vscode-foreground:#3b3b3b;--vscode-descriptionForeground:#717171;--vscode-editor-background:#ffffff;--vscode-panel-border:#e5e5e5;--vscode-input-background:#ffffff;--vscode-input-foreground:#3b3b3b;--vscode-input-border:#cecece;
  --vscode-badge-background:#cccccc;--vscode-badge-foreground:#3b3b3b;--vscode-button-background:#005fb8;--vscode-button-foreground:#fff;--vscode-button-secondaryBackground:#e5e5e5;--vscode-button-secondaryForeground:#3b3b3b;--vscode-button-secondaryHoverBackground:#cccccc;
  --vscode-editor-selectionBackground:#add6ff;--vscode-list-activeSelectionBackground:#e4e6f1;--vscode-list-activeSelectionForeground:#000;--vscode-focusBorder:#005fb8;--vscode-list-hoverBackground:#f2f2f2;--vscode-textLink-foreground:#005fb8;--vscode-errorForeground:#e51400;--vscode-editorWarning-foreground:#895503;
  --vscode-charts-blue:#1a85ff;--vscode-charts-green:#388a34;--vscode-charts-orange:#d18616;--vscode-charts-purple:#652d90;--vscode-charts-yellow:#bf8803;--vscode-notifications-background:#f3f3f3;
  --vscode-debugTokenExpression-name:#9b46b0;--vscode-debugTokenExpression-string:#a31515;--vscode-debugTokenExpression-number:#098658;--vscode-debugTokenExpression-boolean:#0000ff;`,
};
const SCENARIOS = {
  'chat-dark': { theme: 'dark', file: 'chat-finetune.jsonl' },
  'table-dark': { theme: 'dark', file: 'app-logs.ndjson' },
  'record-light': { theme: 'light', file: 'eval-results.jsonl' },
  'edge-dark': { theme: 'dark', file: 'mixed-edge.jsonl' },
};
const sc = SCENARIOS[scenario];
const file = path.join(DATA, sc.file);

const shim = `window.acquireVsCodeApi = () => { let st = null; return {
  postMessage: m => window.hostPost(JSON.stringify(m)), getState: () => st, setState: s => { st = s; } }; };`;
const NONCE = 'harnessnonceharnessnonceharness0';
const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/index.html') {
    let html = buildHtml({ cspSource: `http://127.0.0.1:${server.address().port}`, scriptUri: '/webview.js', styleUri: '/webview.css', title: sc.file, nonce: NONCE });
    html = html.replace('<link rel="stylesheet"', '<link rel="stylesheet" href="/theme.css"><link rel="stylesheet"')
      .replace('<script nonce', `<script nonce="${NONCE}" src="/shim.js"></script><script nonce`);
    res.writeHead(200, { 'content-type': 'text/html' }); return res.end(html);
  }
  if (u === '/shim.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(shim); }
  if (u === '/theme.css') {
    res.writeHead(200, { 'content-type': 'text/css' });
    return res.end(`html{${THEMES[sc.theme]}--vscode-font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--vscode-font-size:13px;--vscode-editor-font-family:Menlo,Monaco,monospace;}`);
  }
  const map = { '/webview.js': [path.join(root, 'dist/webview.js'), 'text/javascript'], '/webview.css': [path.join(root, 'media/webview.css'), 'text/css'] };
  const f = map[u];
  if (!f) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': f[1] }); fs.createReadStream(f[0]).pipe(res);
});

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const t = await (await fetch(`http://127.0.0.1:${cdpPort}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r, { once: true }));
  let id = 0; const waits = new Map(); const logs = [];
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const send = (method, params = {}) => new Promise(r => { const i = ++id; waits.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const evalJs = async expr => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400)); return r.result.result.value; };
  const toWebview = msg => send('Runtime.evaluate', { expression: `window.dispatchEvent(new MessageEvent('message', { data: ${JSON.stringify(msg)} }))` });
  const seen = [];
  const copied = [];
  const session = createSession({ doc: new JsonlDoc({ path: file }), post: m => { seen.push(m); toWebview(m); }, host: { copy: async x => copied.push(x) } });
  let started = false;
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && waits.has(m.id)) { waits.get(m.id)(m); waits.delete(m.id); return; }
    if (m.method === 'Runtime.bindingCalled' && m.params.name === 'hostPost') {
      const msg = validateWebviewMessage(JSON.parse(m.params.payload));
      if (!msg) { logs.push('INVALID ' + m.params.payload.slice(0, 200)); return; }
      if (msg.type === 'ready' && !started) { started = true; session.start(); return; }
      session.handle(msg);
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') logs.push(m.params.args.map(a => a.value || a.description).join(' '));
    if (m.method === 'Runtime.exceptionThrown') logs.push('EXC ' + JSON.stringify(m.params.exceptionDetails).slice(0, 300));
    if (m.method === 'Log.entryAdded') logs.push('LOG ' + m.params.entry.level + ' ' + m.params.entry.text);
  });
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  await send('Runtime.addBinding', { name: 'hostPost' });
  const W = Number(process.env.W || 1280), H = Number(process.env.H || 760);
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: false });
  const t0 = Date.now();
  await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/index.html` });
  const waitFor = async (expr, ms = 15000) => { for (let i = 0; i < ms / 50; i++) { if (await evalJs(expr).catch(() => false)) return true; await sleep(50); } return false; };
  await waitFor(`!!document.querySelector('.body .row .cell:not(.gutter):not(.pending)') || !!document.querySelector('.bubble') || !!document.querySelector('.recbody .node')`);
  const firstPaintMs = Date.now() - t0;
  await waitFor(`document.querySelector('.status .right').textContent.startsWith('Indexed')`);
  await waitFor(`!/checking/.test(document.querySelector('.status .mid').textContent)`);
  const box = async (sel, idx = 0) => JSON.parse(await evalJs(`(() => { const e = document.querySelectorAll(${JSON.stringify(sel)})[${idx}]; const b = e.getBoundingClientRect(); return JSON.stringify({ x: b.x + Math.min(12, b.width / 2), y: b.y + b.height / 2 }); })()`));
  const click = async (p, count = 1) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
    for (let k = 1; k <= count; k++) {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: k });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: k });
    }
  };
  const typeText = async text => { for (const ch of text) await send('Input.dispatchKeyEvent', { type: 'char', text: ch }); };
  const key = async (k, code) => { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: code || k, windowsVirtualKeyCode: { Enter: 13, ArrowDown: 40, ArrowRight: 39 }[k] || 0 }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: code || k }); };
  const button = async text => JSON.parse(await evalJs(`(() => { const e = [...document.querySelectorAll('button')].find(b => b.textContent === ${JSON.stringify(text)} && b.offsetParent); const r = e.getBoundingClientRect(); return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 }); })()`));
  const shot = async name => { await evalJs(`(document.querySelector('.toast').hidden = true, 1)`); const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name), Buffer.from(r.result.data, 'base64')); console.log('shot', name); };
  const views = () => seen.filter(m => m.type === 'view').length;
  const waitView = async (n) => { for (let i = 0; i < 200 && views() <= n; i++) await sleep(50); await sleep(400); };
  const result = { scenario, file: sc.file, firstPaintMs };

  if (scenario === 'chat-dark') {
    await click(await button('Next ▶')); await sleep(400);
    result.bubbles = await evalJs(`document.querySelectorAll('.bubble').length`);
    result.toolBoxes = await evalJs(`document.querySelectorAll('.toolbox').length`);
    await shot('chat-dark.png');
  } else if (scenario === 'table-dark') {
    let v = views();
    await click(await box('.filter')); await typeText('level == error and ctx.ms > 300'); await key('Enter');
    await waitView(v);
    v = views();
    const msIdx = await evalJs(`[...document.querySelectorAll('.hcell')].findIndex(h => h.querySelector('.hname').textContent === 'ts')`);
    await click(await box('.hcell', msIdx)); await waitView(v);
    v = views();
    await click(await box('.hcell', msIdx)); await waitView(v);
    const ctxIdx = await evalJs(`[...document.querySelectorAll('.hcell')].findIndex(h => h.querySelector('.hname').textContent === 'ctx')`);
    await click(await box(`.body .row:not([hidden]):nth-child(3) .cell:not(.gutter)`, ctxIdx)); await sleep(500);
    result.viewCount = seen.filter(m => m.type === 'view').pop().count;
    result.drawer = await evalJs(`!document.querySelector('.drawer').hidden`);
    await shot('table-dark.png');
  } else if (scenario === 'record-light') {
    const v = views();
    await click(await box('.filter')); await typeText('score == 0'); await key('Enter');
    await waitView(v);
    await click(await button('Record')); await sleep(400);
    await click(await button('Next ▶')); await sleep(300);
    await evalJs(`(() => { const n = [...document.querySelectorAll('.nline')].find(l => l.textContent.startsWith('▸tags') || l.textContent.includes('tags')); if (n) n.click(); })()`);
    await sleep(200);
    // hover a line to show the copy-path button
    const lines = await evalJs(`document.querySelectorAll('.nline').length`);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...(await box('.nline', Math.min(4, lines - 1))) });
    await click(await box('.pbtn', 4)); await sleep(300);
    result.copied = copied.slice(-1)[0];
    await shot('record-light.png');
  } else if (scenario === 'edge-dark') {
    await sleep(300);
    result.badRows = await evalJs(`document.querySelectorAll('.row.badrow:not([hidden])').length`);
    result.status = await evalJs(`document.querySelector('.status').textContent`);
    await click(await box('.body .row:not([hidden])', 1), 1); await sleep(300);
    await shot('edge-dark.png');
    // XSS check: the html field must be text, not markup
    result.injected = await evalJs(`document.querySelectorAll('script:not([src]), img').length`);
  }
  result.consoleErrors = logs;
  console.log(JSON.stringify(result));
  await session.dispose();
  await send('Target.closeTarget', { targetId: t.id }).catch(() => {});
  ws.close(); server.close();
  process.exit(0);
})().catch(e => { console.error(e); server.close(); process.exit(1); });
