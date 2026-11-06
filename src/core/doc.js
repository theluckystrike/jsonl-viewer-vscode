'use strict';
// A JSON Lines document: a byte source plus its line index. The text is read by offset on demand.
const fs = require('fs');
const path = require('path');
const { Gunzip } = require('fflate');
const L = require('./limits');
const { LineIndex, trimEnd } = require('./lineindex');
const { FileSource, MemSource } = require('./source');

class TooBigError extends Error {
  constructor(size, limit, what) {
    super(`${what} is ${fmtBytes(size)}. JSONL Viewer opens files up to ${fmtBytes(limit)}.`);
    this.code = 'TOO_BIG';
    this.size = size;
  }
}

function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n, k = -1;
  do { v /= 1024; k++; } while (v >= 1024 && k < u.length - 1);
  return (v >= 100 ? v.toFixed(0) : v.toFixed(1)) + ' ' + u[k];
}

function formatOf(name) {
  const n = name.toLowerCase();
  if (n.endsWith('.gz')) return 'gzip';
  if (n.endsWith('.ndjson')) return 'ndjson';
  if (n.endsWith('.jsonlines')) return 'jsonlines';
  return 'jsonl';
}

class JsonlDoc {
  /** @param {{path?:string, name?:string, bytes?:Uint8Array, gz?:boolean}} opts */
  constructor(opts) {
    this.path = opts.path || null;
    this.name = opts.name || (this.path ? path.basename(this.path) : 'data.jsonl');
    this.format = formatOf(this.name);
    this.gz = opts.gz !== undefined ? opts.gz : this.format === 'gzip';
    this.bytesIn = opts.bytes || null;
    this.index = new LineIndex();
    this.source = null;
    this.size = 0; // file size on disk (compressed size for .gz)
    this.done = false;
    this.capped = ''; // set when only the first part of the data was indexed
    this.indexMs = 0;
    this.closed = false;
    this.busy = Promise.resolve();
  }

  get count() { return this.index.count; }
  get bytes() { return this.index.bytes; }
  get canTail() { return !!this.path && !this.gz; }

  /**
   * Start indexing. Resolves once the first `early` records are indexed (or the file is done),
   * so the first page can show while the rest is indexed. `whenDone` resolves at the end.
   */
  open({ early = L.PAGE, onProgress } = {}) {
    const t0 = Date.now();
    let earlyResolve, earlyReject;
    const earlyP = new Promise((res, rej) => { earlyResolve = res; earlyReject = rej; });
    let lastTick = 0;
    const tick = () => {
      if (!this.done && this.index.count >= early) earlyResolve();
      const now = Date.now();
      if (onProgress && now - lastTick > 100) { lastTick = now; onProgress(this.progress()); }
    };
    const finish = () => {
      this.done = true;
      this.indexMs = Date.now() - t0;
      earlyResolve();
      if (onProgress) onProgress(this.progress());
    };
    this.whenDone = (async () => {
      if (this.bytesIn) return this.openBytes(tick, finish);
      const st = await fs.promises.stat(this.path);
      this.size = st.size;
      if (st.size > L.MAX_FILE_BYTES) throw new TooBigError(st.size, L.MAX_FILE_BYTES, 'This file');
      if (this.gz) return this.openGz(tick, finish);
      this.source = await new FileSource(this.path).open();
      if (st.size > 0) await new Promise((resolve, reject) => {
        const rs = fs.createReadStream(this.path, { highWaterMark: 1024 * 1024, end: st.size - 1 });
        this.stream = rs;
        rs.on('data', c => { if (this.closed) return rs.destroy(); this.index.feed(c); tick(); });
        rs.on('error', reject);
        rs.on('close', resolve);
      });
      finish();
    })();
    this.whenDone.catch(e => earlyReject(e));
    return earlyP;
  }

  async openBytes(tick, finish) {
    let bytes = this.bytesIn;
    this.size = bytes.length;
    const mem = new MemSource();
    this.source = mem;
    if (this.gz) {
      await this.gunzip(bytes, c => { mem.push(c); this.index.feed(c); tick(); });
    } else {
      if (bytes.length > L.MAX_FILE_BYTES) throw new TooBigError(bytes.length, L.MAX_FILE_BYTES, 'This file');
      const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
      mem.push(buf);
      this.index.feed(buf);
    }
    this.bytesIn = null;
    finish();
  }

  async openGz(tick, finish) {
    const mem = new MemSource();
    this.source = mem;
    const rs = fs.createReadStream(this.path, { highWaterMark: 1024 * 1024 });
    this.stream = rs;
    await this.gunzip(rs, c => { mem.push(c); this.index.feed(c); tick(); });
    finish();
  }

  /** Unpack gzip from a Uint8Array or a stream, calling onChunk with Buffers. Stops at MAX_GZ_BYTES. */
  gunzip(input, onChunk) {
    return new Promise((resolve, reject) => {
      let total = 0, stopped = false;
      const gz = new Gunzip((chunk) => {
        if (stopped) return;
        if (total + chunk.length > L.MAX_GZ_BYTES) {
          const keep = L.MAX_GZ_BYTES - total;
          if (keep > 0) onChunk(Buffer.from(chunk.subarray(0, keep)));
          total = L.MAX_GZ_BYTES;
          stopped = true;
          this.capped = `Only the first ${fmtBytes(L.MAX_GZ_BYTES)} of unpacked data is shown. Unpack the file to see all of it.`;
          return;
        }
        total += chunk.length;
        onChunk(Buffer.from(chunk));
      });
      const push = (c, final) => {
        try { gz.push(c, final); } catch (e) { stopped = true; reject(new Error('This .gz file is damaged or not gzip: ' + e.message)); return false; }
        return true;
      };
      if (input instanceof Uint8Array) {
        for (let o = 0; o < input.length && !stopped; o += 1024 * 1024) push(input.subarray(o, Math.min(input.length, o + 1024 * 1024)), false);
        if (!stopped) push(new Uint8Array(0), true);
        resolve();
        return;
      }
      input.on('data', c => {
        if (this.closed || stopped) { input.destroy(); return; }
        push(c, false);
      });
      input.on('error', reject);
      input.on('close', () => { if (!stopped) push(new Uint8Array(0), true); resolve(); });
    });
  }

  progress() {
    return { count: this.index.count, bytes: this.index.bytes, size: this.gz ? 0 : this.size, done: this.done, ms: this.indexMs };
  }

  /**
   * Read records by index. ids must be valid record indices (any order). Returns
   * [{i, line, text, truncated, len}] in the same order. Lines over MAX_LINE_BYTES are cut.
   */
  async readRecords(ids) {
    const idx = this.index;
    const items = ids.map((i, k) => { const [s, e] = idx.range(i); return { k, i, s, e }; });
    const sorted = items.slice().sort((a, b) => a.s - b.s);
    const out = new Array(ids.length);
    let g = 0;
    while (g < sorted.length) {
      const first = sorted[g];
      if (first.e - first.s > L.MAX_LINE_BYTES) {
        const buf = await this.source.read(first.s, L.MAX_LINE_BYTES);
        out[first.k] = this.decode(first, buf, 0, buf.length, true);
        g++;
        continue;
      }
      let h = g + 1, end = first.e;
      while (h < sorted.length) {
        const nx = sorted[h];
        if (nx.e - nx.s > L.MAX_LINE_BYTES || nx.s - end > 65536 || nx.e - first.s > L.READ_BATCH) break;
        end = Math.max(end, nx.e);
        h++;
      }
      const buf = await this.source.read(first.s, end - first.s);
      for (let q = g; q < h; q++) {
        const it = sorted[q];
        out[it.k] = this.decode(it, buf, it.s - first.s, Math.min(buf.length, it.e - first.s), false);
      }
      g = h;
    }
    return out;
  }

  decode(it, buf, s, e, truncated) {
    const end = truncated ? e : trimEnd(buf, s, e);
    let text = buf.toString('utf8', s, end);
    if (it.s === 0 && text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return { i: it.i, line: this.index.lineOf(it.i), text, truncated, len: truncated ? it.e - it.s : end - s };
  }

  /**
   * Live tail: index bytes added since the last read. Returns {from, count} when records were
   * added or changed (from = first record to refresh), 'reset' when the file shrank or was
   * replaced, or null when nothing changed.
   */
  tail() {
    const run = async () => {
      if (!this.canTail || !this.done || this.closed) return null;
      let st;
      try { st = await fs.promises.stat(this.path); } catch { return null; }
      if (st.size < this.index.bytes) return 'reset';
      if (st.size === this.index.bytes) return null;
      if (st.size > L.MAX_FILE_BYTES) return 'reset';
      const before = this.index.count;
      const partial = this.index.hasContent; // the last record had no newline yet
      let pos = this.index.bytes;
      while (pos < st.size) {
        const n = Math.min(L.READ_BATCH, st.size - pos);
        const buf = await this.source.read(pos, n);
        if (!buf.length) break;
        this.index.feed(buf);
        pos += buf.length;
      }
      this.size = st.size;
      const from = partial && before > 0 ? before - 1 : before;
      return { from, count: this.index.count };
    };
    const p = this.busy.then(run, run);
    this.busy = p.catch(() => null);
    return p;
  }

  async close() {
    this.closed = true;
    if (this.stream) this.stream.destroy();
    if (this.source) await this.source.close();
  }
}

module.exports = { JsonlDoc, TooBigError, fmtBytes, formatOf };
