import test from "node:test";
import assert from "node:assert/strict";
import { createTeamsGraphEvents } from "../src/platforms/msteams/graph-events.js";

function fixture(options = {}) {
  const rows = new Map(), requests = [], messages = [], logs = [];
  let time = Date.parse("2026-09-09T10:00:00Z"), fail = null;
  const service = createTeamsGraphEvents({
    auth: { token: async () => "test-token" }, tenantId: "tenant",
    notificationUrl: "https://example.org/api/teams/graph", now: () => time,
    intervalMs: options.intervalMs || 60_000,
    enqueueNotifications: options.enqueueNotifications || null,
    log: (...args) => logs.push(args),
    store: { list: async () => [...rows.values()].map(row => ({ ...row })), put: async row => rows.set(row.conversationId, { ...row }), remove: async id => rows.delete(id) },
    onMessage: async (...args) => { if (options.failCallback) throw new Error("queue unavailable"); messages.push(args); },
    fetchImpl: async (url, init) => {
      requests.push({ url, ...init });
      if (fail) return { ok: false, status: fail };
      if (init.method === "DELETE") return { ok: true, status: 204 };
      if (url.includes("/subscriptions")) return { ok: true, status: 200, json: async () => ({ id: "sub-1", expirationDateTime: JSON.parse(init.body).expirationDateTime }) };
      return { ok: true, status: 200, json: async () => ({ id: "123", body: { content: "hello" } }) };
    },
  });
  const row = { conversationId: "teams:19:chat@thread.v2", resource: "/chats/19:chat@thread.v2/messages", context: { conversation: { id: "19:chat@thread.v2" } } };
  const notification = () => ({ subscriptionId: "sub-1", clientState: rows.get(row.conversationId)?.clientState, tenantId: "tenant", changeType: "updated", resource: "chats('19:chat@thread.v2')/messages('123')", resourceData: { id: "123" } });
  async function handle(body, query) {
    const response = { code: null, mime: null, body: null, status(code) { this.code = code; return this; }, type(mime) { this.mime = mime; return this; }, send(body) { this.body = body; return this; }, end() { return this; } };
    await service.handle({ body, query }, response);
    return response;
  }
  return { service, rows, row, notification, requests, messages, logs, handle, advance: ms => { time += ms; }, fail: status => { fail = status; } };
}

test("Graph creates scoped beta chat subscriptions, no encrypted data or lifecycle needed", async () => {
  const f = fixture();
  const row = await f.service.ensure(f.row);
  assert.equal(row.apiVersion, "beta");
  assert.match(row.clientState, /^[a-f0-9]{64}$/);
  const request = f.requests[0], body = JSON.parse(request.body);
  assert.equal(request.url, "https://graph.microsoft.com/beta/subscriptions");
  assert.equal(request.redirect, "error");
  assert.equal(body.includeResourceData, false);
  assert.equal(body.expirationDateTime, "2026-09-09T10:55:00.000Z");
  assert.equal(body.resource, "/chats/19%3Achat%40thread.v2/messages");
  await f.service.ensure(f.row);
  assert.equal(f.requests.length, 1);
  f.advance(21 * 60_000);
  await f.service.renew();
  assert.equal(f.requests[1].method, "PATCH");
  assert.equal(f.rows.get(f.row.conversationId).clientState, row.clientState);
});

test("Graph uses stable channel API and permits only replies inside subscribed channel", async () => {
  const f = fixture();
  await f.service.ensure({ ...f.row, resource: "/teams/team-1/channels/channel-1/messages" });
  assert.match(f.requests[0].url, /\/v1\.0\/subscriptions$/);
  const notification = { ...f.notification(), resource: "teams('team-1')/channels('channel-1')/messages('root')/replies('123')" };
  assert.equal((await f.handle({ value: [notification] })).code, 200);
  assert.match(f.requests[1].url, /\/teams\/team-1\/channels\/channel-1\/messages\/root\/replies\/123$/);
  assert.equal(f.messages.length, 1);
});

test("Graph validation token is echoed plain text without authenticating or fetching", async () => {
  const f = fixture();
  const response = await f.handle(null, { validationToken: "opaque decoded + token" });
  assert.equal(response.code, 200);
  assert.equal(response.mime, "text/plain");
  assert.equal(response.body, "opaque decoded + token");
  assert.equal(f.requests.length, 0);
});

test("Graph rejects forged notifications, wrong scopes and URL traversal before GET", async () => {
  const f = fixture();
  await f.service.ensure(f.row);
  for (const patch of [
    { clientState: "wrong" }, { tenantId: "other" }, { subscriptionId: "unknown" },
    { resource: "chats('another')/messages('123')" },
    { resource: "https://evil.example/chats/19:chat@thread.v2/messages/123" },
    { resource: "chats('19:chat@thread.v2')/messages('%2e%2e%2fusers')" },
    { resource: "chats('19:chat@thread.v2')/messages('%2e%2e')", resourceData: { id: ".." } },
    { resourceData: { id: "different" } }, { changeType: "unknown" },
  ]) assert.equal((await f.handle({ value: [{ ...f.notification(), ...patch }] })).code, 403);
  assert.equal(f.requests.length, 1);
  assert.equal(f.messages.length, 0);
});

test("Graph validates entire batch before processing and retries GET/queue failure", async () => {
  const f = fixture();
  await f.service.ensure(f.row);
  assert.equal((await f.handle({ value: [f.notification(), { ...f.notification(), tenantId: "wrong" }] })).code, 403);
  assert.equal(f.requests.length, 1);
  f.fail(429);
  assert.equal((await f.handle({ value: [f.notification()] })).code, 503);
  f.fail(null);
  assert.equal((await f.handle({ value: [f.notification()] })).code, 200);
  assert.equal(f.messages.length, 1);
  const unavailable = fixture({ failCallback: true });
  await unavailable.service.ensure(unavailable.row);
  assert.equal((await unavailable.handle({ value: [unavailable.notification()] })).code, 503);
});

test("Graph preserves retryable state on create or renewal errors without logging secrets", async () => {
  const f = fixture();
  f.fail(403);
  await f.service.ensure(f.row);
  assert.equal(f.rows.size, 1);
  assert.equal(f.rows.get(f.row.conversationId).subscriptionId, null);
  f.fail(null);
  await f.service.renew();
  assert.equal(f.rows.get(f.row.conversationId).subscriptionId, "sub-1");
  f.advance(21 * 60_000);
  f.fail(500);
  await f.service.renew();
  assert.equal(f.rows.get(f.row.conversationId).renewedAt, Date.parse("2026-09-09T10:00:00Z"));
  f.fail(null);
  await f.service.renew();
  assert.equal(f.rows.get(f.row.conversationId).renewedAt, Date.parse("2026-09-09T10:21:00Z"));
  assert.ok(!JSON.stringify(f.logs).includes(f.rows.get(f.row.conversationId).clientState));
  assert.ok(!JSON.stringify(f.logs).includes("test-token"));
});

test("Graph stop clears repeated maintenance and start is idempotent", async () => {
  const f = fixture({ intervalMs: 10 });
  await f.service.ensure(f.row);
  f.advance(21 * 60_000);
  f.service.start(); f.service.start();
  await new Promise(resolve => setTimeout(resolve, 25));
  await f.service.stop();
  const count = f.requests.length;
  f.advance(21 * 60_000);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(f.requests.length, count);
  assert.equal(count, 2);
});

test("Graph scope changes are rejected and deleted messages never trigger", async () => {
  const f = fixture();
  await f.service.ensure(f.row);
  await assert.rejects(f.service.ensure({ ...f.row, resource: "/chats/other/messages" }), /scope changed/);
  assert.equal((await f.handle({ value: [{ ...f.notification(), changeType: "deleted" }] })).code, 200);
  assert.equal(f.requests.length, 1);
  assert.equal((await f.handle({ value: [] })).code, 400);
});

test("Graph notification URL change recreates subscription and uninstall revokes local delivery", async () => {
  const f = fixture();
  await f.service.ensure(f.row);
  const stored = f.rows.get(f.row.conversationId);
  stored.notificationUrl = "https://old.example/notifications";
  const previousSecret = stored.clientState;
  await f.service.renew();
  assert.equal(f.requests[1].method, "DELETE");
  assert.equal(f.requests[2].method, "POST");
  assert.notEqual(f.rows.get(f.row.conversationId).clientState, previousSecret);
  const priorEvent = f.notification();
  await f.service.remove(f.row.conversationId);
  assert.equal(f.rows.size, 0);
  assert.equal((await f.handle({ value: [priorEvent] })).code, 403);
  f.advance(1000);
  const installed = await f.service.ensure(f.row);
  assert.equal(installed.startedAt, "2026-09-09T10:00:01.000Z");
});


test("Graph acknowledges durable acceptance without waiting for message fetch and validates before enqueue", async () => {
  const queued = [];
  const f = fixture({ enqueueNotifications: async accepted => queued.push(accepted) });
  await f.service.ensure(f.row);
  assert.equal((await f.handle({ value: [f.notification()] })).code, 202);
  assert.equal(f.requests.length, 1); // no GET, even if the API would hang
  assert.equal(queued.length, 1);
  assert.equal((await f.handle({ value: [{ ...f.notification(), clientState: "forged" }] })).code, 403);
  assert.equal(queued.length, 1);
  await f.service.processNotifications(queued[0]);
  assert.equal(f.messages.length, 1);
  const count = f.requests.length;
  await f.service.remove(f.row.conversationId);
  await f.service.processNotifications(queued[0]);
  assert.equal(f.requests.length, count + 1); // DELETE only, revoked snapshot never fetched
});
