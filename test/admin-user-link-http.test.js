import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
delete process.env.ADMIN_PASSWORD;
const { setUser } = await import("../src/config/store.js");
const { saveSettings } = await import("../src/config/settings.js");
const { hashPassword } = await import("../src/web/security.js");
const { createWebApp } = await import("../src/web/app.js");
const { getDb } = await import("../src/db/index.js");

test("private identity proof is session-bound, fails closed on delivery/role races and unlocks bootstrap enrollment only after verification", async (t) => {
  const password = "disposable-link-http-bootstrap";
  saveSettings({ publicUrl: "", adminPassword: await hashPassword(password), apiKey: "" });
  await setUser("UHTTPADMIN", { name: "Fixture admin", isAdmin: true });
  await setUser("UHTTPMEMBER", { name: "Fixture member", isAdmin: false });
  let delivery = "ok";
  let code;
  const app = createWebApp({ adminIdentityDelivery: async (id, text) => {
    assert.equal(id, "UHTTPADMIN");
    code = text.match(/\b\d{8}\b/)?.[0];
    if (delivery === "fail") throw new Error("fixture delivery failure");
    if (delivery === "role-race") {
      await setUser(id, { isAdmin: false });
      await setUser(id, { isAdmin: true });
    }
    return true;
  } });
  const server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://localhost:${server.address().port}`;
  async function request(route, body, cookie = "") {
    const response = await fetch(`${base}${route}`, { method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", "X-CG-Request": "1", Origin: base, Cookie: cookie },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get("set-cookie")?.split(";")[0] };
  }
  const first = await request("/api/login", { password });
  const other = await request("/api/login", { password });
  assert.equal(first.status, 200);
  assert.equal((await request("/api/auth/me", undefined, first.cookie)).body.linkRequired, true);
  assert.equal((await request("/api/settings", undefined, first.cookie)).body.code, "identity_link_required");
  assert.equal((await request("/api/auth/users/UHTTPADMIN", undefined, first.cookie)).status, 403);
  assert.equal((await request("/api/auth/register/options", {}, first.cookie)).status, 403);
  assert.equal((await request("/api/auth/link/options", { userId: "UHTTPMEMBER", isAdmin: true }, first.cookie)).status, 400);
  assert.equal((await request("/api/auth/link/options", { userId: "missing", isAdmin: true }, first.cookie)).status, 400);
  delivery = "fail";
  assert.equal((await request("/api/auth/link/options", { userId: "UHTTPADMIN" }, first.cookie)).status, 503);
  assert.equal(getDb().prepare("SELECT count(*) AS n FROM admin_identity_links").get().n, 0);
  delivery = "role-race";
  assert.equal((await request("/api/auth/link/options", { userId: "UHTTPADMIN" }, first.cookie)).status, 503);
  assert.equal(getDb().prepare("SELECT count(*) AS n FROM admin_identity_links").get().n, 0);
  delivery = "ok";
  const proof = await request("/api/auth/link/options", { userId: "UHTTPADMIN" }, first.cookie);
  assert.equal(proof.status, 200);
  assert.match(code, /^\d{8}$/);
  assert.equal(JSON.stringify(proof.body).includes(code), false);
  assert.equal((await request("/api/auth/link/verify", { requestId: proof.body.requestId, code }, other.cookie)).status, 400);
  const verified = await request("/api/auth/link/verify", { requestId: proof.body.requestId, code }, first.cookie);
  assert.equal(verified.status, 200);
  assert.notEqual(verified.cookie, first.cookie);
  assert.equal((await request("/api/auth/me", undefined, first.cookie)).status, 401);
  const me = await request("/api/auth/me", undefined, verified.cookie);
  assert.equal(me.body.account.userId, "UHTTPADMIN");
  assert.equal(me.body.bootstrap, true);
  assert.equal(me.body.linkRequired, false);
  assert.equal((await request("/api/auth/register/options", {}, verified.cookie)).status, 200);
  assert.equal((await request("/api/auth/link/verify", { requestId: proof.body.requestId, code }, verified.cookie)).status, 403);
  await setUser("UHTTPADMIN", { isAdmin: false });
  await setUser("UHTTPADMIN", { isAdmin: true });
  assert.equal((await request("/api/auth/me", undefined, verified.cookie)).status, 401);
});
