'use strict';
// Byte sources: a file on disk read by offset, or bytes held in memory (.jsonl.gz, remote URIs).
const fs = require('fs');

class FileSource {
  constructor(path) { this.path = path; this.fh = null; }
  async open() { this.fh = await fs.promises.open(this.path, 'r'); return this; }
  async read(offset, length) {
    const buf = Buffer.allocUnsafe(length);
    let got = 0;
    while (got < length) {
      const { bytesRead } = await this.fh.read(buf, got, length - got, offset + got);
      if (!bytesRead) break;
      got += bytesRead;
    }
    return got === length ? buf : buf.subarray(0, got);
  }
  async close() { if (this.fh) { const fh = this.fh; this.fh = null; await fh.close().catch(() => {}); } }
}

class MemSource {
  constructor() { this.chunks = []; this.ends = []; this.size = 0; }
  push(chunk) { this.chunks.push(chunk); this.size += chunk.length; this.ends.push(this.size); }
  async read(offset, length) {
    const end = Math.min(this.size, offset + length);
    if (end <= offset) return Buffer.alloc(0);
    let lo = 0, hi = this.ends.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.ends[mid] <= offset) lo = mid + 1; else hi = mid; }
    const parts = [];
    let pos = offset;
    for (let k = lo; pos < end; k++) {
      const cStart = this.ends[k] - this.chunks[k].length;
      const s = pos - cStart;
      const e = Math.min(this.chunks[k].length, end - cStart);
      parts.push(this.chunks[k].subarray(s, e));
      pos = cStart + e;
    }
    return parts.length === 1 ? parts[0] : Buffer.concat(parts);
  }
  async close() { this.chunks = []; this.ends = []; }
}

module.exports = { FileSource, MemSource };
