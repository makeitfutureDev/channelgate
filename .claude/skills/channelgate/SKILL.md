---
name: "channelgate"
description: "Set up a \"gated\" Claude Code session: confine Claude's filesystem to one folder and restrict which MCP servers it can use to an explicit allowlist. Use when asked to sandbox/lock-down/restrict a folder, limit Claude to certain MCP connectors (e.g. \"only HubSpot\"), disable memory for a folder, create an isolated/gateway working directory, or inject/restrict MCP config in a headless (-p / SDK) session via --mcp-config / --strict-mcp-config."
category: "claude-code"
version: "1.2.0"
complexity: "intermediate"
tags:
  - "claude-code"
  - "mcp"
  - "sandbox"
  - "permissions"
  - "security"
  - "settings"
created: "2026-06-16"
updated: "2026-06-16"
---

# channelgate

Create a **gated folder** for Claude Code: when `claude` is launched inside it, Claude's
filesystem access is confined to that folder, only an explicit allowlist of MCP servers is
reachable, and persistent memory is disabled. Everything else is unavailable.

Driven by a project-scoped `<folder>/.claude/settings.json` (interactive), or by `--mcp-config`
/ `--strict-mcp-config` flags (headless). No admin/sudo needed.

## When to use
- "Restrict/sandbox/lock down a folder", "isolate this project"
- "Only let Claude use HubSpot (or X, Y) MCP here, nothing else"
- "Don't let Claude read outside this folder / extend its own permissions / use memory"
- "Inject an MCP config into a headless session"

## Inputs to collect
1. **Folder** — absolute path of the gateway folder (create it if missing).
2. **Allowed MCP servers** — the exact connectors that should work inside it.
   For each, you need either its **URL** (claude.ai cloud connectors) or its **name**
   (locally-added servers). Get both from `claude mcp list`.

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
- The sandbox filesystem rules already block *Bash* from touching `~/.claude/...`, but
  auto-memory is accessed by Claude Code itself (not via Bash), so it needs these explicit
  switches.
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

## Template `<folder>/.claude/settings.json`
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
  },

  "sandbox": {
    "enabled": true,
    "allowUnsandboxedCommands": false,
    "filesystem": {
      "denyRead":  ["//ABS/PARENT"],
      "allowRead": ["//ABS/PARENT/<folder>"],
      "denyWrite":  ["//ABS/PARENT"],
      "allowWrite": ["//ABS/PARENT/<folder>"]
    }
  }
}
```

### Filling the template
- **`allowedMcpServers`** — one entry per allowed server. claude.ai connectors → `serverUrl`
  (e.g. HubSpot `https://mcp.hubspot.com/*`); local servers → `serverName` (e.g. `trigger`).
- **`autoMemoryEnabled` / `autoDreamEnabled`** — keep both `false` to fully disable persistent
  memory for the gateway folder. Omit (or set `true`) only if the gateway is allowed to learn.
- **`permissions.allow`** — list the tool namespaces of the allowed servers so they run
  without prompts. The namespace is `mcp__<server>` where `<server>` is the name with
  spaces/dots → underscores (e.g. `claude.ai HubSpot` → `mcp__claude_ai_HubSpot`).
- **`permissions.deny`** — block built-in browser MCP tools you don't want
  (`mcp__claude-in-chrome`). `computer-use` is usually already disabled.
- **`sandbox.filesystem`** — `denyRead`/`denyWrite` the parent (or home), then `allowRead`/
  `allowWrite` re-allow the gateway folder (allow overrides deny). Use absolute paths with
  the `//` prefix. This confines Bash. Edit/Write are also held to the folder by leaving
  `additionalDirectories` empty.
- **Lockdown extras** — `disableBypassPermissionsMode` blocks `--dangerously-skip-permissions`;
  `disableAutoMode` blocks auto-approve. Optionally `deny` edits to the folder's own
  `.claude/**` so a session can't loosen its own rules.

## Limits to state honestly
- Project `settings.json` lives inside the folder — a strong guardrail, but anyone editing the
  file on disk (outside a Claude session) can change it. A tamper-proof lock needs **managed
  settings** (`/Library/Application Support/ClaudeCode/managed-settings.json`, sudo), which is
  **machine-wide** and cannot be scoped to one folder.
- This is folder-scoped on purpose; disabling connectors in claude.ai is account-wide instead.

## Worked example (HubSpot + trigger only, memory off)
A gateway folder restricted to the claude.ai HubSpot connector plus the local `trigger`
server, with memory disabled, confined to
`~/Agent Folders/access_test/demo`, was verified with `claude mcp list`
returning exactly:
```
claude.ai HubSpot: https://mcp.hubspot.com/anthropic - ✔ Connected
trigger: npx trigger.dev@4.4.6 mcp - ✔ Connected
```
