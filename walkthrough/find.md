# Find and filter

Type text in the Find box and press Enter. It matches any line that holds that text, in any case.

The Filter box reads the parsed values. A few examples follow.

```
level == error
ctx.ms > 500 and route contains /api
messages[0].role == system
error exists
```

Both run in the background over the whole file. Click Cancel to stop early, and Show all to go back.
