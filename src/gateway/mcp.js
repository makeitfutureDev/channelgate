// Builds the per-run --mcp-config payload. The gateway control plane is always present; optional
// token-backed servers are added when their independently resolved credentials exist:
//   - gateway: the gateway's own control MCP server (schedules + channel admin), scoped to this
//     channel/author via env — runs outside the sandbox so it can read/write gateway config.
//   - composio-user: injected only when the active author has a personal token.
//   - composio-agent: the agent's OWN account — injected independently with the channel token, or
//     the org token as fallback (the model never learns which; to it this is simply its account).
//     Both tokens ride x-consumer-api-key headers and are never written to channel storage.
//   - makeitfuture-skills: injected only when a resolved per-user/channel/org
//     token is available, carrying it in the Authorization: Bearer header.
//   - makeitfuture-toolbox: same idea as makeitfuture-skills — injected only when a (per-user,
//     channel, or org-default) token is available, carrying it in the Authorization: Bearer header.
// The channel's other picked MCP servers are NOT injected — they're the machine's
// globally-configured servers, reachable via the lockdown's allowedMcpServers allowlist.
import { fileURLToPath } from "node:url";
import { composioUrl, skillsUrl, toolboxUrl } from "./mcp-catalog.js";
import { gatewayRoot } from "../config/paths.js";
import { requireAdapter } from "../engines/registry.js";
import { mintGatewayCapability } from "./mcp-capability.js";

const GATEWAY_PATH = fileURLToPath(new URL("../mcp/gateway-server.js", import.meta.url));
const COMPOSIO_SDK_BRIDGE_PATH = fileURLToPath(new URL("../mcp/composio-sdk-bridge.js", import.meta.url));

function composioServer(endpoint, legacyToken) {
  if (endpoint?.mode === "sdk" && endpoint.url) {
    return {
      command: process.execPath,
      args: [COMPOSIO_SDK_BRIDGE_PATH, endpoint.url],
      env: { CHANNELGATE_DIR: gatewayRoot() },
      default_tools_approval_mode: "approve",
    };
  }
  if (endpoint?.url) {
    return {
      type: "http",
      url: endpoint.url,
      headers: endpoint.headers || {},
      default_tools_approval_mode: "approve",
    };
  }
  if (!legacyToken) return null;
  return {
    type: "http",
    url: composioUrl(),
    headers: { "x-consumer-api-key": legacyToken },
    default_tools_approval_mode: "approve",
  };
}

export async function buildMcpConfig({ composioUserEndpoint = null, composioEndpoint = null, composioUserToken = "", composioToken = "", skillsToken = "", toolboxToken = "", makeToolboxUrl = "", makeToolboxKey = "", channelId = "", slug = "", authorId = "", threadKey = "", origin = "", progressReport = false, engine = "claude", principalTrusted = true, gatewayFsRoot = "", gatewayWorkspaceRoot = "", toolset = "" } = {}) {
  // Identity claim — fail closed on garbage instead of silently signing as Claude.
  const normalizedEngine = requireAdapter(engine || "claude").id;
  const gatewayCapability = mintGatewayCapability({
    secret: process.env.CG_APPROVAL_SECRET || "",
    channelId,
    slug,
    authorId,
    threadKey,
    origin,
    engine: normalizedEngine,
    principalTrusted,
  });
  const servers = {
    gateway: {
      command: process.execPath, // node
      args: [GATEWAY_PATH],
      env: {
        // Identity is authoritative only inside this signed, expiring run capability. The legacy
        // CG_* identity fields are intentionally absent so a child cannot rewrite its principal.
        CG_GATEWAY_CAPABILITY: gatewayCapability,
        // The engine the MCP server should assume. Normalized through the registry so an
        // unregistered value falls back explicitly rather than being relabelled "claude".
        CG_ENGINE: normalizedEngine,
        CG_PORT: String(process.env.PORT || 4747), // the daemon's local port for /internal/approval
        CG_APPROVAL_SECRET: process.env.CG_APPROVAL_SECRET || "", // shared secret for that endpoint
        // MCP subprocesses run with an isolated HOME. Pass the daemon-resolved roots explicitly so
        // default/custom channel paths cannot silently rebase into that disposable home directory.
        CG_FS_ROOT: gatewayFsRoot,
        CG_WORKSPACE_DIR: gatewayWorkspaceRoot,
        CHANNELGATE_DIR: gatewayRoot(),
        PATH: process.env.PATH || "", // so the server can run `claude/codex mcp list`
        ...(progressReport ? { CG_PROGRESS_REPORT: "1" } : {}),
        // A reduced tool surface for daemon-spawned helpers (the background memory review gets ONLY
        // the save tool). Absent = the full control plane. Reduces only; never grants.
        ...(toolset ? { CG_TOOLSET: toolset } : {}),
      },
    },
  };
  const userComposio = composioServer(composioUserEndpoint, composioUserToken);
  if (userComposio) servers["composio-user"] = userComposio;
  const sharedComposio = composioServer(composioEndpoint, composioToken);
  if (sharedComposio) servers["composio-agent"] = sharedComposio;
  if (skillsToken) {
    servers["makeitfuture-skills"] = { type: "http", url: skillsUrl(), headers: { Authorization: `Bearer ${skillsToken}` } };
  }
  if (toolboxToken) {
    servers["makeitfuture-toolbox"] = { type: "http", url: toolboxUrl(), headers: { Authorization: `Bearer ${toolboxToken}` } };
  }
  if (makeToolboxUrl && makeToolboxKey) {
    servers["make-toolbox"] = {
      type: "http",
      url: makeToolboxUrl,
      headers: { Authorization: `Bearer ${makeToolboxKey}` },
    };
  }
  return JSON.stringify({ mcpServers: servers });
}
