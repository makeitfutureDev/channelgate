// Builds the per-run --mcp-config payload. The gateway control plane is always present; optional
// token-backed servers are added when their independently resolved credentials exist:
//   - gateway: the gateway's own control MCP server (schedules + channel admin), scoped to this
//     channel/author via env — runs on the daemon, outside the container, so it can read/write gateway config.
//   - composio-user: injected only when the active author has a personal token.
//   - composio-agent: the agent's OWN account — injected independently with the channel token, or
//     the org token as fallback (the model never learns which; to it this is simply its account).
//     Both tokens ride x-consumer-api-key headers and are never written to channel storage.
//   - makeitfuture-toolbox: injected only when a (per-user, channel, or org-default) token is
//     available, carrying it in the Authorization: Bearer header. (Skills come from the gateway's
//     own catalog as files — src/gateway/skills — never from an MCP server.)
// The channel's other picked MCP servers are NOT injected — they're the machine's
// globally-configured servers, reachable via the lockdown's allowedMcpServers allowlist.
//
// RUNTIME TARGETS (v0.8): an `isolated` target (the container backend) gets the SAME servers with
// two differences — the two STDIO entries are the image's socket bridge instead of a script in this
// checkout, and their env carries the signed capability and nothing else. A container must never
// receive CG_PORT / CG_APPROVAL_SECRET (there is no /internal/* route it could reach), nor
// CHANNELGATE_DIR / CG_FS_ROOT / CG_WORKSPACE_DIR / PATH (host paths that do not exist inside it).
// Remote http entries are the same with or without a target — the engine dials those itself. The
// local runtime (daemon-internal turns) or no target at all produces the plain stdio form.
import { fileURLToPath } from "node:url";
import { composioUrl, toolboxUrl } from "./mcp-catalog.js";
import { gatewayRoot } from "../config/paths.js";
import { requireAdapter } from "../engines/registry.js";
import { runtimeSupports } from "../runtimes/contract.js";
import { requireComposioSdkEntitlement } from "../ee/composio-entitlement.js";
import { mintGatewayCapability } from "./mcp-capability.js";

const GATEWAY_PATH = fileURLToPath(new URL("../mcp/gateway-server.js", import.meta.url));
const COMPOSIO_SDK_BRIDGE_PATH = fileURLToPath(new URL("../ee/composio-sdk-bridge.js", import.meta.url));

function composioServer(endpoint, legacyToken, { socketBridge = null, gatewayCapability = "" } = {}) {
  if (endpoint?.mode === "sdk" && endpoint.url) {
    requireComposioSdkEntitlement();
    // SDK mode reads the ORGANIZATION Composio key from gateway settings — a settings file and a
    // database a container deliberately cannot see. So inside a container it rides the daemon
    // socket as well, selected by CG_MCP_SERVICE, and the command is the SAME stdio↔socket bridge
    // the gateway entry uses (the "gateway-mcp" helper), not the image's copy of
    // composio-sdk-bridge.js — that script would come up keyless and fail on the container side.
    if (socketBridge) {
      return {
        command: socketBridge.command,
        args: [...(socketBridge.args || []), endpoint.url],
        env: { CG_MCP_SERVICE: "composio-sdk", CG_GATEWAY_CAPABILITY: gatewayCapability },
        default_tools_approval_mode: "approve",
      };
    }
    return {
      command: process.execPath,
      args: [COMPOSIO_SDK_BRIDGE_PATH, endpoint.url],
      env: { CHANNELGATE_DIR: gatewayRoot(), CG_GATEWAY_CAPABILITY: gatewayCapability },
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

// Which Composio identities THIS run actually injects — the one predicate behind both the server
// map below and the per-run identity line run.js prepends to the prompt. It lives here on purpose:
// the line names `composio-user` / `composio-agent`, the exact keys assigned a few dozen lines
// down, so a rename cannot leave the prompt describing servers that no longer exist. The
// conditions mirror composioServer() above (an SDK session, a remote endpoint, or a legacy token),
// plus the two gates the caller applies: clean mode injects nothing at all, and an untrusted
// principal never gets the author's personal identity. Codex reaches the same answer through its
// own transport (`addComposio` in src/engines/codex.js) because run.js zeroes the user token and
// endpoint for an untrusted principal before either builder sees them.
export function composioIdentitiesForRun({ clean = false, principalTrusted = true, composioUserEndpoint = null, composioUserToken = "", composioEndpoint = null, composioToken = "" } = {}) {
  const present = (endpoint, legacyToken) => Boolean((endpoint?.mode === "sdk" && endpoint.url) || endpoint?.url || legacyToken);
  return {
    user: !clean && principalTrusted && present(composioUserEndpoint, composioUserToken),
    agent: !clean && present(composioEndpoint, composioToken),
  };
}

// The per-run counterpart of the managed block's first hard rule (src/gateway/folders.js). The
// block states the RULE; this states the FACT the rule has to be applied to — which identities this
// turn received — because `composio-user` is per AUTHOR and cannot be written into the channel's
// shared instruction file without two concurrent authors racing each other's sentence. The prompt
// is built per run, per author, so there is no shared file to race. Deliberately engine-neutral and
// content-free: server names and roles only, never a token, an address or an account label.
export function composioIdentityPreamble({ user = false, agent = false } = {}) {
  if (user && agent) {
    return "[Composio identities in THIS run: `composio-user` (the requester's own accounts) and `composio-agent` (the shared agent's own). " +
      "A request that names neither and could be served by either is answered with the question \"which account?\" — no tool call, no read-only peek.]\n\n";
  }
  if (user) {
    return "[Composio identities in THIS run: `composio-user` only (the requester's own accounts). " +
      "There is no shared agent identity here, so a request for the agent's own accounts (\"your inbox\") has nothing to read — say so and stop.]\n\n";
  }
  if (agent) {
    return "[Composio identities in THIS run: `composio-agent` only (the shared agent's own accounts, which hold OTHER people's data — never the requester's). " +
      "A request phrased for the person asking (\"my inbox\", \"my calendar\") cannot be served here: say so and stop, do not read `composio-agent` to answer it.]\n\n";
  }
  return "";
}

export async function buildMcpConfig({ composioUserEndpoint = null, composioEndpoint = null, composioUserToken = "", composioToken = "", toolboxToken = "", makeToolboxUrl = "", makeToolboxKey = "", channelId = "", slug = "", authorId = "", threadKey = "", origin = "", progressReport = false, engine = "claude", principalTrusted = true, gatewayFsRoot = "", gatewayWorkspaceRoot = "", toolset = "", target = null } = {}) {
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
    composioSessions: [
      ...(principalTrusted && composioUserEndpoint?.mode === "sdk" ? [{ kind: "user", url: composioUserEndpoint.url }] : []),
      ...(composioEndpoint?.mode === "sdk" ? [{ kind: "channel", url: composioEndpoint.url }] : []),
    ],
    // Signed, so the bearer alone fixes the tool surface: the socket server has no environment of
    // its own to read these from (src/mcp/socket-server.js).
    toolset,
    progressReport,
  });
  // Fail closed on an unknown capability key; a target that is absent or host-backed is today's path.
  const isolated = target && runtimeSupports(target, "isolated") ? target : null;
  const gatewayHelper = isolated ? isolated.runtime.helperCommand(isolated, "gateway-mcp") : null;
  const servers = {
    gateway: isolated ? {
      command: gatewayHelper.command,
      args: gatewayHelper.args || [],
      env: {
        // The complete env of a containerized gateway MCP entry. Identity is the signed capability;
        // everything else the stdio server needs (db, config, daemon port) lives on the other side
        // of the socket.
        CG_GATEWAY_CAPABILITY: gatewayCapability,
        CG_ENGINE: normalizedEngine,
        ...(progressReport ? { CG_PROGRESS_REPORT: "1" } : {}),
        ...(toolset ? { CG_TOOLSET: toolset } : {}),
      },
    } : {
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
  const composioOpts = { socketBridge: gatewayHelper, gatewayCapability };
  // Same predicate the prompt's identity line is built from — one answer to "which identities does
  // this run have?", never two that can drift apart.
  const identities = composioIdentitiesForRun({ principalTrusted, composioUserEndpoint, composioUserToken, composioEndpoint, composioToken });
  const userComposio = identities.user ? composioServer(composioUserEndpoint, composioUserToken, composioOpts) : null;
  if (userComposio) servers["composio-user"] = userComposio;
  const sharedComposio = identities.agent ? composioServer(composioEndpoint, composioToken, composioOpts) : null;
  if (sharedComposio) servers["composio-agent"] = sharedComposio;
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
