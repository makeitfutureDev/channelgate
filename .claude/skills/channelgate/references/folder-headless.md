# Folder and headless configuration

Use this reference only when manually creating or auditing a gated folder, or composing a raw
Claude Code headless invocation. Normal ChannelGate runs generate this policy and injected MCP
configuration automatically.

## Folder policy

The container is the boundary; `.claude/settings.json` is policy. Keep automatic Claude memory and
dreaming off, admit only the intended MCPs/tools, prevent ordinary bypass/auto modes, leave
additional directories empty, and never add a `sandbox` block.

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
    "allow": ["mcp__claude_ai_HubSpot", "mcp__trigger"],
    "deny": ["mcp__claude-in-chrome"]
  }
}
```

Claude.ai cloud connectors are global account state. At project scope, match remote connectors by
their exact `serverUrl` (wildcards are allowed) and local stdio servers by `serverName`. A deny rule
blocks tools but does not disconnect a server. Copy current names/URLs from `claude mcp list`; do
not assume the display name is a valid remote match. The gateway adds its image-owned Stop hook and
an authorized admin-turn variant itself.

## Raw headless MCP injection

For a standalone `claude -p` run, pass the complete MCP set through `--mcp-config` and add
`--strict-mcp-config` so user/project/local and globally synchronized cloud connectors are ignored:

```bash
claude -p "your prompt" \
  --mcp-config '{"mcpServers":{"hubspot":{"type":"http","url":"https://example.invalid/mcp","headers":{"Authorization":"Bearer ${HUBSPOT_TOKEN}"}}}}' \
  --strict-mcp-config \
  --allowedTools "mcp__hubspot"
```

Prefer non-interactive header/token authentication for headless MCP servers. A fresh OAuth browser
flow normally cannot complete inside `-p`; pre-authenticate inside the conversation HOME, use a
provider-supported device flow, or inject a scoped token through the approved secret mechanism.

## Verification

Run `claude mcp list` from inside the folder/container and confirm that only intended servers are
connected. Verify both an allowed and disallowed operation, memory-off, ordinary bypass refusal,
and that no host-only path is visible. State the remaining limit honestly: anyone able to edit the
folder can edit project policy, while the container mounts/image remain outside the run's control;
network egress is not domain-filtered in this release.

