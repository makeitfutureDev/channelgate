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
