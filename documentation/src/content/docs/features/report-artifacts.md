---
title: Tables, charts, Lists, and canvases
description: Choose a native Slack report, an editable tracker, or a connected-account canvas for the output you need.
---

An agent can turn structured findings into a useful artifact directly in Slack. Choose a format based on whether people need to read a result, explore a dataset, edit a tracker, or maintain a longer document.

## Choose the output

| Format | Best for | Access path |
| --- | --- | --- |
| Inline table | Small comparisons within a reply | Normal streamed answer |
| Native data table | Sortable, filterable read-only data | Gateway bot |
| CSV/TSV snippet | Large or wide exports | Gateway bot file upload |
| Native chart | Trends and category comparisons | Gateway bot |
| Slack List | A tracker people can edit | Gateway bot |
| Canvas | A longer shared document | Selected connected Slack account |

For example:

```text
Show the last seven days of completed tasks as a bar chart, then post a
sortable table of task name, owner, and duration in this thread.
```

Native tables and charts post to the current channel/thread. They require no personal Composio connection or channel-side network access. Their destination comes from the trusted conversation context.

## Limits and configuration

Data tables support up to **20 columns**, **100 data rows**, and **10,000 total cell characters**. Numeric cells remain numbers for sorting. Use an exported CSV/TSV for larger data rather than silently omitting rows.

Charts support line, bar, area, and pie. Line/bar/area charts allow up to **12 series** and **20 shared categories**; pie charts allow up to **12 positive segments**. Supply meaningful labels and units. These tools use the bot's existing `chat:write` scope.

Slack Lists require the app's `lists:read` and `lists:write` scopes. Newly created Lists are shared with the current conversation for member editing. The default tracker has Name and Status; ask for custom columns if needed:

```text
Create an editable Slack List here with Name, Status, Owner, and Due date.
```

Canvas access uses the selected Composio Slack account and that account's service permissions. Specify personal or shared identity for creation/updates; the gateway bot's chart access does not establish canvas access.

These native report surfaces are Slack features. Teams and Google Chat simplify answers and do not provide equivalent native chart/table/List controls.

## Related guides

- [Slack data tables and exports](/docs/features/slack-tables)
- [Native Slack charts](/docs/features/slack-charts)
- [Editable Slack Lists](/docs/features/slack-lists)
- [Slack](/docs/features/slack)
- [Share and export files](/docs/features/file-sharing)
- [Connected accounts](/docs/features/connected-accounts)
- [Attachments and voice](/docs/features/attachments-and-voice)

For a persistent shared document, see [Slack canvases](/docs/features/slack-canvases).
