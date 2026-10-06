---
title: Follow-up digests
description: Receive a personal digest of agent conversations that are waiting for your response.
---

ChannelGate can send approved users a DM containing links to agent threads awaiting their response. A thread qualifies when the gateway took part, the bot spoke last, and the user participated or was mentioned. A human reply clears the waiting state.

## Defaults and configuration

The digest is enabled by default and runs at **08:00 and 14:00 Europe/Bucharest**. Its clock is separate from ordinary schedule cron time. These settings are stored in the gateway settings file and available through the admin settings API:

| Key | Default | Purpose |
| --- | --- | --- |
| `followupRemindersEnabled` | `true` | Enable personal digests |
| `followupDigestHours` | `[8, 14]` | Local hours, 0–23 |
| `followupTimeZone` | `Europe/Bucharest` | IANA timezone |
| `followupDoneReactions` | `white_check_mark`, `heavy_check_mark` | Done reactions |

There is no dedicated follow-up settings card in the current web form. Operators should preserve unrelated settings when changing these keys. Restart after an operator file edit so the daemon loads it.

## Use a digest

Open a linked thread and answer the agent. Alternatively, mark the thread done with a configured check mark. On a digest message, the recipient's done reaction dismisses the threads recorded in that digest. Removing that digest reaction removes its dismissal markers where they still match; newer activity can reopen a thread.

Each digest contains at most **25 lines**, oldest waiting first. Empty digests are not sent. Durable daily slot markers prevent restart duplicates and allow missed slots to catch up. Tracked thread and digest records are retained for **14 days**.

## Scope

This is the Slack follow-up observer. It sees registered conversations the bot participates in; it does not inspect unrelated private conversations. It is a reminder based on conversation activity, not a semantic promise that every last bot message needs an answer.

## Related guides

- [Quiet-thread nudges](/docs/features/quiet-thread-nudges)
- [Activity and audit](/docs/features/activity-and-audit)
- [Gateway settings](/docs/configuration/gateway-settings)
