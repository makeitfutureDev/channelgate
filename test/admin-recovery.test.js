import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ensureTestEnv, tempDir } from "./helpers.js";

ensureTestEnv();
const store = await import("../src/config/admin-accounts.js");
const { gatewayRoot, dbFile } = await import("../src/config/paths.js");
const { saveSettings } = await import("../src/config/settings.js");
const script = fileURLToPath(new URL("../scripts/admin-recover.mjs", import.meta.url));

test("host recovery loads the intended runtime from .env and replaces account authority", () => {
  saveSettings({ publicUrl: "https://gateway.example.test", adminPassword: "disposable-bootstrap" });
  const account = store.createAdminAccount("recover-fixture");
  store.saveAdminPasskey({ accountId: account.id, authVersion: account.authVersion,
    credential: { id: "Y2xpLWZpeHR1cmU", publicKey: new Uint8Array([1]), counter: 0 },
    name: "Disposable fixture", deviceType: "singleDevice", backedUp: false });
  const before = store.adminAccount(account.id).authVersion;
  const dir = tempDir("cg-admin-recovery-env-");
  writeFileSync(`${dir}/.env`, `CHANNELGATE_DIR=${gatewayRoot()}\nCHANNELGATE_DB=${dbFile()}\n`, { mode: 0o600 });
  const env = { ...process.env };
  for (const key of ["CHANNELGATE_DIR", "CHANNELGATE_DB", "CLAUDE_GATEWAY_DIR", "CLAUDE_GATEWAY_DB"]) delete env[key];
  const result = spawnSync(process.execPath, [script, "--username", account.username], { cwd: dir, env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const match = result.stdout.match(/https:\/\/gateway\.example\.test\/login\.html#setup=([A-Za-z0-9_-]{43})/);
  assert.ok(match, "recovery prints one correctly scoped registration URL");
  assert.equal(store.adminEnrollment(match[1]).account.id, account.id);
  assert.equal(store.adminPasskeys(account.id).length, 0);
  assert.ok(store.adminAccount(account.id).authVersion > before);
  assert.equal(store.bootstrapAvailable(), false);
  assert.equal(store.passkeysConfigured(), true);
});

test("invalid recovery invocation cannot reset an account", () => {
  const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage:/);
  assert.equal(result.stdout, "");
});

test("host recovery uses an existing admin ID and cannot bypass canonical roles by local username", async () => {
  const { setUser } = await import("../src/config/store.js");
  const userId = "U_RECOVERY_USER";
  await setUser(userId, { name: "Recovery fixture", isAdmin: true });
  const account = store.ensureUserAdminAccount(userId);
  store.saveAdminPasskey({ accountId: account.id, authVersion: account.authVersion,
    credential: { id: "dXNlci1yZWNvdmVyeS1maXh0dXJl", publicKey: new Uint8Array([2]), counter: 0 },
    name: "Disposable fixture", deviceType: "singleDevice", backedUp: false });
  const rejected = spawnSync(process.execPath, [script, "--username", account.username], { encoding: "utf8" });
  assert.equal(rejected.status, 1);
  assert.equal(rejected.stdout, "");
  assert.equal(store.adminPasskeys(account.id).length, 1, "refused recovery must not revoke keys");
  const recovered = spawnSync(process.execPath, [script, "--user", userId], { encoding: "utf8" });
  assert.equal(recovered.status, 0, recovered.stderr);
  const token = recovered.stdout.match(/#setup=([A-Za-z0-9_-]{43})/)?.[1];
  assert.ok(token);
  assert.equal(store.adminEnrollment(token).account.userId, userId);
  assert.equal(store.adminPasskeys(account.id).length, 0);
  await setUser(userId, { isAdmin: false });
  const demoted = spawnSync(process.execPath, [script, "--user", userId], { encoding: "utf8" });
  assert.equal(demoted.status, 1);
  assert.equal(demoted.stdout, "");
  assert.equal(store.adminEnrollment(token), null);
});

test("host recovery revokes pending proofs targeting its user without touching another user's proof", async () => {
  const { setUser } = await import("../src/config/store.js");
  for (const keyed of [false, true]) {
    const suffix = keyed ? "KEYED" : "EMPTY";
    const userId = `U_RECOVERY_PENDING_${suffix}`;
    const otherUserId = `U_RECOVERY_UNRELATED_${suffix}`;
    await setUser(userId, { name: "Recovery proof fixture", isAdmin: true });
    await setUser(otherUserId, { name: "Unrelated proof fixture", isAdmin: true });
    const target = store.ensureUserAdminAccount(userId);
    const oldInvite = store.createAdminEnrollment(target.id);
    const legacy = store.createAdminAccount(`recovery-pending-${suffix.toLowerCase()}`);
    const otherLegacy = store.createAdminAccount(`recovery-unrelated-${suffix.toLowerCase()}`);
    const proof = store.createAdminIdentityLink(legacy, userId, "recovery-proof-browser");
    const unrelated = store.createAdminIdentityLink(otherLegacy, otherUserId, "unrelated-proof-browser");
    // A proof can be issued before the target enrolls its first key. Recovery must revoke
    // that proof even though its account_id belongs to a different credential container.
    if (keyed) store.saveAdminPasskey({ accountId: target.id, authVersion: target.authVersion,
      credential: { id: "cmVjb3ZlcnktcGVuZGluZy1rZXk", publicKey: new Uint8Array([3]), counter: 0 },
      name: "Disposable target key", deviceType: "singleDevice", backedUp: false });
    const recovered = spawnSync(process.execPath, [script, "--user", userId], { encoding: "utf8" });
    assert.equal(recovered.status, 0, recovered.stderr);
    const token = recovered.stdout.match(/#setup=([A-Za-z0-9_-]{43})/)?.[1];
    assert.ok(token);
    assert.equal(store.getIdentityLinkState(proof.requestId), null, "recovery must revoke proofs targeting the canonical user");
    assert.throws(() => store.verifyAdminIdentityLink(legacy, proof.requestId, proof.code, "recovery-proof-browser"), /no longer valid|expired/);
    assert.equal(store.adminEnrollment(oldInvite), null);
    assert.equal(store.adminEnrollment(token).account.id, target.id, "stale proof must not displace the recovered container");
    assert.equal(store.adminPasskeys(target.id).length, 0);
    assert.ok(store.getIdentityLinkState(unrelated.requestId), "another user's pending proof remains valid");
    assert.equal(store.verifyAdminIdentityLink(otherLegacy, unrelated.requestId, unrelated.code, "unrelated-proof-browser").userId, otherUserId);
  }
});
