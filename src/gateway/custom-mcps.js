// Custom MCP connections: a remote MCP server a channel manager (for the conversation) or a person
// (for themselves) adds by URL + Bearer token. Bearer only — servers that need an OAuth flow go
// through Composio. One home for the record shape, its validation, the masked listing every
// surface returns, and what a run receives.
//
// Stored as a list on the channel's meta (`meta.customMcps`) or the person's user record
// (`user.customMcps`): `{ name, url, token, setBy, setAt }`. The token is WRITE-ONLY, like a
// channel's environment secrets: every surface lists name + server name + URL + last4 + who/when,
// and there is no reveal path — replace it by entering a new one.
//
// The engine sees each server under a scope-prefixed name — `custom-<name>` for the channel's,
// `my-<name>` for the author's own — so the two scopes never collide with each other, with the
// built-in servers (gateway, composio-*, the toolboxes) or with a catalog selection, and the tool
// names themselves (`mcp__custom-linear__…`, `mcp__my-linear__…`) say whose connection it is.
//
// A run reaches them exactly like the other header-bearing remotes (src/gateway/mcp.js): in a
// container the DAEMON relays them, so the token never enters the container; `publicOnly` makes
// that relay re-check the destination against the SSRF policy on every dial and pin the connection
// to the vetted addresses (src/mcp/public-fetch.js) — the daemon sits outside the egress proxy, so
// without it a custom URL would be a way into the host's loopback, private network or cloud
// metadata. A save is refused up front for the same reason (assertPublicCustomMcpUrl).
import { resolvePublicHttpUrl } from "../web/security.js";

export const CUSTOM_MCP_LIMIT = 5;
export const CUSTOM_MCP_SCOPES = Object.freeze({ channel: "custom-", user: "my-" });
const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const MAX_URL_LENGTH = 2048;
const MIN_TOKEN_LENGTH = 8;
const MAX_TOKEN_BYTES = 8 * 1024 - "Bearer ".length;
// RFC 6750 b64token plus the characters real API keys use; never whitespace or a control byte,
// which is what would let a value break out of the Authorization header line.
const TOKEN_RE = /^[\x21-\x7e]+$/;

function prefixFor(scope) {
  const prefix = CUSTOM_MCP_SCOPES[scope];
  if (!prefix) throw new Error(`unknown custom MCP scope: ${scope}`);
  return prefix;
}

/** The lowercase stored name, or a throw naming the rule. */
export function normalizeCustomMcpName(value) {
  const name = String(value ?? "").trim().toLowerCase();
  if (!NAME_RE.test(name)) {
    throw new Error("Name must be 1-32 characters: lowercase letters, digits and dashes, starting and ending with a letter or digit");
  }
  return name;
}

/** The server name the engine sees: `custom-<name>` (channel) or `my-<name>` (personal). */
export function customMcpServerName(scope, name) {
  return `${prefixFor(scope)}${name}`;
}

/** The canonical https URL, or a throw. Syntax only — assertPublicCustomMcpUrl checks the address. */
export function normalizeCustomMcpUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw || raw.length > MAX_URL_LENGTH) throw new Error("URL must be an https:// address of at most 2048 characters");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("URL must be a valid https:// address");
  }
  if (url.protocol !== "https:") throw new Error("URL must use https://");
  if (url.username || url.password) throw new Error("URL must not contain a username or password — put the token in the token field");
  if (url.hash) throw new Error("URL must not contain a #fragment");
  return url.href;
}

/**
 * Refuse a URL whose host resolves to a loopback, private, link-local or metadata address. The
 * relay repeats this on every dial (DNS can change); this is the early, explainable refusal.
 * `lookup` is injectable for tests.
 */
export async function assertPublicCustomMcpUrl(value, { lookup } = {}) {
  const href = normalizeCustomMcpUrl(value);
  try {
    await resolvePublicHttpUrl(href, lookup ? { lookup } : {});
  } catch (error) {
    throw new Error(`URL refused: ${error.message}`);
  }
  return href;
}

/** The trimmed token, or a throw. A leading "Bearer " is accepted and dropped. */
export function normalizeCustomMcpToken(value) {
  const token = String(value ?? "").trim().replace(/^bearer\s+/i, "");
  if (token.length < MIN_TOKEN_LENGTH) throw new Error(`Token must be at least ${MIN_TOKEN_LENGTH} characters`);
  if (Buffer.byteLength(token) > MAX_TOKEN_BYTES) throw new Error("Token is too long (8 KB at most)");
  if (!TOKEN_RE.test(token)) throw new Error("Token must not contain spaces, line breaks or control characters");
  return token;
}

function cleanEntries(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const name = typeof entry.name === "string" ? entry.name : "";
    if (!NAME_RE.test(name) || seen.has(name)) continue;
    if (typeof entry.url !== "string" || typeof entry.token !== "string" || !entry.token) continue;
    seen.add(name);
    out.push(entry);
  }
  return out;
}

/**
 * Add, update or remove one entry; returns the NEW list (the input is not mutated). `set` upserts
 * by name: an update may omit `token` to keep the stored one, a new entry must carry it. The URL
 * must already have passed assertPublicCustomMcpUrl when it came from a caller.
 */
export function patchCustomMcps(list, { set = null, remove = null, actor = "", now = new Date() } = {}) {
  const current = cleanEntries(list);
  if (remove != null) {
    const name = normalizeCustomMcpName(remove);
    if (!current.some((entry) => entry.name === name)) throw new Error(`No custom MCP named "${name}"`);
    return current.filter((entry) => entry.name !== name);
  }
  if (!set) throw new Error("Nothing to change");
  const name = normalizeCustomMcpName(set.name);
  const url = normalizeCustomMcpUrl(set.url);
  const existing = current.find((entry) => entry.name === name);
  const suppliedToken = typeof set.token === "string" && set.token.trim() ? normalizeCustomMcpToken(set.token) : "";
  if (!existing && !suppliedToken) throw new Error("A Bearer token is required for a new custom MCP");
  if (!existing && current.length >= CUSTOM_MCP_LIMIT) throw new Error(`At most ${CUSTOM_MCP_LIMIT} custom MCP servers here — remove one first`);
  const entry = {
    name,
    url,
    token: suppliedToken || existing.token,
    setBy: String(actor || ""),
    setAt: (now instanceof Date ? now : new Date(now)).toISOString(),
  };
  return existing ? current.map((item) => (item.name === name ? entry : item)) : [...current, entry];
}

/** The masked shape — the ONLY form a custom MCP list may leave the process in. */
export function listCustomMcps(list, scope) {
  prefixFor(scope);
  return cleanEntries(list).map((entry) => ({
    name: entry.name,
    serverName: customMcpServerName(scope, entry.name),
    url: entry.url,
    hasToken: true,
    tokenLast4: entry.token.slice(-4),
    setBy: typeof entry.setBy === "string" ? entry.setBy : "",
    setAt: typeof entry.setAt === "string" ? entry.setAt : "",
  }));
}

/**
 * What ONE run receives: `{ [serverName]: { url, token } }`. Lean (clean) gets nothing; the
 * personal list only when the run's author is trusted (the HTTP run API names an author it never
 * authenticated, so it gets no personal scope — the same rule as composio-user). An entry whose URL
 * no longer parses is skipped rather than failing the turn.
 */
export function resolveCustomMcpsForRun({ channelList = [], userList = [], clean = false, principalTrusted = true } = {}) {
  if (clean) return {};
  const out = {};
  const add = (scope, list) => {
    for (const entry of cleanEntries(list)) {
      let url;
      try { url = normalizeCustomMcpUrl(entry.url); } catch { continue; }
      out[customMcpServerName(scope, entry.name)] = { url, token: entry.token };
    }
  };
  add("channel", channelList);
  if (principalTrusted) add("user", userList);
  return out;
}

/** The relay/remote shape mcp.js registers: Bearer header + the per-dial public-address check. */
export function customMcpRemotes(customMcps = {}) {
  const out = {};
  for (const [name, { url, token } = {}] of Object.entries(customMcps || {})) {
    if (!url || !token) continue;
    out[name] = { url, headers: { Authorization: `Bearer ${token}` }, publicOnly: true };
  }
  return out;
}

/** The tokens a run must redact from everything it posts. */
export function customMcpTokens(customMcps = {}) {
  return Object.values(customMcps || {}).map((entry) => entry?.token || "").filter(Boolean);
}

/**
 * Admit this run's custom MCP servers in a generated Claude lockdown (`buildSettings` output),
 * in place. A custom MCP is a stdio relay entry in a container (matched by name) and an http
 * entry on a sudo-host turn (matched by URL, because the allowlist already carries serverUrl
 * entries — see injectedRemoteAllowMatches); without the match, Claude Code drops the server
 * before connecting. Callers pass `url` for a host turn ONLY: the settings file sits in the
 * artifact dir a container can read, and a URL may carry a query-string key. Its tools are pre-approved like every other
 * gateway-injected remote — the person who added it chose the server. `servers` is
 * `[{ name, url }]` or the `{ [serverName]: { url } }` map a run resolves.
 */
export function admitCustomMcpsInSettings(settings, servers = []) {
  const list = Array.isArray(servers) ? servers : Object.entries(servers || {}).map(([name, entry]) => ({ name, url: entry?.url }));
  if (!list.length || !settings) return settings;
  settings.allowedMcpServers ||= [];
  settings.permissions ||= {};
  settings.permissions.allow ||= [];
  for (const server of list) {
    if (!server?.name) continue;
    settings.allowedMcpServers.push({ serverName: server.name });
    if (server.url) settings.allowedMcpServers.push({ serverUrl: server.url });
    settings.permissions.allow.push(`mcp__${server.name}`);
  }
  return settings;
}
