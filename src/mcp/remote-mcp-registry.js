// The daemon-side half of the `remote-mcp` socket relay (src/mcp/socket-server.js): which
// header-bearing remote MCP servers (Composio user/agent, the toolboxes) one run capability may
// reach, and the REAL url + headers the daemon dials them with. In memory only, in the daemon
// process that mints the capability (src/gateway/mcp.js) and serves the socket — so the credential
// never has to be written anywhere a container can read: the container holds only the signed
// capability, and the capability names only server NAMES (its `remoteMcps` claim).
//
// Keyed by the capability's `jti`. An entry lives exactly as long as the capability it was
// registered for (its `exp`); expired entries are swept on every lookup and on an unref'd timer, so
// nothing here outlives a grant and nothing here keeps the daemon alive. A registration is never
// renewed: a later run (or a refreshed SSH session) mints a fresh jti and registers again.
//
// Bounded per registration (MAX_SERVERS servers, header values ≤ MAX_HEADER_VALUE_BYTES). Nothing
// in this module logs, and nothing it throws quotes a header value or a URL.
import { MAX_REMOTE_MCPS, validRemoteMcpName } from "../gateway/mcp-capability.js";

const MAX_SERVERS = MAX_REMOTE_MCPS;
const MAX_HEADER_VALUE_BYTES = 8 * 1024;
const MAX_HEADERS_PER_SERVER = 16;
const MAX_URL_LENGTH = 2048;
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;
const SWEEP_INTERVAL_MS = 60 * 1000;

const registrations = new Map(); // jti → { exp, servers: Map<name, { url, headers }> }
let sweeper = null;

function sweep(now = Date.now()) {
  for (const [jti, entry] of registrations) {
    if (entry.exp <= now) registrations.delete(jti);
  }
  if (!registrations.size && sweeper) {
    clearInterval(sweeper);
    sweeper = null;
  }
}

function ensureSweeper() {
  if (sweeper) return;
  sweeper = setInterval(() => sweep(), SWEEP_INTERVAL_MS);
  sweeper.unref?.();
}

function validUrl(value) {
  if (typeof value !== "string" || !value || value.length > MAX_URL_LENGTH) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

function copyHeaders(headers) {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) throw new Error("remote MCP headers must be an object");
  const names = Object.keys(headers);
  if (names.length > MAX_HEADERS_PER_SERVER) throw new Error("too many remote MCP headers");
  const out = {};
  for (const name of names) {
    const value = headers[name];
    if (!HEADER_NAME_RE.test(name)) throw new Error("invalid remote MCP header name");
    if (typeof value !== "string" || Buffer.byteLength(value) > MAX_HEADER_VALUE_BYTES || /[\r\n\0]/.test(value)) {
      throw new Error("invalid remote MCP header value");
    }
    out[name] = value;
  }
  return Object.freeze(out);
}

/**
 * Register the relayed servers of one capability. `servers` is `{ [name]: { url, headers } }`.
 * Throws (terse, value-free) on anything malformed; replaces an earlier registration of the same jti.
 */
export function registerRemoteMcps({ jti, exp, servers, now = Date.now() } = {}) {
  if (typeof jti !== "string" || !jti) throw new Error("remote MCP registration needs a capability id");
  if (!Number.isFinite(exp) || exp <= now) throw new Error("remote MCP registration needs a live expiry");
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) throw new Error("remote MCP servers must be an object");
  const names = Object.keys(servers);
  if (names.length > MAX_SERVERS) throw new Error(`at most ${MAX_SERVERS} remote MCP servers per run`);
  const map = new Map();
  for (const name of names) {
    if (!validRemoteMcpName(name)) throw new Error("invalid remote MCP server name");
    const server = servers[name];
    if (!server || !validUrl(server.url)) throw new Error("remote MCP servers must be https URLs");
    map.set(name, Object.freeze({ url: server.url, headers: copyHeaders(server.headers || {}) }));
  }
  sweep(now);
  registrations.set(jti, { exp, servers: map });
  ensureSweeper();
  return names;
}

/** `{ url, headers }` for one server of one live registration, or null. Never the stored object. */
export function lookupRemoteMcp(jti, name, now = Date.now()) {
  sweep(now);
  const entry = typeof jti === "string" ? registrations.get(jti) : null;
  const server = entry?.servers.get(String(name || ""));
  return server ? { url: server.url, headers: { ...server.headers } } : null;
}

export function clearRemoteMcps(jti) {
  registrations.delete(jti);
  if (!registrations.size) sweep();
}

/** Counts only — for tests and diagnostics; never a name, a URL or a header. */
export function remoteMcpRegistryStats(now = Date.now()) {
  sweep(now);
  let servers = 0;
  for (const entry of registrations.values()) servers += entry.servers.size;
  return { registrations: registrations.size, servers, sweeping: Boolean(sweeper) };
}
