---
title: Native Slack charts
description: Show a trend or comparison with an inline line, bar, area, or pie chart.
---

ChannelGate can post a structured chart directly in the current Slack thread. Slack renders the visualization from the supplied data, so no external chart service or public image URL is needed.

## Choose a chart

| Chart | Use for |
| --- | --- |
| Line | Changes over ordered time points |
| Bar | Comparing categories or periods |
| Area | Showing magnitude over a shared ordered axis |
| Pie | Positive parts of a total |

```text
@ChannelGate Chart completed tasks per day for the last week as bars.
Label the axis with dates and task count, and summarize the largest change.
```

Use a chart when the pattern is clearer visually. Use a table or export when readers need exact large datasets; a chart does not justify omitting relevant source rows without explanation.

## Supply compatible data

Line, bar, and area charts support 1–12 uniquely named series. Each series has 1–20 points, and all series must use the same category labels. The first series defines display order; subsequent series are normalized to it. Values must be finite numbers.

Pie charts support 1–12 positive segments. Zero or negative values do not form valid segments; choose a different chart when those values matter.

Titles are limited to 50 characters, series and category labels to 20, and axis labels to 50. A meaningful optional summary supports notifications and accessibility; the gateway can generate fallback text from the data when it is omitted.

## Understand delivery

The tool posts with the workspace bot's existing `chat:write` scope. It does not need a personal Composio connection or a browser session. The destination is bound to the current trusted conversation context.

After posting, the agent should state the useful takeaway without duplicating the chart as ASCII or pasting every value into another reply. Ask explicitly for a companion exact-data table when you need one.

Native charts are a Slack surface. Teams and Google Chat use their own degraded reply formats.

Related: [Slack tables](/docs/features/slack-tables), [report formats](/docs/features/report-artifacts), and the [`slack_post_chart` reference](/docs/controls/slack#slack_post_chart).
