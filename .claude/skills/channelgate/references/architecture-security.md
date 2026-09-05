# Architecture and security

## Runtime boundary

ChannelGate targets Linux with systemd and rootless Podman. Each conversation gets one lazily
created container with dropped capabilities, no `sudo`, a durable HOME volume at `/home/agent`, and
only these bind mounts at identical host/container paths:

- the conversation work folder;
- its clean workspace;
- its artifact directory, which also backs `/tmp` and `/var/tmp`.

The operator HOME, gateway runtime root/database, daemon checkout, sibling conversations, and host
credential stores are not mounted. An admin conversation may deliberately point its work folder at
a host repository; that one directory is then visible read-write, but nothing beside it.

Containers are stopped when idle and recreated when their create-time fingerprint changes. The
HOME volume and mounted workspace/artifacts survive both. Active foreground runs, background work,
scheduled runs, editors, and memory reviewers hold leases; never stop or recreate a leased
container. Deleting a conversation is the exceptional operation that may remove its HOME volume.

## Honest network model

Containers use the bridge network. *Allow network* records policy intent and is passed to engines;
Codex read mode refuses network itself. This release has neither domain filtering nor a reliable
container egress cut-off. Do not describe the switch as a firewall or promise host-level network
isolation.

## Permission modes

Modes are tool presets, never mount profiles:

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

