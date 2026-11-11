import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const store = await import("../src/config/admin-accounts.js");
const { setUser, getUser } = await import("../src/config/store.js");
const { createAdminSession, authMiddleware } = await import("../src/web/auth.js");
const { createUsersRouter } = await import("../src/web/routes/users.js");

test("a demoted actor cannot finish an in-flight user update that would promote them again", { timeout: 5000 }, async (t) => {
  const original = store.ensureBootstrapAdmin();
  const account = store.saveAdminPasskey({ accountId: original.id, authVersion: original.authVersion,
    credential: { id: "cm9sZS1yYWNlLWZpeHR1cmU", publicKey: new Uint8Array([1]), counter: 0, transports: ["internal"] },
    deviceType: "multiDevice", backedUp: true, name: "Store-only authority fixture" });
  const userId = "U_ROLE_RACE_FIXTURE";
  await setUser(userId, { name: "Original administrator", isAdmin: true });
  const proof = store.createAdminIdentityLink(account, userId, "disposable-link-session");
  const linked = store.verifyAdminIdentityLink(account, proof.requestId, proof.code, "disposable-link-session");
  let cookie;
  createAdminSession({ headers: {} }, { setHeader: (_key, value) => { cookie = value.split(";")[0]; } }, linked);

  let finishValidation;
  let reportValidationStarted;
  const validationStarted = new Promise((resolve) => { reportValidationStarted = resolve; });
  const validationCanFinish = new Promise((resolve) => { finishValidation = resolve; });
  const app = express();
  app.use(express.json());
  app.use(authMiddleware);
  app.use("/api", createUsersRouter({ validateMcpSelections: async () => {
    reportValidationStarted();
    await validationCanFinish;
  } }));
  const server = await new Promise((resolve) => { const value = app.listen(0, "127.0.0.1", () => resolve(value)); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const pendingSave = fetch(`http://127.0.0.1:${server.address().port}/api/users/${userId}`, {
    method: "PUT", headers: { "Content-Type": "application/json", "X-CG-Request": "1", Cookie: cookie },
    body: JSON.stringify({ isAdmin: true, name: "Unwanted role restoration", accessGrants: { allowedMcps: [] } }),
  });
  await validationStarted;
  await setUser(userId, { isAdmin: false });
  finishValidation();
  const result = await pendingSave;
  assert.equal(result.status, 401);
  assert.match((await result.json()).error, /access changed/i);
  const saved = await getUser(userId);
  assert.equal(saved.isAdmin, false, "the admitted request must not resurrect revoked administrator authority");
  assert.equal(saved.name, "Original administrator", "the refused save must be atomic");
});
