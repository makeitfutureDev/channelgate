---
title: VPN and private database reads
description: Use an optional operator-provisioned VPN service to query a private MySQL database safely from chat.
---

The optional VPN/database service lets an admitted channel user request bounded reads from a private MySQL database. The operator provisions a dedicated VPN and extractor for the conversation. It does not give the assistant's normal container a VPN route or general access to the private network.

## Provisioning comes first

An operator must configure the protected OpenVPN profile, exact database IPv4 address/port, service image, and supervision. Adding an `.ovpn` attachment and passwords in chat is not enough.

Add the selected channel's `VPN_USERNAME`, `VPN_PASSWORD`, `MYSQL_USERNAME`, and `MYSQL_PASSWORD` through its Variables/Secrets controls. Prefer a provider-issued read-only database user. Provisioning is a host operation; the [operator VPN reference](https://github.com/makeitfutureDev/channelgate/blob/beta/docs/CHANNEL-VPN.md) documents the supported profile and commands.

The service requires channel network permission. Missing credentials or network off prevent startup. Its current contract uses database TCP inside the encrypted VPN; provider-required database TLS needs a separate supported configuration extension.

## Start and inspect

After setup, a channel manager or organization admin can ask:

```text
Turn VPN on and check its status.
```

In Slack, **Settings → General Settings** includes a VPN row with **Turn on**, **Turn off**, and **Refresh**. The admin website also shows VPN beside Network for a prepared channel.

**Starting** does not mean **Connected**. Connected requires the service pair, working tunnel, and database route. Turning off removes the owned running pair and disables its automatic startup; it preserves configuration and secrets. Network off also stops an active pair.

## Ask for bounded reads

```text
List the databases, then describe the customers table in the selected database.
Count active customers and show their id and name, 20 at a time.
```

Supported operations list databases/tables, describe a table, count matching rows, and select named columns with structured filters and deterministic pagination. Each page is limited to 100 rows, with bounded output and a finite timeout.

Arbitrary SQL, expressions, writes, stored procedures, connection URLs, and credential parameters are not accepted. Queries run read-only; database grants provide an additional restriction. The dedicated extractor can reach only its configured database through the tunnel. The assistant gets no shell inside that service.

## Related guides

- [Network access](/docs/features/network-access)
- [Secrets](/docs/features/secrets)
- [Permissions](/docs/features/permissions)
- [Operations reference](/docs/operations)
