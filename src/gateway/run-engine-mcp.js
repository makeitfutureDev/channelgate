// Build the MCP payload and signed gateway capability for the engine that will actually spawn.
// A fallback is a new authority decision, not merely another runner: engine-scoped mutations are
// authorized from this claim, so Claude's capability must never be reused by a Codex fallback.
import { buildMcpConfig } from "./mcp.js";

// Capabilities live for six hours; a persistent Claude process idles out after ten minutes, but a
// continuously active thread can keep it alive much longer. Rotate the warm fingerprint at least
// once per five-hour bucket so a reused MCP subprocess never runs indefinitely on an expired grant.
const CAPABILITY_FINGERPRINT_BUCKET_MS = 5 * 60 * 60 * 1000;

export async function buildEngineMcpRuntime({ clean = false, engine = "claude", fingerprintNow = Date.now(), ...identity } = {}) {
  if (clean) {
    const mcpConfigJson = JSON.stringify({ mcpServers: {} });
    return { mcpConfigJson, mcpConfigFingerprint: mcpConfigJson, gatewayCapability: "" };
  }
  const mcpConfigJson = await buildMcpConfig({ ...identity, engine });
  const parsed = JSON.parse(mcpConfigJson);
  const gatewayCapability = parsed.mcpServers.gateway.env.CG_GATEWAY_CAPABILITY;

  // The signed token contains volatile iat/exp/jti fields, so hashing the raw MCP JSON tears down
  // the warm process on every message. Replace only that token in the FINGERPRINT view with its
  // stable authority scope plus a bounded renewal bucket. Actual argv/config still receives the
  // authentic signed token; author/origin/engine/trust changes continue to force a safe drain.
  const fingerprintView = structuredClone(parsed);
  fingerprintView.mcpServers.gateway.env.CG_GATEWAY_CAPABILITY = JSON.stringify({
    channelId: identity.channelId || "",
    slug: identity.slug || "",
    authorId: identity.authorId || "",
    threadKey: identity.threadKey || "",
    origin: identity.origin || "",
    engine: parsed.mcpServers.gateway.env.CG_ENGINE || engine,
    principalTrusted: identity.principalTrusted !== false,
    renewalBucket: Math.floor(Number(fingerprintNow) / CAPABILITY_FINGERPRINT_BUCKET_MS),
  });
  return {
    mcpConfigJson,
    mcpConfigFingerprint: JSON.stringify(fingerprintView),
    gatewayCapability,
  };
}
