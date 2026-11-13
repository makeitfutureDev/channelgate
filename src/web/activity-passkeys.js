import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import { activityAccount, activityPasskeys, activityPasskey, saveActivityPasskey, advanceActivityPasskey, removeActivityPasskey } from '../config/activity-passkeys.js';
import { clientKey, createLoginLimiter, timingSafeEqualStr } from './security.js';
import { activityAccessPage } from './activity-access-page.js';
import { adminAccount, adminAccountForUser, adminPasskeys, adminPasskeyById, advanceAdminCounter, listAdminAccounts } from '../config/admin-accounts.js';

const FIVE_MIN = 5 * 60_000;
const COOKIE = 'cg_activity_webauthn';
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
function reject(status = 400) { throw Object.assign(new Error('Activity passkey request failed'), { status }); }
function topLevel(response) {
  const data = JSON.parse(Buffer.from(response?.response?.clientDataJSON || '', 'base64url').toString('utf8'));
  if (data.crossOrigin === true || data.topOrigin !== undefined) reject(403);
}

// Admin credentials can authenticate their linked user's Activity without minting admin sessions.
// Activity-only credentials never acquire administrator authority.
export function installActivityPasskeys(router, { context, authorize, issueSession, sendPage, getTeamId, version, now }) {
  const pending = new Map();
  const limiter = createLoginLimiter({ freeAttempts: 10, baseDelayMs: 1000, maxDelayMs: 60_000, ttlMs: 60_000, globalMaxFailures: 500, globalWindowMs: 60_000 });
  const starts = new Map();
  function guard(req, res) {
    if (req.headers.origin !== req.activityOrigin || req.headers['x-cg-request'] !== '1') reject(403);
    const wait = limiter.retryAfterMs(clientKey(req), now());
    if (wait) { res.setHeader('Retry-After', String(Math.ceil(wait / 1000))); reject(429); }
    if (req.path.endsWith('/options')) {
      for (const [id, entry] of starts) if (entry.until <= now()) starts.delete(id);
      const id = clientKey(req), entry = starts.get(id) || { count: 0, until: now() + 60_000 };
      if (entry.count >= 60 || (!starts.has(id) && starts.size >= 2000)) {
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil((entry.until - now()) / 1000)))); reject(429);
      }
      entry.count++; starts.set(id, entry);
    }
    return { origin: req.activityOrigin, rpID: new URL(req.activityOrigin).hostname.replace(/^\[|\]$/g, '') };
  }
  function binding(req) {
    return String(req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) || '';
  }
  function remember(req, res, kind, rp, options, extra = {}) {
    for (const [id, saved] of pending) if (saved.expiresAt <= now()) pending.delete(id);
    if (pending.size >= 2000) reject(429);
    // Rotate the browser binding at every start. Cookies contain no account or challenge data.
    const secret = crypto.randomBytes(32).toString('base64url');
    const secure = rp.origin.startsWith('https:') ? '; Secure' : '';
    res.append('Set-Cookie', `${COOKIE}=${secret}; HttpOnly; SameSite=Strict; Path=/activity; Max-Age=300${secure}`);
    pending.set(digest(secret), { kind, ...rp, challenge: options.challenge, expiresAt: now() + FIVE_MIN, version: version(), ...extra });
  }
  function consume(req, kind, rp) {
    const id = digest(binding(req)), saved = pending.get(id);
    pending.delete(id); // A failed verification also consumes its challenge.
    if (!saved || saved.kind !== kind || saved.origin !== rp.origin || saved.rpID !== rp.rpID || saved.expiresAt <= now() || saved.version !== version()) reject(401);
    return saved;
  }
  const safe = handler => async (req, res) => {
    try {
      await handler(req, res);
      if (req.path.endsWith('/verify')) limiter.recordSuccess(clientKey(req));
    }
    catch (error) {
      if (req.path.endsWith('/verify') && error.status !== 429) limiter.recordFailure(clientKey(req), now());
      // Never return verifier errors, credential material, or attacker-controlled assertions.
      res.status(error.status || 400).json({ error: error.status === 429 ? 'Too many requests. Try again shortly.' :
        'Passkey request expired, was cancelled, or could not be verified. Try again, or open a new Dashboard link from Slack.' });
    }
  };
  async function managed(req) {
    const { session } = await context(req);
    if (req.headers.origin !== req.activityOrigin || !timingSafeEqualStr(String(req.headers['x-cg-csrf'] || ''), session.csrf)) reject(403);
    return session;
  }
  const publicKeys = accountId => activityPasskeys(accountId).map(({ transports: _transports, ...key }) => key);

  router.get('/passkeys.js', (_req, res) => res.sendFile('passkeys.js', { root: fileURLToPath(new URL('../../public/', import.meta.url)) }));
  router.get('/login', (_req, res) => sendPage(res, activityAccessPage({ mode: 'login' })));
  router.get('/:id/passkeys', async (req, res) => {
    try {
      const { session } = await context(req);
      const admin = adminAccountForUser(session.ownerId);
      sendPage(res, activityAccessPage({ mode: 'manage', base: `/activity/${req.params.id}`, csrf: session.csrf,
        adminPasskeysAvailable: Boolean(admin?.enabled && adminPasskeys(admin.id).length) }));
    } catch { res.redirect(303, '/activity/login'); }
  });
  router.get('/:id/api/passkeys', safe(async (req, res) => {
    const { session } = await context(req);
    res.json({ passkeys: publicKeys(activityAccount(session)?.id) });
  }));
  router.post('/:id/api/passkeys/register/options', safe(async (req, res) => {
    const rp = guard(req, res), session = await managed(req), before = version();
    const account = activityAccount(session, true);
    const options = await generateRegistrationOptions({ rpName: 'ChannelGate Activity', rpID: rp.rpID,
      userID: Buffer.from(account.id, 'base64url'), userName: `Activity · ${session.ownerId}`, userDisplayName: 'ChannelGate Activity',
      attestationType: 'none', supportedAlgorithmIDs: [-7, -257], timeout: 60_000,
      excludeCredentials: activityPasskeys(account.id).map(key => ({ id: key.id, transports: key.transports })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' } });
    if ((await context(req)).session !== session || before !== version()) reject(401);
    remember(req, res, 'register', rp, options, { session, accountId: account.id });
    res.json({ options });
  }));
  router.post('/:id/api/passkeys/register/verify', safe(async (req, res) => {
    const rp = guard(req, res), saved = consume(req, 'register', rp), session = await managed(req);
    if (saved.session !== session) reject(401);
    topLevel(req.body?.response);
    const result = await verifyRegistrationResponse({ response: req.body?.response, expectedChallenge: saved.challenge,
      expectedOrigin: rp.origin, expectedRPID: rp.rpID, requireUserVerification: true, requireUserPresence: true, supportedAlgorithmIDs: [-7, -257] });
    if (!result.verified || !result.registrationInfo.userVerified || (await context(req)).session !== session || saved.version !== version() || saved.expiresAt <= now()) reject(401);
    saveActivityPasskey(saved.accountId, result.registrationInfo.credential, req.body?.name, now());
    res.json({ passkeys: publicKeys(saved.accountId) });
  }));
  router.delete('/:id/api/passkeys/:credentialId', safe(async (req, res) => {
    guard(req, res); const session = await managed(req);
    const account = activityAccount(session);
    if (!account || !removeActivityPasskey(account.id, req.params.credentialId)) reject(404);
    res.json({ passkeys: publicKeys(account.id) });
  }));
  router.post('/auth/login/options', safe(async (req, res) => {
    const rp = guard(req, res);
    // Discoverable login selects its account later. Snapshot versions server-side so an admin
    // revocation (or workspace switch) also invalidates ceremonies already open in a browser.
    const teamId = getTeamId();
    const adminVersions = Object.fromEntries(listAdminAccounts().filter(account => account.enabled && account.userId && account.passkeyCount)
      .map(account => [account.id, account.authVersion]));
    const options = await generateAuthenticationOptions({ rpID: rp.rpID, userVerification: 'required', timeout: 60_000 });
    remember(req, res, 'login', rp, options, { adminVersions, teamId });
    res.json({ options }); // Discoverable: never enumerate users or credential IDs.
  }));
  router.post('/auth/login/verify', safe(async (req, res) => {
    const rp = guard(req, res), saved = consume(req, 'login', rp);
    const response = req.body?.response, activityKey = activityPasskey(response?.id);
    const adminKey = activityKey ? null : adminPasskeyById(response?.id);
    const account = adminKey ? adminAccount(adminKey.accountId) : null;
    if (!activityKey && (!adminKey || !account?.enabled || !account.userId || saved.adminVersions?.[account.id] !== account.authVersion)) reject(401);
    const key = activityKey || adminKey;
    const handle = activityKey ? key.account_id : account.userHandle;
    if ((activityKey && key.origin !== rp.origin) || response.response?.userHandle !== handle) reject(401);
    const identity = activityKey ? { ownerId: key.owner_id, teamId: key.team_id, origin: key.origin, expiresAt: saved.expiresAt, credentialId: key.id } :
      { ownerId: account.userId, teamId: saved.teamId, origin: rp.origin, expiresAt: saved.expiresAt,
        adminAuth: { accountId: account.id, authVersion: account.authVersion, credentialId: key.id } };
    await authorize(identity);
    topLevel(response);
    const result = await verifyAuthenticationResponse({ response, expectedChallenge: saved.challenge, expectedOrigin: rp.origin,
      expectedRPID: rp.rpID, credential: { id: key.id, publicKey: key.publicKey, counter: key.counter, transports: key.transports },
      requireUserVerification: true, requireUserPresence: true });
    await authorize(identity);
    if (!result.verified || !result.authenticationInfo.userVerified || saved.version !== version() || saved.expiresAt <= now()) reject(401);
    if (activityKey) {
      if (!advanceActivityPasskey(key, result.authenticationInfo.newCounter, now())) reject(401);
    } else advanceAdminCounter(account, key, result.authenticationInfo);
    issueSession(res, identity);
  }));
}
