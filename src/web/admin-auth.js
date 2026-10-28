// Authentication never runs through an agent. Verified passkey signatures or the explicitly
// enabled password-plus-private-Slack-code flow mint sessions; setup links only enroll keys.
import crypto from 'node:crypto';
import express from 'express';
import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import { getPublicUrl, getAdminPassword, getSettings, saveSettings } from '../config/settings.js';
import { adminAccount, adminPasskeys, adminPasskeyById, bootstrapAvailable, createAdminEnrollment, adminEnrollment, saveAdminPasskey, advanceAdminCounter, listAdminAccounts, deleteAdminPasskey, revokeAdminSessions, adminLinkRequired, eligibleAdminUsers, dashboardUser, adminAccountForUser, ensureUserAdminAccount, createAdminIdentityLink, verifyAdminIdentityLink, cancelAdminIdentityLink, getIdentityLinkState } from '../config/admin-accounts.js';
import { adminSession, requireRecentAdminAuth, createAdminSession, refreshAdminSession, parseCookies, cookieAttrs, passwordOk, adminPasswordFingerprint } from './auth.js';
import { clientKey, createLoginLimiter, hashPassword, verifyPassword } from './security.js';
import { logEvent } from '../util/logger.js';

const FIVE_MIN = 5 * 60_000;
const MAX_PENDING = 2000;
const pending = new Map();
const failures = createLoginLimiter();
const starts = createLoginLimiter({ freeAttempts: 20, baseDelayMs: 1000, maxDelayMs: 60_000, ttlMs: 60_000, globalMaxFailures: 500, globalWindowMs: 60_000 });
const COOKIE = 'cg_webauthn';
const passwordSlackPending = new Map();
const slackAdmin = id => typeof id === 'string' && /^[UW][A-Z0-9]{8,}$/.test(id) && dashboardUser(id)?.isAdmin === true;
const passwordSlackVersion = () => Number(getSettings().adminPasswordSlackVersion) || 0;
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
  pending.set(`${binding}:${kind}`, { kind, ...rp, accountId: a?.id ?? null, authVersion: a?.authVersion ?? null, challenge: options.challenge,
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
  if (kind === 'login' && saved.discoverable) return { saved, account: null };
  const a = adminAccount(saved.accountId);
  if (!a?.enabled || a.authVersion !== saved.authVersion) reject('Account access changed. Start again.', 401);
  if (saved.sessionToken && saved.sessionToken !== adminSession(req)?.token) reject('Sign-in session changed. Start again.', 401);
  req.adminAuthAccountId = a.id;
  return { saved, account: a };
}
function loggedIn(req) { const s = adminSession(req); if (!s) reject('unauthorized', 401); return s; }
function fresh(req) { const s = loggedIn(req); if (!requireRecentAdminAuth(req)) reject('Verify your passkey again to continue.', 403); return s; }
function publicAccount(a) { return { id: a.id, username: a.username, displayName: a.displayName, userId: a.userId }; }
function canLink(s) { return Boolean(s && !s.account.userId && Date.now() - s.authenticatedAt <= FIVE_MIN && (s.bootstrap || adminPasskeys(s.accountId).length)); }
function linkSession(req) { const s = loggedIn(req); if (!canLink(s)) reject('Verify your passkey or initial setup password again before linking your user.', 403); return s; }
function linkedFresh(req) { const s = fresh(req); if (!s.account.userId) reject('Verify and link your existing administrator user first.', 403); return s; }
function audit(action, a, extra = {}) { logEvent(`admin_auth_${action}`, { actor: a.id, username: a.username, ...extra }); }
async function registrationOptions(a, rp) {
  return generateRegistrationOptions({ rpName: 'ChannelGate', rpID: rp.rpID,
    userID: Buffer.from(a.userHandle, 'base64url'), userName: a.userId || a.username, userDisplayName: a.displayName,
    attestationType: 'none', timeout: 60_000, supportedAlgorithmIDs: [-7, -257],
    excludeCredentials: adminPasskeys(a.id).map(p => ({ id: p.id, transports: p.transports })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' } });
}
function safe(handler) {
  return async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try { await handler(req, res); } catch (error) {
      if (/^\/(login|reauth|register|enroll|password-slack)\/(options|verify)\/?$/.test(req.path) && error.status !== 429) {
        for (const key of rateKeys(req, req.adminAuthAccountId)) failures.recordFailure(key);
      }
      // Verifier error strings may contain attacker-controlled assertions. Do not log or echo.
      if (!error.expose) return res.status(400).json({ error: 'Passkey verification failed. Start again.' });
      next(error);
    }
  };
}
export function createAdminAuthRouter({ adminIdentityDelivery } = {}) {
  const router = express.Router({ caseSensitive: true });
  router.get('/status', safe(async (req, res) => {
    const rp = adminRelyingParty(req);
    res.json({ bootstrapAvailable: Boolean(getAdminPassword()) && bootstrapAvailable(), passwordSlackEnabled: getSettings().adminPasswordSlackEnabled === true, ...rp });
  }));
  router.get('/me', safe(async (req, res) => {
    const s = loggedIn(req);
    res.json({ account: publicAccount(s.account), passwordSlackEnabled: getSettings().adminPasswordSlackEnabled === true, fresh: requireRecentAdminAuth(req), bootstrap: s.bootstrap, linkRequired: adminLinkRequired(s.account), canLink: canLink(s),
      passkeys: adminPasskeys(s.accountId).map(p => ({ id: p.id, name: p.name, createdAt: p.createdAt, lastUsedAt: p.lastUsedAt })) });
  }));
  router.post('/password-slack/options', safe(async (req, res) => {
    const rp = ceremonyGuard(req);
    limited(req, res, failures); limited(req, res, starts, '', true);
    if (getSettings().adminPasswordSlackEnabled !== true || typeof adminIdentityDelivery !== 'function') reject('Password and Slack code sign-in is unavailable.', 403);
    const userId = req.body?.userId;
    if (!slackAdmin(userId)) reject('Unable to sign in with those credentials.', 401);
    const a = ensureUserAdminAccount(userId);
    req.adminAuthAccountId = a.id;
    limited(req, res, failures, a.id); limited(req, res, starts, a.id, true);
    const version = passwordSlackVersion(); const passwordBefore = getAdminPassword();
    // Verify directly: an opportunistic legacy hash upgrade would invalidate this ceremony.
    if (!a.enabled || !passwordBefore || typeof req.body?.password !== 'string' || !(await verifyPassword(req.body.password, passwordBefore))) reject('Unable to sign in with those credentials.', 401);
    const valid = () => getSettings().adminPasswordSlackEnabled === true && passwordSlackVersion() === version && getAdminPassword() === passwordBefore && slackAdmin(userId) && adminAccount(a.id)?.enabled && adminAccount(a.id)?.authVersion === a.authVersion;
    if (!valid()) reject('Account access changed. Start again.', 401);
    const now = Date.now();
    for (const [key, value] of passwordSlackPending) if (value.expiresAt <= now) passwordSlackPending.delete(key);
    if (passwordSlackPending.size >= MAX_PENDING) reject('Authentication is busy. Try again shortly.', 429);
    const binding = browserBinding(req, res);
    // One outstanding code per browser/account; a resend retires the previous code.
    for (const [key, value] of passwordSlackPending) if (value.binding === binding && value.accountId === a.id) passwordSlackPending.delete(key);
    const requestId = crypto.randomBytes(24).toString('base64url');
    const code = String(crypto.randomInt(10_000_000, 100_000_000));
    const digest = crypto.createHash('sha256').update(`${requestId}\0${code}`).digest('hex');
    const saved = { binding, accountId: a.id, authVersion: a.authVersion, version, passwordFingerprint: adminPasswordFingerprint(), origin: rp.origin, expiresAt: now + FIVE_MIN, digest, attempts: 0 };
    passwordSlackPending.set(requestId, saved);
    try {
      await adminIdentityDelivery(userId, `ChannelGate dashboard sign-in for ${rp.origin}\nYour sign-in code is: ${code}\nThis code expires in 5 minutes. Enter it only on the gateway page where you requested it. If you did not request this, ignore this message.`);
      if (!valid() || passwordSlackPending.get(requestId) !== saved || saved.expiresAt <= Date.now()) throw new Error('Access changed');
    } catch { passwordSlackPending.delete(requestId); reject('The private Slack code could not be delivered, or access changed. Retry sign-in.', 503); }
    audit('password_slack_code_sent', a);
    res.json({ requestId, expiresAt: saved.expiresAt });
  }));
  router.post('/password-slack/verify', safe(async (req, res) => {
    const rp = ceremonyGuard(req); limited(req, res, failures);
    const requestId = req.body?.requestId;
    const saved = typeof requestId === 'string' ? passwordSlackPending.get(requestId) : null;
    if (!saved || saved.binding !== parseCookies(req.headers.cookie)[COOKIE] || saved.origin !== rp.origin) reject('Sign-in request expired. Start again.', 401);
    req.adminAuthAccountId = saved.accountId; limited(req, res, failures, saved.accountId);
    const a = adminAccount(saved.accountId);
    if (saved.expiresAt <= Date.now() || saved.attempts >= 5 || getSettings().adminPasswordSlackEnabled !== true || passwordSlackVersion() !== saved.version || saved.passwordFingerprint !== adminPasswordFingerprint() || !a?.enabled || a.authVersion !== saved.authVersion || !slackAdmin(a.userId)) {
      passwordSlackPending.delete(requestId); reject('Sign-in request expired or access changed. Start again.', 401);
    }
    const code = req.body?.code;
    const digest = crypto.createHash('sha256').update(`${requestId}\0${String(code)}`).digest('hex');
    if (typeof code !== 'string' || !/^\d{8}$/.test(code) || !crypto.timingSafeEqual(Buffer.from(digest, 'hex'), Buffer.from(saved.digest, 'hex'))) {
      if (++saved.attempts >= 5) passwordSlackPending.delete(requestId);
      reject('The verification code is incorrect.', 401);
    }
    passwordSlackPending.delete(requestId);
    createAdminSession(req, res, a, { method: 'password-slack' });
    for (const key of rateKeys(req, a.id)) { failures.recordSuccess(key); starts.recordSuccess(key); }
    audit('password_slack_login', a); res.json({ ok: true });
  }));
  router.put('/password-slack/settings', safe(async (req, res) => {
    ceremonyGuard(req); const s = loggedIn(req);
    if (typeof req.body?.enabled !== 'boolean') reject('Choose whether password and Slack code sign-in is enabled.');
    const enabled = req.body.enabled;
    const bootstrap = s.bootstrap && s.account.userId && Date.now() - s.authenticatedAt <= FIVE_MIN;
    if (!bootstrap) linkedFresh(req);
    if (!s.account.userId) reject('Verify and link your administrator user first.', 403);
    if (bootstrap && (!enabled || !(await passwordOk(req.body?.password)))) reject('Verify the initial setup password before enabling sign-in.', 403);
    const passwordBefore = getAdminPassword(); const version = passwordSlackVersion();
    const patch = { adminPasswordSlackEnabled: enabled };
    if (enabled) {
      if (!slackAdmin(s.account.userId) || typeof adminIdentityDelivery !== 'function') reject('A linked Slack administrator and private Slack delivery are required.', 403);
      if (req.body.password !== undefined && req.body.password !== '') {
        if (typeof req.body.password !== 'string' || req.body.password.length < 12 || req.body.password.length > 1024) reject('Use a password between 12 and 1024 characters.');
        patch.adminPassword = await hashPassword(req.body.password);
      }
      if (!patch.adminPassword && !getAdminPassword()) reject('Set a shared admin password before enabling this sign-in method.');
    }
    const current = adminSession(req);
    if (!current || current.token !== s.token || current.authVersion !== s.authVersion || getAdminPassword() !== passwordBefore || passwordSlackVersion() !== version || (bootstrap ? Date.now() - current.authenticatedAt > FIVE_MIN : !requireRecentAdminAuth(req))) reject('Authentication changed. Start again.', 401);
    saveSettings(patch); passwordSlackPending.clear();
    // Preserve this freshly authenticated browser, while old alternate sessions fail validation.
    const signedOut = !enabled && current.method === 'password-slack';
    if (!signedOut) createAdminSession(req, res, current.account, { method: bootstrap || current.method === 'password-slack' ? 'password-slack' : 'passkey' });
    else res.setHeader('Set-Cookie', `cg_session=; ${cookieAttrs(req)}; Max-Age=0`);
    audit('password_slack_setting_changed', current.account, { enabled });
    res.json({ ok: true, passwordSlackEnabled: enabled, signedOut });
  }));
  for (const kind of ['login', 'reauth']) {
    router.post(`/${kind}/options`, safe(async (req, res) => {
      const rp = ceremonyGuard(req);
      limited(req, res, failures);
      let a;
      if (kind === 'reauth') { const s = loggedIn(req); if (s.bootstrap) reject('Register your first passkey before verifying it.', 403); a = s.account; }
      limited(req, res, starts, a?.id, true);
      if (kind === 'reauth' && (!a?.enabled || !adminPasskeys(a.id).length)) reject('Unable to verify this account with a passkey.', 401);
      // Discoverable credentials let the authenticator choose the account. Keep authorization
      // versions only on the server so a revocation also invalidates unbound login challenges.
      const extra = kind === 'login' ? { discoverable: true, accountVersions: Object.fromEntries(
        listAdminAccounts().filter(account => account.enabled && account.passkeyCount).map(account => [account.id, account.authVersion]),
      ) } : {};
      const options = await generateAuthenticationOptions({ rpID: rp.rpID, timeout: 60_000, userVerification: 'required',
        ...(kind === 'reauth' ? { allowCredentials: adminPasskeys(a.id).map(p => ({ id: p.id, transports: p.transports })) } : {}),
      });
      remember(req, res, kind, rp, a, options, extra); res.json({ options });
    }));
    router.post(`/${kind}/verify`, safe(async (req, res) => {
      const rp = ceremonyGuard(req); limited(req, res, failures);
      const { saved, account: boundAccount } = consume(req, kind, rp);
      requireTopLevelResponse(req.body?.response);
      const key = kind === 'login' ? adminPasskeyById(req.body?.response?.id)
        : adminPasskeys(boundAccount.id).find(p => p.id === req.body?.response?.id);
      const a = kind === 'login' && key ? adminAccount(key.accountId) : boundAccount;
      if (!key || !a?.enabled || (kind === 'login' && saved.accountVersions?.[a.id] !== a.authVersion)) reject('Passkey verification failed.', 401);
      req.adminAuthAccountId = a.id;
      limited(req, res, failures, a.id);
      const userHandle = req.body?.response?.response?.userHandle;
      if ((kind === 'login' && !userHandle) || (userHandle && userHandle !== a.userHandle)) reject('Passkey verification failed.', 401);
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
        a = s.account; if (adminLinkRequired(a)) reject('Verify and link your existing administrator user before registering a passkey.', 403);
        extra = { bootstrap: s.bootstrap };
      } else {
        const enrollment = adminEnrollment(req.body?.token);
        if (!enrollment) reject('Setup link expired or was already used.', 401);
        a = enrollment.account; if (adminLinkRequired(a)) reject('This setup link requires a verified administrator user.', 403);
        extra = { enrollmentDigest: enrollment.digest };
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
  // One Users directory owns administration. Historical independent-account routes are retired.
  router.all(['/accounts', '/accounts/:id', '/accounts/:id/invite', '/accounts/:id/revoke-sessions'], safe(async (req, res) => {
    loggedIn(req); res.status(410).json({ error: 'Manage dashboard access in the existing Users directory.' });
  }));
  router.get('/link/users', safe(async (req, res) => {
    const s = loggedIn(req);
    if (s.account.userId) reject('This account is already linked.');
    res.json({ users: eligibleAdminUsers().filter(user => {
      const target = adminAccountForUser(user.id); return !target || !adminPasskeys(target.id).length;
    }).map(user => ({ id: user.id, name: user.name })) });
  }));
  router.post('/link/options', safe(async (req, res) => {
    const rp = ceremonyGuard(req); const s = linkSession(req);
    limited(req, res, starts, s.accountId, true);
    if (typeof adminIdentityDelivery !== 'function') reject('Private identity verification is unavailable. Reconnect the user’s chat platform.', 503);
    let proof;
    try { proof = createAdminIdentityLink(s.account, req.body?.userId, s.token); }
    catch (error) { reject(error.message); }
    try {
      await adminIdentityDelivery(req.body.userId, `ChannelGate identity verification for ${rp.origin}\nLink your existing administrator user (${req.body.userId}) to the dashboard passkey account signed in on that page.\nYour verification code is: ${proof.code}\nThis code expires in 5 minutes. Enter it only on the gateway page where you requested it. If you did not request this, ignore this message.`);
      const current = adminSession(req);
      // A role/version change while delivery is in flight revokes the proof, even if promoted back.
      const row = getIdentityLinkState(proof.requestId);
      if (!current || current.token !== s.token || current.authVersion !== s.authVersion || !row || !dashboardUser(req.body.userId)?.isAdmin) throw new Error('Identity verification changed. Start again.');
    } catch {
      cancelAdminIdentityLink(proof.requestId);
      reject('The private verification message could not be delivered, or access changed. Reconnect the user’s chat platform and retry.', 503);
    }
    audit('identity_proof_sent', s.account, { targetUser: req.body.userId });
    res.json({ requestId: proof.requestId, expiresAt: proof.expiresAt });
  }));
  router.post('/link/verify', safe(async (req, res) => {
    ceremonyGuard(req); const s = linkSession(req);
    limited(req, res, failures, s.accountId);
    let updated;
    try { updated = verifyAdminIdentityLink(s.account, req.body?.requestId, req.body?.code, s.token); }
    catch (error) { reject(error.message); }
    createAdminSession(req, res, updated, { bootstrap: s.bootstrap, method: s.method });
    audit('identity_linked', updated, { userId: updated.userId }); res.json({ ok: true });
  }));
  router.get('/users/:userId', safe(async (req, res) => {
    const s = loggedIn(req);
    if (adminLinkRequired(s.account)) reject('Verify and link your administrator user before viewing dashboard access.', 403);
    const user = dashboardUser(req.params.userId);
    if (!user) reject('User not found.', 404);
    const a = adminAccountForUser(user.id);
    const keys = a ? adminPasskeys(a.id) : [];
    res.json({ userId: user.id, isAdmin: user.isAdmin, passkeyCount: keys.length, linked: Boolean(a),
      canInvite: Boolean(user.isAdmin && (!a || a.enabled) && !keys.length),
      passkeys: keys.map(p => ({ id: p.id, name: p.name, createdAt: p.createdAt, lastUsedAt: p.lastUsedAt })) });
  }));
  router.post('/users/:userId/invite', safe(async (req, res) => {
    const rp = ceremonyGuard(req); const s = linkedFresh(req);
    limited(req, res, starts, s.accountId, true);
    let a; let token;
    try {
      a = ensureUserAdminAccount(req.params.userId);
      if (!a.enabled || adminPasskeys(a.id).length) reject('Only an administrator without passkeys can receive a setup link.');
      token = createAdminEnrollment(a.id);
    } catch (error) { reject(error.message); }
    audit('setup_issued', s.account, { targetUser: a.userId });
    res.json({ setupUrl: `${rp.origin}/login.html#setup=${token}`, expiresAt: Date.now() + 15 * 60_000 });
  }));
  router.post('/users/:userId/revoke-sessions', safe(async (req, res) => {
    ceremonyGuard(req); const s = linkedFresh(req);
    const user = dashboardUser(req.params.userId); if (!user) reject('User not found.', 404);
    const a = adminAccountForUser(user.id);
    if (a) {
      revokeAdminSessions(a.id);
      if (a.id === s.accountId) createAdminSession(req, res, adminAccount(a.id), { method: s.method });
    }
    audit('sessions_revoked', s.account, { targetUser: user.id }); res.json({ ok: true });
  }));
  router.delete('/users/:userId/passkeys/:keyId', safe(async (req, res) => {
    ceremonyGuard(req); const s = linkedFresh(req);
    if (s.account.userId !== req.params.userId) reject('You can remove only your own passkeys.', 403);
    try { deleteAdminPasskey(s.accountId, req.params.keyId); } catch (error) { reject(error.message); }
    createAdminSession(req, res, adminAccount(s.accountId), { method: s.method }); audit('passkey_removed', s.account); res.json({ ok: true });
  }));
  router.delete('/passkeys/:id', safe(async (req, res) => {
    ceremonyGuard(req); const s = fresh(req);
    try { deleteAdminPasskey(s.accountId, req.params.id); } catch (error) { reject(error.message); }
    // Other sessions and in-flight ceremonies are revoked, this freshly verified browser rotates.
    createAdminSession(req, res, adminAccount(s.accountId), { method: s.method }); audit('passkey_removed', s.account); res.json({ ok: true });
  }));
  return router;
}
