import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const store = await import("../src/config/admin-accounts.js");
const { getDb } = await import("../src/db/index.js");
let sequence = 0;
function key(id = `key-${++sequence}`) {
  return { id, publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ["internal"] };
}
function enroll(account, credential = key(), extra = {}) {
  return store.saveAdminPasskey({ accountId: account.id, authVersion: account.authVersion,
    credential, deviceType: "multiDevice", backedUp: true, name: "Fixture passkey", ...extra });
}

test("first enrollment permanently retires the shared-password bootstrap", () => {
  const account = store.ensureBootstrapAdmin();
  assert.equal(account.username, "admin");
  assert.equal(store.bootstrapAvailable(), true);
  assert.equal(store.passkeysConfigured(), false);
  const registered = enroll(account);
  assert.equal(store.bootstrapAvailable(), false);
  assert.equal(store.passkeysConfigured(), true);
  assert.ok(registered.authVersion > account.authVersion);
  assert.equal(store.ensureBootstrapAdmin().id, account.id);
  const recovery = store.createAdminEnrollment(account.id, { recover: true });
  assert.ok(recovery);
  assert.equal(store.adminPasskeys(account.id).length, 0);
  assert.equal(store.passkeysConfigured(), true, "recovery never revives shared-password access");
  assert.equal(store.bootstrapAvailable(), false);
  enroll(store.adminAccount(account.id));
});

test("usernames normalize uniquely and user handles are opaque", () => {
  const account = store.createAdminAccount("  Operator.Example  ", "Operator");
  assert.equal(account.username, "operator.example");
  assert.equal(store.adminAccountByUsername("OPERATOR.EXAMPLE").id, account.id);
  assert.equal(Buffer.from(account.userHandle, "base64url").length, 32);
  assert.ok(!account.userHandle.includes("operator"));
  assert.throws(() => store.createAdminAccount("OPERATOR.EXAMPLE"), /UNIQUE/);
  assert.throws(() => store.createAdminAccount("bad user"), /username/);
});

test("setup secrets are digest-only, expire, and enroll exactly the bound account once", () => {
  const account = store.createAdminAccount("invited");
  const token = store.createAdminEnrollment(account.id);
  const invitation = store.adminEnrollment(token);
  assert.equal(invitation.account.id, account.id);
  const raw = getDb().prepare("SELECT * FROM admin_enrollment_tokens WHERE account_id = ?").get(account.id);
  assert.ok(!JSON.stringify(raw).includes(token));
  assert.ok(raw.expires_ms > Date.now());
  enroll(account, key(), { enrollmentDigest: invitation.digest });
  assert.equal(store.adminEnrollment(token), null);
  assert.throws(() => enroll(store.adminAccount(account.id), key(), { enrollmentDigest: invitation.digest }), /expired|already used/);
  const expiring = store.createAdminAccount("expired");
  const expiredToken = store.createAdminEnrollment(expiring.id);
  getDb().prepare("UPDATE admin_enrollment_tokens SET expires_ms = ? WHERE account_id = ?").run(Date.now() - 1, expiring.id);
  assert.equal(store.adminEnrollment(expiredToken), null);
});

test("revocation during an authenticator operation invalidates its result and setup link", () => {
  const account = store.createAdminAccount("revoked");
  const token = store.createAdminEnrollment(account.id);
  const invitation = store.adminEnrollment(token);
  store.revokeAdminSessions(account.id);
  assert.equal(store.adminEnrollment(token), null);
  assert.throws(() => enroll(account, key(), { enrollmentDigest: invitation.digest }), /changed/);
  assert.equal(store.adminPasskeys(account.id).length, 0);
  store.setAdminEnabled(account.id, false);
  assert.throws(() => enroll(store.adminAccount(account.id)), /changed/);
});

test("credentials cannot be reassigned, and removing the final passkey is refused", () => {
  const account = store.createAdminAccount("keys-owner");
  const credential = key();
  const enrolled = enroll(account, credential);
  assert.equal(store.adminPasskeyById(credential.id).accountId, account.id);
  assert.equal(store.adminPasskeyById("unknown-credential"), null);
  assert.equal(store.adminPasskeyById(null), null);
  const other = store.createAdminAccount("keys-other");
  assert.throws(() => enroll(other, credential), /UNIQUE/);
  assert.equal(store.adminPasskeys(other.id).length, 0);
  assert.throws(() => store.deleteAdminPasskey(account.id, credential.id), /last passkey/);
  const spare = key();
  enroll(enrolled, spare);
  const before = store.adminAccount(account.id).authVersion;
  store.deleteAdminPasskey(account.id, credential.id);
  assert.deepEqual(store.adminPasskeys(account.id).map((entry) => entry.id), [spare.id]);
  assert.ok(store.adminAccount(account.id).authVersion > before);
});

test("counter updates reject stale credential state and a disabled account", () => {
  const credential = key();
  const account = enroll(store.createAdminAccount("counter-owner"), credential);
  const registered = store.adminPasskeys(account.id)[0];
  const info = { newCounter: 1, credentialDeviceType: "multiDevice", credentialBackedUp: true };
  store.advanceAdminCounter(account, registered, info);
  assert.throws(() => store.advanceAdminCounter(account, registered, info), /changed/);
  store.setAdminEnabled(account.id, false);
  assert.throws(() => store.advanceAdminCounter(account, store.adminPasskeys(account.id)[0], { ...info, newCounter: 2 }), /changed/);
});

test("the final enabled administrator with a passkey cannot be disabled", () => {
  const accounts = store.listAdminAccounts().filter((account) => account.enabled && account.passkeyCount);
  for (const account of accounts.slice(1)) store.setAdminEnabled(account.id, false);
  assert.throws(() => store.setAdminEnabled(accounts[0].id, false), /last administrator/);
  assert.equal(store.adminAccount(accounts[0].id).enabled, true);
});
