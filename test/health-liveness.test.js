// /api/health as a LIVENESS probe sees it. An operator watchdog is not a browser and holds no
// session, so the open view of this route is the only thing it can read — and a probe that cannot
// tell "up and connected to Slack" from "up but wedged offline" is worse than no probe at all.
// Regression: after the route was narrowed to volunteer nothing to a stranger, an external monitor
// read the missing `slack` as unknown, called a perfectly healthy daemon disconnected, and
// restarted it (@here-ing the channel) every 10 minutes indefinitely.
//
// The narrowing itself still holds: the workspace/bot identity and the connect error text (which
// can quote a token) never leave a session. Driven as a bare request handler — no socket — so it
// also runs in sandboxes where `listen` is refused.
import test from "node:test";
import assert from "node:assert/strict";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
process.env.ADMIN_PASSWORD = "test-admin-pw"; // authEnabled() → true: a stranger really is a stranger
process.env.CG_APPROVAL_SECRET = "internal-test-secret";

const { createWebApp } = await import("../src/web/app.js");

let snapshot = { status: "disconnected", connected: false };
const app = createWebApp({ slack: { snapshot: () => snapshot, getClient: () => null } });

function getHealth(headers = {}) {
  return new Promise((resolve) => {
    const socket = new Socket();
    // The internal-secret identity is loopback-gated, and a detached socket has no peer address.
    Object.defineProperty(socket, "remoteAddress", { value: "127.0.0.1", configurable: true });
    const request = new IncomingMessage(socket);
    request.method = "GET";
    request.url = "/api/health";
    request.headers = { host: "127.0.0.1:4747", ...headers };
    const response = new ServerResponse(request);
    const chunks = [];
    const collect = (chunk, encoding) => {
      if (chunk && typeof chunk !== "function") chunks.push(Buffer.from(chunk, typeof encoding === "string" ? encoding : undefined));
    };
    response.write = (chunk, encoding, done) => { collect(chunk, encoding); if (typeof done === "function") done(); return true; };
    response.end = (chunk, encoding, done) => {
      collect(chunk, encoding);
      if (typeof done === "function") done();
      resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      return response;
    };
    app(request, response);
  });
}

test("a connected daemon says so to a caller with no session", async () => {
  snapshot = { status: "connected", connected: true, user: "gatewaybot", team: "Make it Future", teamId: "T0BB", botUserId: "U0BB", error: null };
  const body = await getHealth();
  assert.deepEqual(body.slack, { status: "connected", connected: true }, "the connection state, exactly — nothing that names the workspace");
  assert.equal(body.ok, true);
});

test("a real outage is reported, but its error string is not", async () => {
  // The manager stores the raw connect failure, which routinely quotes the credential that failed.
  snapshot = { status: "error", connected: false, user: null, team: null, teamId: null, botUserId: null, error: "invalid_auth for xoxb-1234-secret" };
  const body = await getHealth();
  assert.deepEqual(body.slack, { status: "error", connected: false });
  assert.equal(JSON.stringify(body).includes("xoxb"), false, "no connect error text on the open view");
});

test("a reconnect in progress is distinguishable from a dead one, so a watchdog can wait it out", async () => {
  snapshot = { status: "connecting", connected: false, user: null, team: null, teamId: null, botUserId: null, error: null };
  const body = await getHealth();
  assert.deepEqual(body.slack, { status: "connecting", connected: false });
});

test("a manager with no state yet answers disconnected instead of omitting the field", async () => {
  // An absent answer is the one a monitor has to guess about, and guessing is how the loop started.
  snapshot = undefined;
  const body = await getHealth();
  assert.deepEqual(body.slack, { status: "disconnected", connected: false });
});

test("a caller who cannot identify itself still gets no engine or filesystem detail", async () => {
  // The liveness widening is exactly one field wide: everything the narrowing was for stays shut.
  snapshot = { status: "connected", connected: true, user: "gatewaybot", team: "Make it Future", teamId: "T0BB", botUserId: "U0BB", error: null };
  const body = await getHealth({ "x-cg-secret": "not-the-secret" });
  assert.deepEqual(Object.keys(body).sort(), ["instanceId", "ok", "slack"]);
});
