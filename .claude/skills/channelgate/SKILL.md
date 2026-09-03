---
name: "channelgate"
description: "Set up a \"gated\" Claude Code session for ChannelGate: a per-conversation work folder whose .claude/settings.json carries the tool permissions, an explicit MCP allowlist and memory-off, run inside that conversation's own container. Use when asked to lock down / restrict a channel folder, limit Claude to certain MCP connectors (e.g. \"only HubSpot\"), disable memory for a folder, or inject/restrict MCP config in a headless (-p / SDK) session via --mcp-config / --strict-mcp-config."
category: "claude-code"
version: "2.0.0"
complexity: "intermediate"
tags:
  - "claude-code"
  - "mcp"
  - "containers"
  - "permissions"
  - "security"
  - "settings"
created: "2026-06-16"
updated: "2026-09-03"
---

# channelgate

A **gated folder** is a ChannelGate conversation's working directory. Confinement does NOT come
from the folder: it comes from the **container** the gateway runs every turn in (rootless Podman,
one per conversation) — a per-channel HOME volume at `/home/agent`, only the work folder, its
clean workspace and its artifact dir bind-mounted at their identical absolute paths, and nothing of
the operator's home, the gateway root or any other channel visible. (The boundary is the
filesystem and the process namespace, not egress: every container is on the bridge network, and
the channel's *Allow network* switch only tells the engines whether the channel is meant to use
it.) The folder's `<folder>/.claude/settings.json` carries **policy only**: which
tools run without a prompt, which MCP servers exist, and memory off. It never carries a `sandbox`
block — there is no host sandbox to configure, and a `sandbox.filesystem` rule would only name
host paths that do not exist inside the container.

## When to use
- "Lock down / restrict this channel folder", "only let Claude use HubSpot (or X, Y) MCP here"
- "Don't let Claude extend its own permissions / use memory in this folder"
- "Inject an MCP config into a headless session"

## Inputs to collect
1. **Folder** — the channel's work folder (the gateway creates it; a custom `workDir` is allowed).
2. **Allowed MCP servers** — the exact connectors that should work inside it. For each, you need
   either its **URL** (claude.ai cloud connectors) or its **name** (locally-added servers). Get
   both from `claude mcp list`.

## How Claude Code MCP scoping actually works (verified, non-obvious)
- **claude.ai cloud connectors are GLOBAL** — synced from the claude.ai account, available
  in every folder by default. They are NOT stored in `~/.claude.json`. So "restricting" a
  folder means *subtracting* from this global set.
- **`allowedMcpServers` is the real on/off allowlist and it works at PROJECT scope**
  (not only managed settings). When present, anything not matching is fully blocked
  (not connected at all).
  - Match **claude.ai connectors by `serverUrl`** (wildcards allowed). Matching them by
    `serverName` SILENTLY FAILS and blocks everything — including the one you wanted.
  - Match **locally-added servers by `serverName`** (the name shown in `claude mcp list`).
- **`permissions.deny` does NOT hide/disconnect a server** — it only blocks that server's
  *tools*. The server still shows "Connected". Use `deny` for built-in MCPs
  (`claude-in-chrome`, `computer-use`) since `allowedMcpServers` doesn't gate built-ins.
- The genuine claude.ai HubSpot connector endpoint is `https://mcp.hubspot.com/anthropic`
  (≠ the generic `https://mcp.hubspot.com`). Always copy the exact URL from `claude mcp list`.

## How memory limiting works
- **`autoMemoryEnabled: false`** stops Claude reading from or writing to the auto-memory
  directory (`~/.claude/projects/<sanitized-cwd>/memory/`) for that folder.
- **`autoDreamEnabled: false`** also disables background memory consolidation (async writes).
- Inside a container that directory would live in the channel's own HOME volume — never the
  operator's — but it is switched off anyway: the gateway's channel memory (`MEMORY.md` +
  `memory/<topic>.md`, saved through `update_channel_memory`) is the memory that exists, and it is
  folder-scoped by design.
- Note: `autoMemoryDirectory` (which *relocates* memory) is **ignored when set in checked-in
  project settings, for security** — from a project `settings.json` you can only DISABLE
  memory, not redirect it.

## Headless mode (`-p` / SDK): inject MCP via flags
For non-interactive runs you don't need a settings file — inject MCP config on the command line:
- **`--mcp-config <…>`** — load MCP servers from **JSON file path(s) or inline JSON string(s)**
  (space-separated, repeatable). Shape is identical to `.mcp.json`:
  `{"mcpServers": { "<name>": { … } }}`.
- **`--strict-mcp-config`** — use **ONLY** the servers from `--mcp-config`, ignoring every other
  MCP source (user/project/local **and** the global claude.ai connectors). This is the headless
  equivalent of the gateway lockdown, and is cleaner than `allowedMcpServers` because it's an
  absolute whitelist that also drops the cloud connectors.
- Bound the run further with `--allowedTools` / `--disallowedTools` and `--permission-mode`.

```bash
claude -p "your prompt" \
  --mcp-config '{"mcpServers":{"hubspot":{"type":"http","url":"https://…","headers":{"Authorization":"Bearer ${HUBSPOT_TOKEN}"}}}}' \
  --strict-mcp-config \
  --allowedTools "mcp__hubspot"
```

**OAuth caveat (critical):** headless mode cannot run an **interactive OAuth** flow. The
claude.ai HubSpot connector and the `mcp.hubspot.com` OAuth server both need a browser login,
so they will NOT authenticate fresh inside a `-p` run. For headless, use servers with
**non-interactive auth** — an HTTP server with a header token (`Authorization: Bearer …`) — or
pre-authenticate the OAuth server once interactively so its cached token already exists.

A cwd `.claude/settings.json` (e.g. the gateway file below) still layers on top of headless runs;
injected servers come from the flags, not the file.

## Procedure (interactive gateway)
1. `mkdir -p <folder>/.claude`
2. Run `claude mcp list` (from any folder) and copy the exact **URL** of each allowed
   claude.ai connector and the exact **name** of each allowed local server.
3. Write `<folder>/.claude/settings.json` from the template below.
4. **Verify** by running `claude mcp list` **from inside `<folder>`** — the output must list
   ONLY the allowed servers. If a wanted connector is missing, its URL/name didn't match.
5. Tell the user to relaunch any open `claude` session in the folder (or open `/mcp`) so the
   config reloads.

## Template `<folder>/.claude/settings.json` (what the gateway generates)
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",

  "allowedMcpServers": [
    { "serverUrl": "https://mcp.hubspot.com/*" },
    { "serverName": "trigger" }
  ],

  "autoMemoryEnabled": false,
  "autoDreamEnabled": false,

  "enableAllProjectMcpServers": false,
  "enabledMcpjsonServers": [],

  "permissions": {
    "defaultMode": "default",
    "disableBypassPermissionsMode": "disable",
    "disableAutoMode": "disable",
    "additionalDirectories": [],
    "allow": [
      "mcp__claude_ai_HubSpot",
      "mcp__trigger"
    ],
    "deny": [
      "mcp__claude-in-chrome"
    ]
  }
}
```

The gateway adds its own `hooks.Stop` entry (the helper comes from the image's `/opt/channelgate`
bundle, never from a path on the host) and keeps a separate variant of the file for an admin
author's live turn, which permits the bypass. There is deliberately no `sandbox` key.

### Filling the template
- **`allowedMcpServers`** — one entry per allowed server. claude.ai connectors → `serverUrl`
  (e.g. HubSpot `https://mcp.hubspot.com/*`); local servers → `serverName` (e.g. `trigger`).
- **`autoMemoryEnabled` / `autoDreamEnabled`** — keep both `false` to fully disable persistent
  memory for the gateway folder. Omit (or set `true`) only if the gateway is allowed to learn.
- **`permissions.allow`** — list the tool namespaces of the allowed servers so they run
  without prompts. The namespace is `mcp__<server>` where `<server>` is the name with
  spaces/dots → underscores (e.g. `claude.ai HubSpot` → `mcp__claude_ai_HubSpot`). The channel's
  mode (read / bash / auto / admin) is expressed here too — it is a TOOL preset, nothing more.
- **`permissions.deny`** — block built-in browser MCP tools you don't want
  (`mcp__claude-in-chrome`). `computer-use` is usually already disabled.
- **Lockdown extras** — `disableBypassPermissionsMode` blocks `--dangerously-skip-permissions`;
  `disableAutoMode` blocks auto-approve. Optionally `deny` edits to the folder's own
  `.claude/**` so a session can't loosen its own rules.
- **What confines the run** — the container, decided by the daemon at create time: the mounts
  (work folder, clean workspace, artifact dir, the HOME volume) and the image. Edit/Write are
  held to the folder by leaving `additionalDirectories` empty; Bash cannot reach anything that is
  not mounted. Nothing in this file (and nothing a run does) filters the network.

## Limits to state honestly
- The settings file is policy, not a wall: anyone who can edit the folder on disk can change it,
  and a bash/auto-mode turn can edit its own folder. The wall is the container — a run cannot
  change its own mounts or image. It is a filesystem/process wall, not a network one: there is no
  per-domain filtering and the *Allow network* switch does not cut egress in this release. Managed settings
  (`/etc/claude-code/managed-settings.json`) are machine-wide and cannot be scoped to one folder.
- This is folder-scoped on purpose; disabling connectors in claude.ai is account-wide instead.

## Worked example (HubSpot + trigger only, memory off)
A gateway folder restricted to the claude.ai HubSpot connector plus the local `trigger`
server, with memory disabled, was verified with `claude mcp list` run inside the folder
returning exactly:
```
claude.ai HubSpot: https://mcp.hubspot.com/anthropic - ✔ Connected
trigger: npx trigger.dev@4.4.6 mcp - ✔ Connected
```
