'use strict';
// Line-offset index for JSON Lines. It keeps one Uint32 start offset per record and never holds
// the text. Blank and whitespace-only lines are skipped but still counted, so every record knows
// its real line number. feed() can be called again when the file grows (live tail).

class LineIndex {
  constructor() {
    this.starts = new Uint32Array(4096);
    this.count = 0; // records
    this.bytes = 0; // bytes fed so far
    this.lineStart = 0; // start offset of the line being read
    this.hasContent = false; // the current line has a non-blank byte (its record is already pushed)
    this.blanks = 0; // blank lines seen so far
    this.blankAt = []; // [recordIndex, blanksBefore] pairs, one per change, for lineOf()
    this.blankVal = [];
  }

  push(start) {
    if (this.count === this.starts.length) {
      const next = new Uint32Array(this.starts.length * 2);
      next.set(this.starts);
      this.starts = next;
    }
    const last = this.blankVal.length ? this.blankVal[this.blankVal.length - 1] : 0;
    if (this.blanks !== last) { this.blankAt.push(this.count); this.blankVal.push(this.blanks); }
    this.starts[this.count++] = start;
  }

  /** Feed the next bytes of the file. buf starts at offset this.bytes. */
  feed(buf) {
    const base = this.bytes;
    const n = buf.length;
    let i = 0;
    while (i < n) {
      if (!this.hasContent) {
        let b = 0;
        while (i < n && ((b = buf[i]) === 32 || b === 9 || b === 13)) i++;
        if (i >= n) break;
        if (b === 10) { this.blanks++; i++; this.lineStart = base + i; continue; }
        this.push(this.lineStart);
        this.hasContent = true;
      }
      const nl = buf.indexOf(10, i);
      if (nl === -1) break;
      this.hasContent = false;
      i = nl + 1;
      this.lineStart = base + i;
    }
    this.bytes = base + n;
  }

  /** 1-based line number of record i. */
  lineOf(i) {
    const a = this.blankAt;
    let lo = 0, hi = a.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (a[mid] <= i) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return i + 1 + (best >= 0 ? this.blankVal[best] : 0);
  }

  /** Record index for a 1-based line number, or -1 when that line is blank or past the end. */
  recordOfLine(line) {
    let lo = 0, hi = this.count - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const l = this.lineOf(mid);
      if (l === line) return mid;
      if (l < line) lo = mid + 1; else hi = mid - 1;
    }
    return -1;
  }

  /** Byte range [start, end) of record i. end may include trailing newlines and blank lines. */
  range(i) {
    return [this.starts[i], i + 1 < this.count ? this.starts[i + 1] : this.bytes];
  }
}

/** Trim trailing whitespace bytes (\n, \r, space, tab) from buf[s, e). Returns the new end. */
function trimEnd(buf, s, e) {
  while (e > s) {
    const b = buf[e - 1];
    if (b === 10 || b === 13 || b === 32 || b === 9) e--; else break;
  }
  return e;
}

module.exports = { LineIndex, trimEnd };
