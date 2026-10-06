---
title: Google Chat
description: Configure the Beta Google Chat connector with Pub/Sub and use spaces and direct messages.
---

Google Chat is a **Beta** connector. It receives events through a Cloud Pub/Sub pull subscription, so inbound chat does not require a public webhook or tunnel. The assistant uses the same conversation isolation, approved-user checks, and engine settings as other surfaces.

## Set up Google Cloud

Enable Google Chat API and Cloud Pub/Sub API in one project. Create a topic and a **Pull** subscription, then create a service account with **Pub/Sub Subscriber** on that subscription. Keep its JSON key private.

Configure the Chat app as Live, enable direct messages and the intended space interactions, and select its Cloud Pub/Sub topic. Grant **Pub/Sub Publisher** on the topic to the publisher appropriate to the app's mode. Workspace add-ons and standalone Chat apps use different publisher identities; follow the [full setup reference](/docs/platforms#google-chat-beta) rather than substituting the subscriber account.

Under **Settings → Connection → Google Chat**, enter the service-account JSON and full subscription name:

```text
projects/example-project/subscriptions/chat-events-sub
```

Save and **Connect**. A “Connected — pulling” status confirms the subscriber can poll; it does not prove the Chat app can publish events.

## Verify with a message

Add the app to a space, approve the sender's Google Chat identity under **Users**, and send a new bot mention. In a DM, send directly without a mention. Check for an actual response.

Space threads are preserved. Google creates a new thread for each top-level DM message, so ChannelGate treats new DM threads as the main continuous conversation; an explicit reply into an existing thread becomes a side thread.

## Limits to plan around

Direct Chat uploads can be downloaded. Files shared from the Drive picker require user OAuth scopes this connector does not request and are reported as skipped. Bot file uploads are unavailable, so responses are text.

Google Chat has no Slack-style ephemeral controls. Private notices and approval links arrive as DMs. Reachable browser approval links require the gateway's Public URL. Editing is bounded by the platform's shared per-space write limit, so progress is less frequent than Slack streaming.

## Related guides

- [Connections](/docs/configuration/connections)
- [Approvals](/docs/features/approvals)
- [Attachments and voice](/docs/features/attachments-and-voice)
- [Threads and sessions](/docs/features/threads-and-sessions)
