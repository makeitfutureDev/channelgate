# Privacy and data flow

Slack events enter the local gateway over Socket Mode. Authorization and mention gates run before
the message, explicitly downloaded attachments, thread context, and enabled MCP configuration are
passed to the selected local CLI process. The CLI may send prompt/context to its configured model
provider. Composio connections send only tool requests selected during a run to the connected
third-party service. The gateway stores configuration, sessions, audit/usage events, schedules,
jobs, and channel metadata in local SQLite; channel work folders may retain attachments and agent
outputs. Encrypted backups contain the same durable operational data.

Operators control the host, provider accounts, connected apps, retention window, and backups. They
must disclose enabled providers/connectors to users, grant least privilege, define a deletion and
legal-retention policy, and avoid sensitive data beyond the intended workflow. Removing a Slack
message does not automatically erase provider logs, connector records, local backups, or generated
files. Cross-border transfer, DPA, subprocessors, lawful basis, and data-subject workflows remain
deployment-owner responsibilities, not claims made by this repository.

## License verification and usage reporting

The only outbound traffic the gateway itself originates — as distinct from the CLI's model
provider and the connectors an operator enables — is the license check described in
[`LICENSE-KEYS.md`](LICENSE-KEYS.md). It goes to the ChannelGate platform at
`CHANNELGATE_PLATFORM_URL` (default `https://channelgate.dev`) and consists of
exactly two request shapes. There are no others, and there is no analytics, telemetry, crash
reporting, or heartbeat.

**1. Key verification** — at start-up and about once every 24 hours,
`POST {base}/v1/license/verify`:

```json
{ "key": "<the license key>", "installationId": "<uuid v4>", "version": "<package version>" }
```

The response is a signed license object (tier, limits, organization display name, key id, issue
and expiry dates). Its Ed25519 signature is verified locally against the public key compiled into
`src/ee/license-public-key.js`, so a response the deployment cannot authenticate changes nothing.

**2. Usage reporting** — about once every 24 hours and once during shutdown,
`POST {base}/v1/usage/report`:

```json
{
  "installationId": "<uuid v4>",
  "keyHash": "<sha256 hex of the key>",
  "version": "<package version>",
  "month": "YYYY-MM",
  "conversations": [{ "hash": "<sha256 hex of the conversation id>", "count": 12 }]
}
```

This is fire-and-forget: it never blocks a turn, a boot, or a shutdown, and a failure is simply
retried on the next cycle.

### What is never sent

Message content, prompts, model output, file names, file contents, attachments, user identifiers,
display names, email addresses, channel or space names, workspace/tenant identifiers, tokens, API
keys, IP-address lists, or timestamps of individual messages. Conversation identifiers are sent
only as SHA-256 hashes, so the platform can count a conversation across months without ever
learning what or where it is. The license key itself is sent only to the verification endpoint —
never in a usage report, where it appears as a hash.

### The installation id

A random UUID v4 generated once and stored in the local database (`_meta`). It is not derived from
the hostname, MAC address, machine id, workspace, or any other property of the host, and deleting
the database's `_meta` row simply mints a new one.

### Turning the outbound traffic off entirely

A deployment that must make no outbound connection at all can run on an offline license: set
`CHANNELGATE_LICENSE_PAYLOAD` to the signed payload issued by the Licensor. It is verified locally
against the same public key and no request is ever made. A deployment with no key and no payload
also makes no request — it simply runs on the no-key limits.

### Where this is enforced

`src/ee/license.js` (verification, caching, the offline path) and `src/ee/limits.js` (the counters
and the report). Both are readable in this repository; the outbound payloads are built by
`buildUsageReport()` and the `verifyLicense()` request body and by nothing else.
