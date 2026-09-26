// The daemon-side half of the `remote-mcp` socket relay (src/mcp/socket-server.js): which
// header-bearing remote MCP servers (Composio user/agent, the toolboxes) one run capability may
// reach, and the REAL url + headers the daemon dials them with. In memory only, in the daemon
// process that mints the capability (src/gateway/mcp.js) and serves the socket — so the credential
// never has to be written anywhere a container can read: the container holds only the signed
// capability, and the capability names only server NAMES (its `remoteMcps` claim).
//
// Keyed by the capability's `jti`. An entry never outlives the capability it was registered for
// (its `exp`): expired entries are swept on every lookup and on an unref'd timer, and nothing here
// keeps the daemon alive. It usually goes much sooner, through HOLDS: registering takes one hold
// for the minting caller (a turn, an SSH session), every open relay connection takes one more, and
// the entry is dropped when the last hold is released. So a cold run's grant goes when the run
// settles and its engine's bridges have hung up; a warm Claude process keeps its grant exactly as
// long as its bridge connections stay open (its retirement closes them); a later turn that merely
// REUSES that warm process registers its own jti, which nothing ever connects with, and drops it at
// its end. `clearRemoteMcpsWhere` removes entries outright, holds or not — for a revoked personal
// token or a finished SSH session — and every forwarded request re-checks the registry, so an open
// relay stops working at its next request. A registration is never renewed: a later run (or a
// refreshed SSH session) mints a fresh jti and registers again.
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

// jti → { exp, servers: Map<name, { url, headers }>, meta: { channelId, slug, authorId, origin }, holds }
const registrations = new Map();
let sweeper = null;
let lastSweep = 0;
const LOOKUP_SWEEP_MIN_INTERVAL_MS = 1000;

function drop(jti) {
  registrations.delete(jti);
  if (!registrations.size && sweeper) {
    clearInterval(sweeper);
    sweeper = null;
  }
}

function sweep(now = Date.now()) {
  lastSweep = now;
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

/** Whether the relay would accept this URL at all (https, no embedded credentials, bounded). */
export function isRelayableUrl(value) {
  if (typeof value !== "string" || !value || value.length > MAX_URL_LENGTH) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

/**
 * Why ONE server cannot be relayed, as a value-free sentence, or "" when it can. The minting
 * caller (src/gateway/mcp.js) checks every server with this first and drops — and announces —
 * only the bad one, so one malformed header never fails a whole container turn.
 */
export function remoteMcpServerProblem(server) {
  if (!server || !isRelayableUrl(server.url)) return "its URL is not https, so the gateway cannot relay it into a container";
  const headers = server.headers ?? {};
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return "its credential headers are malformed";
  const names = Object.keys(headers);
  if (names.length > MAX_HEADERS_PER_SERVER) return "it carries too many credential headers";
  for (const name of names) {
    const value = headers[name];
    if (!HEADER_NAME_RE.test(name)) return "a credential header name is invalid";
    if (typeof value !== "string" || Buffer.byteLength(value) > MAX_HEADER_VALUE_BYTES || /[\r\n\0]/.test(value)) {
      return "a credential header value is invalid (not text, over 8 KB, or containing a line break)";
    }
  }
  return "";
}

function cleanMeta(meta = {}) {
  const pick = (value) => (typeof value === "string" ? value : "");
  return Object.freeze({ channelId: pick(meta.channelId), slug: pick(meta.slug), authorId: pick(meta.authorId), origin: pick(meta.origin) });
}

/**
 * Register the relayed servers of one capability. `servers` is `{ [name]: { url, headers } }`;
 * `meta` names whose grant it is (`channelId`, `slug`, `authorId`, `origin` — never a value) so
 * `clearRemoteMcpsWhere` can find it. Takes ONE hold for the caller (release with
 * `releaseRemoteMcps`). Throws (terse, value-free) on anything malformed — callers pre-filter with
 * `remoteMcpServerProblem`; replaces an earlier registration of the same jti.
 */
export function registerRemoteMcps({ jti, exp, servers, meta = {}, now = Date.now() } = {}) {
  if (typeof jti !== "string" || !jti) throw new Error("remote MCP registration needs a capability id");
  if (!Number.isFinite(exp) || exp <= now) throw new Error("remote MCP registration needs a live expiry");
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) throw new Error("remote MCP servers must be an object");
  const names = Object.keys(servers);
  if (names.length > MAX_SERVERS) throw new Error(`at most ${MAX_SERVERS} remote MCP servers per run`);
  const map = new Map();
  for (const name of names) {
    if (!validRemoteMcpName(name)) throw new Error("invalid remote MCP server name");
    const server = servers[name];
    const problem = remoteMcpServerProblem(server);
    if (problem) throw new Error(`remote MCP server refused: ${problem}`);
    map.set(name, Object.freeze({ url: server.url, headers: Object.freeze({ ...(server.headers || {}) }) }));
  }
  sweep(now);
  registrations.set(jti, { exp, servers: map, meta: cleanMeta(meta), holds: 1 });
  ensureSweeper();
  return names;
}

/**
 * Take one more hold on a live registration (an open relay connection does). Returns an
 * idempotent release function; a no-op when there is nothing registered under `jti`.
 */
export function retainRemoteMcps(jti) {
  const entry = registrations.get(jti);
  if (!entry) return () => {};
  entry.holds += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (registrations.get(jti) !== entry) return; // already cleared or re-registered
    entry.holds -= 1;
    if (entry.holds <= 0) drop(jti);
  };
}

/** Release the registering caller's hold; the entry goes once no relay connection holds it either. */
export function releaseRemoteMcps(jti) {
  const entry = typeof jti === "string" ? registrations.get(jti) : null;
  if (!entry) return;
  entry.holds -= 1;
  if (entry.holds <= 0) drop(jti);
}

/** `{ url, headers }` for one server of one live registration, or null. Never the stored object. */
// Runs on every relayed request (the relay re-authorizes each one), so the full sweep is throttled;
// the entry being asked about is always checked against its own expiry.
export function lookupRemoteMcp(jti, name, now = Date.now()) {
  if (Math.abs(now - lastSweep) >= LOOKUP_SWEEP_MIN_INTERVAL_MS) sweep(now);
  const entry = typeof jti === "string" ? registrations.get(jti) : null;
  if (entry && entry.exp <= now) {
    drop(jti);
    return null;
  }
  const server = entry?.servers.get(typeof name === "string" ? name : "");
  return server ? { url: server.url, headers: { ...server.headers } } : null;
}

/**
 * The `remote-mcp` hello's authorization, re-run on every forwarded request: the capability must
 * verify, its signed `remoteMcps` claim must name the server, AND the daemon must hold a live
 * registration for that name under the capability's jti. Both, never either: the claim alone has
 * no credential behind it, and a registration alone was never granted to this bearer.
 * Returns `{ url, headers }`; throws one fixed sentence otherwise.
 */
export function authorizeRemoteMcp(checked, name, now = Date.now()) {
  const claims = checked?.ok ? checked.claims : null;
  const granted = claims && validRemoteMcpName(name) && Array.isArray(claims.remoteMcps) && claims.remoteMcps.includes(name);
  const server = granted ? lookupRemoteMcp(claims.jti, name, now) : null;
  if (!server) throw new Error("remote MCP is not authorized for this run");
  return server;
}

/** Drop one registration outright, holds or not. */
export function clearRemoteMcps(jti) {
  drop(jti);
}

/**
 * Drop every registration whose metadata matches — holds or not. `predicate(meta, jti)` sees only
 * `{ channelId, slug, authorId, origin }`. Returns how many were dropped.
 */
export function clearRemoteMcpsWhere(predicate) {
  let dropped = 0;
  for (const [jti, entry] of [...registrations]) {
    let match = false;
    try { match = Boolean(predicate(entry.meta, jti)); } catch { match = false; }
    if (match) {
      drop(jti);
      dropped += 1;
    }
  }
  return dropped;
}

/**
 * A person removed their personal Composio or Toolbox token: drop every relay grant minted for a
 * run THEY authored (any channel, any origin), so the removed token stops being usable at once
 * instead of for the rest of those capabilities' lives. Coarse on purpose — the registry does not
 * track which credential a server's header came from, and the next turn simply registers again
 * with whatever still resolves. Only effective in the daemon process (where every registration
 * lives); a host-run stdio gateway child has none to drop.
 */
export function revokeRemoteMcpsForAuthor(authorId) {
  if (typeof authorId !== "string" || !authorId) return 0;
  return clearRemoteMcpsWhere((meta) => meta.authorId === authorId);
}

/** Counts only — for tests and diagnostics; never a name, a URL or a header. */
export function remoteMcpRegistryStats(now = Date.now()) {
  sweep(now);
  let servers = 0;
  for (const entry of registrations.values()) servers += entry.servers.size;
  return { registrations: registrations.size, servers, sweeping: Boolean(sweeper) };
}

/** Whether a registration is live under `jti` (tests and diagnostics). */
export function hasRemoteMcps(jti, now = Date.now()) {
  const entry = registrations.get(jti);
  return Boolean(entry && entry.exp > now);
}
