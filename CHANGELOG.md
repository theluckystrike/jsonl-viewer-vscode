# Changelog

## 0.1.3 (2026-11-07)

- The "More free viewers" list and the README list now show the 15 Zovo extensions on the Marketplace under their current names, and 12 that are coming soon.
- Extensions for related files now come first, starting with Large JSON Viewer & JSON Tree and CSV Viewer, Excel Viewer & Parquet Viewer.

## 0.1.2 (2026-11-06)

- The status line at the bottom of the viewer ends with two small links, "Sponsor" (GitHub Sponsors) and "More free viewers". The new setting `jsonlViewer.showSupportLinks` (default `true`) hides them, and so does the "Hide" link next to them. There is no popup, and nothing is sent anywhere.
- New commands "JSONL Viewer: Support the developer" and "JSONL Viewer: More free viewers". The second one lists the other Zovo extensions and installs only the one you pick. Ones that are not on the Marketplace yet open their GitHub page.
- The listing gets a Sponsor button. The README has a short Support section and lists all Zovo extensions.

## 0.1.1 (2026-11-06)

- JSONL Viewer asks one time for a Marketplace rating. It counts each file that opens in the viewer. After 5 of them, and no sooner than 2 days after the first, it shows a small message with "Rate it", "Later" and "Don't ask again". "Later" waits for 20 more, at most two more times. It never shows in your first session, more than once per session, when the window is not focused, or in a remote or untrusted workspace.
- New setting `jsonlViewer.askForRating` (default `true`) turns it off. Nothing is sent anywhere; "Rate it" only opens the review page in your browser.

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
