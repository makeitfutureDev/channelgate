# Architecture and security

## Runtime boundary

ChannelGate targets Linux with systemd and rootless Podman. Each conversation has separate
project and trusted-admin runtime scopes. Containers are created lazily with dropped capabilities,
no `sudo`, and a durable HOME volume at `/home/agent`. By default each scope has these directory
bind mounts at identical host/container paths:

- the conversation work folder;
- its clean workspace;
- its artifact directory, which also backs `/tmp` and `/var/tmp`.

The operator HOME, gateway runtime root/database, daemon checkout, sibling conversations, and host
credential stores are normally not mounted. An admin conversation may deliberately point its work folder at
a host repository; that one directory is then visible read-write, but nothing beside it.

The explicit boundary exception is a Slack thread whose current organization admin enabled typed
`/sudo`. That thread resolves the registered host backend: engine and inherited background work
run directly as the daemon OS user with the host filesystem, processes, native HOME, commands and
network. It is not Admin channel mode and not a mount. Only current admins can toggle or message
it; every ingress/run rechecks authority, non-admin messages are rejected before work starts, and
stored channel metadata or run-API overrides cannot select it. `/sudo off` restores the container.

One operator-chosen exception: with the gateway-wide **Admin channels can access the host home**
switch on (`containerFullAccessHome`, Settings → Container runtime, off by default), ONLY a current
organization admin's trusted run in an Admin/Full-access channel receives a read-write mount of
the gateway user's whole home at its identical path. The trusted admin runtime scope, Admin
channel mode and gateway switch must all apply. It includes other conversations' work folders and
memory, repositories, gateway configuration, logs, metadata and credential stores; container-engine
storage stays masked. It does not mount the whole host filesystem or grant host root.

Non-admin members and guests run in a separate project container with only their resolved project
mounts, including in an Admin channel; they receive no operator-home mount. Admin tool bypass is
a separate permission decision, and with the gateway switch off Admin mode adds no home mount.
The switch is a boolean, never a path, and changes the container fingerprint for recreation at the
next eligible turn. No MCP tool can flip it. The injected `gateway-usage` runtime note states this
run's resolved grant. `$HOME` and `~` remain that runtime's own channel HOME at `/home/agent`,
even when the operator home is mounted at another path.

Containers are stopped when idle and recreated when their create-time fingerprint changes. The
HOME volume and mounted workspace/artifacts survive both. Active foreground runs, background work,
scheduled runs, editors, and memory reviewers hold leases; never stop or recreate a leased
container. Deleting a conversation is the exceptional operation that may remove its HOME volume.

## Honest network model

Containers run with `--network none`; their only egress is the daemon's per-channel egress proxy
(`src/gateway/egress/`) over a read-only unix socket whose path is the channel identity. The proxy
enforces *Allow network* on every request (off: engine endpoints + the channel's selected remote
MCPs; on: public destinations), always refuses private, loopback and metadata addresses (every
resolved address checked and pinned), terminates TLS with a per-deployment CA, and swaps
placeholder credentials for real ones only on their declared hosts while the channel has live
work. There is no per-domain allow-list when the switch is on. The legacy `containerEgressMode =
"bridge"` and a channel's `rawNetwork` restore the open bridge, where the switch is advisory again;
`networkEnforcedFor(target)` is the one answer every surface uses. Codex read mode refuses network
itself. Do not promise more than that: a member with a live placeholder can use the real credential
on its declared hosts, and request-signing or raw-protocol secrets stay raw.

## Permission modes

Modes are tool presets. Admin/Full-access additionally qualifies for the operator-home grant
described above when the operator has enabled its separate gateway-wide switch:

- Read-only: read tools; Codex uses its read-only sandbox mode.
- Worker: shell and file writes allowed within mounted state.
- Autonomous: permission prompts are auto-approved and unattended shell work is possible.
- Full/admin: only an admin author's live turn gets the bypass flag; non-admin authors remain
  restricted and the run still stays inside its container.
- Lean/clean execution omits optional grants, credentials, and memory injection as defined by the
  run orchestrator; it is not a different filesystem boundary.

The generated `.claude/settings.json` keeps `disableBypassPermissionsMode` and `disableAutoMode`
locked down for ordinary authors, leaves `additionalDirectories` empty, disables Claude automatic
memory/dreaming, and contains the explicit MCP/tool policy. The daemon swaps in the admin-author
variant only for the authorized turn.

## Authorization

An author may talk when they are an admin or approved member, including in their DM. An unknown or
unapproved author is denied everywhere unless a non-DM conversation explicitly grants them guest
access. Posting proves channel membership but does not replace approval. Outside DMs the bot also
requires an explicit mention. Dangerous permissions require both an admin author and an admin-mode
conversation.

## Engines and liveness

The engine registry owns capabilities, session identity, MCP transport, model/effort settings,
context limits, and credential fingerprints. Channel/gateway defaults may fail over when safe; an
explicit per-thread/per-run pin never silently changes engines.

A quiet run is not killed merely for taking time. The shared watchdog checks process liveness,
reports continuing waits, and keeps the user informed through heartbeat/status updates. A run ends
on process disappearance or the absolute silence budget. Stderr is diagnostic commentary and does
not reset stdout activity. Replay/failover is permitted only when the failure classification and
tool/output state make it safe.
