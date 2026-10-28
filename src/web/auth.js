// Dashboard sessions are bound to individual local admin accounts. The existing shared
// password can authenticate bootstrap username `admin` only until the first passkey is enrolled.
// The durable passkey latch prevents restoring password-only bootstrap. The optional
// password-plus-Slack-code path is separately enabled and always verifies both factors.
// WebAuthn ceremonies live in admin-auth.js; every session use rechecks account authorization.
import crypto from "node:crypto";
import { getAdminPassword, getApiKey, getSettings, saveSettings } from "../config/settings.js";
import { adminAccount, adminAccountByUsername, ensureBootstrapAdmin, bootstrapAvailable, passkeysConfigured, adminLinkRequired } from "../config/admin-accounts.js";
export { passkeysConfigured } from "../config/admin-accounts.js";
import { clientKey, timingSafeEqualStr, createLoginLimiter, verifyPassword, hashPassword, isHashedPassword } from "./security.js";

// Sessions expire two ways: IDLE (untouched for this long) and ABSOLUTE (this old regardless of
// use). Previously the set only grew and a token stayed valid for the daemon's whole lifetime, so
// a cookie exfiltrated once — via a tunnel, a shared browser — never stopped working.
const IDLE_MS = 30 * 60 * 1000;
const ABSOLUTE_MS = 12 * 60 * 60 * 1000;

// token → { accountId, authVersion, bootstrap, authenticatedAt, createdAt, lastSeenAt }
const sessions = new Map();

function sessionValid(token, now = Date.now()) {
  const s = sessions.get(token);
  if (!s) return false;
  if (now - s.createdAt > ABSOLUTE_MS || now - s.lastSeenAt > IDLE_MS) {
    sessions.delete(token);
    return false;
  }
  const a = adminAccount(s.accountId);
  if (!a?.enabled || a.authVersion !== s.authVersion || (s.bootstrap && !bootstrapAvailable()) || (s.method === 'password-slack' && (getSettings().adminPasswordSlackEnabled !== true || s.passwordFingerprint !== adminPasswordFingerprint() || s.passwordSlackVersion !== (Number(getSettings().adminPasswordSlackVersion) || 0)))) {
    sessions.delete(token); return false;
  }
  s.lastSeenAt = now; // sliding idle window
  return true;
}

// Drop every session. Called when the admin password changes or is cleared: the old credential
// must not keep granting access through cookies minted under it.
export function invalidateAllSessions() {
  sessions.clear();
}

// Per-IP exponential backoff on failed logins (in-memory, like the session set): a few free
// attempts, then each retry must wait a doubling delay — turns online brute force into a crawl.
const loginLimiter = createLoginLimiter();

export function authEnabled() {
  return Boolean(getAdminPassword()) || passkeysConfigured();
}

export function parseCookies(header) {
  const out = {};
  for (const part of (header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// Verify, and opportunistically retire a legacy cleartext password. Only the settings.json copy
// is upgraded — an ADMIN_PASSWORD from the environment is owned by whoever wrote .env, so we
// verify against it but never rewrite config behind their back.
export async function passwordOk(pw) {
  const expected = getAdminPassword();
  if (!expected || !pw) return false;
  const ok = await verifyPassword(String(pw), expected);
  if (!ok) return false;

  if (!isHashedPassword(expected) && getSettings().adminPassword === expected) {
    try {
      saveSettings({ adminPassword: await hashPassword(String(pw)) });
    } catch {
      /* upgrade is best-effort — a failed rewrite must not fail the login */
    }
  }
  return true;
}

// Session cookie attributes. `Secure` is added when the request arrived over HTTPS — directly
// (req.secure) or via a TLS-terminating proxy (x-forwarded-proto, e.g. a Cloudflare tunnel) —
// so the cookie never travels in clear text there, while plain-HTTP loopback use keeps working.
export function cookieAttrs(req) {
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
  const secure = req.secure || proto === "https";
  // Setup-link landing pages do not authenticate on GET, so they need no session cookie on
  // the initial cross-site navigation. Their subsequent ceremony requests are same-origin.
  return `HttpOnly; SameSite=Strict; Path=/${secure ? "; Secure" : ""}`;
}

// Paths reachable without a session (so you can actually log in).
const OPEN_PATHS = new Set([
  "/login", "/login.html", "/api/login", "/api/health", "/api/skills/webhook/github", "/mcp/skills",
  // The signed-out page needs its script, icon and fonts before it can submit a password.
  // Keep these exact: other static assets and every privileged route retain their session gate.
  "/login.js", "/passkeys.js", "/favicon.svg",
  "/fonts/poppins-400-latin.woff2", "/fonts/poppins-600-latin.woff2", "/fonts/poppins-700-latin.woff2",
]);

// The HTTP run API accepts a bearer API key as an alternative to the admin session cookie, so an
// automation can fire runs without logging in. It is an admin credential for the RUNS it starts —
// they act as the admin API principal (config/api-principal.js) — but it is scoped to /api/runs
// only: it can't reach the settings/token/fs-browser routes. Bearer or X-API-Key.
const API_RUN_PREFIX = "/api/runs";
function bearerToken(req) {
  const h = String(req.headers.authorization || "");
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : "";
}
export function apiRunKeyOk(req) {
  const expected = getApiKey();
  if (!expected) return false;
  const got = String(req.headers["x-api-key"] || "") || bearerToken(req);
  return Boolean(got) && timingSafeEqualStr(got, expected);
}
// Express matches mount paths case-insensitively unless told otherwise (src/web/app.js turns
// case-sensitive routing on), so every path test here lowercases first: "/API/settings" must be
// treated exactly like "/api/settings" by the lockdown, the 401 branch and the run-API key gate,
// never slip past them into the router.
export function isApiPath(p) {
  return String(p || "").toLowerCase().startsWith("/api/");
}
function isApiRunPath(p) {
  const lower = String(p || "").toLowerCase();
  return lower === API_RUN_PREFIX || lower.startsWith(`${API_RUN_PREFIX}/`);
}

// CSRF: a state-changing request authenticated by the session COOKIE must carry a header only
// same-origin JavaScript can set. A cross-site form can't set headers at all, and a cross-site
// fetch that tries is stopped by the preflight (we send no CORS allow headers). SameSite=Strict
// already covers modern browsers; this is the belt to that suspenders, and it's what the
// file-editor routes already do with their own token.
//
// Reads are exempt (no state change), and so is the run API — that's machine-to-machine traffic
// authenticated by an API key, not a cookie, so it isn't a confused-deputy target.
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
export function csrfOk(req) {
  if (SAFE_METHODS.has(req.method)) return true;
  if (isApiRunPath(req.path)) return true;
  return String(req.headers["x-cg-request"] || "") === "1";
}

// Is this request from a logged-in admin? Used by routes that are reachable without a session but
// should only volunteer detail to one (see /api/health). A valid session cookie is the ONLY thing
// that answers yes: the old `!authEnabled() → true` shortcut meant a passwordless install handed
// its privileged /api/health view — absolute gateway path (→ the OS username), Slack workspace and
// bot names — to any unauthenticated caller, which is precisely the install that can least afford
// it. Nothing is authenticated when nothing can authenticate. (/api/health additionally accepts
// the same-machine internal secret for the self-updater; that is a separate, narrower check in
// web/app.js, not a session.)
export function isAuthenticated(req) {
  const s = adminSession(req);
  return Boolean(s && !adminLinkRequired(s.account));
}

export function authMiddleware(req, res, next) {
  // Nothing to check a session against — noPasswordLockdown ahead of this has already refused
  // every privileged route, so what falls through here is the static shell and the login page.
  if (!authEnabled()) return next();
  if (OPEN_PATHS.has(req.path)) return next();

  const s = adminSession(req);
  if (s) {
    if (isApiPath(req.path) && adminLinkRequired(s.account)) return res.status(403).json({ code: 'identity_link_required', error: 'Verify and link your existing administrator user before managing the gateway.' });
    if (!csrfOk(req)) return res.status(403).json({ error: "missing X-CG-Request header" });
    return next();
  }

  // A valid run-API key stands in for the session cookie on the /api/runs routes.
  if (isApiRunPath(req.path) && apiRunKeyOk(req)) return next();

  if (isApiPath(req.path)) return res.status(401).json({ error: "unauthorized" });
  return res.redirect("/login.html");
}

// No-password lockdown: an open admin API hands the caller the filesystem browser, the stored
// tokens, and the admin/workDir switches (→ RCE with the sandbox off). It used to be waived
// whenever the daemon was BOUND to loopback, which is the exact inverse of the threat: a loopback
// bind is the shape a reverse proxy, a Cloudflare tunnel and `ssh -L` all present, so the whole
// internet can arrive as 127.0.0.1 — and every other process and account on the host has that
// address natively too. Authentication is a property of the ROUTE, not of the interface a request
// happened to land on, so the bind exemption is gone: privileged /api routes (state-changing,
// token-revealing, and the fs browser) are refused with instructions on EVERY bind until an admin
// password exists.
//
// This costs new installs nothing — harden.js generates a password on first boot — so a
// passwordless gateway today is a legacy or half-configured one, and refusing is the safe reading.
// Non-secret liveness stays reachable (/api/health, which volunteers nothing to an unauthenticated
// caller) along with login/logout, and the static UI shell still loads so the operator sees why.
const LOCKDOWN_OPEN = new Set(["/api/health", "/api/login", "/api/logout", "/api/skills/webhook/github", "/mcp/skills"]);

export const NO_PASSWORD_ERROR =
  "Set an admin password first: privileged routes stay closed until one is configured — on every bind, " +
  "because a loopback address is also what a reverse proxy, a tunnel, and every other process on this " +
  "host present. Set ADMIN_PASSWORD in .env (or adminPassword in ~/.channelgate/config/settings.json) " +
  "and restart.";

export function noPasswordLockdown(req, res, next) {
  if (authEnabled()) return next();
  if (!isApiPath(req.path) || LOCKDOWN_OPEN.has(req.path.toLowerCase())) return next();
  // A configured run-API key IS a credential, so the run routes stay reachable without an admin
  // password — but only with a matching key.
  if (isApiRunPath(req.path) && apiRunKeyOk(req)) return next();
  return res.status(403).json({ error: NO_PASSWORD_ERROR });
}

// Which identity the login backoff counts against. Behind a reverse proxy or tunnel every request
// arrives from 127.0.0.1, so keying on the socket puts all remote clients in ONE bucket: an
// attacker's failures lock out the real admin, and distributed guessing looks like one client.
// The forwarding header of the proxy the operator DECLARED (`trustProxy`: cloudflare → the
// CF-Connecting-IP it overwrites, xff → the last X-Forwarded-For hop it appended) fixes that; an
// undeclared header is a client's claim and is ignored, and a global failure cap bounds guessing
// either way. One helper, shared with the approval-link router, so both limiters bucket callers
// the same way.
export function loginKey(req) {
  return clientKey(req);
}

// Authentication context is always revalidated against SQLite, including callers outside the
// middleware (/health and the passkey router). A disabled account loses access immediately.
export function adminSession(req) {
  const token = parseCookies(req.headers?.cookie).cg_session;
  if (!token || !sessionValid(token)) return null;
  const s = sessions.get(token);
  return { ...s, token, account: adminAccount(s.accountId) };
}
export function requireRecentAdminAuth(req) {
  const s = adminSession(req);
  return Boolean(s && !s.bootstrap && !adminLinkRequired(s.account) && Date.now() - s.authenticatedAt <= 5 * 60_000);
}
export function adminPasswordFingerprint() { return crypto.createHash('sha256').update(getAdminPassword() || '').digest('hex'); }
export function createAdminSession(req, res, a, { bootstrap = false, method = 'passkey' } = {}) {
  const current = adminAccount(a.id);
  if (!current?.enabled || current.authVersion !== a.authVersion) throw new Error('Account access changed. Start again.');
  const previous = parseCookies(req.headers?.cookie).cg_session;
  if (previous) sessions.delete(previous);
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  sessions.set(token, { createdAt: now, lastSeenAt: now, authenticatedAt: now, accountId: a.id, authVersion: a.authVersion, bootstrap, method, ...(method === 'password-slack' ? { passwordFingerprint: adminPasswordFingerprint(), passwordSlackVersion: Number(getSettings().adminPasswordSlackVersion) || 0 } : {}) });
  // Bound memory even if an authenticated client deliberately creates sessions repeatedly.
  while (sessions.size > 10_000) sessions.delete(sessions.keys().next().value);
  res.setHeader('Set-Cookie', `cg_session=${token}; ${cookieAttrs(req)}; Max-Age=${Math.floor(ABSOLUTE_MS / 1000)}`);
}
export function refreshAdminSession(req) {
  const s = adminSession(req);
  if (!s || s.bootstrap) throw new Error('Sign in again.');
  sessions.get(s.token).authenticatedAt = Date.now();
}
export async function handleLogin(req, res) {
  if (!authEnabled()) return res.status(403).json({ error: NO_PASSWORD_ERROR });
  const ip = loginKey(req);
  const wait = loginLimiter.retryAfterMs(ip);
  if (wait > 0) {
    const secs = Math.ceil(wait / 1000); res.setHeader('Retry-After', String(secs));
    return res.status(429).json({ error: `Too many attempts — try again in ${secs}s` });
  }
  ensureBootstrapAdmin();
  let a;
  try { a = adminAccountByUsername(req.body?.username ?? 'admin'); } catch { /* generic failure */ }
  if (!bootstrapAvailable() || a?.username !== 'admin' || !(await passwordOk(req.body?.password)) || !bootstrapAvailable()) {
    loginLimiter.recordFailure(ip);
    return res.status(401).json({ error: passkeysConfigured() ? 'Use your username and passkey to sign in.' : 'Wrong username or password' });
  }
  a = adminAccount(a.id); loginLimiter.recordSuccess(ip);
  createAdminSession(req, res, a, { bootstrap: true });
  res.json({ ok: true, bootstrap: true });
}

export function handleLogout(req, res) {
  const cookies = parseCookies(req.headers.cookie);
  if (cookies.cg_session) sessions.delete(cookies.cg_session);
  res.setHeader("Set-Cookie", `cg_session=; ${cookieAttrs(req)}; Max-Age=0`);
  res.json({ ok: true });
}
