---
title: Admin-only sudo threads
description: Run a trusted Slack thread directly on the gateway host with explicit administrator authorization.
---

A `/sudo` thread lets a current organization admin run the selected engine directly on the gateway host as the daemon's operating-system account. Use it for deliberate host operations that cannot run inside a conversation container.

This is a **Slack-only**, per-thread control. It is not a channel mode and does not grant Linux root automatically. It grants the filesystem, processes, HOME, commands, and network available to the daemon account, which is a substantial increase in access.

## Enable it in a trusted thread

Wait until the thread has no running or queued work, then send the command as message text:

```text
@ChannelGate /sudo on
```

In a DM, the mention is unnecessary. This is an in-thread bot command, not Slack's conversation-top-level slash-command entry point.

Inspect the current posture before issuing a host task:

```text
@ChannelGate /sudo status
```

For example, an administrator might ask the host thread to inspect the service configuration and propose a repair. The assistant now runs with the daemon account's actual host access; ordinary container network enforcement no longer supplies the same boundary.

## Return to the container

After host work completes, wait for running and queued tasks to finish, then send:

```text
@ChannelGate /sudo off
```

Future turns return to the conversation's normal container. ChannelGate carries supported Claude and Codex session history across the boundary; if that carry cannot complete, it can restore visible conversation context into a fresh native session.

## Who can use it

Only current organization admins may enable, disable, message, or launch background work from a sudo thread. Other senders are rejected before work begins. The permission is checked again for subsequent turns and unattended launches; an old saved flag does not confer admin authority.

The HTTP run API and ordinary channel metadata cannot select this host runtime. Shared channel settings and connector grants still matter, but they do not turn direct-host work into container-confined work. Keep the thread's participants and tasks appropriate to its broader access.

## Related guides

- [Permissions](/docs/features/permissions)
- [Container isolation](/docs/features/container-isolation)
- [Admin dashboard](/docs/features/admin-dashboard)
- [Operations reference](/docs/operations)
