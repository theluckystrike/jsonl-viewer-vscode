'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

/** A temp folder for one test file. Call cleanup() in after(). */
function tempDir(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `jsonl-viewer-${tag}-`));
  return { dir, file: name => path.join(dir, name), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** Generate the sample files into dir (same script the README screenshots use). */
function makeSamples(dir) {
  execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'make-samples.js'), dir], { stdio: 'ignore' });
}

/** A session wired to an array of posted messages. */
function harness(doc, host = {}) {
  const { createSession } = require('../src/core/protocol');
  const msgs = [];
  const waiters = [];
  const post = m => {
    msgs.push(m);
    for (const w of waiters.slice()) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.res(m); }
  };
  const session = createSession({ doc, post, host });
  const next = (pred, ms = 10000) => new Promise((res, rej) => {
    const hit = msgs.find(m => pred(m) && !m._seen);
    if (hit) { hit._seen = true; return res(hit); }
    const w = { pred: m => pred(m) && !m._seen && (m._seen = true), res };
    waiters.push(w);
    setTimeout(() => rej(new Error('timeout waiting for message')), ms).unref();
  });
  return { session, msgs, next };
}

module.exports = { tempDir, makeSamples, harness };
