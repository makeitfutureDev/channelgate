import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const { registerActivityConnectionRoutes } = await import("../src/web/activity-connections.js");
const { ActivityConnectionsError } = await import("../src/gateway/activity-connections.js");

async function fixture(t, remove) {
  const session = { ownerId: "viewer", teamId: "workspace", csrf: "csrf", origin: "https://activity.example" };
  let current = session;
  const app = express(); app.use(express.json());
  app.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  registerActivityConnectionRoutes(app, {
    context: async () => { if (!current) throw Object.assign(new Error("revoked"), { status: 401 }); return { session: current }; },
    csrfOk: (req, selected) => req.get("Origin") === selected.origin && req.get("X-CG-CSRF") === selected.csrf,
    services: { remove },
  });
  const server = await new Promise(resolve => { const value = app.listen(0, "127.0.0.1", () => resolve(value)); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { setSession(value) { current = value; }, session,
    async request({ path = "ca_target", csrf = "csrf", origin = session.origin, body } = {}) {
      return fetch(`http://127.0.0.1:${server.address().port}/activity/api/connections/${path}`, { method: "DELETE", headers: { Origin: origin, ...(csrf === null ? {} : { "X-CG-CSRF": csrf }), ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    } };
}
test("delete route binds exact connection to authenticated owner/workspace and reauthorizes", async t => {
  let captured;
  const f = await fixture(t, async input => { captured = input; await input.authorize(); return { deleted: true }; });
  const response = await f.request(); assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { deleted: true });
  assert.equal(captured.ownerId, "viewer"); assert.equal(captured.teamId, "workspace"); assert.equal(captured.connectionId, "ca_target");
});
test("delete route rejects absent or invalid CSRF and foreign Origin without mutation", async t => {
  let mutations = 0; const f = await fixture(t, async () => { mutations++; return { deleted: true }; });
  for (const options of [{ csrf: null }, { csrf: "wrong" }, { origin: "https://foreign.example" }]) assert.equal((await f.request(options)).status, 403);
  assert.equal(mutations, 0);
});
test("delete route rejects client-selected identities and query selectors", async t => {
  let mutations = 0; const f = await fixture(t, async () => { mutations++; });
  for (const options of [{ body: { ownerId: "someone_else" } }, { body: ["target"] }, { path: "ca_target?teamId=foreign" }]) assert.equal((await f.request(options)).status, 400);
  assert.equal(mutations, 0);
});
test("session revocation during delete preparation prevents the mutation", async t => {
  let mutations = 0, f;
  f = await fixture(t, async input => { f.setSession(null); await input.authorize(); mutations++; return { deleted: true }; });
  assert.equal((await f.request()).status, 401); assert.equal(mutations, 0);
});
test("replacement session cannot inherit an in-flight deletion", async t => {
  let mutations = 0, f;
  f = await fixture(t, async input => { f.setSession({ ...f.session, ownerId: "replacement" }); await input.authorize(); mutations++; return { deleted: true }; });
  assert.equal((await f.request()).status, 401); assert.equal(mutations, 0);
});
test("provider errors are generic while deliberate ownership refusals remain safe", async t => {
  let safe = false;
  const f = await fixture(t, async () => { if (safe) throw new ActivityConnectionsError("This is not your private connection.", 404); throw new Error("upstream secret response"); });
  let response = await f.request(); assert.equal(response.status, 503); assert.doesNotMatch(JSON.stringify(await response.json()), /secret|upstream/);
  safe = true; response = await f.request(); assert.equal(response.status, 404); assert.match((await response.json()).error, /not your private/);
});
