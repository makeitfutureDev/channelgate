// HTTP run API (POST/GET /api/runs) — auth + validation wiring. Hermetic: it boots the real
// Express app on an ephemeral loopback port against a scratch gateway dir, and only ever sends
// INVALID requests (missing message / bad engine / bad webhook / unknown id) so a real `claude`
// subprocess is never spawned. Env is set before importing src so getApiKey()/getAdminPassword()
// resolve from it and getDb() opens the scratch file. `node --test` isolates each file in its own
// process, so these env writes don't leak into the rest of the suite.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
process.env.ADMIN_PASSWORD = "test-admin-pw"; // authEnabled() → true, so the run-API key gate is live
process.env.CG_API_KEY = "cg_testkey_abcdef0123456789"; // the bearer key (env fallback for getApiKey)
process.env.CG_APPROVAL_SECRET = "internal-test-secret";
const KEY = process.env.CG_API_KEY;

const { createWebApp } = await import("../src/web/app.js");

const slackStub = { snapshot: () => ({ status: "disconnected", connected: false, user: "gatewaybot", team: "Make it Future", teamId: "T0BB", botUserId: "U0BB", error: null }), getClient: () => null };
let updateSmokeCalls = 0;
let updateStartResult = {
  ok: true,
  transaction: { id: "tx-web", status: "running", phase: "queued" },
};
let lastUpdateStartOptions = null;
const restartRequests = [];
const app = createWebApp({
  slack: slackStub,
  restartCoordinator: {
    request: (input) => {
      restartRequests.push(input);
      return { ok: true, id: "restart-web", waitMs: 300_000, pollMs: 30_000 };
    },
    status: (id) => ({ ok: true, id, phase: "waiting", activity: { total: 2 }, message: "Waiting for ongoing work." }),
  },
  startGatewayUpdate: (options) => {
    lastUpdateStartOptions = options;
    return updateStartResult;
  },
  updateSmoke: async () => {
    updateSmokeCalls += 1;
    return { ok: true, durationMs: 7 };
  },
});
const server = await new Promise((resolve) => {
  const s = app.listen(0, "127.0.0.1", () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

const post = (path, body, headers = {}) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body ?? {}) });
const get = (path, headers = {}) => fetch(base + path, { headers });

test("POST /api/runs with no key → 401", async () => {
  const r = await post("/api/runs", { message: "hi" });
  assert.equal(r.status, 401);
});

test("POST /api/runs with a wrong key → 401", async () => {
  const r = await post("/api/runs", { message: "hi" }, { "x-api-key": "wrong" });
  assert.equal(r.status, 401);
});

test("X-API-Key accepted; missing message → 400 (before any engine spawn)", async () => {
  const r = await post("/api/runs", {}, { "x-api-key": KEY });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /message/i);
});

test("Authorization: Bearer accepted; missing message → 400", async () => {
  const r = await post("/api/runs", {}, { authorization: `Bearer ${KEY}` });
  assert.equal(r.status, 400);
});

test("bad engine override → 400", async () => {
  const r = await post("/api/runs", { message: "hi", engine: "bogus" }, { "x-api-key": KEY });
  assert.equal(r.status, 400);
});

test("bad webhook url → 400", async () => {
  const r = await post("/api/runs", { message: "hi", webhook: "not-a-url" }, { "x-api-key": KEY });
  assert.equal(r.status, 400);
});

test("GET /api/runs (list) with key → 200 + jobs array", async () => {
  const r = await get("/api/runs", { "x-api-key": KEY });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.ok(Array.isArray(j.jobs));
});

test("GET /api/runs/:id unknown → 404", async () => {
  const r = await get("/api/runs/nope", { "x-api-key": KEY });
  assert.equal(r.status, 404);
});

test("POST /api/runs/:id/stop unknown → 404", async () => {
  const r = await post("/api/runs/nope/stop", {}, { "x-api-key": KEY });
  assert.equal(r.status, 404);
});

test("GET /api/runs list without key → 401", async () => {
  const r = await get("/api/runs");
  assert.equal(r.status, 401);
});

test("GET /api/health exposes a stable daemon identity to anyone, and nothing else", async () => {
  // Health stays reachable without a session — it is how the UI notices a restart — so it must
  // not hand a stranger the absolute gateway path (which leaks the OS username), the Slack
  // workspace/bot identity, or an authEnabled flag advertising an open API.
  const first = await (await get("/api/health")).json();
  const second = await (await get("/api/health")).json();
  assert.match(first.instanceId, /^[0-9a-f-]{36}$/i);
  assert.equal(second.instanceId, first.instanceId, "restart detection still works unauthenticated");
  for (const leaky of ["revision", "gatewayRoot", "claude", "engines", "authEnabled", "warmSessions"]) {
    assert.equal(first[leaky], undefined, `${leaky} must not be served to an unauthenticated caller`);
  }
  // `slack` is the exception, and only its non-identifying half: a liveness probe has to be able
  // to tell a connected daemon from a wedged one (see test/health-liveness.test.js).
  assert.deepEqual(first.slack, { status: "disconnected", connected: false });
  assert.equal("team" in first.slack, false, "the workspace identity still needs a session");
});

test("GET /api/health gives an authenticated admin the full diagnostic payload", async () => {
  const login = await post("/api/login", { password: "test-admin-pw" });
  const cookie = login.headers.get("set-cookie").split(";", 1)[0];
  const body = await (await get("/api/health", { cookie })).json();

  assert.match(body.instanceId, /^[0-9a-f-]{36}$/i);
  assert.match(body.revision, /^[0-9a-f]{40}$/i);
  assert.equal(body.update, null);
  assert.equal(typeof body.gatewayRoot, "string");
  assert.equal(body.slack.team, "Make it Future", "the workspace identity a stranger is denied");
  assert.equal(body.slack.botUserId, "U0BB");
});

test("GET /api/health serves the updater's revision to the same-machine internal secret", async () => {
  // The detached self-updater has no browser session, so it identifies itself with the internal
  // secret instead. If this ever stops returning `revision`, baselineFailure() sees "(unknown)"
  // and every admin-UI update refuses before it starts (regression: the health endpoint was
  // narrowed without updating its one non-browser caller).
  const body = await (await get("/api/health", { "x-cg-secret": "internal-test-secret" })).json();
  assert.match(body.revision, /^[0-9a-f]{40}$/i);
  assert.equal(typeof body.claude, "object");

  const wrong = await (await get("/api/health", { "x-cg-secret": "not-the-secret" })).json();
  assert.equal(wrong.revision, undefined, "a wrong secret is exactly a stranger");
  assert.match(wrong.instanceId, /^[0-9a-f-]{36}$/i);
});

test("the real updater's healthAt reads a revision baselineFailure accepts", async () => {
  // Crosses the seam the two half-suites never met at: the actual runner function against the
  // actual route. Both sides were self-consistently tested while the flow between them was broken.
  const { baselineFailure, healthAt } = await import("../scripts/update-runner.mjs");
  const health = await healthAt({ port: server.address().port, secret: "internal-test-secret" });
  // Only the revision gate is asserted — whether a `claude` binary exists is a property of the
  // machine running the suite, not of this wiring.
  assert.doesNotMatch(baselineFailure(health, { expectedRevision: health.revision }), /revision/);
});

test("POST /api/update/run returns the transaction and rejects an overlapping update", async () => {
  const login = await post("/api/login", { password: "test-admin-pw" });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";", 1)[0];

  // Cookie-authenticated mutations carry the CSRF marker the admin UI sends (see web/auth.js).
  const started = await post("/api/update/run", {}, { cookie, "x-cg-request": "1" });
  assert.equal(started.status, 202);
  const body = await started.json();
  assert.equal(body.transaction.id, "tx-web");
  assert.equal(lastUpdateStartOptions.source, "admin-ui");

  updateStartResult = {
    ok: false,
    conflict: true,
    transaction: { id: "tx-existing", status: "running", phase: "testing" },
  };
  const conflict = await post("/api/update/run", {}, { cookie, "x-cg-request": "1" });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).transaction.id, "tx-existing");
});

test("POST /internal/update-smoke requires loopback IPC auth", async () => {
  const missing = await post("/internal/update-smoke", {});
  assert.equal(missing.status, 403);
  const wrong = await post("/internal/update-smoke", {}, { "x-cg-secret": "wrong" });
  assert.equal(wrong.status, 403);
  assert.equal(updateSmokeCalls, 0);
});

test("POST /internal/update-smoke runs the injected smoke without admin login", async () => {
  const response = await post("/internal/update-smoke", {}, { "x-cg-secret": "internal-test-secret" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, durationMs: 7 });
  assert.equal(updateSmokeCalls, 1);
});

test("POST /internal/restart requires loopback IPC auth and queues the safe coordinator", async () => {
  const missing = await post("/internal/restart", { reason: "unsafe" });
  assert.equal(missing.status, 403);
  assert.equal(restartRequests.length, 0);

  const response = await post(
    "/internal/restart",
    { channelId: "C1", threadKey: "1.0", requestedBy: "U1", reason: "safe test" },
    { "x-cg-secret": "internal-test-secret" },
  );
  assert.equal(response.status, 202);
  assert.equal((await response.json()).id, "restart-web");
  assert.deepEqual(restartRequests, [{ channelId: "C1", threadKey: "1.0", requestedBy: "U1", reason: "safe test" }]);
});

test("admin restart endpoint queues and reports safe restart status", async () => {
  const login = await post("/api/login", { password: "test-admin-pw" });
  const cookie = login.headers.get("set-cookie").split(";", 1)[0];
  const started = await post("/api/daemon/restart", {}, { cookie, "x-cg-request": "1" });
  assert.equal(started.status, 202);
  assert.equal((await started.json()).id, "restart-web");

  const status = await get("/api/daemon/restart/status?id=restart-web", { cookie });
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), {
    ok: true,
    id: "restart-web",
    phase: "waiting",
    activity: { total: 2 },
    message: "Waiting for ongoing work.",
  });
});
