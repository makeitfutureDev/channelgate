---
title: Environment secrets
description: Provide scoped CLI credentials without pasting them into chat.
---

Environment secrets make credentials available to permitted tools during a run. They are separate from Composio connected accounts and separate from the gateway's engine authentication settings.

## Choose the right scope

The store has three scopes:

- **Organization:** shared across the deployment; administrator-managed.
- **Personal:** belongs to the requester and is supplied only to their authenticated turns.
- **Channel:** belongs to this conversation's project identity.

Effective precedence is **channel → personal → organization**, with the channel taking precedence. A personal value fills a missing name; it does not replace the channel's saved value. API attribution cannot impersonate a person to obtain their personal secrets.

## Add or rotate a credential

Open `/secrets` or **Settings → Variables** in Slack, choose the scope, and use **Add/update**. The admin UI exposes channel variables, organization secrets under integrations, and personal secrets on user records.

For example, save the project's `SUPABASE_ACCESS_TOKEN` in the channel scope, then request a permitted CLI action. Enter the token in the private credential form, not in a channel message or an agent-created file. Listings reveal names and configured/masked state, not a usable value.

Names use letters, digits, and underscores and are normalized to uppercase. Gateway-controlled names and reserved prefixes are rejected. Values cannot contain line breaks or NULs. Rotation changes the runtime fingerprint so a warm process cannot keep an old environment indefinitely.

## Understand protected and readable values

For eligible credentials, the egress proxy gives the container a placeholder and substitutes the real value only in approved HTTPS headers or query parameters. A new destination may require administrator approval. Raw-value credentials needed outside HTTPS, such as passwords, require a readable configuration. If the gateway’s strict secret runtime guard is enabled, readable variables are withheld from ordinary container runs; changing visibility alone does not bypass that guard.

Personal protected placeholders pause when another person's work is live in the same conversation. Secret removal or revocation takes effect at the proxy. Known values are redacted from replies and job output, but a usable credential still carries its provider permissions: grant the minimum needed at that service.

Lean suppresses optional environment-secret injection in ordinary runs. Related: [environment variables](/docs/configuration/environment-variables), [network policy](/docs/configuration/network-policy), and [engine authentication](/docs/configuration/engine-authentication).
