// Grant matching and the placeholder → real-value swap on an outbound request.
//
// Why: the swap is the one place a real credential re-enters traffic, so it must happen only where
// the secret's owner declared it may go — the right host, the right header, the right position
// inside that header — and only while `canUse` (owner liveness, rotation, revocation) says yes.
// Everything else leaves the placeholder exactly as the container sent it: a placeholder reaching
// the wrong host is harmless, a real value reaching it is the leak this system exists to prevent.
//
// A grant: { placeholder (the CORE `cgph_…`), value, secretName, scope, owner,
//            hosts: ["api.github.com", "*.vercel.app"], headers: ["authorization", …] (lowercase),
//            format: "bearer" | "raw" | "basic-password" | "basic-user" (or an array of them),
//            query: ["token"]?, body: boolean (reserved, not swapped here), plainHttp: boolean? }
// Formats: `bearer` = the header is `<scheme> <token>`; `raw` = the header value IS the token;
// `basic-password` / `basic-user` = `Authorization: Basic base64(user:password)` with the token as
// exactly that half; `jwt` = the token (bearer or the whole value) is a JWT-SHAPED placeholder
// (`<header>.<payload>.cgph_…`, placeholders.js) and the WHOLE three-segment token is replaced by the
// real one — only a grant that lists `jwt` accepts it, and a jwt-only grant refuses a bare
// placeholder. A grant without `format` accepts bearer and raw; one without `headers` accepts
// DEFAULT_SWAP_HEADERS.
//
// Invariants: never throws on a malformed header, never mutates its input, and never swaps part
// of a header — if any placeholder in one header value is refused, that whole value is left as is.
// Results name secrets and reasons only; the `scrub` map (value → token) is for the response
// scrubber and must never reach an audit event or a log.
import { JWT_PLACEHOLDER_RE, PLACEHOLDER_PREFIX, PLACEHOLDER_RE } from "./placeholders.js";

export const DEFAULT_SWAP_HEADERS = Object.freeze([
  "authorization", "x-api-key", "apikey", "x-consumer-api-key", "x-auth-token", "private-token", "x-vercel-token",
]);

const DEFAULT_FORMATS = Object.freeze(["bearer", "raw"]);
// Node's own rule for a header value it will send (see _http_common.js checkInvalidHeaderChar).
const INVALID_HEADER_CHAR = /[^\t\x20-\x7e\x80-\xff]/;
const BASIC_RE = /^(Basic)(\s+)([A-Za-z0-9+/]+={0,2})(\s*)$/i;
const BEARER_RE = /^([A-Za-z][A-Za-z0-9._~+/-]*)( +)(\S+)( *)$/;

// Lowercase, no IPv6 brackets, no trailing root dot.
export function normalizeHost(host) {
  return String(host ?? "").trim().toLowerCase().replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "");
}

// Exact match, or a one-level wildcard: "*.example.com" matches "a.example.com" but neither
// "example.com" nor "a.b.example.com".
export function hostMatches(pattern, hostname) {
  const p = normalizeHost(pattern);
  const h = normalizeHost(hostname);
  if (!p || !h) return false;
  if (!p.startsWith("*.")) return p === h;
  const suffix = p.slice(1);
  if (!h.endsWith(suffix)) return false;
  const label = h.slice(0, -suffix.length);
  return label.length > 0 && !label.includes(".");
}

export function grantAllowsHost(grant, hostname) {
  return Array.isArray(grant?.hosts) && grant.hosts.some((pattern) => hostMatches(pattern, hostname));
}

function grantFormats(grant) {
  const raw = grant?.format;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : DEFAULT_FORMATS;
  return new Set(list.map((f) => String(f).toLowerCase()));
}

function grantHeaders(grant) {
  const list = Array.isArray(grant?.headers) && grant.headers.length ? grant.headers : DEFAULT_SWAP_HEADERS;
  return new Set(list.map((h) => String(h).toLowerCase()));
}

// The host half of a Host header ("example.com:8443" → "example.com", "[::1]:443" → "::1").
export function hostHeaderName(value) {
  const text = String(value ?? "").trim();
  if (text.startsWith("[")) return normalizeHost(text.slice(0, text.indexOf("]") + 1));
  const colons = text.split(":").length - 1;
  return normalizeHost(colons === 1 ? text.slice(0, text.lastIndexOf(":")) : text);
}

// One request's swap state: grant lookups and canUse verdicts are memoized per placeholder so a
// token repeated across headers is decided once, and swapped/refused are reported once per secret.
function createSwapSession({ hostname, resolveGrant, canUse, plainHttp, hostHeader }) {
  const host = normalizeHost(hostname);
  // A MISSING Host header is a mismatch too: nothing then ties the request to the host the
  // connection is pinned to (an absolute-form request line inside a tunnel carries its own host),
  // so no placeholder is swapped into it. HTTP/1.1 clients always send one.
  const mismatch = hostHeader === undefined || hostHeader === null || hostHeaderName(hostHeader) !== host;
  const grants = new Map();
  const verdicts = new Map();
  const swapped = new Map();
  const refused = new Map();
  const scrub = new Map();

  function grantFor(core) {
    if (!grants.has(core)) {
      let grant = null;
      try { grant = resolveGrant(core) || null; } catch { grant = null; }
      grants.set(core, grant);
    }
    return grants.get(core);
  }

  function allowed(grant) {
    if (!verdicts.has(grant)) {
      let verdict;
      try { verdict = canUse ? canUse(grant) : { ok: true }; } catch { verdict = { ok: false, reason: "denied" }; }
      verdicts.set(grant, verdict && verdict.ok === true ? { ok: true } : { ok: false, reason: String(verdict?.reason || "denied") });
    }
    return verdicts.get(grant);
  }

  // → { grant } or { refusal: { secretName, reason, denied? } } for a core placeholder seen at
  // `where` = { kind: "header", name, position } | { kind: "query", name }.
  function decide(core, where) {
    const grant = grantFor(core);
    if (!grant || typeof grant.value !== "string" || !grant.value) return { refusal: { secretName: null, reason: "unknown-placeholder" } };
    const secretName = grant.secretName ?? null;
    const refuse = (reason, extra = {}) => ({ refusal: { secretName, reason, ...extra } });
    if (plainHttp && grant.plainHttp !== true) return refuse("plain-http");
    if (mismatch) return refuse("host-header-mismatch");
    if (!grantAllowsHost(grant, host)) return refuse("host");
    if (where.kind === "query") {
      if (!Array.isArray(grant.query) || !grant.query.includes(where.name)) return refuse("query");
      if (where.position === "embedded") return refuse("format");
    } else {
      if (!grantHeaders(grant).has(where.name)) return refuse("header");
      if (where.position === "embedded" || !grantFormats(grant).has(where.position)) return refuse("format");
      if (where.position !== "basic-user" && where.position !== "basic-password" && INVALID_HEADER_CHAR.test(grant.value)) return refuse("invalid-value");
      if (where.position === "basic-user" && grant.value.includes(":")) return refuse("invalid-value");
    }
    const verdict = allowed(grant);
    if (!verdict.ok) return refuse(verdict.reason, { denied: true });
    return { grant };
  }

  // Record one header's (or query pair's) outcome. `applied` false means the value was kept as is
  // because a sibling token was refused: its granted tokens are reported refused ("partial").
  function record(results, applied = true) {
    for (const r of results) {
      if (!r.refusal && !applied) {
        const key = `${r.grant.secretName ?? null}\0partial`;
        if (!refused.has(key)) refused.set(key, { secretName: r.grant.secretName ?? null, reason: "partial" });
      } else if (r.refusal) {
        const key = `${r.refusal.secretName}\0${r.refusal.reason}`;
        if (!refused.has(key)) refused.set(key, r.refusal);
      } else {
        const { grant, token } = r;
        if (!swapped.has(grant)) swapped.set(grant, { secretName: grant.secretName ?? null, scope: grant.scope ?? null, owner: grant.owner ?? null });
        scrub.set(grant.value, token);
      }
    }
  }

  function result() {
    return { swapped: [...swapped.values()], refused: [...refused.values()], scrub };
  }

  return { decide, record, result };
}

// Every placeholder token in `text` with its position. `matchAll` over a /g regex never throws.
function tokensIn(text) {
  if (typeof text !== "string" || !text.includes(PLACEHOLDER_PREFIX)) return [];
  return Array.from(text.matchAll(PLACEHOLDER_RE), (m) => ({ token: m[0], core: m[1] }));
}

// Swap inside one `Basic` credential. Returns the new header value, or null to leave it untouched.
function swapBasic(name, value, session) {
  const m = BASIC_RE.exec(value);
  if (!m) return null;
  const decoded = Buffer.from(m[3], "base64");
  // A value that does not round-trip is not base64 we understand: leave it alone.
  if (decoded.toString("base64").replace(/=+$/, "") !== m[3].replace(/=+$/, "")) return null;
  const text = decoded.toString("utf8");
  const colon = text.indexOf(":");
  if (colon < 0 || Buffer.from(text, "utf8").compare(decoded) !== 0) return null;
  const parts = { "basic-user": text.slice(0, colon), "basic-password": text.slice(colon + 1) };
  const results = [];
  const out = { ...parts };
  for (const [position, part] of Object.entries(parts)) {
    const tokens = tokensIn(part);
    if (!tokens.length) continue;
    if (tokens.length !== 1 || tokens[0].token !== part) {
      // Extra text around a token in one half: we do not guess where the secret goes.
      for (const t of tokens) results.push(session.decide(t.core, { kind: "header", name, position: "embedded" }));
      continue;
    }
    const verdict = session.decide(tokens[0].core, { kind: "header", name, position });
    results.push(verdict.grant ? { grant: verdict.grant, token: tokens[0].token } : verdict);
    if (verdict.grant) out[position] = verdict.grant.value;
  }
  return { results, value: `${m[1]}${m[2]}${Buffer.from(`${out["basic-user"]}:${out["basic-password"]}`, "utf8").toString("base64")}${m[4]}` };
}

// A JWT-shaped placeholder standing alone as `text`, whose core is `core` → the whole token, else "".
function jwtToken(text, core) {
  const m = JWT_PLACEHOLDER_RE.exec(String(text ?? ""));
  return m && m[1] === core ? m[0] : "";
}

// Swap in one plain header value (not Basic): `raw` = the whole value, `bearer` = `<scheme> <token>`,
// `jwt` = a JWT-shaped placeholder in either of those places, replaced whole.
function swapPlain(name, value, session) {
  const tokens = tokensIn(value);
  if (!tokens.length) return null;
  let position = "embedded";
  let prefix = "";
  let suffix = "";
  let whole = "";
  const bearer = BEARER_RE.exec(value);
  if (tokens.length === 1 && (whole = jwtToken(value.trim(), tokens[0].core))) {
    position = "jwt";
    prefix = value.slice(0, value.indexOf(whole));
    suffix = value.slice(prefix.length + whole.length);
  } else if (tokens.length === 1 && bearer && (whole = jwtToken(bearer[3], tokens[0].core))) {
    position = "jwt";
    prefix = `${bearer[1]}${bearer[2]}`;
    suffix = bearer[4];
  } else if (tokens.length === 1 && tokens[0].token === value.trim()) {
    position = "raw";
    prefix = value.slice(0, value.indexOf(tokens[0].token));
    suffix = value.slice(prefix.length + tokens[0].token.length);
  } else if (tokens.length === 1 && bearer && bearer[3] === tokens[0].token) {
    position = "bearer";
    prefix = `${bearer[1]}${bearer[2]}`;
    suffix = bearer[4];
  }
  if (position === "embedded") return { results: tokens.map((t) => session.decide(t.core, { kind: "header", name, position })), value };
  const verdict = session.decide(tokens[0].core, { kind: "header", name, position });
  if (!verdict.grant) return { results: [verdict], value };
  return { results: [{ grant: verdict.grant, token: whole || tokens[0].token }], value: `${prefix}${verdict.grant.value}${suffix}` };
}

function swapHeaderValue(name, value, session) {
  if (typeof value !== "string") return value;
  const attempt = (name === "authorization" && BASIC_RE.test(value) ? swapBasic : swapPlain)(name, value, session);
  if (!attempt) return value;
  // Never partially swap: one refusal anywhere in this value keeps the original bytes.
  const applied = attempt.results.every((r) => r.grant);
  session.record(attempt.results, applied);
  return applied ? attempt.value : value;
}

function swapHeadersIn(headers, session) {
  const out = {};
  for (const [rawName, value] of Object.entries(headers || {})) {
    const name = rawName.toLowerCase();
    out[rawName] = Array.isArray(value) ? value.map((v) => swapHeaderValue(name, v, session)) : swapHeaderValue(name, value, session);
  }
  return out;
}

// Headers: Node's lowercase-keyed request header object. `hostname` is the destination the TLS
// connection is actually pinned to; a Host header naming a different host refuses every swap.
// → { headers, swapped: [{secretName, scope, owner}], refused: [{secretName, reason}], scrub }
export function swapHeaders({ headers, hostname, resolveGrant, canUse, plainHttp = false }) {
  const session = createSwapSession({ hostname, resolveGrant, canUse, plainHttp, hostHeader: headers?.host });
  const swappedHeaders = swapHeadersIn(headers, session);
  return { headers: swappedHeaders, ...session.result() };
}

function swapQueryIn(path, session) {
  const text = String(path ?? "");
  const q = text.indexOf("?");
  if (q < 0 || !text.includes(PLACEHOLDER_PREFIX, q)) return text;
  const hash = text.indexOf("#", q);
  const query = text.slice(q + 1, hash < 0 ? undefined : hash);
  const pairs = query.split("&").map((pair) => {
    const eq = pair.indexOf("=");
    if (eq < 0) return pair;
    let name;
    let value;
    try {
      name = decodeURIComponent(pair.slice(0, eq).replace(/\+/g, " "));
      value = decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, " "));
    } catch {
      return pair; // malformed escape: leave the pair untouched
    }
    const tokens = tokensIn(value);
    if (!tokens.length) return pair;
    if (tokens.length !== 1 || tokens[0].token !== value) {
      session.record(tokens.map((t) => session.decide(t.core, { kind: "query", name, position: "embedded" })));
      return pair;
    }
    const verdict = session.decide(tokens[0].core, { kind: "query", name });
    session.record([verdict.grant ? { grant: verdict.grant, token: tokens[0].token } : verdict]);
    return verdict.grant ? `${pair.slice(0, eq)}=${encodeURIComponent(verdict.grant.value)}` : pair;
  });
  return `${text.slice(0, q + 1)}${pairs.join("&")}${hash < 0 ? "" : text.slice(hash)}`;
}

// The whole request (headers + the query parameters a grant lists), decided in one session.
// → { headers, path, swapped, refused, scrub }
export function swapRequest({ headers, path, hostname, resolveGrant, canUse, plainHttp = false }) {
  const session = createSwapSession({ hostname, resolveGrant, canUse, plainHttp, hostHeader: headers?.host });
  const swappedHeaders = swapHeadersIn(headers, session);
  const swappedPath = swapQueryIn(path, session);
  return { headers: swappedHeaders, path: swappedPath, ...session.result() };
}

// Every core placeholder a request carries in its headers or query (for pre-resolving grants).
export function placeholdersInRequest({ headers, path }) {
  const found = new Set();
  const add = (text) => { for (const t of tokensIn(text)) found.add(t.core); };
  for (const value of Object.values(headers || {})) {
    for (const v of Array.isArray(value) ? value : [value]) {
      if (typeof v !== "string") continue;
      add(v);
      const basic = BASIC_RE.exec(v);
      if (basic) add(Buffer.from(basic[3], "base64").toString("utf8"));
    }
  }
  const text = String(path ?? "");
  const q = text.indexOf("?");
  if (q >= 0) {
    let query = text.slice(q + 1);
    try { query = decodeURIComponent(query.replace(/\+/g, " ")); } catch { /* scan the raw form */ }
    add(query);
  }
  return [...found];
}
