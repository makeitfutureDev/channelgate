// The Google Chat HTTP endpoint: the bearer check that is its whole authentication boundary, the
// synchronous acknowledgement that keeps Chat from printing "unable to process your request", and
// the hand-off into the SAME transport handler the Pub/Sub puller feeds. Google is never reached:
// tokens are minted here with a throwaway RSA key and the key sets are fakes.
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createSign } from "node:crypto";
import express from "express";

import { ensureTestEnv } from "./helpers.js";
import { createGoogleJwks, verifyGoogleChatRequest, googleChatSenders, CHAT_SYSTEM_ACCOUNT, ADDON_SERVICE_ACCOUNT } from "../src/platforms/googlechat/verify.js";
import { createGoogleChatWebhook, GOOGLE_CHAT_EVENTS_PATH } from "../src/platforms/googlechat/webhook.js";
import { parseChatEvent } from "../src/platforms/googlechat/events.js";
import { startGoogleChat } from "../src/platforms/googlechat/transport.js";
import { googleChatAdapter } from "../src/platforms/googlechat.js";

ensureTestEnv();

const ENDPOINT = "https://gateway.example/api/googlechat/events";
const APP_SA = "service-123456789012@gcp-sa-gsuiteaddons.iam.gserviceaccount.com";
const PROJECT = "123456789012";
const keyA = generateKeyPairSync("rsa", { modulusLength: 2048 });
const keyB = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwkOf = (pair, kid) => ({ ...pair.publicKey.export({ format: "jwk" }), kid, use: "sig", alg: "RS256" });
const b64 = value => Buffer.from(JSON.stringify(value)).toString("base64url");
const nowSec = () => Math.floor(Date.now() / 1000);

function mint({ pair = keyA, kid = "a", alg = "RS256", iss = "https://accounts.google.com", aud = ENDPOINT, email = APP_SA, email_verified = true, exp = nowSec() + 300, iat = nowSec() - 5, extra = {} } = {}) {
  const head = b64({ alg, kid, typ: "JWT" });
  const claims = b64({ iss, aud, email, email_verified, exp, iat, ...extra });
  const signer = createSign("RSA-SHA256");
  signer.update(`${head}.${claims}`);
  return `${head}.${claims}.${signer.sign(pair.privateKey).toString("base64url")}`;
}
const fakeKeys = (...entries) => ({ async get(kid) { return entries.find(k => k.kid === kid) || null; } });
const oidcKeys = fakeKeys(jwkOf(keyA, "a"));
const chatKeys = fakeKeys(jwkOf(keyB, "b"));
const verify = (token, overrides = {}) => verifyGoogleChatRequest({ authorization: `Bearer ${token}`, endpointUrl: ENDPOINT, appServiceAccount: APP_SA, projectNumber: PROJECT, oidcKeys, chatKeys, ...overrides });

// ── bearer verification ───────────────────────────────────────────────────────

test("an add-on ID token for this endpoint from this app's service account verifies", async () => {
  const result = await verify(mint());
  assert.equal(result.ok, true);
  assert.equal(result.sender, APP_SA);
  assert.equal((await verify(mint({ aud: `${ENDPOINT}/` }))).ok, true, "a trailing slash on the audience is tolerated");
  assert.equal((await verify(mint({ iss: "accounts.google.com", email: APP_SA.toUpperCase() }))).ok, true, "the bare issuer form and case-folded email are the same sender");
  assert.equal((await verify(mint({ email: CHAT_SYSTEM_ACCOUNT }))).ok, true, "Google's shared Chat account is always an accepted sender");
});

test("every forged, foreign, stale or mis-signed token is refused with a log reason only", async () => {
  const cases = {
    "missing bearer token": { authorization: "" },
    "malformed token": { authorization: "Bearer not.a-jwt" },
    "unsupported token header": { authorization: `Bearer ${mint({ alg: "HS256" })}` },
    "unexpected issuer": { authorization: `Bearer ${mint({ iss: "https://evil.example" })}` },
    "audience is not this endpoint": { authorization: `Bearer ${mint({ aud: "https://other.example/api/googlechat/events" })}` },
    "sender email not verified": { authorization: `Bearer ${mint({ email_verified: false })}` },
    "sender is not this Chat app": { authorization: `Bearer ${mint({ email: "service-999@gcp-sa-gsuiteaddons.iam.gserviceaccount.com" })}` },
    "token expired": { authorization: `Bearer ${mint({ exp: nowSec() - 600 })}` },
    "token not yet valid": { authorization: `Bearer ${mint({ extra: { nbf: nowSec() + 900 } })}` },
    "unknown signing key": { authorization: `Bearer ${mint({ kid: "zzz" })}` },
    "bad signature": { authorization: `Bearer ${mint({ pair: keyB, kid: "a" })}` },
  };
  for (const [reason, overrides] of Object.entries(cases)) {
    const result = await verifyGoogleChatRequest({ endpointUrl: ENDPOINT, appServiceAccount: APP_SA, projectNumber: PROJECT, oidcKeys, chatKeys, ...overrides });
    assert.equal(result.ok, false, reason);
    assert.equal(result.reason, reason);
  }
  // An add-on token verifies only against the deployment's OWN sender: with no app account
  // configured, the add-on identity is unknown and the request fails closed.
  assert.equal((await verify(mint(), { appServiceAccount: "" })).reason, "sender is not this Chat app");
  // Without a Public URL nothing can be the audience, however well signed.
  assert.equal((await verify(mint(), { endpointUrl: "" })).reason, "audience is not this endpoint");
  assert.equal((await verify(mint({ aud: [ENDPOINT, "https://other.example"] }))).reason, "audience is not this endpoint");
  assert.equal((await verify(mint(), { oidcKeys: undefined })).reason, "unknown signing key", "no key set is a refusal, not a crash");
  assert.equal((await verify(mint(), { oidcKeys: { get: async () => { throw new Error("offline"); } } })).reason, "unknown signing key");
});

test("a standalone app's project-number JWT verifies against Google's Chat account keys only", async () => {
  const legacy = overrides => mint({ pair: keyB, kid: "b", iss: CHAT_SYSTEM_ACCOUNT, aud: PROJECT, email: undefined, email_verified: undefined, ...overrides });
  const result = await verify(legacy());
  assert.equal(result.ok, true);
  assert.equal(result.sender, CHAT_SYSTEM_ACCOUNT);
  assert.equal((await verify(legacy({ aud: "999" }))).reason, "audience is not this project");
  assert.equal((await verify(legacy(), { projectNumber: "" })).reason, "audience is not this project");
  assert.equal((await verify(legacy({ pair: keyA, kid: "a" }))).reason, "unknown signing key", "the OIDC key set never signs a project-number token");
});

test("the key cache fetches Google once, refreshes for an unknown kid at most once a minute, and keeps old keys on failure", async () => {
  let fetches = 0;
  let now = 1_000_000;
  let fail = false;
  const fetchImpl = async () => { fetches += 1; if (fail) return { ok: false, status: 503 }; return { ok: true, json: async () => ({ keys: [jwkOf(keyA, "a"), { kty: "EC", kid: "ec" }] }) }; };
  const jwks = createGoogleJwks({ url: "https://www.googleapis.com/oauth2/v3/certs", fetchImpl, now: () => now });
  assert.ok(await jwks.get("a"));
  assert.equal(await jwks.get("ec"), null, "non-RSA keys are dropped");
  assert.equal(fetches, 1);
  assert.equal(await jwks.get("unknown"), null);
  assert.equal(fetches, 1, "an unknown kid within a minute of the last fetch does not refetch");
  now += 61_000;
  assert.equal(await jwks.get("unknown"), null);
  assert.equal(fetches, 2);
  fail = true; now += 25 * 60 * 60 * 1000;
  assert.ok(await jwks.get("a"), "a failed refresh keeps the cached keys");
  assert.throws(() => createGoogleJwks({ url: "https://evil.example/certs" }), /www\.googleapis\.com/);
  assert.deepEqual([...googleChatSenders(" X@Y.gserviceaccount.com ")], [CHAT_SYSTEM_ACCOUNT, "x@y.gserviceaccount.com"]);
  assert.ok(ADDON_SERVICE_ACCOUNT.test(APP_SA));
});

// ── the handler ───────────────────────────────────────────────────────────────

function fakeRes() {
  const res = { statusCode: 200, body: undefined, headersSent: false };
  res.status = code => { res.statusCode = code; return res; };
  res.json = body => { res.body = body; res.headersSent = true; return res; };
  return res;
}
const req = (body, authorization = "Bearer x") => ({ body, get: name => (name.toLowerCase() === "authorization" ? authorization : undefined) });

test("the handler answers 503 with the remedy, 401 on a refused token, 400 on a non-object, 500 when intake fails, and {} on success", async () => {
  const seen = [];
  const logs = [];
  let enabled = true;
  let verdict = { ok: true, sender: APP_SA };
  const handler = createGoogleChatWebhook({
    enabled: () => (enabled ? true : "Google Chat endpoint is not enabled: set the gateway Public URL and reconnect Google Chat"),
    verify: async authorization => { logs.push(authorization); return verdict; },
    onEvent: async (envelope, attributes, metadata) => { seen.push({ envelope, attributes, metadata }); if (envelope.boom) throw new Error("db closed"); },
    log: { warn: m => logs.push(m), error: m => logs.push(m) },
  });
  assert.equal(GOOGLE_CHAT_EVENTS_PATH, "/api/googlechat/events");
  let res = fakeRes(); enabled = false;
  await handler(req({ chat: {} }), res);
  assert.equal(res.statusCode, 503); assert.match(res.body.error, /Public URL/);
  enabled = true; verdict = { ok: false, reason: "bad signature" };
  res = fakeRes(); await handler(req({ chat: {} }), res);
  assert.equal(res.statusCode, 401); assert.deepEqual(res.body, { error: "unauthorized" });
  assert.ok(logs.some(l => /rejected: bad signature/.test(String(l))), "the reason reaches the log, never the body");
  assert.equal(seen.length, 0, "a refused request never reaches intake");
  verdict = { ok: true, sender: APP_SA };
  res = fakeRes(); await handler(req([1]), res);
  assert.equal(res.statusCode, 400);
  res = fakeRes(); await handler(req({ boom: true }), res);
  assert.equal(res.statusCode, 500);
  res = fakeRes(); await handler(req({ chat: { user: { name: "users/1" } } }), res);
  assert.equal(res.statusCode, 200); assert.deepEqual(res.body, {}, "an empty object is the synchronous acknowledgement");
  assert.equal(seen.at(-1).metadata.source, "http");
  assert.equal(seen.at(-1).metadata.sender, APP_SA);
  assert.match(seen.at(-1).metadata.messageId, /^http:[0-9a-f]{32}$/);
  assert.deepEqual(seen.at(-1).attributes, {}, "no CloudEvent attributes exist on this path");
});

// ── event shapes the endpoint delivers without CloudEvent attributes ──────────

test("membership payloads and legacy membership types parse without ce-type attributes", () => {
  const space = { name: "spaces/AAA", displayName: "Ops" };
  assert.deepEqual(parseChatEvent({ chat: { addedToSpacePayload: { space } } }), { type: "membership.added", space, membership: {} });
  assert.deepEqual(parseChatEvent({ chat: { removedFromSpacePayload: { space } } }), { type: "membership.removed", space, membership: {} });
  assert.equal(parseChatEvent({ type: "ADDED_TO_SPACE", space }).type, "membership.added");
  assert.equal(parseChatEvent({ type: "REMOVED_FROM_SPACE", space }).type, "membership.removed");
  assert.equal(parseChatEvent({ chat: { buttonClickedPayload: { space, message: { name: "spaces/AAA/messages/1" } }, user: { name: "users/1" } } }).type, "card");
  assert.equal(parseChatEvent({ chat: { messagePayload: { space, message: { name: "spaces/AAA/messages/1" } } } }).type, "message");
});

// ── end to end through Express and the real transport ─────────────────────────

const MESSAGE = { name: "spaces/AAA/messages/1", text: "@Bot hello", argumentText: " hello", sender: { name: "users/9", displayName: "Ana", email: "ana@example.com", type: "HUMAN" }, annotations: [{ type: "USER_MENTION", userMention: { user: { name: "users/bot", type: "BOT" } } }] };
const SPACE = { name: "spaces/AAA", displayName: "Ops", spaceType: "SPACE" };
const tick = () => new Promise(resolve => setImmediate(resolve));

test("a clicked button and a message POSTed by Google reach the transport's card and message handlers, acknowledged with {}", async () => {
  const delivered = [];
  const cards = [];
  const reconciles = [];
  const transport = await startGoogleChat({
    subscription: "projects/cg-test/subscriptions/http-lane", endpointUrl: `${ENDPOINT}/`, appServiceAccount: APP_SA,
    capabilities: googleChatAdapter.capabilities,
    onMessage: async message => { delivered.push(message); },
    onCard: async card => { cards.push(card); },
    log: {}, deps: { auth: { token: async () => "tok", reset() {} }, api: {}, connector: { platform: "googlechat" }, puller: { start() {}, async stop() {} }, oidcKeys, chatKeys },
  });
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.post(GOOGLE_CHAT_EVENTS_PATH, (req, res) => transport.handler(req, res));
  const server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}${GOOGLE_CHAT_EVENTS_PATH}`;
  const post = (body, token = mint()) => fetch(base, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  try {
    assert.equal(transport.endpointUrl, ENDPOINT);
    assert.match(transport.detail, /endpoint https:\/\/gateway\.example\/api\/googlechat\/events/);
    const click = { chat: { user: { name: "users/1", email: "ana@example.com", type: "HUMAN" }, eventTime: "2026-10-14T10:00:00Z",
      buttonClickedPayload: { space: SPACE, message: { ...MESSAGE, name: "spaces/AAA/messages/card", sender: { name: "users/bot", type: "BOT" } } } },
      commonEventObject: { parameters: { cgAction: "settings.page", stateId: "state", page: "\"general\"" } } };
    let res = await post(click);
    assert.equal(res.status, 200); assert.deepEqual(await res.json(), {});
    await tick();
    assert.equal(cards.length, 1);
    assert.equal(cards[0].action.function, "settings.page");
    assert.equal(cards[0].userId, "ana@example.com");
    res = await post(click);
    assert.equal(res.status, 200, "a redelivered identical click is acknowledged");
    await tick();
    assert.equal(cards.length, 1, "…but handled once");
    res = await post({ chat: { messagePayload: { space: SPACE, message: MESSAGE } } });
    assert.equal(res.status, 200);
    await tick();
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].text, "hello");
    assert.equal(delivered[0].mentionsBot, true);
    res = await post({ chat: { messagePayload: { space: SPACE, message: { ...MESSAGE, name: "spaces/AAA/messages/2" } } } }, mint({ email: "service-999@gcp-sa-gsuiteaddons.iam.gserviceaccount.com" }));
    assert.equal(res.status, 401);
    res = await post({ chat: { messagePayload: { space: SPACE, message: { ...MESSAGE, name: "spaces/AAA/messages/3" } } } }, "");
    assert.equal(res.status, 401);
    await tick();
    assert.equal(delivered.length, 1, "a stranger's token delivers nothing");
    res = await post({ chat: { addedToSpacePayload: { space: SPACE } } });
    assert.equal(res.status, 200, "membership on the endpoint is acknowledged");
    res = await post({ chat: { buttonClickedPayload: { space: { name: "spaces/FOREIGN" }, message: { name: "spaces/AAA/messages/card" } }, user: { name: "users/1" } } });
    assert.equal(res.status, 200, "an invalid click is acknowledged and dropped");
    await tick();
    assert.equal(cards.length, 1);
    void reconciles;
  } finally { server.closeAllConnections(); server.close(); await transport.stop(); }
});

test("without a Public URL or project number the endpoint reports the remedy instead of refusing silently", async () => {
  const transport = await startGoogleChat({
    subscription: "projects/cg-test/subscriptions/no-endpoint", capabilities: googleChatAdapter.capabilities,
    onMessage: async () => {}, log: {}, deps: { auth: { token: async () => "tok", reset() {} }, api: {}, connector: { platform: "googlechat" }, puller: { start() {}, async stop() {} }, oidcKeys, chatKeys },
  });
  try {
    assert.match(transport.detail, /endpoint off \(set Public URL\)/);
    const res = fakeRes();
    await transport.handler(req({ chat: {} }, `Bearer ${mint()}`), res);
    assert.equal(res.statusCode, 503);
    assert.match(res.body.error, /set the gateway Public URL/);
  } finally { await transport.stop(); }
});

// ── the public route ──────────────────────────────────────────────────────────

test("POST /api/googlechat/events is mounted ahead of admin auth: 503 until connected, then the transport's handler answers", async () => {
  const { IncomingMessage, ServerResponse } = await import("node:http");
  const { Socket } = await import("node:net");
  const { createWebApp } = await import("../src/web/app.js");
  const slackStub = { snapshot: () => ({ status: "disconnected", connected: false }), getClient: () => null };
  let handler = null;
  const app = createWebApp({ slack: slackStub, transports: { googlechat: { getTransport: () => ({ handler }) } } });
  const post = (body, headers = {}) => new Promise((resolve, reject) => {
    const request = new IncomingMessage(new Socket());
    request.method = "POST"; request.url = GOOGLE_CHAT_EVENTS_PATH;
    const payload = Buffer.from(JSON.stringify(body));
    request.headers = { host: "evil.example", "content-type": "application/json", "content-length": String(payload.length), ...headers };
    const response = new ServerResponse(request);
    const chunks = [];
    response.write = chunk => { if (chunk && typeof chunk !== "function") chunks.push(Buffer.from(chunk)); return true; };
    response.end = chunk => { if (chunk && typeof chunk !== "function") chunks.push(Buffer.from(chunk)); resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }); return response; };
    response.on("error", reject);
    app(request, response);
    request.push(payload); request.push(null);
  });
  let res = await post({ chat: {} });
  assert.equal(res.status, 503, "no connected transport");
  assert.match(res.body, /not connected/);
  const calls = [];
  handler = async (req, rsp) => { calls.push({ body: req.body, auth: req.get("authorization") }); rsp.status(200).json({}); };
  res = await post({ chat: { user: { name: "users/1" } } }, { authorization: "Bearer t" });
  assert.equal(res.status, 200, "no admin cookie and a foreign Host header still reach the self-authenticating handler");
  assert.equal(res.body, "{}");
  assert.deepEqual(calls[0].body, { chat: { user: { name: "users/1" } } });
  assert.equal(calls[0].auth, "Bearer t");
  handler = async () => { throw new Error("boom"); };
  const silent = console.error; console.error = () => {};
  try { res = await post({ chat: {} }); } finally { console.error = silent; }
  assert.equal(res.status, 500);
});
