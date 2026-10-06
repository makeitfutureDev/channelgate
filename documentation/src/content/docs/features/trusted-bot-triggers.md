---
title: Trusted bot triggers
description: Allow selected Slack integration messages to start runs without accepting every bot message.
---

ChannelGate normally ignores bot messages to prevent reply loops. Administrators can explicitly trust a Slack app ID or bot ID so an integration's message can enter the ordinary message pipeline.

## Configure an integration

1. Identify the Slack app or bot that sends the integration message.
2. Add its ID in **Settings → Access & security → Trusted bot apps** and save.
3. Approve the message's Slack author in **Users**.
4. Make the saved message contain a real mention of the ChannelGate bot.
5. Send one bounded test and confirm the resulting thread and author.

The default trusted list is **empty**. Trusting an ID does not bypass approved-user, conversation-access, mention, licensing, or runtime-policy checks.

## Example: a workflow posts a task

An automation can post “@ChannelGate summarize this build result” to its target Slack channel. Verify that the automation's saved/exported message contains the mention; a visual mention in an editor is insufficient if the serialized field dropped it. The receiving pipeline still needs a valid authorized author.

Use the **API** page for the in-product integration example. An HTTP run via [the run API](/docs/features/run-api) is an alternative when a visible Slack trigger message is unnecessary.

## Limits and authority

Only administrators change the trust list. Use app/bot identities rather than matching arbitrary prose. The gateway's own bot messages remain subject to reply-loop safeguards. Trust does not supply a missing personal connector account or make caller-supplied author metadata authoritative in HTTP API runs.

This setting is specific to Slack bot-originated messages. Microsoft Teams and Google Chat use their own authenticated transport admission.

## Related guides

- [Slack](/docs/features/slack)
- [User administration](/docs/features/user-administration)
- [Access and users](/docs/configuration/access-and-users)
