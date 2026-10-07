---
title: Personal and shared accounts
description: Use the intended service account for email, CRM, calendars, and other tools.
---

ChannelGate separates the requesting person's connected apps from the agent's shared connections. When configured, tool identities make this distinction visible:

- `composio-user` routes to the active requester's personal connection.
- `composio-agent` routes to the shared agent connection for the channel or organization.

These names identify routing roles, not the owner of a Gmail inbox or CRM account. Discover the connected service metadata before assuming who owns it. Two identities can reach the same owner and still remain separate choices.

## Ask for the intended account

Use pronouns or the account name:

```text
@ChannelGate Search my calendar for the customer kickoff.
@ChannelGate Search the shared sales inbox for the latest proposal.
```

“My” selects the requester identity. “Your account” or “the agent's account” selects the shared identity. A named account requires matching an actual connected alias.

Unrestricted reads and searches can use either or both available identities. A write, send, or other state change needs the intended identity and connected account. ChannelGate reuses an established choice; if it remains ambiguous, the agent asks before making the change. A missing personal connection is not silently replaced by the shared one.

## Configure credentials privately

In standard Composio MCP mode, Slack App Home offers **Connect my Composio key** for the requester's credential. Conversation **Settings → MCPs** manages the shared channel credential and its label. A channel credential takes priority over an inherited organization credential; inherited fallback can be disabled.

Credential forms show configured or masked state and do not prefill saved secret values. Do not paste keys into the channel timeline. Direct messages receive only the requester identity, not a shared agent account.

## Know the provisioning modes

Standard MCP mode is available without Enterprise entitlement. Enterprise Composio SDK mode is Beta and can provision separate user/channel identities and reusable thread sessions. Lean suppresses optional connectors in ordinary runs.

Related: [connection settings](/docs/configuration/connections), [MCP](/docs/features/mcp), [secrets](/docs/features/secrets), and [privacy](/docs/privacy).

## Account references

See [account and secret controls](/docs/controls/accounts-and-secrets) for the supported personal key and environment operations. Separate guides cover [Enterprise SDK mode](/docs/features/composio-sdk), [Toolbox and Make](/docs/features/toolbox-and-make), and [business workflow examples](/docs/features/business-workflows).
