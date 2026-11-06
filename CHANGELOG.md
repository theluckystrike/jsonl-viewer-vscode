# Changelog

## 0.1.0

First release.

- Opens `.jsonl`, `.ndjson`, `.jsonlines`, `.jsonl.gz` and `.ndjson.gz` files in a read-only viewer.
- Streams the file and keeps a line-offset index, so the first page shows before the whole file is read.
- Table view with columns from the keys, their type and fill %, sorting, and a value tree for any cell.
- Record view with a JSON tree and copy JSONPath.
- Chat view for OpenAI, ShareGPT, Gemini and Anthropic style records, with tool calls and tool results.
- Find and filter across the whole file, with progress and Cancel.
- Bad lines in red with their line numbers, a count, and a bad-lines-only view.
- Live tail for files that grow, with Follow.
- Export to CSV, JSON or JSON Lines, and open any line in the text editor.
