---
title: Start work from messages and reactions
description: Invoke the agent in DMs, channels, existing threads, or with an engagement reaction.
---

ChannelGate starts an agent turn when a message passes both the conversation's trigger rules and the author's access checks. Addressing the bot alone does not grant access.

## Send a request

| Surface | How to start |
| --- | --- |
| Direct message to the bot | Send a message without a mention. |
| Public or private Slack channel | Invite the bot and mention it in the request. |
| Group DM | Mention the bot. |
| Existing channel thread | Reply in the thread and mention the bot. |

```text
@ChannelGate Review the proposed change and list any migration risks.
```

A new top-level request starts a thread. Replies continue that thread's session; project files remain shared across the conversation. The bot ignores its own messages and deduplicates repeated Slack deliveries.

If mentioning a bot that is not yet in a channel leads Slack to offer an invitation, accept it. On joining, ChannelGate checks a bounded recent window for the pending mention rather than requiring the request to be sent again.

## Engage with a reaction

React with the configured engagement emoji, normally 🤖, to treat a message as a request. The **person adding the reaction** becomes the author: their authorization and personal connections apply.

Reaction engagement works in DMs, on a new top-level message, and in threads already owned by this gateway. A thread with an existing session, a gateway-authored reminder root, or a prior gateway command reply can qualify. Reaction engagement does not hijack another bot's unrelated thread; explicitly mention ChannelGate there instead.

## Stop work

Use `/stop` in the appropriate thread or a supported stop reaction, such as 🛑 or ❌, on its message. Stop controls still check authorization. Cancelling a turn is different from marking a follow-up done with ✅.

Related: [conversations](/docs/features/conversations), [steer, queue, and stop](/docs/features/collaboration-and-steering), and [chat commands](/docs/features/chat-commands). Teams and Google Chat are Beta and have their own supported trigger behavior; see [platforms](/docs/platforms).
