// WebAuthn ceremonies never run through an agent. Only verified public-key signatures mint
// dashboard sessions; setup links authorize registration alone, not dashboard access.
import crypto from 'node:crypto';
import express from 'express';
import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import { getPublicUrl, getAdminPassword } from '../config/settings.js';
import { adminAccount, adminAccountByUsername, adminPasskeys, bootstrapAvailable, createAdminAccount, createAdminEnrollment, adminEnrollment, saveAdminPasskey, advanceAdminCounter, listAdminAccounts, setAdminEnabled, deleteAdminPasskey, revokeAdminSessions } from '../config/admin-accounts.js';
import { adminSession, requireRecentAdminAuth, createAdminSession, refreshAdminSession, parseCookies, cookieAttrs } from './auth.js';
import { clientKey, createLoginLimiter } from './security.js';
import { logEvent } from '../util/logger.js';

const FIVE_MIN = 5 * 60_000;
const MAX_PENDING = 2000;
const pending = new Map();
const failures = createLoginLimiter();
const starts = createLoginLimiter({ freeAttempts: 20, baseDelayMs: 1000, maxDelayMs: 60_000, ttlMs: 60_000, globalMaxFailures: 500, globalWindowMs: 60_000 });
const COOKIE = 'cg_webauthn';
function reject(message, status = 400) { const error = new Error(message); error.status = status; error.expose = true; throw error; }
const loopback = host => ['localhost', '127.0.0.1', '[::1]'].includes(host);
// A configured public URL is authoritative. With none configured only an explicitly loopback
// browser origin is accepted. Arbitrary Host/X-Forwarded-Host values never choose the RP.
export function adminRelyingParty(req) {
  const configured = getPublicUrl();
  let url;
  try {
    let localOrigin = `http://localhost:${process.env.PORT || 4747}`;
    // Only loopback Host may supply an ephemeral local development port. Forwarded headers
    // never select a relying party, even when a reverse proxy is configured.
    if (!configured && req?.headers?.host) {
      const candidate = new URL(`${req.secure ? 'https' : 'http'}://${req.headers.host}`);
      if (!loopback(candidate.hostname)) reject('Configure the HTTPS Public URL before using passkeys.', 503);
      localOrigin = candidate.origin;
    }
    const fallback = String(req?.headers?.origin || '') || localOrigin;
    url = new URL(configured || fallback);
  } catch { reject('Configure a valid HTTPS Public URL before using passkeys.', 503); }
  if (url.username || url.password || (!configured && !loopback(url.hostname)) || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback(url.hostname)))) reject('Passkeys require an HTTPS Public URL, or a localhost origin.', 503);
  return { origin: url.origin, rpID: url.hostname.replace(/^\[|\]$/g, '') };
}
function ceremonyGuard(req) {
  const rp = adminRelyingParty(req);
  if (String(req.headers['x-cg-request'] || '') !== '1') reject('missing X-CG-Request header', 403);
  const origin = req.headers.origin;
  if (origin !== undefined && String(origin) !== rp.origin) reject('Authentication origin does not match the configured Public URL.', 403);
  // Browser fetches include Origin. Missing Origin is retained for explicit-header local API
  // clients, which have no ambient browser authority and cannot bypass signature verification.
  return rp;
}
function rateKeys(req, accountId = '') { return [`ip:${clientKey(req)}`, ...(accountId ? [`account:${accountId}`] : [])]; }
function limited(req, res, limiter, accountId = '', count = false) {
  const keys = rateKeys(req, accountId);
  const wait = Math.max(...keys.map(k => limiter.retryAfterMs(k)));
  if (wait > 0) {
    res.setHeader('Retry-After', String(Math.ceil(wait / 1000)));
    reject('Too many authentication attempts. Try again shortly.', 429);
  }
  if (count) for (const k of keys) limiter.recordFailure(k);
}
function browserBinding(req, res) {
  let value = parseCookies(req.headers.cookie)[COOKIE];
  if (!/^[A-Za-z0-9_-]{43}$/.test(value || '')) value = crypto.randomBytes(32).toString('base64url');
  res.append('Set-Cookie', `${COOKIE}=${value}; ${cookieAttrs(req)}; Max-Age=300`);
  return value;
}
function remember(req, res, kind, rp, a, options, extra = {}) {
  const now = Date.now();
  for (const [key, value] of pending) if (value.expiresAt <= now) pending.delete(key);
  if (pending.size >= MAX_PENDING) reject('Authentication is busy. Try again shortly.', 429);
  const binding = browserBinding(req, res);
  pending.set(`${binding}:${kind}`, { kind, ...rp, accountId: a.id, authVersion: a.authVersion, challenge: options.challenge,
    sessionToken: kind === 'register' || kind === 'reauth' ? adminSession(req)?.token : null, expiresAt: now + FIVE_MIN, ...extra });
}
function requireTopLevelResponse(response) {
  try {
    const clientData = JSON.parse(Buffer.from(response?.response?.clientDataJSON || '', 'base64url').toString('utf8'));
    if (clientData.crossOrigin === true || clientData.topOrigin !== undefined) reject('Passkeys must be used directly on the gateway page.', 403);
  } catch (error) {
    if (error.expose) throw error;
    reject('Invalid passkey response.');
  }
}
function consume(req, kind, rp) {
  const binding = parseCookies(req.headers.cookie)[COOKIE];
  const key = `${binding}:${kind}`;
  const saved = pending.get(key); pending.delete(key); // including failed verification: never retry a challenge
  if (!saved || saved.expiresAt <= Date.now() || saved.origin !== rp.origin || saved.rpID !== rp.rpID) reject('Authentication request expired. Start again.');
  const a = adminAccount(saved.accountId);
  if (!a?.enabled || a.authVersion !== saved.authVersion) reject('Account access changed. Start again.', 401);
  if (saved.sessionToken && saved.sessionToken !== adminSession(req)?.token) reject('Sign-in session changed. Start again.', 401);
  req.adminAuthAccountId = a.id;
  return { saved, account: a };
}
function loggedIn(req) { const s = adminSession(req); if (!s) reject('unauthorized', 401); return s; }
function fresh(req) { const s = loggedIn(req); if (!requireRecentAdminAuth(req)) reject('Verify your passkey again to continue.', 403); return s; }
function publicAccount(a) { return { id: a.id, username: a.username, displayName: a.displayName }; }
function audit(action, a, extra = {}) { logEvent(`admin_auth_${action}`, { actor: a.id, username: a.username, ...extra }); }
async function registrationOptions(a, rp) {
  return generateRegistrationOptions({ rpName: 'ChannelGate', rpID: rp.rpID,
    userID: Buffer.from(a.userHandle, 'base64url'), userName: a.username, userDisplayName: a.displayName,
    attestationType: 'none', timeout: 60_000, supportedAlgorithmIDs: [-7, -257],
    excludeCredentials: adminPasskeys(a.id).map(p => ({ id: p.id, transports: p.transports })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' } });
}
function safe(handler) {
  return async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try { await handler(req, res); } catch (error) {
      if (/^\/(login|reauth|register|enroll)\/(options|verify)\/?$/.test(req.path) && error.status !== 429) {
        for (const key of rateKeys(req, req.adminAuthAccountId)) failures.recordFailure(key);
      }
      // Verifier error strings may contain attacker-controlled assertions. Do not log or echo.
      if (!error.expose) return res.status(400).json({ error: 'Passkey verification failed. Start again.' });
      next(error);
    }
  };
}
export function createAdminAuthRouter() {
  const router = express.Router({ caseSensitive: true });
  router.get('/status', safe(async (req, res) => {
    const rp = adminRelyingParty(req);
    res.json({ bootstrapAvailable: Boolean(getAdminPassword()) && bootstrapAvailable(), ...rp });
  }));
  router.get('/me', safe(async (req, res) => {
    const s = loggedIn(req);
    res.json({ account: publicAccount(s.account), fresh: requireRecentAdminAuth(req), bootstrap: s.bootstrap,
      passkeys: adminPasskeys(s.accountId).map(p => ({ id: p.id, name: p.name, createdAt: p.createdAt, lastUsedAt: p.lastUsedAt })) });
  }));
  for (const kind of ['login', 'reauth']) {
    router.post(`/${kind}/options`, safe(async (req, res) => {
      const rp = ceremonyGuard(req);
      limited(req, res, failures);
      let a;
      if (kind === 'reauth') { const s = loggedIn(req); if (s.bootstrap) reject('Register your first passkey before verifying it.', 403); a = s.account; }
      else { try { a = adminAccountByUsername(req.body?.username); } catch { /* generic invalid account */ } }
      limited(req, res, starts, a?.id, true);
      if (!a?.enabled || !adminPasskeys(a.id).length) reject('Unable to sign in with this username and passkey.', 401);
      const options = await generateAuthenticationOptions({ rpID: rp.rpID, timeout: 60_000, userVerification: 'required', allowCredentials: adminPasskeys(a.id).map(p => ({ id: p.id, transports: p.transports })) });
      remember(req, res, kind, rp, a, options); res.json({ options });
    }));
    router.post(`/${kind}/verify`, safe(async (req, res) => {
      const rp = ceremonyGuard(req); limited(req, res, failures);
      const { saved, account: a } = consume(req, kind, rp);
      requireTopLevelResponse(req.body?.response);
      limited(req, res, failures, a.id);
      const key = adminPasskeys(a.id).find(p => p.id === req.body?.response?.id);
      if (!key) reject('Passkey verification failed.', 401);
      const userHandle = req.body?.response?.response?.userHandle;
      if (userHandle && userHandle !== a.userHandle) reject('Passkey verification failed.', 401);
      let verification;
      try { verification = await verifyAuthenticationResponse({ response: req.body?.response, expectedChallenge: saved.challenge,
        expectedOrigin: rp.origin, expectedRPID: rp.rpID, credential: key, requireUserVerification: true }); }
      catch { reject('Passkey verification failed.', 401); }
      if (!verification.verified || !verification.authenticationInfo.userVerified) reject('Passkey verification failed.', 401);
      // Recheck a reauthentication's session after the async signature verification as well.
      if (kind === 'reauth' && saved.sessionToken !== adminSession(req)?.token) reject('Sign-in session changed. Start again.', 401);
      advanceAdminCounter(a, key, verification.authenticationInfo);
      if (kind === 'login') createAdminSession(req, res, a); else refreshAdminSession(req);
      for (const k of rateKeys(req, a.id)) { failures.recordSuccess(k); starts.recordSuccess(k); }
      audit(kind, a); res.json({ ok: true });
    }));
  }
  for (const kind of ['register', 'enroll']) {
    router.post(`/${kind}/options`, safe(async (req, res) => {
      const rp = ceremonyGuard(req); limited(req, res, failures);
      let a; let extra = {};
      if (kind === 'register') {
        const s = loggedIn(req);
        if (s.bootstrap) {
          if (!bootstrapAvailable() || Date.now() - s.authenticatedAt > FIVE_MIN) reject('Sign in again before registering your first passkey.', 403);
        } else fresh(req);
        a = s.account; extra = { bootstrap: s.bootstrap };
      } else {
        const enrollment = adminEnrollment(req.body?.token);
        if (!enrollment) reject('Setup link expired or was already used.', 401);
        a = enrollment.account; extra = { enrollmentDigest: enrollment.digest };
      }
      limited(req, res, starts, a.id, true);
      const options = await registrationOptions(a, rp);
      remember(req, res, kind, rp, a, options, extra); res.json({ options });
    }));
    router.post(`/${kind}/verify`, safe(async (req, res) => {
      const rp = ceremonyGuard(req); limited(req, res, failures);
      const { saved, account: a } = consume(req, kind, rp);
      requireTopLevelResponse(req.body?.response);
      limited(req, res, failures, a.id);
      const verification = await verifyRegistrationResponse({ response: req.body?.response, expectedChallenge: saved.challenge,
        expectedOrigin: rp.origin, expectedRPID: rp.rpID, requireUserVerification: true, requireUserPresence: true, supportedAlgorithmIDs: [-7, -257] });
      if (!verification.verified || !verification.registrationInfo.userVerified) reject('Passkey verification failed.', 401);
      if (kind === 'register') {
        const s = loggedIn(req);
        if (s.token !== saved.sessionToken || (saved.bootstrap ? !bootstrapAvailable() || Date.now() - s.authenticatedAt > FIVE_MIN : !requireRecentAdminAuth(req))) reject('Sign in again before registering a passkey.', 403);
      }
      const info = verification.registrationInfo;
      const updated = saveAdminPasskey({ accountId: a.id, authVersion: saved.authVersion, credential: info.credential,
        deviceType: info.credentialDeviceType, backedUp: info.credentialBackedUp, name: req.body?.name, enrollmentDigest: saved.enrollmentDigest });
      createAdminSession(req, res, updated);
      for (const k of rateKeys(req, a.id)) { failures.recordSuccess(k); starts.recordSuccess(k); }
      audit('passkey_registered', a); res.json({ ok: true });
    }));
  }
  router.get('/accounts', safe(async (req, res) => {
    loggedIn(req); res.json({ accounts: listAdminAccounts().map(a => ({ ...publicAccount(a), enabled: a.enabled, passkeyCount: a.passkeyCount })) });
  }));
  router.post('/accounts', safe(async (req, res) => {
    const rp = ceremonyGuard(req); const s = fresh(req);
    limited(req, res, starts, s.accountId, true);
    let a;
    try { a = createAdminAccount(req.body?.username, req.body?.displayName); }
    catch { reject('Username is invalid or already exists.'); }
    const token = createAdminEnrollment(a.id); audit('account_created', s.account, { target: a.id });
    res.json({ account: publicAccount(a), setupUrl: `${rp.origin}/login.html#setup=${token}` });
  }));
  router.patch('/accounts/:id', safe(async (req, res) => {
    ceremonyGuard(req); const s = fresh(req);
    if (req.params.id === s.accountId && req.body?.enabled === false) reject('You cannot disable your own account.');
    if (typeof req.body?.enabled !== 'boolean') reject('enabled must be true or false.');
    let a; try { a = setAdminEnabled(req.params.id, req.body.enabled); } catch (error) { reject(error.message); }
    audit('account_changed', s.account, { target: a.id, enabled: a.enabled }); res.json({ account: { ...publicAccount(a), enabled: a.enabled } });
  }));
  router.post('/accounts/:id/revoke-sessions', safe(async (req, res) => {
    ceremonyGuard(req); const s = fresh(req);
    const a = adminAccount(req.params.id); if (!a) reject('Account not found.', 404);
    revokeAdminSessions(a.id);
    if (a.id === s.accountId) createAdminSession(req, res, adminAccount(a.id));
    audit('sessions_revoked', s.account, { target: a.id }); res.json({ ok: true });
  }));
  router.post('/accounts/:id/invite', safe(async (req, res) => {
    const rp = ceremonyGuard(req); const s = fresh(req);
    limited(req, res, starts, s.accountId, true);
    const a = adminAccount(req.params.id);
    if (!a?.enabled || adminPasskeys(a.id).length) reject('Only an enabled account without a passkey can receive a setup link.');
    const token = createAdminEnrollment(a.id); audit('setup_issued', s.account, { target: a.id });
    res.json({ setupUrl: `${rp.origin}/login.html#setup=${token}` });
  }));
  router.delete('/passkeys/:id', safe(async (req, res) => {
    ceremonyGuard(req); const s = fresh(req);
    try { deleteAdminPasskey(s.accountId, req.params.id); } catch (error) { reject(error.message); }
    // Other sessions and in-flight ceremonies are revoked, this freshly verified browser rotates.
    createAdminSession(req, res, adminAccount(s.accountId)); audit('passkey_removed', s.account); res.json({ ok: true });
  }));
  return router;
}
