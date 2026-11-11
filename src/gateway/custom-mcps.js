// Custom MCP connections: a remote MCP server a channel manager (for the conversation) or a person
// (for themselves) adds by URL with optional authentication presets, headers and query parameters.
// Servers that need an OAuth flow go
// through Composio. One home for the record shape, its validation, the masked listing every
// surface returns, and what a run receives.
//
// Stored as a list on the channel's meta (`meta.customMcps`) or the person's user record
// (`user.customMcps`): `{ name, url, token, authType, headers?, queryParams?, setBy, setAt }`. Values are WRITE-ONLY, like a
// channel's environment secrets: every surface lists name + server name + URL + last4 + who/when,
// and there is no reveal path — replace it by entering a new one.
//
// The engine sees each server under a scope-prefixed name — `custom-<name>` for the channel's,
// `my-<name>` for the author's own — so the two scopes never collide with each other, with the
// built-in servers (gateway, composio-*, the toolboxes) or with a catalog selection, and the tool
// names themselves (`mcp__custom-linear__…`, `mcp__my-linear__…`) say whose connection it is.
//
// A run reaches them exactly like the other header-bearing remotes (src/gateway/mcp.js): in a
// container or on the host the DAEMON relays them, so values never enter engine configuration; `publicOnly` makes
// that relay re-check the destination against the SSRF policy on every dial and pin the connection
// to the vetted addresses (src/mcp/public-fetch.js) — the daemon sits outside the egress proxy, so
// without it a custom URL would be a way into the host's loopback, private network or cloud
// metadata. A save is refused up front for the same reason (assertPublicCustomMcpUrl).
import { customMcpAuthentication, normalizeCustomMcpAuthType } from "./custom-mcp-auth.js";
export { normalizeCustomMcpAuthType } from "./custom-mcp-auth.js";
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

/** Trim the credential; accept a pasted Bearer prefix only for Bearer authentication. */
export function normalizeCustomMcpToken(value, authType) {
  const { prefix } = customMcpAuthentication(authType);
  const trimmed = String(value ?? "").trim();
  const token = prefix ? trimmed.replace(/^bearer\s+/i, "") : trimmed;
  if (token.length < MIN_TOKEN_LENGTH) throw new Error(`Token must be at least ${MIN_TOKEN_LENGTH} characters`);
  if (Buffer.byteLength(token) > MAX_TOKEN_BYTES) throw new Error("Token is too long (8 KB at most)");
  if (!TOKEN_RE.test(token)) throw new Error("Token must not contain spaces, line breaks or control characters");
  return token;
}

const MAX_FIELDS = 16;
const FIELD_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const CONTROL_RE = /[\x00-\x1f\x7f-\x9f]/u;
const RESERVED_HEADERS = new Set(["host", "content-length", "connection", "transfer-encoding", "te", "trailer", "upgrade", "expect", "accept", "content-type", "mcp-session-id", "mcp-protocol-version", "last-event-id"]);

/** Validate and merge write-only fields. An explicit list replaces the rows; blank values retain by name. */
function mergeFields(input, saved, kind, authType) {
  if (input === undefined && saved === undefined) return undefined;
  const rows = input === undefined ? saved : input;
  if (!Array.isArray(rows) || rows.length > MAX_FIELDS) throw new Error(`${kind} must be an array of at most 16 entries`);
  const seen = new Set();
  const preset = customMcpAuthentication(authType).headerName?.toLowerCase();
  if (kind === "Headers" && preset && rows.length >= MAX_FIELDS) throw new Error("At most 16 headers including authentication are allowed");
  return rows.map((row) => {
    if (!row || typeof row !== "object" || typeof row.name !== "string") throw new Error(`${kind} entries require a name`);
    const name = row.name;
    if (!name || name.length > 128) throw new Error(`${kind} names must contain 1-128 characters`);
    const key = kind === "Headers" ? name.toLowerCase() : name;
    if (kind === "Headers") {
      if (!FIELD_NAME_RE.test(name)) throw new Error("Header names must be valid HTTP tokens");
      if (RESERVED_HEADERS.has(key) || key.startsWith("proxy-")) throw new Error("Header name is reserved for the HTTP or MCP transport");
      if (key === preset) throw new Error("Header duplicates the selected authentication header");
    } else if (!name.isWellFormed() || CONTROL_RE.test(name) || /[&=#]/u.test(name)) throw new Error("Query parameter names must not contain controls or &=#");
    if (seen.has(key)) throw new Error(`${kind} names must be unique`);
    seen.add(key);
    if (row.value !== undefined && typeof row.value !== "string") throw new Error(`${kind} values must be strings`);
    const previous = Array.isArray(saved) ? saved.find((item) => (kind === "Headers" ? item?.name?.toLowerCase() : item?.name) === key) : null;
    const value = row.value === undefined || row.value === "" ? previous?.value : row.value;
    if (typeof value !== "string" || !value) throw new Error(`${kind} values are required for new entries`);
    if (Buffer.byteLength(value) > 8192) throw new Error(`${kind} values must be at most 8 KB`);
    if (CONTROL_RE.test(value) || (kind === "Headers" && /[^\x20-\x7e\xa0-\xff]/u.test(value))) throw new Error(`${kind} values must not contain controls or unsupported characters`);
    // URLSearchParams replaces unpaired surrogates; reject these so the saved and sent secrets match.
    if (kind !== "Headers" && !value.isWellFormed()) throw new Error("Query parameter values must be well-formed Unicode");
    return { name, value };
  });
}

function materializeUrl(url, queryParams) {
  const effective = new URL(url);
  for (const { name, value } of queryParams || []) {
    if (effective.searchParams.has(name)) throw new Error("Query parameter duplicates a parameter in the URL");
    effective.searchParams.append(name, value);
  }
  if (effective.href.length > MAX_URL_LENGTH) throw new Error("URL including query parameters must be at most 2048 characters");
  return effective.href;
}

function cleanEntries(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const name = typeof entry.name === "string" ? entry.name : "";
    if (!NAME_RE.test(name) || seen.has(name)) continue;
    try {
      const authType = normalizeCustomMcpAuthType(entry.authType);
      const url = normalizeCustomMcpUrl(entry.url);
      if (authType !== "custom") normalizeCustomMcpToken(entry.token, authType);
      else if (entry.token) throw new Error("Custom authentication uses named headers or query parameters");
      mergeFields(entry.headers, undefined, "Headers", authType);
      const queryParams = mergeFields(entry.queryParams, undefined, "Query parameters", authType);
      materializeUrl(url, queryParams);
    } catch { continue; }
    seen.add(name);
    out.push(entry);
  }
  return out;
}

/**
 * Add, update or remove one entry; returns the NEW list (the input is not mutated). `set` upserts
 * by name: an update may omit `token` to keep the stored one; preset authentication requires it. The URL
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
  const authType = normalizeCustomMcpAuthType(set.authType === undefined ? existing?.authType : set.authType);
  const suppliedToken = authType === "custom" ? "" : typeof set.token === "string" && set.token.trim() ? normalizeCustomMcpToken(set.token, authType) : "";
  if (authType !== "custom" && !existing && !suppliedToken) throw new Error("A token is required for a new custom MCP");
  if (!existing && current.length >= CUSTOM_MCP_LIMIT) throw new Error(`At most ${CUSTOM_MCP_LIMIT} custom MCP servers here — remove one first`);
  const entry = {
    name,
    url,
    token: authType === "custom" ? "" : suppliedToken || normalizeCustomMcpToken(existing?.token, authType),
    authType,
    setBy: String(actor || ""),
    setAt: (now instanceof Date ? now : new Date(now)).toISOString(),
  };
  for (const [field, label] of [["headers", "Headers"], ["queryParams", "Query parameters"]]) {
    const rows = mergeFields(set[field], existing?.[field], label, authType);
    if (rows !== undefined) entry[field] = rows;
  }
  materializeUrl(url, entry.queryParams);
  return existing ? current.map((item) => (item.name === name ? entry : item)) : [...current, entry];
}

function maskedFields(entry) {
  return Object.fromEntries(["headers", "queryParams"].filter((field) => entry[field] !== undefined).map((field) => [field,
    entry[field].map(({ name, value }) => ({ name, hasValue: true, valueLast4: value.length > 4 ? value.slice(-4) : "" })),
  ]));
}

/** The masked shape — the ONLY form a custom MCP list may leave the process in. */
export function listCustomMcps(list, scope) {
  prefixFor(scope);
  return cleanEntries(list).map((entry) => ({
    name: entry.name,
    serverName: customMcpServerName(scope, entry.name),
    url: entry.url,
    authType: normalizeCustomMcpAuthType(entry.authType),
    hasToken: Boolean(entry.token),
    tokenLast4: entry.token?.length > 4 ? entry.token.slice(-4) : "",
    ...maskedFields(entry),
    setBy: typeof entry.setBy === "string" ? entry.setBy : "",
    setAt: typeof entry.setAt === "string" ? entry.setAt : "",
  }));
}

/**
 * What ONE run receives: `{ [serverName]: { url, token, authType } }`. Lean (clean) gets nothing; the
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
      out[customMcpServerName(scope, entry.name)] = { url, token: entry.token, authType: normalizeCustomMcpAuthType(entry.authType),
        ...(entry.headers !== undefined ? { headers: entry.headers.map((row) => ({ ...row })) } : {}),
        ...(entry.queryParams !== undefined ? { queryParams: entry.queryParams.map((row) => ({ ...row })) } : {}),
      };
    }
  };
  add("channel", channelList);
  if (principalTrusted) add("user", userList);
  return out;
}

/** The relay/remote shape mcp.js registers: selected authentication header + the per-dial public-address check. */
export function customMcpRemotes(customMcps = {}) {
  const out = {};
  for (const [name, entry] of Object.entries(customMcps || {})) {
    if (!entry?.url) continue;
    // Apply the same fail-closed validation to direct callers as stored records.
    if (!cleanEntries([{ ...entry, name: "remote" }]).length) continue;
    const { headerName, prefix } = customMcpAuthentication(entry.authType);
    const headers = Object.fromEntries((entry.headers || []).map(({ name: key, value }) => [key, value]));
    if (headerName) headers[headerName] = `${prefix}${entry.token}`;
    out[name] = { url: materializeUrl(entry.url, entry.queryParams), headers, publicOnly: true };
  }
  return out;
}

/** The tokens a run must redact from everything it posts. */
export function customMcpTokens(customMcps = {}) {
  const values = [];
  for (const entry of Object.values(customMcps || {})) {
    if (entry?.token) values.push(entry.token);
    for (const { value } of [...(entry?.headers || []), ...(entry?.queryParams || [])]) {
      if (value) values.push(value);
    }
    // Legacy URLs can already contain query credentials, which need the same protection.
    try { for (const value of new URL(entry?.url).searchParams.values()) if (value) values.push(value); } catch { /* invalid entries are ignored */ }
  }
  return [...new Set(values.flatMap((value) => [value, encodeURIComponent(value), new URLSearchParams({ v: value }).toString().slice(2)]))];
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
