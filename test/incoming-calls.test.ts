import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { ensureTestEnv } from "./helpers.js";
import type { PushConfig } from "../src/gateway/voice/apns.ts";
ensureTestEnv();
const { getDb } = await import("../src/db/index.js");
const { createIncomingCalls } = await import("../src/gateway/voice/incoming.ts");
const { providerToken, parsePushKey, pushHeaders } = await import("../src/gateway/voice/apns.ts");
const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const config: PushConfig = { enabled: true, teamId: "ABCDE12345", keyId: "FGHIJ67890", bundleId: "com.example.calls",
  privateKey: key.privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
const target = { ownerId: "U_PERSON", channelId: "C_THREAD", threadTs: "1700000000.000001" };
const registration = { platform: "ios", kind: "voip", token: "ab".repeat(32), bundleId: config.bundleId, environment: "sandbox", name: "Test phone" };
beforeEach(() => { getDb().exec("DELETE FROM user_devices; DELETE FROM incoming_calls;"); });
function fixture() {
  let clock = 1_000_000, allowed = true;
  const pushes: Record<string, unknown>[] = [], outcomes: string[] = [];
  const calls = createIncomingCalls({ config: () => config, now: () => clock, authorize: async () => allowed,
    voiceEnabled: () => true, send: async (_config, _device, payload) => { pushes.push(payload); return { status: 200, reason: "" }; },
    notify: async (_row, status) => { outcomes.push(status); } });
  return { calls, pushes, outcomes, tick: (ms: number) => { clock += ms; }, revoke: () => { allowed = false; } };
}
test("APNs JWT uses ES256 raw signature, correct claims and VoIP headers", () => {
  const token = providerToken(config, 1_000_000), [header, body, signature] = token.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), { alg: "ES256", kid: config.keyId });
  assert.deepEqual(JSON.parse(Buffer.from(body, "base64url").toString()), { iss: config.teamId, iat: 1000 });
  assert.equal(verify("sha256", Buffer.from(`${header}.${body}`), { key: key.publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url")), true);
  assert.equal(providerToken(config, 1_001_000), token);
  assert.notEqual(providerToken(config, 2_201_000), token);
  const headers = pushHeaders(config, { token: registration.token, environment: "sandbox" }, "invitation-id");
  assert.equal(headers["apns-topic"], "com.example.calls.voip");
  assert.equal(headers["apns-push-type"], "voip");
  assert.equal(headers["apns-expiration"], "0");
  assert.throws(() => parsePushKey("not a key"));
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  assert.throws(() => parsePushKey(rsa), /P-256/);
});
test("registration is bounded, owner scoped, survives service recreation, and never lists a token", () => {
  const f = fixture();
  const device = f.calls.registerDevice(target.ownerId, registration);
  assert.equal(f.calls.registerDevice(target.ownerId, registration).id, device.id);
  const listed = f.calls.listDevices(target.ownerId);
  assert.equal(listed.length, 1);
  assert.doesNotMatch(JSON.stringify(listed), new RegExp(registration.token));
  f.calls.removeDevice("OTHER", device.id);
  assert.equal(f.calls.listDevices(target.ownerId).length, 1);
  assert.equal(f.calls.listDevices("OTHER").length, 0);
  assert.throws(() => f.calls.registerDevice(target.ownerId, { ...registration, bundleId: "another.app" }));
  assert.throws(() => f.calls.registerDevice(target.ownerId, { ...registration, environment: "unknown" }));
  for (let i = 1; i < 10; i++) f.calls.registerDevice(target.ownerId, { ...registration, token: i.toString(16).padStart(64, "0") });
  assert.throws(() => f.calls.registerDevice(target.ownerId, { ...registration, token: "ff".repeat(32) }), /Remove an old device/);
  assert.equal(createIncomingCalls().listDevices(target.ownerId).length, 10);
});
test("accept binds recorded owner and thread and consumes invitation exactly once across devices", async () => {
  const f = fixture(); f.calls.registerDevice(target.ownerId, registration);
  const result = await f.calls.request(target, "Review this thread");
  const token = String(f.pushes[0].token);
  assert.doesNotMatch(JSON.stringify(getDb().prepare("SELECT * FROM incoming_calls").all()), new RegExp(token));
  assert.equal(result.delivered, 1);
  await assert.rejects(f.calls.accept("OTHER", token, async () => ({ id: "bad" })), /unavailable/);
  const received: unknown[] = [];
  const outcomes = await Promise.allSettled([1, 2].map(() => f.calls.accept(target.ownerId, token, async value => { received.push(value); return { id: "CALL" }; })));
  assert.equal(outcomes.filter(x => x.status === "fulfilled").length, 1);
  assert.deepEqual(received, [target]);
  await assert.rejects(f.calls.decline(target.ownerId, token));
});
test("pending call throttles retries; expiration and decline create notices once", async () => {
  const f = fixture(); f.calls.registerDevice(target.ownerId, registration);
  await f.calls.request(target, "Review");
  await assert.rejects(f.calls.request(target, "Again"), /pending|limit/);
  f.tick(46_000); await f.calls.flushNotices(); await f.calls.flushNotices();
  assert.deepEqual(f.outcomes, ["missed"]);
  await assert.rejects(f.calls.accept(target.ownerId, String(f.pushes[0].token), async () => ({ id: "BAD" })));
  f.tick(15_000); await f.calls.request(target, "Review again");
  await f.calls.decline(target.ownerId, String(f.pushes[1].token));
  assert.deepEqual(f.outcomes, ["missed", "declined"]);
});
test("revocation prevents both ringing and acceptance; failed acceptance consumes the token", async () => {
  const f = fixture(); f.calls.registerDevice(target.ownerId, registration);
  await f.calls.request(target, "Review"); f.revoke();
  await assert.rejects(f.calls.accept(target.ownerId, String(f.pushes[0].token), async () => ({ id: "BAD" })), /unavailable/);
  await assert.rejects(f.calls.request(target, "Review"), /access/);
});
test("delayed invitation is durable, checked at delivery, and token expires from ringing time", async () => {
  const f = fixture(); f.calls.registerDevice(target.ownerId, registration);
  const result = await f.calls.request(target, "Call in one minute", 1);
  assert.ok(result.scheduledAt); assert.equal(f.pushes.length, 0);
  await f.calls.flushNotices(); assert.equal(f.pushes.length, 0);
  f.tick(60_000); await f.calls.flushNotices();
  assert.equal(f.pushes.length, 1);
  await f.calls.accept(target.ownerId, String(f.pushes[0].token), async value => { assert.deepEqual(value, target); return { id: "call" }; });
});
test("revoked and stale schedules never deliver a VoIP push", async () => {
  const f = fixture(); f.calls.registerDevice(target.ownerId, registration);
  await f.calls.request(target, "Later", 1); f.revoke(); f.tick(60_000); await f.calls.flushNotices();
  assert.equal(f.pushes.length, 0); assert.deepEqual(f.outcomes, ["failed"]);
});
test("invalidated APNs registrations are removed and failed delivery is not reported as ringing", async () => {
  const f = fixture(); f.calls.registerDevice(target.ownerId, registration);
  const reject = createIncomingCalls({ config: () => config, voiceEnabled: () => true, authorize: async () => true,
    send: async () => ({ status: 410, reason: "Unregistered" }) });
  await assert.rejects(reject.request(target, "Review"), /Apple did not accept/);
  assert.equal(reject.listDevices(target.ownerId).length, 0);
  assert.equal((getDb().prepare("SELECT status FROM incoming_calls").get() as {status:string}).status, "failed");
});
test("APNs sender targets sandbox or production and handles accepted and rejected responses", async () => {
  const { createServer, connect } = await import("node:http2");
  const { sendVoipPush } = await import("../src/gateway/voice/apns.ts");
  const server = createServer();
  const received: {topic: unknown; type: unknown; payload: unknown}[] = [];
  let status = 200;
  server.on("stream", (stream, headers) => {
    let body = ""; stream.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    stream.on("end", () => {
      received.push({ topic: headers["apns-topic"], type: headers["apns-push-type"], payload: JSON.parse(body) });
      stream.respond({ ":status": status }); stream.end(status === 200 ? "" : JSON.stringify({ reason: "Unregistered" }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const destinations: string[] = [];
  const open = (host: string) => { destinations.push(host); return connect(`http://127.0.0.1:${address.port}`); };
  try {
    assert.deepEqual(await sendVoipPush(config, { token: registration.token, environment: "sandbox" }, { uuid: "test" }, "test", open), { status: 200, reason: "" });
    status = 410;
    assert.deepEqual(await sendVoipPush(config, { token: registration.token, environment: "production" }, { uuid: "test" }, "test", open), { status: 410, reason: "Unregistered" });
    assert.deepEqual(destinations, ["https://api.sandbox.push.apple.com", "https://api.push.apple.com"]);
    assert.equal(received[0].topic, "com.example.calls.voip");
    assert.equal(received[0].type, "voip");
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
test("failed acceptance is single-use and cancelling a scheduled call prevents delivery", async () => {
  const f = fixture(); f.calls.registerDevice(target.ownerId, registration);
  await f.calls.request(target, "Review"); const token = String(f.pushes[0].token);
  await assert.rejects(f.calls.accept(target.ownerId, token, async () => { throw new Error("voice offline"); }), /offline/);
  await assert.rejects(f.calls.accept(target.ownerId, token, async () => ({ id: "BAD" })));
  f.tick(61_000); const queued = await f.calls.request(target, "Later", 1);
  f.calls.cancel(target.ownerId, queued.id); f.tick(61_000); await f.calls.flushNotices();
  assert.equal(f.pushes.length, 1);
});
test("default admission requires both current channel authorization and actual thread participation", async () => {
  const { setUser, upsertChannelEntry, saveChannelMeta } = await import("../src/config/store.js");
  const { indexSlackThread } = await import("../src/gateway/slack-threads.js");
  await setUser(target.ownerId, { approved: true, isAdmin: false });
  const entry = await upsertChannelEntry(target.channelId, { name: "incoming-fixture", type: "channel", isDM: false });
  await saveChannelMeta(entry.slug, { channelId: target.channelId, access: "approved", isDM: false });
  const service = createIncomingCalls({ config: () => config, voiceEnabled: () => true,
    send: async () => ({ status: 200, reason: "" }), notify: async () => {} });
  service.registerDevice(target.ownerId, registration);
  await assert.rejects(service.request(target, "Review"), /access/);
  indexSlackThread({ channelId: target.channelId, slug: entry.slug,
    root: { ts: target.threadTs, user: target.ownerId, text: "Review this fixture" }, agentEngaged: true });
  assert.equal((await service.request(target, "Review")).delivered, 1);
  await saveChannelMeta(entry.slug, { channelId: target.channelId, access: "none", isDM: false });
  await assert.rejects(service.request(target, "Review"), /access/);
});
test("disabling incoming calls while ringing prevents a voice session from starting", async () => {
  let enabled = true, token = "", started = false;
  const service = createIncomingCalls({ config: () => ({ ...config, enabled }), voiceEnabled: () => true, authorize: async () => true,
    send: async (_c, _d, payload) => { token = String(payload.token); return { status: 200, reason: "" }; }, notify: async () => {} });
  service.registerDevice(target.ownerId, registration); await service.request(target, "Review"); enabled = false;
  await assert.rejects(service.accept(target.ownerId, token, async () => { started = true; return { id: "BAD" }; }), /unavailable/);
  assert.equal(started, false);
});
