---
title: Slack App Home
description: Check your gateway role, personal connections, skills, and visible conversations.
---

Open the ChannelGate app in Slack and select **Home** for an orientation dashboard. Select **Messages** to talk directly to the bot without mentioning it.

## Choose a Home section

The navigation row inside Home has five sections. The selected section is highlighted:

- **Activity** opens by default, with My threads.
- **Connections** shows your personal/shared connection status and personal Composio controls.
- **Skills** shows your personal grants and the organization-wide skill count.
- **Channels** lists conversations currently available to you.
- **Help & settings** contains quiet-thread reminders, command/runtime guidance and gateway information.

Only the selected section loads. Saving or disconnecting a personal connection keeps you on
Connections. Thread filters and pagination stay on Activity; reminder changes stay on Help & settings. Opening Home again
starts at Activity; navigation is personal to the viewing user.

## Understand your access

Home identifies whether you are an administrator, an approved user, or awaiting approval. It also lists gateway conversations visible to you, with their mode and any configured engine. Private Slack conversations are subject to membership checks; the list is not a directory of every private channel on the gateway.

The channel list is bounded. If it shows a count with a plus sign, more eligible conversations exist than fit in the view.

## Follow your threads

**My threads** lists threads you started with this gateway, with the original link, conversation,
status and last-message date. Divider lines separate compact entries: click the title to open the
thread, with channel, status and date below it and the green **✓ Done** button on the right.
Dates come from Slack messages, rather than the time a run
finished or you clicked Done. Slack displays the date in your local time.

**Active** and **All open** hide completed work. Choose a specific open status and use
**Previous** / **Next** to browse ten threads at a time:

- **Working**: a foreground request is running or queued, or background work is active.
- **Waiting**: a question, permission/approval card or busy-thread choice needs an answer.
- **Idle**: no tracked work or decision is active. A finished reply does not declare the task done.
- **Error**: the latest tracked foreground/recovery or background outcome failed or was refused.

A ✅, ✔️ or 👍 on the root or **any reply**, or **✓ Done** in Activity, completes the thread.
The thread owner’s native 👍 feedback button below an answer also marks it Done.
Completed work disappears from open views and stops quiet-thread reminders and pending-response
digests, even if later messages arrive or work/forms remain active. Marking Done does not cancel
running work or decide approvals. Use the explicit **Completed** archive and **Reopen** to restore
an entry. Reopen can override existing reactions; a newer completion reaction closes it again.
Removing a reaction opens the thread only if no other completion reaction or manual Done remains.

Activity checks for tracked changes every 15 seconds and updates automatically, keeping your
selected filter and page. It pauses when you switch Home sections or open Messages; reopening
Home resumes it. Manual **Refresh** also reconciles reactions missed while the gateway was offline.
Existing gateway sessions and follow-ups are
indexed in small batches; **Load older threads** continues that discovery. Completion reactions are
also checked in batches so changes made while the gateway was offline can be reconciled. This is a
list of tracked gateway threads, rather than a search of all Slack history. Bot-started roots and
top-level code-channel sessions without a thread are excluded.

Only threads whose original message you posted appear. Current gateway admission, private/group/DM
membership and sudo-thread authority still apply, including for administrators. Stale controls cannot
change another person's work or keep access after you leave a private conversation. Temporary Slack
failures can hide entries; the view indicates when verification is incomplete.

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
