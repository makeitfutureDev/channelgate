// Build the MCP payload and signed gateway capability for the engine that will actually spawn.
// A fallback is a new authority decision, not merely another runner: engine-scoped mutations are
// authorized from this claim, so Claude's capability must never be reused by a Codex fallback.
import { buildMcpRuntimePayload } from "./mcp.js";
import { releaseRemoteMcps } from "../mcp/remote-mcp-registry.js";
import { requireAdapter } from "../engines/registry.js";
import { requirePluginRuntime } from "./plugin-runtime.js";
import { safeCodexMcpDefinition } from "./mcp-discovery.js";

// Capabilities live for six hours; a persistent Claude process idles out after ten minutes, but a
// continuously active thread can keep it alive much longer. Rotate the warm fingerprint at least
// once per five-hour bucket so a reused MCP subprocess never runs indefinitely on an expired grant.
const CAPABILITY_FINGERPRINT_BUCKET_MS = 5 * 60 * 60 * 1000;

// `target` is the run's RuntimeTarget (src/runtimes/resolve.js). mcp.js needs it to decide how the
// engine reaches the gateway control server: a host run spawns the stdio server from this checkout,
// an isolated run gets the in-container bridge instead (there is no DB and no checkout on that
// side). Passed through explicitly rather than riding in `identity`, so the dependency is visible.
export async function buildEngineMcpRuntime({ clean = false, engine = "claude", target = null, allowedMcps = [], pluginRuntime = null, fingerprintNow = Date.now(), ...identity } = {}) {
  if (clean) {
    const mcpConfigJson = JSON.stringify({ mcpServers: {} });
    return { mcpConfigJson, mcpConfigFingerprint: mcpConfigJson, gatewayCapability: "", relayJti: "", rejectedMcps: [] };
  }
  // Every engine's resolver answers { servers, rejected }: an optional selection it cannot admit
  // safely is dropped here rather than ending the turn, and `rejectedMcps` is what the caller
  // reports in the thread so the drop is visible to the admin who has to fix the selection.
  const optional = await requireAdapter(engine).resolveOptionalMcpConfig?.(allowedMcps) || {};
  const payload = await buildMcpRuntimePayload({ ...identity, engine, target });
  try {
    return finishEngineMcpRuntime({ payload, optional, engine, pluginRuntime, fingerprintNow, identity });
  } catch (error) {
    // A payload the caller never receives must not leave its relay registration behind.
    if (payload.relayJti) releaseRemoteMcps(payload.relayJti);
    throw error;
  }
}

function finishEngineMcpRuntime({ payload, optional, engine, pluginRuntime, fingerprintNow, identity }) {
  const optionalServers = optional.servers || {};
  // A built-in remote an isolated run could not be relayed (a non-https override) is reported the
  // same way as an unadmittable selection: dropped, named, never silently absent.
  const rejectedMcps = [...(Array.isArray(optional.rejected) ? optional.rejected : []), ...(payload.rejectedRemotes || [])];
  const parsed = JSON.parse(payload.configJson);
  for (const [name, definition] of Object.entries(optionalServers)) {
    if (Object.hasOwn(parsed.mcpServers, name)) throw new Error("Selected MCP server conflicts with a built-in identity.");
    parsed.mcpServers[name] = definition;
  }
  const pluginServers = [];
  for (const server of requirePluginRuntime(pluginRuntime, engine).servers) {
    if (Object.hasOwn(parsed.mcpServers, server.name)) throw new Error("Plugin MCP server conflicts with a selected connection");
    const definition = server.definition || safeCodexMcpDefinition(optionalServers[server.sourceName]);
    if (!definition) throw new Error(`Plugin ${server.plugin}: MCP ${server.sourceName} needs a separately selected, supported connection; source credentials are not imported`);
    parsed.mcpServers[server.name] = definition.transport === "http"
      ? { type: "http", url: definition.url }
      : { command: definition.command, args: definition.args };
    pluginServers.push({ name: server.name, enabled: true, definition });
  }
  const mcpConfigJson = JSON.stringify(parsed);
  const gatewayCapability = parsed.mcpServers.gateway.env.CG_GATEWAY_CAPABILITY;

  // The signed token contains volatile iat/exp/jti fields, so hashing the raw MCP JSON tears down
  // the warm process on every message. Replace only that token in the FINGERPRINT view with its
  // stable authority scope plus a bounded renewal bucket. Actual argv/config still receives the
  // authentic signed token; author/origin/engine/trust changes continue to force a safe drain.
  //
  // The same token also rides every socket-bridged entry (the SDK-mode Composio sessions and, on an
  // isolated target, the relayed remotes), so it is replaced wherever it appears. A relayed remote's
  // credential is NOT in the JSON any more (it is in the daemon's relay registry), so its URL +
  // header digest is added instead: a rotated Composio/toolbox token must still retire the warm
  // process, exactly as it did when the token itself was part of the JSON.
  const fingerprintView = structuredClone(parsed);
  const stableCapability = JSON.stringify({
    channelId: identity.channelId || "",
    slug: identity.slug || "",
    authorId: identity.authorId || "",
    threadKey: identity.threadKey || "",
    origin: identity.origin || "",
    engine: parsed.mcpServers.gateway.env.CG_ENGINE || engine,
    principalTrusted: identity.principalTrusted !== false,
    renewalBucket: Math.floor(Number(fingerprintNow) / CAPABILITY_FINGERPRINT_BUCKET_MS),
  });
  for (const server of Object.values(fingerprintView.mcpServers)) {
    if (server?.env?.CG_GATEWAY_CAPABILITY === gatewayCapability) server.env.CG_GATEWAY_CAPABILITY = stableCapability;
  }
  if (Object.keys(payload.relayDigest || {}).length) fingerprintView.relayDigest = payload.relayDigest;
  return {
    mcpConfigJson,
    mcpConfigFingerprint: JSON.stringify(fingerprintView),
    gatewayCapability,
    // The relay registration this payload's capability took (src/gateway/mcp.js), or "". The
    // caller holds it and must releaseRemoteMcps() it when the run settles.
    relayJti: payload.relayJti || "",
    pluginServers,
    rejectedMcps,
  };
}
