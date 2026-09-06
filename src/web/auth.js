// Password gate for the admin UI + API. On correct password we set an httpOnly session cookie
// backed by an in-memory token set (cleared on restart → re-login). No external deps — cookies are
// parsed by hand.
//
// Two middlewares, in this order (see web/app.js): noPasswordLockdown refuses the privileged API
// when NO password is configured at all, on every bind; authMiddleware then requires a session (or
// the run-API key on /api/runs) once one is. There is no "open" posture left — see the lockdown
// comment below for why a loopback bind never bought one.
import crypto from "node:crypto";
import { getAdminPassword, getApiKey, getSettings, saveSettings } from "../config/settings.js";
import { clientKey, timingSafeEqualStr, createLoginLimiter, verifyPassword, hashPassword, isHashedPassword } from "./security.js";

// Sessions expire two ways: IDLE (untouched for this long) and ABSOLUTE (this old regardless of
// use). Previously the set only grew and a token stayed valid for the daemon's whole lifetime, so
// a cookie exfiltrated once — via a tunnel, a shared browser — never stopped working.
const IDLE_MS = 7 * 24 * 60 * 60 * 1000;
const ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000;

// token → { createdAt, lastSeenAt }
const sessions = new Map();

function sessionValid(token, now = Date.now()) {
  const s = sessions.get(token);
  if (!s) return false;
  if (now - s.createdAt > ABSOLUTE_MS || now - s.lastSeenAt > IDLE_MS) {
    sessions.delete(token);
    return false;
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
  return Boolean(getAdminPassword());
}

function parseCookies(header) {
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
async function passwordOk(pw) {
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
function cookieAttrs(req) {
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
  const secure = req.secure || proto === "https";
  // Strict, not Lax: nothing here is reached by following a link from elsewhere, so the cookie
  // never needs to ride a cross-site navigation — and Lax still attaches it to top-level GETs.
  return `HttpOnly; SameSite=Strict; Path=/${secure ? "; Secure" : ""}`;
}

// Paths reachable without a session (so you can actually log in).
const OPEN_PATHS = new Set(["/login", "/login.html", "/api/login", "/api/health", "/api/skills/webhook/github", "/mcp/skills"]);

// The HTTP run API accepts a bearer API key as an alternative to the admin session cookie, so an
// automation can fire runs without logging in. Scoped to /api/runs only — the key is NOT a general
// admin credential (it can't reach the settings/token/fs-browser routes). Bearer or X-API-Key.
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
function isApiRunPath(p) {
  return p === API_RUN_PREFIX || p.startsWith(`${API_RUN_PREFIX}/`);
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
  const cookies = parseCookies(req.headers?.cookie);
  return Boolean(cookies.cg_session && sessionValid(cookies.cg_session));
}

export function authMiddleware(req, res, next) {
  // Nothing to check a session against — noPasswordLockdown ahead of this has already refused
  // every privileged route, so what falls through here is the static shell and the login page.
  if (!authEnabled()) return next();
  if (OPEN_PATHS.has(req.path)) return next();

  const cookies = parseCookies(req.headers.cookie);
  if (cookies.cg_session && sessionValid(cookies.cg_session)) {
    if (!csrfOk(req)) return res.status(403).json({ error: "missing X-CG-Request header" });
    return next();
  }

  // A valid run-API key stands in for the session cookie on the /api/runs routes.
  if (isApiRunPath(req.path) && apiRunKeyOk(req)) return next();

  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "unauthorized" });
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
  if (!req.path.startsWith("/api/") || LOCKDOWN_OPEN.has(req.path)) return next();
  // A configured run-API key IS a credential, so the run routes stay reachable without an admin
  // password — but only with a matching key.
  if (isApiRunPath(req.path) && apiRunKeyOk(req)) return next();
  return res.status(403).json({ error: NO_PASSWORD_ERROR });
}

// Which identity the login backoff counts against. Behind a reverse proxy or tunnel every request
// arrives from 127.0.0.1, so keying on the socket puts all remote clients in ONE bucket: an
// attacker's failures lock out the real admin, and distributed guessing looks like one client.
// The forwarding headers fix that and are honoured exactly where they cannot be forged — from a
// loopback socket, which only the proxy in front and this host's own processes can open — or when
// the operator declares a trusted proxy elsewhere on the network (CG_TRUST_PROXY). One helper,
// shared with the approval-link router, so both limiters bucket callers the same way.
export function loginKey(req) {
  return clientKey(req);
}

export async function handleLogin(req, res) {
  // No password configured → there is nothing to authenticate against, and answering "ok" would
  // hand back a session-less "logged in" state for an API the lockdown above is refusing anyway.
  // Say what to fix instead.
  if (!authEnabled()) return res.status(403).json({ error: NO_PASSWORD_ERROR });
  const ip = loginKey(req);
  const wait = loginLimiter.retryAfterMs(ip);
  if (wait > 0) {
    const secs = Math.ceil(wait / 1000);
    res.setHeader("Retry-After", String(secs));
    return res.status(429).json({ error: `Too many attempts — try again in ${secs}s` });
  }
  if (!(await passwordOk(req.body?.password))) {
    loginLimiter.recordFailure(ip);
    return res.status(401).json({ error: "Wrong password" });
  }
  loginLimiter.recordSuccess(ip);
  // A fresh token per login (never reusing the presented one) means a fixated cookie can't be
  // promoted to an authenticated session.
  const token = crypto.randomBytes(24).toString("hex");
  const now = Date.now();
  sessions.set(token, { createdAt: now, lastSeenAt: now });
  res.setHeader("Set-Cookie", `cg_session=${token}; ${cookieAttrs(req)}; Max-Age=${Math.floor(ABSOLUTE_MS / 1000)}`);
  res.json({ ok: true });
}

export function handleLogout(req, res) {
  const cookies = parseCookies(req.headers.cookie);
  if (cookies.cg_session) sessions.delete(cookies.cg_session);
  res.setHeader("Set-Cookie", `cg_session=; ${cookieAttrs(req)}; Max-Age=0`);
  res.json({ ok: true });
}
