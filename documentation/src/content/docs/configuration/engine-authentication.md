---
title: Engine authentication
description: Configure Claude, Codex, and optional provider credentials without mixing them with app accounts.
---

An engine login authenticates the model answering a turn. It is independent of Slack credentials, connected business apps, and environment variables used to deploy a project. Enabling an engine does not sign it in.

## Claude Code

For a daemon running as an interactive operator account, sign in with `claude` on the gateway host as that account. The gateway resolves credentials in this order:

1. An explicitly configured **Claude token for container runs**.
2. The operator's usable Claude login.
3. A usable login in the gateway's own engine state.
4. The daemon's Anthropic API credential.

To configure the explicit token, run `claude setup-token` on the host, then paste its result into **Settings → Access & security → Container runtime → Claude token for container runs** and save. Leave an existing secret field untouched to keep its value. Use its clear control when you intentionally want to return to another credential source.

In the default proxy runtime, the gateway relays the resolved login's access credential. The operator's full credential file and refresh token are not copied into an ordinary channel container. A hard-expired login needs an interactive sign-in again; restarting the daemon does not renew the login session.

## OpenAI Codex

Open **Settings → Agent defaults → Engine & runtime → Default gateway Codex login**. Choose **Sign in with ChatGPT** and complete the device flow, or choose **Use an OpenAI API key** and save the key. API-key usage is billed separately from a ChatGPT subscription.

Codex also supports a conversation-specific login. In the conversation's Codex sign-in controls, choose the channel login source and sign in there. Choosing this source locks the conversation and its threads to Codex. A channel-specific source must have its own usable login; it does not silently use someone else's gateway account when missing. The gateway keeps these login records outside the agent-writable workspace.

| Credential choice | Scope |
| --- | --- |
| Gateway Codex login | Conversations selecting the gateway source |
| Channel Codex login | The selected conversation |
| Personal Composio account | Business app tools, not Codex model authentication |

## Service installations and optional providers

A dedicated non-login system service needs credentials configured for its service identity. Follow the service credential steps in [Installation](/docs/installation) and [Operations](/docs/operations); signing in as a different Linux user does not necessarily authenticate that service.

Optional Anthropic-compatible provider harnesses have their own API-key and base-URL cards under **Agent defaults**. Configure the intended provider and explicitly enable its harness. These providers do not receive the operator's Anthropic login and do not participate in automatic Claude–Codex failover.

## Verify the result

Save, check sign-in/runtime health, and send a simple request from a fresh thread. Login changes are resolved for subsequent runs without copying credentials into project files. Resolve authentication errors before widening tools or changing network policy.

See [Claude Code](/docs/features/claude-code), [Codex](/docs/features/codex), [Qwen](/docs/features/qwen), and [Connections](/docs/configuration/connections).
