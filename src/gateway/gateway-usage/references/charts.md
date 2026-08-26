# Charts in Slack

Use `slack_post_chart` when the user asks for a chart/graph or when a compact visual makes a real
comparison or trend easier to see. It posts a **native Slack Block Kit chart** into THIS channel and
thread as the bot. It needs no image renderer, public URL, Composio connection, Bash, or network
access from the channel.

Do not add a chart merely as decoration. Never invent values. If the source data is incomplete,
say so or ask for it before charting.

## Pick the chart type

- `line` — change over ordered categories, usually time.
- `area` — change over time when magnitude/volume is the point; keep overlapping series limited.
- `bar` — compare categories or a few grouped series.
- `pie` — parts of one whole; use only with positive values and a small number of segments.

## Tool shape

`slack_post_chart` fields:

- `chart_type` — `line`, `bar`, `area`, or `pie`.
- `title` — required, at most 50 characters.
- For `line` / `bar` / `area`: `series` — 1–12 objects, each with a unique `name` and `data` array
  of `{label, value}` points. The first series defines category order; every series must contain
  exactly the same labels. At most 20 points per series. Negative numeric values are allowed.
- For `pie`: `segments` — 1–12 unique `{label, value}` objects; values must be greater than zero.
- `x_label` / `y_label` — optional axis titles for line/bar/area.
- `summary` — optional plain-text accessibility/notification fallback. If omitted, the gateway
  generates one from the exact chart data.

Series names and data labels are at most 20 characters. Use short, meaningful labels; do not hide
meaning with unexplained abbreviations.

Line example: `chart_type:"line"`, `title:"Weekly requests"`,
`series:[{name:"Requests",data:[{label:"Mon",value:120},{label:"Tue",value:165}]}]`,
`x_label:"Day"`, `y_label:"Requests"`.

Pie example: `chart_type:"pie"`, `title:"Tickets by status"`,
`segments:[{label:"Open",value:8},{label:"Closed",value:12}]`.

## Limits and reply behavior

- Do **not** silently truncate data to fit Slack's 20-point / 12-series limits. Aggregate only when
  that preserves the user's intent and say what aggregation you used. Otherwise use
  `slack_upload_snippet` for the exact dataset or ask which slice to chart.
- For a large/wide exact report, use CSV/TSV via `slack_upload_snippet`; charts summarize patterns,
  tables carry exact detail. Use both only when both genuinely help.
- After the tool succeeds, write only a short takeaway in the normal reply. Do not redraw an ASCII
  chart or paste all chart values again unless the user asked for them.
- The tool is already hard-scoped to the current channel/thread. There is no channel-id argument.
