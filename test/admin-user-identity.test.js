import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const store = await import("../src/config/admin-accounts.js");
const { setUser } = await import("../src/config/store.js");
const { getDb } = await import("../src/db/index.js");
const { createAdminSession, adminSession, invalidateAllSessions } = await import("../src/web/auth.js");
let sequence = 0;

beforeEach(() => {
  invalidateAllSessions();
  getDb().exec(`
    DELETE FROM admin_identity_links;
    DELETE FROM admin_enrollment_tokens;
    DELETE FROM admin_passkeys;
    DELETE FROM admin_accounts;
    DELETE FROM users;
    DELETE FROM _meta WHERE key IN ('admin_bootstrap_created', 'admin_passkeys_enrolled');
  `);
});

// These bytes exercise credential ownership/revocation in the store, not WebAuthn signatures.
// The browser regression supplies actual authenticator-generated keys and signed assertions.
function key() {
  return { id: Buffer.from(`identity-fixture-${++sequence}`).toString("base64url"),
    publicKey: new Uint8Array([1, 2, sequence]), counter: 0, transports: ["internal"] };
}
function legacyWithKey(username = "admin") {
  const original = username === "admin" ? store.ensureBootstrapAdmin() : store.createAdminAccount(username);
  return store.saveAdminPasskey({ accountId: original.id, authVersion: original.authVersion,
    credential: key(), deviceType: "multiDevice", backedUp: true, name: "Existing passkey" });
}
function session(account) {
  let header;
  createAdminSession({ headers: {} }, { setHeader: (_name, value) => { header = value; } }, account);
  const request = { headers: { cookie: header.split(";")[0] } };
  return { request, token: header.split(";")[0].slice("cg_session=".length) };
}
async function admin(userId = "U_IDENTITY_ONE", name = "Existing administrator") {
  await setUser(userId, { name, isAdmin: true, approved: true });
  return userId;
}
function link(account, userId, token = "disposable-browser-session") {
  const proof = store.createAdminIdentityLink(account, userId, token);
  return store.verifyAdminIdentityLink(account, proof.requestId, proof.code, token);
}

test("linking requires private identity proof, preserves credential bytes, and rotates authority", async () => {
  const account = legacyWithKey();
  const original = store.adminPasskeys(account.id)[0];
  const userId = await admin("U_IDENTITY_ONE", account.displayName);
  assert.equal(store.adminAccount(account.id).userId, null, "a matching display name must never establish ownership");
  assert.equal(store.adminAccountForUser(userId), null);
  const browser = session(account);
  const proof = store.createAdminIdentityLink(account, userId, browser.token);
  assert.throws(() => store.verifyAdminIdentityLink(account, proof.requestId, proof.code, "other-browser"), /no longer valid|expired/);
  const linked = store.verifyAdminIdentityLink(account, proof.requestId, proof.code, browser.token);
  assert.equal(linked.userId, userId);
  assert.equal(linked.userHandle, account.userHandle, "authenticator user handles cannot change during identity migration");
  const migrated = store.adminPasskeys(linked.id)[0];
  assert.equal(migrated.id, original.id);
  assert.deepEqual(migrated.publicKey, original.publicKey);
  assert.equal(adminSession(browser.request), null, "the old unlinked session loses authority immediately");
  assert.equal(adminSession(session(linked).request).account.userId, userId);
  assert.throws(() => store.verifyAdminIdentityLink(linked, proof.requestId, proof.code, browser.token), /no longer valid|expired/);
  await admin("U_IDENTITY_TWO", "Other administrator");
  assert.throws(() => store.createAdminIdentityLink(linked, "U_IDENTITY_TWO", browser.token), /unavailable/);
});

test("identity codes are digest-only, expire, and stop accepting guesses after five attempts", async () => {
  const account = legacyWithKey();
  const userId = await admin();
  const token = "disposable-proof-session-token";
  const proof = store.createAdminIdentityLink(account, userId, token);
  const record = getDb().prepare("SELECT * FROM admin_identity_links WHERE id = ?").get(proof.requestId);
  assert.ok(!JSON.stringify(record).includes(proof.code), "the numeric verification code must not be stored in plaintext");
  assert.ok(!JSON.stringify(record).includes(token), "the browser session token must not be stored in plaintext");
  const wrong = proof.code === "10000000" ? "10000001" : "10000000";
  for (let attempt = 0; attempt < 5; attempt++) {
    assert.throws(() => store.verifyAdminIdentityLink(account, proof.requestId, wrong, token), /incorrect/);
  }
  assert.equal(getDb().prepare("SELECT id FROM admin_identity_links WHERE id = ?").get(proof.requestId), undefined);
  assert.throws(() => store.verifyAdminIdentityLink(account, proof.requestId, proof.code, token), /no longer valid|expired/);
  assert.equal(store.adminAccount(account.id).userId, null);
  const expired = store.createAdminIdentityLink(account, userId, token);
  getDb().prepare("UPDATE admin_identity_links SET expires_ms = ? WHERE id = ?").run(Date.now() - 1, expired.requestId);
  assert.throws(() => store.verifyAdminIdentityLink(account, expired.requestId, expired.code, token), /no longer valid|expired/);
});

test("demoting the only administrator revokes sessions, invites and in-flight credential authority permanently", async () => {
  const account = legacyWithKey();
  const userId = await admin();
  const linked = link(account, userId);
  const browser = session(linked);
  const credential = store.adminPasskeys(linked.id)[0];
  const invite = store.createAdminEnrollment(linked.id);
  await setUser(userId, { isAdmin: false });
  assert.equal(store.adminAccount(linked.id).enabled, false, "canonical demotion must succeed even for the last dashboard administrator");
  assert.equal(adminSession(browser.request), null);
  assert.equal(store.adminEnrollment(invite), null);
  assert.throws(() => store.advanceAdminCounter(linked, credential, { newCounter: 1, credentialDeviceType: "multiDevice", credentialBackedUp: true }), /changed/);
  assert.throws(() => store.saveAdminPasskey({ accountId: linked.id, authVersion: linked.authVersion, credential: key(), deviceType: "multiDevice", backedUp: true }), /changed/);
  await setUser(userId, { isAdmin: true });
  const promoted = store.adminAccount(linked.id);
  assert.equal(promoted.enabled, true);
  assert.ok(promoted.authVersion > linked.authVersion);
  assert.equal(adminSession(browser.request), null, "re-promotion cannot revive a session issued before demotion");
  assert.equal(store.adminEnrollment(invite), null);
  assert.throws(() => store.advanceAdminCounter(linked, credential, { newCounter: 1, credentialDeviceType: "multiDevice", credentialBackedUp: true }), /changed/);
  assert.equal(adminSession(session(promoted).request).account.userId, userId);
});

test("demotion and re-promotion invalidate pending identity proofs even before the user has linked credentials", async () => {
  const account = legacyWithKey();
  const userId = await admin();
  const proof = store.createAdminIdentityLink(account, userId, "pending-browser");
  await setUser(userId, { isAdmin: false });
  await setUser(userId, { isAdmin: true });
  assert.equal(getDb().prepare("SELECT id FROM admin_identity_links WHERE id = ?").get(proof.requestId), undefined);
  assert.throws(() => store.verifyAdminIdentityLink(account, proof.requestId, proof.code, "pending-browser"), /no longer valid|expired/);
  assert.equal(link(account, userId).userId, userId, "the user may prove their newly granted authority through a fresh request");
});

test("the API principal, non-admins, missing users and non-boolean role claims cannot acquire dashboard credentials", async () => {
  const account = legacyWithKey();
  await setUser("api", { name: "Synthetic API principal", isAdmin: true });
  await setUser("U_ROLE_STRING", { name: "String role claim", isAdmin: "true" });
  await setUser("U_ROLE_FALSE", { name: "Non-admin", isAdmin: false });
  assert.deepEqual(store.eligibleAdminUsers(), []);
  for (const userId of ["api", "U_ROLE_STRING", "U_ROLE_FALSE", "U_MISSING"]) {
    assert.throws(() => store.createAdminIdentityLink(account, userId, "browser"), /unavailable/);
    assert.throws(() => store.ensureUserAdminAccount(userId), /not an administrator/);
  }
  await setUser("U_ROLE_STRING", { isAdmin: true });
  const linked = link(account, "U_ROLE_STRING");
  const browser = session(linked);
  getDb().prepare("DELETE FROM users WHERE user_id = ?").run("U_ROLE_STRING");
  assert.equal(store.adminAccount(linked.id).enabled, false, "an orphaned identity cannot retain dashboard authority");
  assert.equal(adminSession(browser.request), null);
});

test("a user with existing passkeys cannot be claimed by another legacy credential container", async () => {
  const first = legacyWithKey();
  const second = legacyWithKey("second-legacy");
  const userId = await admin();
  const linked = link(first, userId);
  assert.equal(store.ensureUserAdminAccount(userId).id, linked.id);
  assert.throws(() => store.createAdminIdentityLink(second, userId, "other-browser"), /already has linked passkeys/);
  assert.equal(store.adminAccount(second.id).userId, null);
  assert.equal(store.adminAccountForUser(userId).id, first.id);
});

test("verified migration replaces only an empty invite container and revokes its pending enrollment", async () => {
  const original = legacyWithKey();
  const userId = await admin();
  const empty = store.ensureUserAdminAccount(userId);
  const invitation = store.createAdminEnrollment(empty.id);
  const linked = link(original, userId);
  assert.equal(linked.id, original.id);
  assert.equal(store.adminAccountForUser(userId).id, original.id);
  assert.equal(store.adminAccount(empty.id), null);
  assert.equal(store.adminEnrollment(invitation), null);
  assert.throws(() => store.saveAdminPasskey({ accountId: empty.id, authVersion: empty.authVersion, credential: key(), deviceType: "multiDevice", backedUp: true }), /changed/);
  assert.equal(store.adminPasskeys(original.id).length, 1);
});
