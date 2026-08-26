// Turns a channel's picked MCP servers (self-contained objects from discovery) into the two
// things the lockdown needs: tool namespaces (permissions.allow) and allowedMcpServers matches.
//
// Composio is NOT a pick. Two stable identities may be injected at spawn time: `composio-user`
// for the active author's token and `composio-agent` for the AGENT's own account (backed by the
// channel token, else the org token — the model is never told which). Both are always referenced
// in the lockdown so either injected server is permitted.
export function composioUrl() {
  return process.env.COMPOSIO_MCP_URL || "https://connect.composio.dev/mcp";
}

// Reference data for the agent's own Composio (channel token, else org token), used when generating
// the lockdown. Matched by serverName (not URL) so a global claude.ai Composio connector cannot
// collide and load with the wrong auth. The name is self-describing on purpose: every tool the
// model calls reads `mcp__composio-agent__*` / `mcp__composio-user__*`, so whose account it is acting
// as is visible in the call itself, not something it has to remember from the guide.
export function composioRef() {
  return {
    name: "composio-agent",
    namespace: "mcp__composio-agent",
    allowMatch: { serverName: "composio-agent" },
  };
}

// Reference data for the active author's personal Composio connection.
export function composioUserRef() {
  return {
    name: "composio-user",
    namespace: "mcp__composio-user",
    allowMatch: { serverName: "composio-user" },
  };
}

// Skills Manager (makeitfuture-skills) — a separately injected token-backed MCP. Its resolved
// user/channel token is injected at spawn time in the
// `Authorization: Bearer <token>` header, and the server is always referenced in the lockdown so
// the injected one is permitted. URL is overridable via SKILLS_MCP_URL (settings.json).
export function skillsUrl() {
  return process.env.SKILLS_MCP_URL || "https://www.skillsmanager.uk/mcp";
}
export function skillsRef() {
  return {
    name: "makeitfuture-skills",
    namespace: "mcp__makeitfuture-skills",
    allowMatch: { serverName: "makeitfuture-skills" },
  };
}

// Toolbox (makeitfuture-toolbox) — a THIRD per-author injected MCP, identical in shape to Skills
// Manager: each user's own token (or a channel-wide one, or the org default) is injected at spawn
// time in the `Authorization: Bearer <token>` header, and the server is always referenced in the
// lockdown so the injected one is permitted. URL is overridable via TOOLBOX_MCP_URL (settings.json).
export function toolboxUrl() {
  return process.env.TOOLBOX_MCP_URL || "https://www.skillsmanager.uk/toolbox";
}
export function toolboxRef() {
  return {
    name: "makeitfuture-toolbox",
    namespace: "mcp__makeitfuture-toolbox",
    allowMatch: { serverName: "makeitfuture-toolbox" },
  };
}

// Per-channel Make MCP toolbox — the URL/key pair is injected at spawn time under one stable
// server name. The key never lives in this catalog or a channel folder.
export function makeToolboxRef() {
  return {
    name: "make-toolbox",
    namespace: "mcp__make-toolbox",
    allowMatch: { serverName: "make-toolbox" },
  };
}

// The gateway's own control MCP server (scheduling + channel admin) — always injected per channel.
export function gatewayRef() {
  return {
    name: "gateway",
    namespace: "mcp__gateway",
    allowMatch: { serverName: "gateway" },
  };
}

export const GATEWAY_TOOL_NAMES = [
  "create_schedule",
  "list_schedules",
  "delete_schedule",
  "run_in_background",
  "run_agent_in_background",
  "request_approval",
  "list_available_mcps",
  "list_channel_mcps",
  "add_channel_mcps",
  "remove_channel_mcps",
  "set_channel_admin_mode",
  "set_channel_bash",
  "set_channel_network",
  "request_network_domain",
  "set_channel_auto_mode",
  "get_channel_workdir",
  "set_channel_workdir",
  "clear_channel_workdir",
  "list_folders",
  "get_channel_drive_folder",
  "set_channel_drive_folder",
  "clear_channel_drive_folder",
  "update_channel_instructions",
  "update_channel_memory",
  "update_gateway",
  "restart_gateway",
  "get_gateway_guide",
  "update_gateway_guide",
  "reset_gateway_guide",
  "set_my_composio_token",
  "clear_my_composio_token",
  "set_my_skills_token",
  "clear_my_skills_token",
  "set_my_toolbox_token",
  "clear_my_toolbox_token",
  "report_progress",
  "slack_list_create",
  "slack_list_add_item",
  "slack_list_update_item",
  "slack_list_items",
  "slack_list_info",
  "slack_upload_snippet",
  "slack_post_table",
  "slack_post_chart",
  "slack_channel_history",
  "slack_thread_replies",
  "permission_prompt",
];

export function gatewayToolRefs() {
  const { namespace } = gatewayRef();
  return GATEWAY_TOOL_NAMES.map((name) => `${namespace}__${name}`);
}

// `allowed` is the channel's picked MCP servers — self-contained objects from discovery:
// { name, namespace, match }. The tool namespaces to allow (always includes both Composio
// identities + gateway).
// (Slack capabilities beyond the gateway's own bot-token tools come from the Slack toolkit inside
// the selected `mcp__composio-user` or `mcp__composio-agent` namespace — not a hosted Slack MCP.)
export function namespacesFor(allowed = []) {
  const out = new Set([composioUserRef().namespace, composioRef().namespace, skillsRef().namespace, toolboxRef().namespace, makeToolboxRef().namespace, gatewayRef().namespace]);
  for (const a of allowed) if (a?.namespace) out.add(a.namespace);
  return [...out];
}

// The allowedMcpServers match objects for the lockdown (+ both Composio identities, Skills
// Manager, Toolbox & scheduler).
export function allowMatchesFor(allowed = []) {
  const out = [composioUserRef().allowMatch, composioRef().allowMatch, skillsRef().allowMatch, toolboxRef().allowMatch, makeToolboxRef().allowMatch, gatewayRef().allowMatch];
  for (const a of allowed) if (a?.match) out.push(a.match);
  return out;
}
