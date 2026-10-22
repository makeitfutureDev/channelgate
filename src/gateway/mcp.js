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
// Selected optional definitions are added by run-engine-mcp.js through the engine adapter.
// Claude receives explicit safe definitions; ambient user/project settings remain disabled.
//
// RUNTIME TARGETS (v0.8): an `isolated` target (the container backend) gets the SAME servers with
// two differences — the two STDIO entries are the image's socket bridge instead of a script in this
// checkout, and their env carries the signed capability and nothing else. A container must never
// receive CG_PORT / CG_APPROVAL_SECRET (there is no /internal/* route it could reach), nor
// CHANNELGATE_DIR / CG_FS_ROOT / CG_WORKSPACE_DIR / PATH (host paths that do not exist inside it).
// The local runtime (daemon-internal turns) or no target at all produces the plain stdio form.
//
// RELAYED REMOTES: composio-user
// and composio-agent in token/endpoint mode always use the daemon socket so membership changes
// cannot skip human approval. Other header-bearing remotes (the toolboxes) are plain
// `{type:"http", url, headers}` entries on a host target (the engine dials them itself, credential
// in the file). On an ISOLATED target that file lives in the artifact dir every process in the
// container can read, so there they become the SAME socket-bridge entry the SDK mode uses, with
// `CG_MCP_SERVICE=remote-mcp` and the server name as the bridge argument: the container holds only
// the signed capability (whose `remoteMcps` claim names the servers), and the real URL + headers
// are registered in the daemon's in-memory registry (src/mcp/remote-mcp-registry.js) under the
// capability's jti, for the capability's lifetime. The daemon dials them (src/mcp/remote-relay.js).
// `buildMcpRuntimePayload` also returns a digest of the relayed URL + headers so the warm pool can
// still retire a process when a token rotates (src/gateway/run-engine-mcp.js).
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { composioUrl, toolboxUrl } from "./mcp-catalog.js";
import { gatewayRoot, runtimeSocketFile } from "../config/paths.js";
import { requireAdapter } from "../engines/registry.js";
import { runtimeSupports } from "../runtimes/contract.js";
import { requireComposioSdkEntitlement } from "../ee/composio-entitlement.js";
import { mintGatewayCapability, mintedCapabilityClaims } from "./mcp-capability.js";
import { registerRemoteMcps, remoteMcpServerProblem } from "../mcp/remote-mcp-registry.js";
import { customMcpRemotes } from "./custom-mcps.js";

const GATEWAY_PATH = fileURLToPath(new URL("../mcp/gateway-server.js", import.meta.url));
const SOCKET_BRIDGE_PATH = fileURLToPath(new URL("../mcp/socket-bridge.js", import.meta.url));

function composioServer(endpoint, { socketBridge, gatewayCapability, socketEnv }) {
  if (endpoint?.mode !== "sdk" || !endpoint.url) return null;
  requireComposioSdkEntitlement();
  return {
    command: socketBridge.command,
    args: [...(socketBridge.args || []), endpoint.url],
    env: { ...socketEnv, CG_MCP_SERVICE: "composio-sdk", CG_GATEWAY_CAPABILITY: gatewayCapability },
    default_tools_approval_mode: "approve",
  };
}

// The header-bearing form of a Composio identity (an explicit endpoint, or the legacy token against
// the hosted URL), or null for SDK mode / no credential. Composio is relayed on every runtime.
function composioHttpTarget(endpoint, legacyToken) {
  if (endpoint?.mode === "sdk" && endpoint.url) return null;
  if (endpoint?.url) return { url: endpoint.url, headers: endpoint.headers || {} };
  if (!legacyToken) return null;
  return { url: composioUrl(), headers: { "x-consumer-api-key": legacyToken } };
}

// A stable, value-free digest of one relayed server's URL + headers: the warm pool's fingerprint
// needs to CHANGE when a token rotates, but must never contain the token.
function relayDigestOf({ url, headers }) {
  const sorted = Object.keys(headers).sort().map((name) => [name, headers[name]]);
  return `sha256:${createHash("sha256").update(JSON.stringify([url, sorted])).digest("hex")}`;
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
  const ownership = " These logical identities do not establish the connected service owner; discover account metadata through the selected identity before claiming ownership. The agent identity is not necessarily shared across channels. Matching service owners never authorize substituting identities.";
  // QA-0925 (FSHARE-02): the routing lived only in the gateway-usage guide, and a Codex turn that
  // skipped that page pushed a PDF through the workbench as base64 instead. Every run that has a
  // Composio identity needs the one handoff rule, whichever engine and whichever pages it reads.
  const files = " To hand a file from this folder to a Composio tool that takes a file object (Drive upload, email attachment, …), call `gateway` → `stage_file_for_composio` with `identity: \"user\"` for tools run through `composio-user`, or `identity: \"agent\"` for `composio-agent`; these are the only accepted identity values. Pass its result on unchanged; a tool that only ingests by URL takes a `create_public_file_link` upload link instead. Never push a file's bytes as base64 or chunks through the workbench or another Composio tool to get around staging, including when staging fails or the file is too large.";
  if (user && agent) {
    return "[Composio identities in THIS run: `composio-user` (the requester's own accounts) and `composio-agent` (the shared agent's own). " +
      "Reads and searches may use either or both identities without asking which account unless the user restricts the account or scope. Writes, sends and other state changes require the intended identity and connected account: reuse an established choice, or ask \"which account?\" if unresolved before mutating; continue independent authorized reads." + ownership + files + "]\n\n";
  }
  if (user) {
    return "[Composio identities in THIS run: `composio-user` only (the requester's own accounts). " +
      "There is no shared agent identity here, so a request for the agent's own accounts (\"your inbox\") has nothing to read — say so and stop." + ownership + files + "]\n\n";
  }
  if (agent) {
    return "[Composio identities in THIS run: `composio-agent` only (the shared agent's connections). " +
      "A request phrased for the person asking (\"my inbox\", \"my calendar\") cannot be served here: say so and stop, do not read `composio-agent` to answer it." + ownership + files + "]\n\n";
  }
  return "";
}

// The per-run MCP config as the JSON string every existing caller writes to a file.
export async function buildMcpConfig(options = {}) {
  return (await buildMcpRuntimePayload(options)).configJson;
}

/**
 * The per-run MCP payload plus what a caller needs beyond the JSON: `relayDigest` (per relayed
 * server, a digest of its URL + headers — `{}` on a host target, where the headers are in the JSON
 * itself) for the warm-pool fingerprint, the signed `gatewayCapability`, and `relayedMcps` (the
 * names registered with the daemon's relay for this capability), `relayJti` (the registration's key
 * when there is one — the caller owns one hold on it, see registerRemoteMcps) and `rejectedRemotes` (a remote an
 * isolated run could not be given, `[{ name, reason }]`, for the caller's rejected-MCP note).
 */
export async function buildMcpRuntimePayload({ composioUserEndpoint = null, composioEndpoint = null, composioUserToken = "", composioToken = "", toolboxToken = "", makeToolboxUrl = "", makeToolboxKey = "", customMcps = {}, channelId = "", slug = "", authorId = "", threadKey = "", questionThreadKey, sudoSchedule = false, origin = "", progressReport = false, engine = "claude", principalTrusted = true, gatewayFsRoot = "", gatewayWorkspaceRoot = "", toolset = "", target = null, ttlMs = undefined } = {}) {
  // Identity claim — fail closed on garbage instead of silently signing as Claude.
  const normalizedEngine = requireAdapter(engine || "claude").id;
  // Fail closed on an unknown capability key; a target that is absent or host-backed is today's path.
  const isolated = target && runtimeSupports(target, "isolated") ? target : null;
  const gatewayHelper = isolated ? isolated.runtime.helperCommand(isolated, "gateway-mcp") : null;
  // Managed Composio always traverses the daemon's membership-approval boundary, including /sudo.
  const connectorHelper = gatewayHelper || { command: process.execPath, args: [SOCKET_BRIDGE_PATH] };
  const connectorSocketEnv = isolated ? {} : { CG_MCP_SOCKET: runtimeSocketFile() };
  // Same predicate the prompt's identity line is built from — one answer to "which identities does
  // this run have?", never two that can drift apart.
  const identities = composioIdentitiesForRun({ principalTrusted, composioUserEndpoint, composioUserToken, composioEndpoint, composioToken });
  // Composio is always relayed. Other remotes are relayed on isolated targets only. Relayed
  // names go into the signed claim and their URL + headers into the daemon registry.
  const httpRemotes = {};
  const userRemote = identities.user ? composioHttpTarget(composioUserEndpoint, composioUserToken) : null;
  if (userRemote) httpRemotes["composio-user"] = userRemote;
  const sharedRemote = identities.agent ? composioHttpTarget(composioEndpoint, composioToken) : null;
  if (sharedRemote) httpRemotes["composio-agent"] = sharedRemote;
  if (toolboxToken) httpRemotes["makeitfuture-toolbox"] = { url: toolboxUrl(), headers: { Authorization: `Bearer ${toolboxToken}` } };
  if (makeToolboxUrl && makeToolboxKey) httpRemotes["make-toolbox"] = { url: makeToolboxUrl, headers: { Authorization: `Bearer ${makeToolboxKey}` } };
  // Custom MCP connections (src/gateway/custom-mcps.js): `custom-<name>` / `my-<name>`, Bearer
  // header, `publicOnly` so the relay re-checks the destination on every dial. The prefixes keep
  // them from ever replacing one of the built-in entries above.
  for (const [name, remote] of Object.entries(customMcpRemotes(customMcps))) {
    if (!Object.hasOwn(httpRemotes, name)) httpRemotes[name] = remote;
  }
  // Each server is checked on its own before anything is registered. The relay dials https only
  // and carries bounded, single-line text headers; a remote that fails that (a plain-http
  // COMPOSIO_MCP_URL / TOOLBOX_MCP_URL override, a malformed endpoint header) cannot be relayed,
  // and handing its credential to the container instead is exactly what this path exists to stop.
  // So THAT server alone is dropped from the relayed run and REPORTED through the same
  // rejected-MCP note an unadmittable catalog selection gets; the rest of the turn is unaffected.
  const rejectedRemotes = [];
  for (const name of Object.keys(httpRemotes)) {
    if (!isolated && !["composio-user", "composio-agent"].includes(name)) continue;
    const problem = remoteMcpServerProblem(httpRemotes[name]);
    if (!problem) continue;
    delete httpRemotes[name];
    rejectedRemotes.push({ name, reason: problem });
  }
  const relayedMcps = Object.keys(httpRemotes).filter((name) => isolated || ["composio-user", "composio-agent"].includes(name));
  const jti = randomUUID();
  const gatewayCapability = mintGatewayCapability({
    secret: process.env.CG_APPROVAL_SECRET || "",
    channelId,
    slug,
    authorId,
    threadKey,
    questionThreadKey,
    sudoSchedule,
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
    ...(relayedMcps.length ? { remoteMcps: relayedMcps } : {}),
    jti,
    ...(ttlMs ? { ttlMs } : {}),
  });
  // Registered under the capability's own jti and expiry, in THIS process — the daemon that also
  // serves the socket. Nothing else holds the credential for an isolated run.
  const relayDigest = {};
  if (relayedMcps.length) {
    // Takes the caller's hold: whoever minted this (a turn in run.js, an SSH session) releases it
    // with releaseRemoteMcps(relayJti) when it no longer needs the grant; open relay connections
    // keep it alive past that (src/mcp/remote-mcp-registry.js).
    registerRemoteMcps({
      jti,
      exp: mintedCapabilityClaims(gatewayCapability).exp,
      servers: Object.fromEntries(relayedMcps.map((name) => [name, httpRemotes[name]])),
      meta: { channelId, slug, authorId, origin },
    });
    for (const name of relayedMcps) relayDigest[name] = relayDigestOf(httpRemotes[name]);
  }
  // A relayed remote's entry: the gateway's own socket bridge, selecting the
  // remote-mcp service and naming the server. The capability is the only authority it carries.
  const relayServer = (name) => ({
    command: connectorHelper.command,
    args: [...(connectorHelper.args || []), name],
    env: { ...connectorSocketEnv, CG_MCP_SERVICE: "remote-mcp", CG_GATEWAY_CAPABILITY: gatewayCapability },
    default_tools_approval_mode: "approve",
  });
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
  const composioOpts = { socketBridge: connectorHelper, gatewayCapability, socketEnv: connectorSocketEnv };
  for (const [name, endpoint, present] of [
    ["composio-user", composioUserEndpoint, identities.user],
    ["composio-agent", composioEndpoint, identities.agent],
  ]) {
    if (!present) continue;
    if (rejectedRemotes.some((rejected) => rejected.name === name)) continue;
    const entry = httpRemotes[name] ? relayServer(name) : composioServer(endpoint, composioOpts);
    if (entry) servers[name] = entry;
  }
  for (const name of ["makeitfuture-toolbox", "make-toolbox", ...Object.keys(customMcpRemotes(customMcps))]) {
    const remote = httpRemotes[name];
    if (remote && !servers[name]) servers[name] = isolated ? relayServer(name) : { type: "http", url: remote.url, headers: remote.headers };
  }
  return { configJson: JSON.stringify({ mcpServers: servers }), relayDigest, gatewayCapability, relayedMcps, relayJti: relayedMcps.length ? jti : "", rejectedRemotes };
}
