'use strict';
// Size limits. One place, so the README, the messages and the tests agree.
module.exports = {
  MAX_FILE_BYTES: 0xffffffff, // offsets are kept in a Uint32Array, so a file must be under 4 GB
  MAX_LINE_BYTES: 5 * 1024 * 1024, // a longer line is read only up to here and shown as truncated
  MAX_GZ_BYTES: 512 * 1024 * 1024, // a .jsonl.gz is unpacked in memory, up to this size
  MAX_REMOTE_BYTES: 256 * 1024 * 1024, // non-file URIs (virtual workspaces) are read whole
  PAGE: 200, // records per page sent to the webview
  CELL_CHARS: 300, // table cells carry at most this many characters
  RECORD_SEND_BYTES: 5 * 1024 * 1024, // the record and chat views get lines up to this size as parsed JSON
  SCHEMA_SAMPLE: 1000, // columns come from the first 1,000 records
  READ_BATCH: 4 * 1024 * 1024, // jobs read the file in batches of about this size
  MAX_VIEW: 50 * 1000 * 1000, // a search or filter keeps at most this many matches
  MAX_SORT: 2 * 1000 * 1000, // sort works on views up to this many records
};
