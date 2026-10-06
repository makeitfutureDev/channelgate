---
title: Slack data tables and spreadsheet exports
description: Present sortable read-only results or export larger datasets as CSV and TSV.
---

Choose a table format based on how much data readers need and whether they need to edit it. Native tables and snippets are posted by the gateway bot into the current Slack conversation and originating thread.

## Post a native data table

```text
@ChannelGate Post a sortable table of tasks, owners, and hours in this thread.
Keep hours numeric and include every matching task.
```

`slack_post_table` creates an inline structured data table with headers, pagination, sorting, and filtering. It supports 1–20 columns, 1–100 rows, and a 10,000-character combined cell budget. Every row must have one string or finite-number cell per header; numeric cells remain numeric.

The default page shows up to ten rows. An optional row-header column helps screen readers, and a summary can provide notification and accessibility text. Short exact values are usually easier to scan than paragraphs in each cell.

## Export a larger dataset

For a large or wide result, ask for a CSV or TSV snippet:

```text
Export all matched rows as results.tsv and post the file here.
```

`slack_upload_snippet` takes generated text and uploads it as a Slack file. The extension controls presentation: CSV and TSV receive a spreadsheet-style preview; Markdown or code extensions produce text snippets. TSV is useful when values contain commas, but tabs and line breaks still need correct escaping or normalization.

If the file already exists in the workspace, use `slack_share_file` to send its actual bytes instead of retyping it into a snippet argument. The existing-file upload limit is 25 MB.

## Choose an editable tracker when needed

A native data table is read-only. Use [Slack Lists](/docs/features/slack-lists) for shared records people should update over time. Small comparisons can stay in the ordinary answer as a Markdown table.

These native report tools do not require a personal Composio connection or channel-side network access. They are Slack capabilities, without equivalent native surfaces in the Beta Teams or Google Chat adapters.

Related: [report formats](/docs/features/report-artifacts), [file sharing](/docs/features/file-sharing), and [table control reference](/docs/controls/slack#slack_post_table).
