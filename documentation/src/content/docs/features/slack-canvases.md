---
title: Slack canvases
description: Create or maintain a longer living document through the explicitly selected connected Slack account.
---

A Slack canvas is a persistent rich document for notes, specifications, meeting outcomes, or a runbook people will edit. It differs from a one-off answer, a read-only data table, or a row-based Slack List.

## Choose the account and destination

```text
@ChannelGate Using my connected Slack account, create a canvas in this
channel with the approved deployment checklist and link it in this thread.
```

“My connected Slack account” selects the requester’s personal identity. An explicit shared-agent account request selects the shared identity. If the intended account is unresolved, the agent must resolve it before creating or updating a document. Logical identity names do not prove which service owner is connected.

Canvas actions come from the selected Composio Slack toolkit. The agent discovers the available create, read, and edit actions rather than assuming a fixed tool name. The native gateway bot’s ability to post charts or Lists does not establish canvas access.

## Create a useful document

Give the agent the desired title, structure, source material, destination, and permitted action. Headings, lists, checkboxes, and tables are appropriate for a living document. After creation, the agent should return a short summary and the canvas link so people can find it.

For an update, identify the existing canvas rather than asking for an unspecified “latest document.” Read its current state, preserve unrelated content, make the authorized edit, and verify the resulting document when the connector supports that read.

## Check prerequisites

The selected identity must have Slack connected and the necessary service permissions. Canvas availability also depends on the workspace and connected toolkit. An absent personal account must not be substituted with the shared agent account merely because that account is connected.

Use [Slack Lists](/docs/features/slack-lists) for records with stable fields, [Slack tables](/docs/features/slack-tables) for compact read-only results, and [file sharing](/docs/features/file-sharing) for a standalone document file.

Related: [connected accounts](/docs/features/connected-accounts) and [report formats](/docs/features/report-artifacts).
