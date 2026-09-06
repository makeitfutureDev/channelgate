// Security helpers for the admin web layer: bind-address policy, allowlisted-root path
// containment, constant-time password compare, which client a per-IP limiter counts against,
// per-IP login backoff, and the MCP `match` shape-check. Kept as small standalone functions (unit-tested in test/web-security.test.js) —
// the Express wiring lives in auth.js / app.js / routes/admin.js.
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { realpathSync } from "node:fs";
import { isIP } from "node:net";
import { classifyAddress } from "./ip-policy.js";
export { classifyAddress } from "./ip-policy.js";
import { getSettings } from "../config/settings.js";

// ── Bind address ────────────────────────────────────────────────────────────────
// The address the admin web server listens on. Loopback by default — LAN exposure must be a
// deliberate act: settings.json `bindHost` (hand-edited) or CG_BIND_HOST in .env. Use "0.0.0.0"
// for that (a single external IP would break the gateway MCP server's 127.0.0.1 IPC calls).
export function getBindHost() {
  const s = getSettings();
  const v = (typeof s.bindHost === "string" && s.bindHost.trim()) || (process.env.CG_BIND_HOST || "").trim();
  return v || "127.0.0.1";
}

// True for loopback hostnames/addresses, including the IPv6 and IPv4-mapped-IPv6 forms that
// req.socket.remoteAddress reports ("::1", "::ffff:127.0.0.1").
export function isLoopbackHost(host) {
  const h = String(host || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1") return true;
  const v4 = h.startsWith("::ffff:") ? h.slice(7) : h;
  return /^127(\.\d{1,3}){3}$/.test(v4);
}

// ── Host / Origin allowlist (DNS-rebinding defence) ─────────────────────────────
// A browser enforces same-origin by HOSTNAME, not by address. An attacker page on evil.example
// whose DNS record flips to 127.0.0.1 becomes "same-origin" with the admin API and can read and
// post to it from the victim's browser — the loopback bind is no protection, and on a
// passwordless install there is no cookie to be missing. The fix is to check the Host header the
// browser sent: a rebound request still carries the attacker's hostname.
//
// Allowed: loopback names/addresses, the configured bind host, the host of a configured
// publicUrl (tunnels/reverse proxies), and anything in CG_ALLOWED_HOSTS (comma-separated).
function hostname(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  // Strip the port, keeping bracketed IPv6 intact.
  const m = /^(\[[^\]]+\]|[^:]+)(?::\d+)?$/.exec(raw);
  return m ? m[1].replace(/^\[|\]$/g, "") : raw;
}

// `publicUrl` is typed by a human into a settings field, and a scheme-less "gateway.example.com"
// is the obvious thing to type. `new URL()` rejects it, which used to mean the host silently
// granted nothing: every /api/* call 403s, and the Settings page that would fix it is behind the
// same guard. Only the hostname is ever used here, so recovering it from a bare authority is safe
// — it grants exactly the host the operator named, never a scheme or a path.
function publicHostname(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  for (const candidate of [raw, `https://${raw}`]) {
    try {
      const host = hostname(new URL(candidate).host);
      if (host) return host;
    } catch {
      /* try the next form */
    }
  }
  return ""; // genuinely unparseable — grant nothing rather than guess
}

export function allowedHosts() {
  const s = getSettings();
  const out = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);
  const bind = hostname(getBindHost());
  if (bind) out.add(bind);
  const pub = (typeof s.publicUrl === "string" && s.publicUrl.trim()) || (process.env.GATEWAY_PUBLIC_URL || "").trim();
  const pubHost = publicHostname(pub);
  if (pubHost) out.add(pubHost);
  for (const extra of String(process.env.CG_ALLOWED_HOSTS || "").split(",")) {
    const h = hostname(extra);
    if (h) out.add(h);
  }
  return out;
}

// Is this request's Host (and Origin, when the browser sent one) an address we recognise?
// A request with no Host header at all is not a browser request — curl/automation without Host
// can't be a rebinding victim, so it passes.
export function hostAllowed(req, allowed = allowedHosts()) {
  const host = hostname(req?.headers?.host);
  if (host && !allowed.has(host) && !isLoopbackHost(host)) return false;

  // Origin is set on every cross-origin fetch; if present it must agree too.
  const origin = String(req?.headers?.origin || "").trim();
  if (origin && origin !== "null") {
    let originHost = "";
    try {
      originHost = hostname(new URL(origin).host);
    } catch {
      return false; // unparseable Origin — refuse rather than guess
    }
    if (!allowed.has(originHost) && !isLoopbackHost(originHost)) return false;
  }
  return true;
}

// ── Outbound URL safety (SSRF) ──────────────────────────────────────────────────
// The run API fetches a caller-supplied `fileUrl` and POSTs results to a caller-supplied
// `webhook`. Both run from inside the host, so without a check they are a proxy into anything the
// daemon can reach: the gateway's own admin API on loopback, other local services, cloud metadata
// endpoints, and the private network. Scheme was the only validation.
//
// This blocks by resolved ADDRESS, not just hostname, so a public name pointing at 127.0.0.1 is
// caught too. Callers pin the connection to the checked records and validate each redirect.
// Resolve a URL, refuse it if it points anywhere internal, and hand back the exact records that
// passed the check. Callers that go on to CONNECT must connect to these addresses and nothing
// else — re-resolving at fetch time reopens the DNS-rebinding TOCTOU this check exists to close.
// `lookup` is injectable for tests.
export async function resolvePublicHttpUrl(value, { lookup } = {}) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new Error("not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("must be an http(s) URL");

  const host = url.hostname.replace(/^\[|\]$/g, "");
  // A literal address needs no DNS round-trip, and hostnames that are loopback by definition
  // never reach a resolver.
  const literal = isIP(host) ? classifyAddress(host) : "";
  if (literal) throw new Error(`refuses to reach a ${literal} address`);
  if (host === "localhost" || host.endsWith(".localhost")) throw new Error("refuses to reach a loopback address");

  const resolve = lookup ?? (await import("node:dns/promises")).lookup;
  let records;
  try {
    records = await resolve(host, { all: true });
  } catch {
    throw new Error(`could not resolve ${host}`);
  }
  if (!Array.isArray(records) || !records.length) throw new Error(`could not resolve ${host}`);
  for (const { address } of records) {
    const kind = classifyAddress(address);
    if (kind) throw new Error(`${host} resolves to a ${kind} address`);
  }
  return { url, addresses: records.map(({ address }) => ({ address, family: isIP(address) })) };
}

// Back-compat shape: validation only, URL out.
export async function assertPublicHttpUrl(value, opts = {}) {
  return (await resolvePublicHttpUrl(value, opts)).url;
}

// ── Admin password hashing ──────────────────────────────────────────────────────
// The admin password used to sit in settings.json in cleartext, so anyone who could read that
// file (or any endpoint that echoes it) had the credential itself rather than a verifier. Stored
// as scrypt now: "scrypt$<saltB64>$<hashB64>". Async so a login never blocks the event loop the
// Slack side is using.
const SCRYPT = { N: 16_384, r: 8, p: 1, keylen: 32 };
const SCRYPT_PREFIX = "scrypt$";

const scryptAsync = (pw, salt) =>
  new Promise((resolve, reject) => {
    crypto.scrypt(pw, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }, (err, key) => (err ? reject(err) : resolve(key)));
  });

export function isHashedPassword(stored) {
  return typeof stored === "string" && stored.startsWith(SCRYPT_PREFIX);
}

export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scryptAsync(String(pw), salt);
  return `${SCRYPT_PREFIX}${salt.toString("base64")}$${key.toString("base64")}`;
}

// Verify against either format. A stored value that isn't a scrypt string is a legacy cleartext
// password — still accepted (so an existing install keeps working) and compared in constant time;
// callers upgrade it to a hash on the next successful login.
export async function verifyPassword(pw, stored) {
  if (!pw || !stored) return false;
  if (!isHashedPassword(stored)) return timingSafeEqualStr(String(pw), String(stored));

  const [, saltB64, hashB64] = String(stored).split("$");
  if (!saltB64 || !hashB64) return false;
  try {
    const key = await scryptAsync(String(pw), Buffer.from(saltB64, "base64"));
    const expected = Buffer.from(hashB64, "base64");
    // Both are fixed-length scrypt outputs, so a length mismatch means a malformed record, not a
    // guess of the wrong length — no timing signal to protect there.
    return key.length === expected.length && crypto.timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

// ── Allowlisted filesystem root ─────────────────────────────────────────────────
// The one root the admin API may browse (`/api/fs/list`) and point a channel's workDir at.
// Defaults to the user's home dir; override with settings.json `fsRoot` or CG_FS_ROOT.
export function allowedFsRoot() {
  const s = getSettings();
  const configured = (typeof s.fsRoot === "string" && s.fsRoot.trim()) || (process.env.CG_FS_ROOT || "").trim();
  const root = configured || os.homedir();
  try {
    return realpathSync(root); // flatten symlinks so containment compares real paths
  } catch {
    return path.resolve(root);
  }
}

// Is `target` equal to or inside `root`? Pure prefix logic via path.relative — separator-aware,
// so "/home/user2" is NOT within "/home/user" while a dir literally named "..foo" IS. Both
// arguments should already be resolved/real paths (see resolveWithinRoot).
export function pathWithin(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  if (rel === "") return true;
  return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

// Resolve `candidate` (following symlinks) and verify it stays inside `root`. Returns the real
// path, or null when it escapes or does not exist — nonexistent paths are rejected so a dangling
// segment can't smuggle a later symlink past the check.
export function resolveWithinRoot(root, candidate) {
  let real;
  try {
    real = realpathSync(path.resolve(String(candidate)));
  } catch {
    return null;
  }
  return pathWithin(root, real) ? real : null;
}

// ── Constant-time compare ───────────────────────────────────────────────────────
// Compare via fixed-size SHA-256 digests: timingSafeEqual needs equal-length inputs, and a raw
// length pre-check would leak when a guess matches the secret's length. Digests never do.
export function timingSafeEqualStr(a, b) {
  const da = crypto.createHash("sha256").update(String(a)).digest();
  const db = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(da, db);
}

// ── Which client is a per-IP limiter counting? ──────────────────────────────────
// The daemon binds loopback and is reached from the internet through a tunnel or reverse proxy on
// this same host (cloudflared, nginx), so EVERY public caller arrives on a 127.0.0.1 socket and
// `req.ip` says so. Keying a backoff on that address puts the whole internet in ONE bucket: a
// handful of bad approval tokens from anywhere locks out every legitimate approval link, and one
// attacker's failed logins locks out the admin. That is not a per-IP limiter, it is a kill switch
// anybody can pull.
//
// The forwarding headers carry the real client, and they are trustworthy exactly when the socket
// itself is loopback: only the proxy in front and other processes on this host can open one, and
// both are already inside the trust boundary. From a NON-loopback socket the header is whatever
// the client typed, so it is ignored — unless the operator declares a trusted proxy elsewhere on
// the network with CG_TRUST_PROXY.
//
// `CF-Connecting-IP` is preferred over `X-Forwarded-For`: Cloudflare's edge OVERWRITES it with the
// connecting address, while the first XFF hop is client-supplied whenever the proxy appends rather
// than replaces (so a caller through the tunnel can rotate it to shed its own backoff — an evasion,
// never a way to attribute failures to someone else's bucket, since a spoofed value only ever
// lengthens that caller's own runway).
//
// Only a syntactically valid address is honoured; anything else falls back to the socket, which
// also caps what a header can put in the limiter's map.
//
// This is deliberately a helper rather than Express's app-wide `trust proxy`: it fixes the two
// call sites that key on an address (this file's login backoff via auth.js, and the approval-link
// router) without also re-pointing `req.secure` / `req.protocol` / `req.hostname` at
// client-supplied headers, and Express's setting knows nothing about `CF-Connecting-IP`.
const MAX_ADDRESS_LEN = 64;

function normalizeAddress(value) {
  const raw = String(value ?? "").trim();
  if (!raw || raw.length > MAX_ADDRESS_LEN) return "";
  let host = raw;
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(host); // [2001:db8::1]:443
  if (bracketed) host = bracketed[1];
  else if (/^[\d.]+:\d+$/.test(host)) host = host.slice(0, host.indexOf(":")); // 203.0.113.5:9000
  return isIP(host) ? host.toLowerCase() : "";
}

export function clientKey(req) {
  const socketIp = String(req?.socket?.remoteAddress || "");
  const fallback = socketIp || String(req?.ip || "") || "unknown";
  if (!isLoopbackHost(socketIp) && !process.env.CG_TRUST_PROXY) return fallback;
  const headers = req?.headers || {};
  const forwarded =
    normalizeAddress(headers["cf-connecting-ip"]) || normalizeAddress(String(headers["x-forwarded-for"] || "").split(",")[0]);
  return forwarded || fallback;
}

// ── Login backoff ───────────────────────────────────────────────────────────────
// Per-IP exponential backoff: the first `freeAttempts` failures are free, after that each next
// attempt must wait baseDelayMs·2ⁿ (capped at maxDelayMs) since the last failure. In-memory with
// a TTL sweep — state resets on restart, like the admin session set. `now` is injectable for tests.
// The caller decides what an "IP" is; both callers use clientKey() above, so the bucket is the real
// client rather than the loopback proxy hop every remote request shares.
export function createLoginLimiter({ freeAttempts = 3, baseDelayMs = 2_000, maxDelayMs = 300_000, ttlMs = 3_600_000 } = {}) {
  const perIp = new Map(); // ip → { fails, last }
  const prune = (now) => {
    for (const [ip, e] of perIp) if (now - e.last > ttlMs) perIp.delete(ip);
  };
  return {
    // Milliseconds this IP must still wait before its next attempt (0 = allowed now).
    retryAfterMs(ip, now = Date.now()) {
      prune(now);
      const e = perIp.get(ip);
      if (!e || e.fails < freeAttempts) return 0;
      const delay = Math.min(baseDelayMs * 2 ** (e.fails - freeAttempts), maxDelayMs);
      return Math.max(0, e.last + delay - now);
    },
    recordFailure(ip, now = Date.now()) {
      const e = perIp.get(ip) ?? { fails: 0, last: now };
      e.fails += 1;
      e.last = now;
      perIp.set(ip, e);
    },
    recordSuccess(ip) {
      perIp.delete(ip);
    },
  };
}

// ── MCP `match` shape-check ─────────────────────────────────────────────────────
// An allowedMcps entry's `match` goes straight into the lockdown's allowedMcpServers matcher
// (see src/gateway/mcp-catalog.js), so only the two shapes mcp-discovery emits may pass:
// { serverUrl: "http(s)://…" } (http transport) or { serverName: "…" } (stdio). Anything else
// → null (the caller drops the entry).
export function sanitizeMcpMatch(match) {
  if (!match || typeof match !== "object" || Array.isArray(match)) return null;
  if (typeof match.serverUrl === "string" && /^https?:\/\//.test(match.serverUrl.trim())) return { serverUrl: match.serverUrl.trim() };
  if (typeof match.serverName === "string" && match.serverName.trim()) return { serverName: match.serverName.trim() };
  return null;
}

// ── Codex runtime MCP selection shape-check ────────────────────────────────────
// Codex selections become dynamic `-c apps."…"` or `-c mcp_servers."…"` keys. Keep only the
// stable identity fields emitted by mcp-discovery; never persist runtime tool schemas/tool arrays
// or accept quoting/control characters in a config path.
const SAFE_CODEX_GROUP = /^[A-Za-z0-9_-]{1,120}$/;
const SAFE_CODEX_SERVER = /^[A-Za-z0-9][A-Za-z0-9_.:@/+ -]{0,159}$/;
const SAFE_CODEX_LABEL = /^[^\u0000-\u001f\u007f]{1,160}$/;

export function sanitizeCodexMcpSelection(selection) {
  if (!selection || typeof selection !== "object" || Array.isArray(selection)) return null;
  const id = typeof selection.id === "string" ? selection.id.trim() : "";
  const name = typeof selection.name === "string" ? selection.name.trim() : "";
  const kind = selection.kind;
  const serverName = typeof selection.serverName === "string" ? selection.serverName.trim() : "";
  if (!id || !SAFE_CODEX_LABEL.test(name)) return null;

  if (kind === "tool-group") {
    const toolPrefix = typeof selection.toolPrefix === "string" ? selection.toolPrefix.trim() : "";
    if (serverName !== "codex_apps" || id !== toolPrefix || !SAFE_CODEX_GROUP.test(id)) return null;
    return { id, name, kind, serverName, toolPrefix };
  }
  if (kind === "server") {
    if (id !== serverName || !SAFE_CODEX_SERVER.test(serverName)) return null;
    return { id, name, kind, serverName };
  }
  return null;
}
