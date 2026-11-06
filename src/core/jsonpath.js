'use strict';
// JSONPath strings for the "copy JSONPath" action. Shared by the webview and the tests.

function pathString(segs) {
  let s = '$';
  for (const k of segs) {
    if (typeof k === 'number') s += `[${k}]`;
    else if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k)) s += '.' + k;
    else s += `['${String(k).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}']`;
  }
  return s;
}

/** The same path in the filter language (no leading $). */
function filterPath(segs) {
  const s = pathString(segs);
  return s === '$' ? '' : s.slice(s[1] === '.' ? 2 : 1).replace(/\['((?:[^'\\]|\\.)*)'\]/g, (m, k) => `["${k.replace(/\\'/g, "'").replace(/"/g, '\\"')}"]`);
}

module.exports = { pathString, filterPath };
