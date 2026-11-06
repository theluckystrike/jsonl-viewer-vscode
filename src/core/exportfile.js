'use strict';
// CSV and JSON export of records. Pure helpers; the session streams them to a writer.

function csvCell(v) {
  if (v === undefined || v === null) return '';
  const s = typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\r\n]|^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function csvHeader(columns) {
  return columns.map(c => csvCell(c.name)).join(',') + '\r\n';
}

function csvRow(value, columns, valueCol) {
  const isObj = value && typeof value === 'object' && !Array.isArray(value);
  return columns.map(c => csvCell(isObj ? value[c.name] : c.name === valueCol ? value : undefined)).join(',') + '\r\n';
}

module.exports = { csvCell, csvHeader, csvRow };
