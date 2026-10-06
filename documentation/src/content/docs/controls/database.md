---
title: Read-only database control
description: Inspect the current conversation’s operator-configured database through bounded structured operations.
---

The database control is bound to the current conversation's operator-provisioned isolated VPN extractor. It does not accept arbitrary SQL, another conversation ID, connection strings, credentials, or filesystem paths.

## query_channel_database

**Required:** `operation`. Other required fields depend on the operation. **Authority:** current conversation access plus a valid run capability; API runs can read their conversation's service without impersonating a personal account.

| Operation | Required fields | Optional fields |
| --- | --- | --- |
| `list_databases` | `operation` | None |
| `list_tables` | `operation`, `database` | None |
| `describe_table` | `operation`, `database`, `table` | None |
| `count_rows` | `operation`, `database`, `table` | `filters` |
| `select_rows` | `operation`, `database`, `table`, `columns` | `filters`, `orderBy`, `limit`, `after` |

Names are strings validated by the service. `columns` is an explicit array of at most **50** names. `filters` contains at most **20** exact equality conditions shaped `{ "column": "status", "value": "open" }`; values can be string, number, boolean, or null. `orderBy` is `{ "column": "id", "direction": "asc" }` or `desc`. `limit` is an integer **1–100**, default **100**. Inapplicable extra fields are refused.

`after` is the previous response's opaque `nextCursor` string, maximum **4,096 characters**, passed back unchanged. Paging requires ordering by a supported single-column primary key or NOT NULL unique integer/character key. `nextCursor: null` marks the final page.

Example:

```json
{"operation":"select_rows","database":"reports","table":"tickets","columns":["id","status"],"filters":[{"column":"status","value":"open"}],"orderBy":{"column":"id","direction":"asc"},"limit":25}
```

Returns safe JSON containing the operation and applicable databases/tables/metadata/count/rows. Errors describe safe failure states such as missing configuration, disconnected tunnel, access denial, timeout, or oversized result. Listing responses are bounded and can indicate truncation.

Every call is its own read; successive pages are not a single snapshot if the table changes. VPN readiness, network routing safety, database credentials, statement-time enforcement, and response size guards are checked by the service. A starting VPN status is not enough to promise a successful read.

## Related guides

- [VPN and database access](/docs/features/vpn-database)
- [Conversation and operator controls](/docs/controls/conversation-settings)
- [Network policy](/docs/configuration/network-policy)
