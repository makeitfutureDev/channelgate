# Privacy and data flow

Slack events enter over Socket Mode; the Beta Google Chat and Microsoft Teams connectors use
Pub/Sub and authenticated webhooks respectively. Authorization and mention gates run before
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

Licensing traffic is separate from chat API calls, attachment downloads, configured webhooks,
model/engine discovery and health checks, update checks, and enabled connector/Drive requests.
The licensing requests described in [LICENSE-KEYS.md](LICENSE-KEYS.md) go to the ChannelGate platform at
`CHANNELGATE_PLATFORM_URL` (default `https://channelgate.dev`) and consists of
the two request shapes below. This section describes licensing only; disabling it does not
disable other enabled features' outbound requests.

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

### What licensing does not send

Message content, prompts, model output, file names, file contents, attachments, user identifiers,
display names, email addresses, channel or space names, workspace/tenant identifiers, tokens, API
keys, IP-address lists, or timestamps of individual messages. Conversation identifiers are sent
only as SHA-256 hashes. They are stable pseudonymous identifiers that may be correlated or
guessed from a known identifier; hashing is not a guarantee of anonymity. The license key itself is sent only to the verification endpoint —
never in a usage report, where it appears as a hash.

### The installation id

A random UUID v4 generated once and stored in the local database (`_meta`). It is not derived from
the hostname, MAC address, machine id, workspace, or any other property of the host, and deleting
the database's `_meta` row simply mints a new one.

### Disabling licensing traffic

For offline licensing, set
`CHANNELGATE_LICENSE_PAYLOAD` to the signed payload issued by the Licensor. It is verified locally
against the same public key and no licensing request is made. A deployment with no key and no payload
also makes no licensing request — it simply runs on the no-key limits.

### Where this is enforced

`src/ee/license.js` (verification, caching, the offline path) and `src/ee/limits.js` (the counters
and the report). Both are readable in this repository; the outbound payloads are built by
`buildUsageReport()` and the `verifyLicense()` request body and by nothing else.

## Runtime boundary and credential retention

Rootless per-conversation containers isolate filesystem and processes, with a private durable home,
work folder and runtime artifacts. Tool settings are policy; they do not establish those mounts.
The optional Full-access whole-home mount is off by default and deliberately exposes the daemon
user's repositories, gateway state and other channels to every author admitted to a Full-access
channel. Operators must understand this exception before enabling it.

All containers currently use bridge networking. *Allow network* expresses intended engine policy;
it is not an egress firewall and does not constrain arbitrary destinations at the network layer.
Host-side run-API attachment/webhook requests separately validate and pin public destination IPs.

Claude runs authenticate with a relay of the host user's own `claude` login — its short-lived
access token, refreshed on the host; the credentials file is never copied or mounted — or with a
configured `claude setup-token` or the daemon's `ANTHROPIC_API_KEY`. Codex sessions are per channel
while its host sign-in file is bind-mounted into the channel containers, so that sign-in is one
shared identity across channels. Either way the provider identity is organization-wide: that is a
shared provider identity, not an assertion of independent per-user billing. Container-native CLI
credentials persist in the channel home. Personal/shared MCP credentials are resolved for each run and may be written into
protected transient runtime bundles; those bundles must be included in the retention assessment.
Runtime secret redaction reduces accidental output leakage, but an agent given a usable credential
can access that value and use its granted privileges. UI write-only fields do not change this fact.

An operator's ability to sign in is not a grant to share that provider account with every gateway
user. Provider account terms and any organization agreement determine who may use it. ChannelGate
does not sell provider access or promise that one personal subscription covers a team. An operator
must choose an account arrangement authorized for the users admitted to the deployment. This is
separate from ChannelGate's software license and from personal Composio connections.

Project privacy, security and legal requests go to `contact@makeitfuture.com`; requests about a
deployment's own records go to its operator. See [SUPPORT.md](../SUPPORT.md) for project and
contracted-support routing.

Keep model/connector grants, channel membership and shared work folders within the intended trust
boundary. Deleting a conversation must include an explicit decision about its home volume,
artifacts, SQLite records, backups and provider-side retention; removing a chat message is not a
cross-system deletion request.
