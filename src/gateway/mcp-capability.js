import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

const VERSION = 2;
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
import { RUN_ORIGINS } from "../engines/contract.js";

const MAX_TTL_MS = 24 * 60 * 60 * 1000;
const ORIGINS = new Set(RUN_ORIGINS); // single source: engines/contract.js

const encode = (value) => Buffer.from(value).toString("base64url");
const sign = (payload, secret) => createHmac("sha256", secret).update(payload).digest("base64url");

// `toolset` and `progressReport` are part of the SIGNED grant (v0.8): the gateway MCP server used
// to read them from CG_TOOLSET / CG_PROGRESS_REPORT in its own environment, which only works when
// the daemon spawns the server itself. A containerized run reaches the server over the daemon's
// unix socket (src/mcp/socket-server.js), where the only thing the caller presents is this bearer —
// so the bearer alone must fix the tool surface. Both are OPTIONAL claims: a token minted by an
// older build (or by a path that still relies on the env) verifies exactly as before and the
// reader falls back to its environment. Neither can WIDEN anything: an absent/blank toolset is the
// full control plane (today's default) and progressReport only adds one ack-only tool.
//
// `remoteMcps` (optional, P1 of the container-secrets plan) names the header-bearing remote MCP
// servers this run may reach through the daemon's `remote-mcp` socket relay. The names are the
// whole claim — the URL and the credential live only in the daemon's in-memory registry
// (src/mcp/remote-mcp-registry.js), keyed by this token's `jti` — so a container holding the token
// can dial exactly those servers and nothing else, and never sees their headers. `jti` may be
// fixed by the caller so it can register under the same key before handing the token out.
export const REMOTE_MCP_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
export const MAX_REMOTE_MCPS = 16;
const MAX_REMOTE_MCP_NAME = 64;

export function validRemoteMcpName(name) {
  return typeof name === "string" && name.length > 0 && name.length <= MAX_REMOTE_MCP_NAME && REMOTE_MCP_NAME_RE.test(name);
}

function validRemoteMcps(claims) {
  if (claims.remoteMcps === undefined) return true; // older grants authorize no relayed servers
  return Array.isArray(claims.remoteMcps) && claims.remoteMcps.length <= MAX_REMOTE_MCPS &&
    claims.remoteMcps.every(validRemoteMcpName) && new Set(claims.remoteMcps).size === claims.remoteMcps.length;
}

export function mintGatewayCapability({ secret, channelId, slug, authorId, threadKey, origin, engine, principalTrusted = true, toolset = "", progressReport = false, composioSessions = [], remoteMcps = undefined, jti = undefined, now = Date.now(), ttlMs = DEFAULT_TTL_MS } = {}) {
  if (!secret || !channelId || !slug || !authorId || !threadKey || !ORIGINS.has(origin)) {
    throw new Error("Cannot mint gateway capability without a complete run identity");
  }
  if (jti !== undefined && (typeof jti !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(jti))) {
    throw new Error("Invalid gateway capability id");
  }
  const ttl = Math.min(Math.max(1, Number(ttlMs) || DEFAULT_TTL_MS), MAX_TTL_MS);
  const claims = {
    v: VERSION,
    aud: "channelgate-mcp",
    channelId,
    slug,
    authorId,
    threadKey,
    origin,
    engine: String(engine || ""),
    principalTrusted: principalTrusted === true,
    toolset: String(toolset || ""),
    progressReport: progressReport === true,
    composioSessions,
    ...(remoteMcps !== undefined ? { remoteMcps } : {}),
    scope: "gateway-tools",
    iat: now,
    exp: now + ttl,
    jti: jti || randomUUID(),
  };
  if (!validComposioGrants(claims)) throw new Error("Invalid Composio session grants");
  if (!validRemoteMcps(claims)) throw new Error("Invalid remote MCP grants");
  const payload = encode(JSON.stringify(claims));
  return `${payload}.${sign(payload, secret)}`;
}

function validComposioGrants(claims) {
  if (claims.composioSessions === undefined) return true; // old grants authorize no SDK sessions
  return Array.isArray(claims.composioSessions) && claims.composioSessions.length <= 2 &&
    claims.composioSessions.every((grant) => grant && typeof grant.url === "string" &&
      grant.url.length <= 2048 && ["user", "channel"].includes(grant.kind) &&
      (grant.kind !== "user" || claims.principalTrusted === true));
}

export function verifyGatewayCapability(token, { secret, now = Date.now() } = {}) {
  if (!token || !secret) return { ok: false, reason: "missing capability or signing secret" };
  const [payload, signature, extra] = String(token).split(".");
  if (!payload || !signature || extra !== undefined) return { ok: false, reason: "malformed capability" };
  const expected = Buffer.from(sign(payload, secret));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { ok: false, reason: "invalid capability signature" };
  }
  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "invalid capability payload" };
  }
  if (claims?.v !== VERSION || claims.aud !== "channelgate-mcp" || claims.scope !== "gateway-tools") {
    return { ok: false, reason: "unsupported capability" };
  }
  if (!claims.channelId || !claims.slug || !claims.authorId || !claims.threadKey || !ORIGINS.has(claims.origin) || typeof claims.principalTrusted !== "boolean") {
    return { ok: false, reason: "incomplete capability claims" };
  }
  if (!validComposioGrants(claims)) return { ok: false, reason: "invalid Composio session grants" };
  // Optional claims (see mint): validate the SHAPE when present so a tampered payload can't smuggle
  // an object/array into the tool-surface decision, but never require them — an older token that
  // omits both is still a valid grant, and the reader falls back to its environment.
  if (claims.toolset !== undefined && typeof claims.toolset !== "string") return { ok: false, reason: "invalid capability toolset" };
  if (claims.progressReport !== undefined && typeof claims.progressReport !== "boolean") return { ok: false, reason: "invalid capability progress claim" };
  if (!validRemoteMcps(claims)) return { ok: false, reason: "invalid remote MCP grants" };
  if (!Number.isFinite(claims.iat) || !Number.isFinite(claims.exp) || claims.iat > now + 30_000 || claims.exp <= now || claims.exp - claims.iat > MAX_TTL_MS) {
    return { ok: false, reason: "expired or invalid capability lifetime" };
  }
  return { ok: true, claims };
}

// The claims of a token THIS process just minted, without re-checking the signature — for the
// minting caller that needs the exp/jti it has to register under (src/gateway/mcp.js). Never an
// authorization decision: anything arriving from outside goes through verifyGatewayCapability.
export function mintedCapabilityClaims(token) {
  const [payload] = String(token || "").split(".");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

export const GATEWAY_CAPABILITY_TTL_MS = DEFAULT_TTL_MS;
