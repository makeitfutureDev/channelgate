---
title: Slack App Home
description: Check your gateway role, personal connections, skills, and visible conversations.
---

Open the ChannelGate app in Slack and select **Home** for an orientation dashboard. Select **Messages** to talk directly to the bot without mentioning it.

## Understand your access

Home identifies whether you are an administrator, an approved user, or awaiting approval. It also lists gateway conversations visible to you, with their mode and any configured engine. Private Slack conversations are subject to membership checks; the list is not a directory of every private channel on the gateway.

The channel list is bounded. If it shows a count with a plus sign, more eligible conversations exist than fit in the view.

## Check personal connections

The connection section shows configured status without displaying token values. In Composio token mode, **Connect my Composio key** opens a form for your personal connection; you can replace or disconnect it there. Your personal connection is distinct from a channel or organization connection used by the shared agent.

Home can show the organization fallback, but it cannot resolve every channel's specific connection. The actual tools and account routing are decided for each turn. Verify the connected service owner before relying on an account label.

In Enterprise Composio SDK mode, runtime identities replace the personal token setup, and the Home view explains that mode's configuration state.

## Work in the Agent Messages view

Where Slack enables its Agent messaging experience, Messages shows suggested prompts based on selected tools and skills, with practical fallback prompts. New DM threads receive a short automatic title derived from the first request, or a file/new-conversation fallback, so the timeline is easier to browse.

Slack can also report which channel or message is open alongside the Agent DM. ChannelGate uses bounded, sanitized per-user view metadata to understand references such as “this thread.” It does not fetch that view’s messages automatically, prove membership, grant access, or treat the metadata as an instruction. Empty context clears the prior selection; cached context expires and does not survive a daemon restart. The actual task still runs in the DM workspace unless an authorized workflow explicitly targets another conversation.

## Review skills and reminders

Home lists a bounded sample of your personal skill grants and the organization-wide skill count. A conversation can add further grants that do not appear in this global overview. It also lets you manage your no-response nudge preference.

The commands and engine section gives quick orientation. Use `/help` for current command details and [Settings](/docs/features/slack-settings) to inspect the runtime of a specific conversation or thread.

Home does not itself start an AI request. On the Messages tab, suggested prompts help you begin a DM. Administrators also receive an admin UI pointer; its host address must be opened through the operator's configured access path.

Related: [connected accounts](/docs/features/connected-accounts), [skills](/docs/features/skills), and [Slack invocation](/docs/features/invocation-and-reactions).
