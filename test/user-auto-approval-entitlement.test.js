import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { ensureTestEnv, testLicenseEnv } from "./helpers.js";

ensureTestEnv();
const { getSettings, saveSettings } = await import("../src/config/settings.js");
const { getUser, setUser } = await import("../src/config/store.js");
const { ensureUserAdminAccount } = await import("../src/config/admin-accounts.js");
const { createAdminSession, authMiddleware } = await import("../src/web/auth.js");
const { createUsersRouter } = await import("../src/web/routes/users.js");
const { autoApproveSlackUser } = await import("../src/gateway/user-auto-approval.js");
const { readEvents } = await import("../src/util/logger.js");

test("Free rejects every policy enable request before writes or audit, including a saved enabled policy", async (t) => {
  testLicenseEnv();
  t.after(() => testLicenseEnv());
  saveSettings({ adminPassword: "disposable-domain-policy-password" });
  await setUser("UPOLICYADMIN", { name: "Policy admin", isAdmin: true, approved: true });
  await setUser("UPOLICYMEMBER", { name: "Existing member", approved: true });
  await setUser("UPOLICYPENDING", { name: "Pending member", approved: false });
  const existing = await getUser("UPOLICYMEMBER");
  const slackClient = { users: { info: async ({ user }) => ({ user: { id: user, profile: { email: "person@example.test" } } }) } };
  const app = express();
  app.use(express.json(), authMiddleware);
  app.use("/api", createUsersRouter({ slack: { getClient: () => slackClient } }));
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message, code: error.code }));
  const server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  let cookie;
  createAdminSession({ headers: {}, protocol: "http" }, { setHeader: (_name, value) => { cookie = value.split(";")[0]; } }, ensureUserAdminAccount("UPOLICYADMIN"));
  const request = async (route, body, method = "PUT") => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api${route}`, {
      method, headers: { Cookie: cookie, "Content-Type": "application/json", "X-CG-Request": "1" }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await request("/user-auto-approval", { enabled: true, domains: ["example.test"] })).status, 200);
  testLicenseEnv({ tier: "free" });
  const before = getSettings();
  const auditCount = () => readEvents().filter(e => e.event === "user_auto_approval_policy_changed").length;
  const beforeAudit = auditCount();
  for (const domains of [["example.test"], ["other.example.test"]]) {
    const result = await request("/user-auto-approval", { enabled: true, domains });
    assert.equal(result.status, 403, JSON.stringify(result));
    assert.equal(result.body.code, "enterprise_required");
    assert.deepEqual(getSettings(), before, "rejected enable must not change saved domains or other settings");
    assert.equal(auditCount(), beforeAudit, "rejected enable must not emit a success audit event");
  }
  assert.equal(await autoApproveSlackUser(slackClient, "UPOLICYPENDING"), false);
  assert.equal((await getUser("UPOLICYPENDING")).approved, false);
  for (const action of ["preview", "apply"]) {
    assert.equal((await request(`/user-auto-approval/${action}`, { userIds: ["UPOLICYPENDING"] }, "POST")).status, 403);
  }
  assert.equal((await request("/users/UPOLICYPENDING", { approved: true })).status, 200);
  assert.equal((await getUser("UPOLICYPENDING")).approved, true);
  assert.deepEqual(await getUser("UPOLICYMEMBER"), existing);
  assert.equal((await request("/user-auto-approval", { enabled: false, domains: ["example.test"] })).status, 200);
  assert.equal(getSettings().userAutoApprovalEnabled, false);
  assert.equal((await request("/user-auto-approval", { enabled: true, domains: ["example.test"] })).status, 403);
  testLicenseEnv();
  assert.equal((await request("/user-auto-approval", { enabled: true, domains: ["example.test"] })).status, 200);
});
