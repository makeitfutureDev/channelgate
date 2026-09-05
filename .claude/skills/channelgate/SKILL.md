---
name: "channelgate"
description: >-
  Configure, secure, explain, or troubleshoot ChannelGate conversations and deployments. Use for
  channel containers and work folders, permissions/network access, Claude or Codex runtime and
  login recovery, per-channel CLI credentials and device-login links, MCP identities, skill
  grants/templates/sources, channel memory, background work, schedules, attachments, or strict
  headless MCP configuration. Do not use for ordinary work merely performed through ChannelGate.
metadata:
  version: 3.0.0
  category: claude-code
  complexity: advanced
  tags: channelgate, containers, claude-code, codex, mcp, skills, memory, security
  created: 2026-06-16
  updated: 2026-09-05
---

# ChannelGate

ChannelGate is a self-hosted Linux daemon that turns supported chat conversations into durable,
gated Claude Code or Codex workspaces. Treat the container, workspace policy, credentials, and
chat identity as separate layers; confusing them is the usual source of unsafe advice.

## Route the request

Read only the references needed for the request:

- Container boundary, mounts, modes, network truth, authorization, engine selection, or recovery:
  [architecture and security](references/architecture-security.md).
- `/secrets`, provider tokens, saved CLI sessions, device-login links, Claude/Codex sign-in, or
  VS Code attachment: [credentials and CLI connections](references/credentials-connections.md).
- MCP identities and allowlists, Composio, the skill catalog, grants, templates, sources,
  authoring, or Claude/Codex discovery: [MCP and skills](references/mcp-skills.md).
- Persistent facts, standing rules, compact catalog recall, search/read, writes, or the background
  reviewer: [channel memory](references/channel-memory.md).
- Background agents/jobs, schedules, attachments, chat-platform behavior, progress, or operational
  status: [conversation operations](references/conversation-operations.md).
- Creating a gated folder manually or composing `claude -p` with strict MCP configuration:
  [folder and headless configuration](references/folder-headless.md).

For work performed *inside* a conversation, the injected `gateway-usage` skill is the live
operating manual and has the exact available tool names. For daemon installation, upgrades, and
host administration, defer to `docs/OPERATIONS.md` in the ChannelGate checkout. This skill explains
the product contracts and decision points; it does not replace either source.

## Invariants that apply everywhere

- Every foreground turn, background agent, shell job, scheduled run, and memory review executes
  inside that conversation's own rootless Podman container. Admin mode changes tool approval, not
  mounts. Never propose running an engine directly on the host.
- The container is the filesystem/process boundary. Its persistent HOME belongs to one
  conversation; the operator's home, gateway database/root, and other conversations are absent.
  The current bridge network has no domain filtering or enforced egress cut-off, so never claim
  that *Allow network* is a firewall.
- `<folder>/.claude/settings.json` carries policy: permissions, MCP allowlisting, memory-off, and
  the Stop hook. It carries no `sandbox` block; the container owns confinement.
- A channel's environment credentials are write-only and channel-scoped. Never ask for a token in
  chat, place one in the work folder, reveal it, log it, or substitute another identity silently.
- Claude and Codex use the same resolved workspace and skill tree, but their sessions,
  authentication, MCP transport details, and usage signals differ. Read engine facts from the
  registry/diagnostics instead of inventing engine-name branches.
- Authorization and capability checks fail closed. An approved/admin member or explicit channel
  guest grant decides who may speak; only an admin author in admin mode gets bypass permissions.
- Platform differences are capabilities, not assumptions. Use the active adapter or injected
  platform guide before promising tables, charts, modals, streaming, threads, or attachment reach.

## Troubleshooting discipline

1. Identify the conversation, platform, author, selected/pinned engine, mode, clean state, and
   whether the failing work is foreground, scheduled, background, or memory review.
2. Separate missing mounts/files from missing permission, missing credentials, missing MCP grants,
   and provider/engine failure. `$HOME` inside a run is the conversation HOME, not the host HOME.
3. Prefer `/status`, the Admin UI, gateway audit/events, and the engine's own error. Do not infer
   host state from inside a container.
4. Preserve explicit engine pins. Defaults may fail over; a user-pinned engine reports its own
   failure and offers a manual switch.
5. Keep remediation inside the affected scope. Credential repair, skill grants, network intent,
   and channel secrets take effect on the next resolved spawn; never broaden access as a shortcut.
