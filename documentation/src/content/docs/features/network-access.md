---
title: Network access
description: Control public internet access and understand proxy enforcement, connector exceptions, and raw hosts.
---

The conversation's **Network** switch controls outbound access during normal container runs. It is independent of Read-only, Worker, Admin, Auto, and Lean. Turning on file writes does not automatically authorize internet access.

## Enable the access you need

A conversation manager can change Network from the channel's settings; administrators can also edit it in the web interface. In Slack, open **Settings → General Settings**. The new policy applies to the next outbound request through the proxy.

For example, enable network for a development task that needs npm downloads or a public GitHub API. Leave it off for a local code review that only needs files and the selected engine.

With the default proxy runtime:

- **Off:** the engine endpoints and the remote connectors selected for this conversation remain reachable, so the assistant can still answer and use those approved connections.
- **On:** public destinations are reachable. Private, loopback, link-local, reserved, and cloud-metadata addresses remain blocked.

A refused request returns an explanation such as `403 network-off`. The assistant should report that reason rather than attempt a bypass.

## Secrets and destinations

Protected API credentials are supplied as placeholders. The proxy replaces them only when the request uses an approved destination and credential location. Network on does not approve a new host for a protected secret. An administrator may need to approve that secret's destination separately.

Tools such as curl, Git over HTTPS, and provider CLIs use the prepared proxy environment. A tool that ignores the proxy cannot reach the internet from the default container.

## Raw connections and exceptions

Outbound SSH/database protocols need an explicitly allowed raw host and a client proxy helper. Administrators can configure `egressRawHosts`; the supported raw ports are 22, 5432, and 6543, with `github.com:22` already supported when network is on.

Legacy bridge mode, an explicit `rawNetwork` escape, and direct-host `/sudo` execution have different enforcement. The gateway reports when the switch is advisory. Those are operator decisions, not ordinary troubleshooting shortcuts. For a private database behind VPN, use the optional dedicated VPN service rather than assuming public network access reaches it.

## Related guides

- [Network policy](/docs/configuration/network-policy)
- [Secrets](/docs/features/secrets)
- [VPN and database access](/docs/features/vpn-database)
- [Privacy and data flow](/docs/privacy)
