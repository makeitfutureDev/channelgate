# MCP identities and skills

## MCP configuration and identities

Every non-clean run receives the channel-scoped `gateway` control MCP. It acts as the bot and owns
current-conversation operations such as memory, schedules, progress, approvals, native Slack
artifacts, file retrieval, and channel administration.

External apps come from two deliberately distinct identities when configured:

- `composio-user`: the active requester's personal account — “my inbox/calendar/account”.
- `composio-agent`: the agent/shared account resolved from the conversation and then organization
  configuration — “your/the agent's/team account”. DMs do not receive this shared identity.

Personal and SDK provisioning modes preserve this semantic split. Never substitute one for the
other. When both identities have an app and the request is ambiguous, ask. The gateway may also
inject the privileged MakeItFuture toolbox according to its channel → user → organization token
precedence. Clean runs and reduced-tool memory reviews omit optional identities.

The daemon builds a fresh explicit MCP config for each spawn and uses strict MCP mode. A channel's
selected MCPs plus daemon-injected servers are the whole set; locally configured host MCPs are not
mounted into containers. Remote Claude servers must be admitted by URL, not merely server name.
See [folder and headless configuration](folder-headless.md) for the low-level policy recipe.

## Local governed skill catalog

ChannelGate's SQLite catalog stores exact, content-hashed skill revisions and bundled resources.
Skills may be bundled, locally authored, imported from reviewed host folders, synchronized from Git
sources, or synchronized from a peer gateway. Review mode stages source changes; auto mode
activates them. Excluding a skill is sticky across future syncs; deleting/tombstoning and restoring
retain revision history.

The active profile is the union of:

- organization grants;
- the conversation's followed template plus its own additions;
- the requester's personal grants;
- transitive `requires` dependencies.

Development, Sales, Marketing, and Management templates are seeded and remain live links: editing
a template changes following conversations on their next run without removing their additions.
Resolution reports missing/review-pending skills, cycles, compatibility, and estimated always-on
description context.

## Materialization and discovery

The gateway materializes the resolved profile as exact files under
`.claude/skills/<slug>/`, marker-managed and write-on-change. Project-owned skill folders win and
are never overwritten. A guarded relative `.agents/skills -> ../.claude/skills` link exposes the
same complete tree to Codex. Claude records exact skill-tool activation; Codex activation is
inferred when it reads a skill entrypoint and is labelled accordingly.

Use the injected `gateway-usage` skills reference for exact tools to list, inspect, grant, revoke,
template, author, propose, review, synchronize, publish, exclude, or report usage. Authoring must
follow the active `skill-authoring`/skill-creator guidance: precise trigger descriptions,
progressive disclosure, preserved user scope, reviewed sources, and validation of every referenced
resource. The former Skills Manager runtime injection and favorites stubs are retired; the local
catalog is authoritative.

