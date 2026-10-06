---
title: Editable Slack Lists
description: Create a shared tracker, inspect its columns, and add or update records.
---

A Slack List is a native tracker people can edit over time. It is appropriate for an action register, issue triage, or shared checklist; a read-only export is better served by a table or snippet.

## Create a tracker

```text
@ChannelGate Create a Slack List for launch actions with Name, Status,
Owner, and Due date. Share it with this conversation.
```

The gateway bot uses Slack Lists APIs. The app needs `lists:read` and `lists:write` scopes, plus a Slack workspace plan and service permissions supporting Lists. New Lists are shared with the current conversation for member editing.

Without a custom schema, the gateway creates Name and a Status selection with New, In progress, and Done. `todo_mode` requests Slack's built-in to-do fields instead. Custom columns can use supported Slack field types such as text, select, user, date, checkbox, and number.

## Work with records

Save the returned `list_id`. Tools accept the raw Slack List ID or its pasted URL. For an existing List, inspect the columns first with `slack_list_info`; fields can be addressed by their column name, key, or ID.

```text
Read the tracker columns and current records, then mark the deployment
review item Done without creating a duplicate.
```

Use `slack_list_items` to obtain a row's item ID, then `slack_list_update_item` to change it. Titles and other fields can be edited separately. Select values can use the option's visible label.

## Respect List scope

The List must be accessible to the bot and shared with the current conversation. Knowing a List URL does not bypass that sharing check. A requested update is a real shared-record mutation; identify the correct row and verify the result rather than adding a duplicate when an update fails.

These tools are native gateway bot tools, separate from the connected-account Slack toolkit. Canvases use a different account route and are covered in [report formats](/docs/features/report-artifacts).

Related: [Slack table formats](/docs/features/slack-tables) and [the Lists control reference](/docs/controls/slack#slack_list_create).
