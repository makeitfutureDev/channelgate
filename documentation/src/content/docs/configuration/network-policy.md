---
title: Network policy
description: Configure conversation network access and the deployment's egress proxy controls.
---

A conversation's **Network / Allow network** switch controls whether its agent should reach external services. In the default runtime, ChannelGate enforces that switch through an egress proxy. Tool permissions, connected-account selection, and destination approval for a secret remain separate checks.

## Configure one conversation

Use **Conversations → Access → Network** or the Slack Access settings available to an authorized manager. Turn it on for work that needs external websites, package registries, or service APIs, and off for work limited to local files and permitted controls. Save and inspect the runtime status before a test request.

When off in the normal proxy runtime, engine endpoints and the conversation's selected connector routes remain available so the agent can answer and use configured tools. Other external destinations are refused. A rejected request returns an explicit refusal; it is not a reason to try a different proxy or connection path around the setting.

## Deployment controls

Administrators configure **Settings → Access & security → Container runtime**.

| Setting | Default and effect |
| --- | --- |
| Legacy open network (no egress proxy) | Off; normal containers have no direct network and use the gateway proxy |
| Withhold readable variables | On for new installs; unruled readable variables are withheld in proxy mode |
| Conversation Allow network | Independent of Read-only, Worker, Admin, Auto, and Lean |
| Secret Used on hosts | Limits where protected credentials are swapped; does not itself enable network access |

The proxy refuses private, loopback, and cloud-metadata destinations. Raw-socket access such as SSH or database protocols requires operator-declared destinations. Public network access does not mean unrestricted access to private infrastructure.

## Configure an API workflow

1. Enable network for the conversation if the workflow needs a public API.
2. Add the credential in the intended secret scope.
3. Declare the API host under **Used on hosts**, for example `api.example.com`.
4. Request a small read through HTTPS and inspect the outcome.
5. If an undeclared host requires administrator approval, wait for that decision before retrying the same request.

```text
Read our example project's status from api.example.com using PROJECT_API_TOKEN.
If access is refused, report the refusal without changing the network settings.
```

## Exceptions and save effects

The legacy bridge option gives containers direct networking and raw secret values. In that runtime, and for an explicit direct-host `/sudo` thread, a network-off instruction is advisory rather than the normal proxy wall. A raw-network channel is also an exception. The agent must still honor the configured restriction.

Changing deployment egress mode recreates containers at their next turn. The proxy reads current conversation policy and credential permissions when handling requests; a daemon restart is not needed for routine conversation network changes.

Network management authority does not grant organization admin status. See [Network access](/docs/features/network-access), [Container isolation](/docs/features/container-isolation), [Secrets](/docs/features/secrets), and [VPN and databases](/docs/features/vpn-database).
