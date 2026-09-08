// The Microsoft Teams transport: Entra client-credentials auth, the Bot Framework REST client, the
// inbound JWT check (the ENTIRE authentication boundary for this surface, since the endpoint is
// public), activity normalization, and the webhook.
//
// The verification tests mint their own RSA keypair and serve it as a fake JWKS, so the real
// signature path runs — a test that stubbed verification would prove nothing about the one check
// standing between the daemon and anyone on the internet.
import test from "node:test";
import assert from "node:assert/strict";
import { createSign, generateKeyPairSync } from "node:crypto";

import { ensureTestEnv } from "./helpers.js";
import { createTeamsAuth } from "../src/platforms/msteams/auth.js";
import { createTeamsApi, validateServiceUrl, isConversationId, DEFAULT_SERVICE_URL } from "../src/platforms/msteams/api.js";
import { verifyTeamsRequest, createJwksCache, activityFingerprint } from "../src/platforms/msteams/verify.js";
import { normalizeActivity, stripMentionTags, splitConversationId, isAllowedDownloadUrl } from "../src/platforms/msteams/activity.js";
import { createTeamsWebhook } from "../src/platforms/msteams/webhook.js";
import { createTeamsConnector } from "../src/platforms/msteams/connector.js";
import { teamsAdapter } from "../src/platforms/msteams.js";
import { botIdFor } from "../src/platforms/msteams/transport.js";

ensureTestEnv();

const APP_ID = "11111111-2222-3333-4444-555555555555";
const BOT_ID = botIdFor(APP_ID);
const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
const fail = (status, body = "nope") => ({ ok: false, status, json: async () => ({}), text: async () => body });
const fakeAuth = () => ({ token: async () => "tok", reset: () => {} });

// ── outbound auth ─────────────────────────────────────────────────────────────

test("Entra's error description is what the operator sees, not just a 400", async () => {
  const auth = createTeamsAuth({
    clientId: APP_ID,
    clientSecret: "secret",
    fetchImpl: async () => fail(400, JSON.stringify({ error: "invalid_client", error_description: "AADSTS7000215: Invalid client secret provided." })),
  });
  await assert.rejects(auth.token(), /AADSTS7000215/);
});

test("a tenant id cannot smuggle a path into the token URL", () => {
  assert.throws(() => createTeamsAuth({ clientId: APP_ID, clientSecret: "s", tenantId: "../../evil.com/token" }), /outside the expected set/);
  assert.throws(() => createTeamsAuth({ clientId: "", clientSecret: "s" }), /app id and client secret/);
});

test("the token is cached and the scope is the Bot Framework audience", async () => {
  let calls = 0;
  let body = "";
  const auth = createTeamsAuth({
    clientId: APP_ID,
    clientSecret: "secret",
    fetchImpl: async (_url, init) => { calls += 1; body = init.body; return ok({ access_token: "t", expires_in: 3600 }); },
  });
  await auth.token();
  await auth.token();
  assert.equal(calls, 1);
  assert.match(new URLSearchParams(body).get("scope"), /api\.botframework\.com/);
});

// ── the serviceUrl allowlist ──────────────────────────────────────────────────

test("only a known Bot Framework host may receive our bearer token", () => {
  assert.equal(validateServiceUrl("https://smba.trafficmanager.net/teams/"), "https://smba.trafficmanager.net/teams/");
  assert.equal(validateServiceUrl("https://smba.trafficmanager.net/amer"), "https://smba.trafficmanager.net/amer/");
  assert.equal(validateServiceUrl("https://smba.infra.gov.teams.microsoft.us/"), "https://smba.infra.gov.teams.microsoft.us/");
  // The three shapes an attacker would try: their own host, http, and a lookalike subdomain.
  assert.equal(validateServiceUrl("https://evil.example/teams/"), "");
  assert.equal(validateServiceUrl("http://smba.trafficmanager.net/teams/"), "");
  assert.equal(validateServiceUrl("https://smba.trafficmanager.net.evil.example/"), "");
  assert.throws(() => createTeamsApi({ auth: fakeAuth(), serviceUrl: "https://evil.example/" }), /not a known Bot Framework host/);
});

test("a conversation id from the wire cannot escape the activities path", async () => {
  const api = createTeamsApi({ auth: fakeAuth(), fetchImpl: async () => ok({ id: "1" }) });
  await assert.rejects(api.sendActivity("../../v3/conversations/other", { text: "x" }), /outside the Bot Framework set/);
  await assert.rejects(api.sendActivity("19:abc@thread.tacv2", { text: "x", threadKey: "1;messageid=2" }), /outside the Bot Framework set/);
  assert.equal(isConversationId("19:a1b2@thread.tacv2"), true);
  assert.equal(isConversationId("19:abc;messageid=1"), false, "the reply suffix is ours to build, never to accept");
});

test("a channel reply threads by extending the conversation id, and markdown is declared", async () => {
  const calls = [];
  const api = createTeamsApi({ auth: fakeAuth(), fetchImpl: async (url, init) => { calls.push({ url: String(url), body: JSON.parse(init.body), method: init.method }); return ok({ id: "act-1" }); } });
  await api.sendActivity("19:abc@thread.tacv2", { text: "hi", threadKey: "1690000000000" });
  assert.match(decodeURIComponent(calls[0].url), /conversations\/19:abc@thread\.tacv2;messageid=1690000000000\/activities/);
  assert.equal(calls[0].body.textFormat, "markdown");

  await api.updateActivity("19:abc@thread.tacv2", "act-1", { text: "edited" });
  assert.equal(calls[1].method, "PUT");
  assert.match(decodeURIComponent(calls[1].url), /activities\/act-1$/);
});

test("a 429 is retried and a 403 is not", async () => {
  let calls = 0;
  const api = createTeamsApi({ auth: fakeAuth(), sleep: async () => {}, fetchImpl: async () => { calls += 1; return calls === 1 ? fail(429) : ok({ id: "1" }); } });
  await api.sendActivity("19:abc@thread.tacv2", { text: "x" });
  assert.equal(calls, 2);

  const api2 = createTeamsApi({ auth: fakeAuth(), sleep: async () => {}, fetchImpl: async () => fail(403) });
  await assert.rejects(api2.sendActivity("19:abc@thread.tacv2", { text: "x" }), /403/);
});

// ── inbound authentication ────────────────────────────────────────────────────

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const JWK = { ...publicKey.export({ format: "jwk" }), kid: "test-kid", kty: "RSA" };

function mintToken(claims = {}, { kid = "test-kid", key = privateKey } = {}) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: "https://api.botframework.com",
    aud: APP_ID,
    exp: Math.floor(Date.now() / 1000) + 600,
    nbf: Math.floor(Date.now() / 1000) - 10,
    serviceurl: DEFAULT_SERVICE_URL,
    ...claims,
  })).toString("base64url");
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(key, "base64url")}`;
}

function fakeJwks({ keys = [JWK] } = {}) {
  return createJwksCache({
    fetchImpl: async (url) => (String(url).includes("openidconfiguration")
      ? ok({ jwks_uri: "https://login.botframework.com/v1/.well-known/keys" })
      : ok({ keys })),
  });
}

test("a genuine Bot Framework token is accepted", async () => {
  const verdict = await verifyTeamsRequest({ authorization: `Bearer ${mintToken()}`, appId: APP_ID, serviceUrl: DEFAULT_SERVICE_URL, jwks: fakeJwks() });
  assert.equal(verdict.ok, true, verdict.reason);
});

test("every forgery shape is refused", async () => {
  const jwks = fakeJwks();
  const cases = [
    ["no header at all", { authorization: "" }],
    ["a token minted for another bot", { authorization: `Bearer ${mintToken({ aud: "99999999-0000-0000-0000-000000000000" })}` }],
    ["a token from another issuer", { authorization: `Bearer ${mintToken({ iss: "https://evil.example" })}` }],
    ["an expired token", { authorization: `Bearer ${mintToken({ exp: Math.floor(Date.now() / 1000) - 3600 })}` }],
    ["a token whose serviceUrl was tampered with", { authorization: `Bearer ${mintToken({ serviceurl: "https://evil.example/" })}` }],
    ["a token signed by an unknown key", { authorization: `Bearer ${mintToken({}, { kid: "not-published" })}` }],
  ];
  for (const [label, extra] of cases) {
    const verdict = await verifyTeamsRequest({ appId: APP_ID, serviceUrl: DEFAULT_SERVICE_URL, jwks, ...extra });
    assert.equal(verdict.ok, false, `${label} must be refused`);
  }
});

test("a re-signed token (right claims, wrong key) is refused", async () => {
  const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  const verdict = await verifyTeamsRequest({
    authorization: `Bearer ${mintToken({}, { key: other })}`,
    appId: APP_ID, serviceUrl: DEFAULT_SERVICE_URL, jwks: fakeJwks(),
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /signature/);
});

test("an unsigned 'alg: none' token is refused before any key lookup", async () => {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iss: "https://api.botframework.com", aud: APP_ID, exp: Math.floor(Date.now() / 1000) + 600 })).toString("base64url");
  const verdict = await verifyTeamsRequest({ authorization: `Bearer ${header}.${payload}.`, appId: APP_ID, jwks: fakeJwks() });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /alg/);
});

test("the OpenID document cannot point the key fetch at an arbitrary host", async () => {
  const jwks = createJwksCache({
    fetchImpl: async (url) => (String(url).includes("openidconfiguration") ? ok({ jwks_uri: "https://evil.example/keys" }) : ok({ keys: [JWK] })),
  });
  await assert.rejects(jwks.get("test-kid"), /unexpected jwks_uri/);
});

// ── activity normalization ────────────────────────────────────────────────────

const ACTIVITY = {
  type: "message",
  id: "1690000000000",
  text: '<at>Jarvis</at> what is the status?',
  serviceUrl: DEFAULT_SERVICE_URL,
  from: { id: "29:user-1", name: "Ana Pop", aadObjectId: "aad-1" },
  conversation: { id: "19:abc@thread.tacv2", conversationType: "channel", tenantId: "tenant-1", name: "Ops" },
  entities: [{ type: "mention", mentioned: { id: BOT_ID, name: "Jarvis" } }],
};

test("the bot's own mention tag never reaches the model", () => {
  assert.equal(stripMentionTags('<at>Jarvis</at> hello'), "hello");
  assert.equal(stripMentionTags('hi <at id="1">Jarvis</at> there'), "hi there");
});

test("a channel reply-chain id is split back into conversation and thread", () => {
  assert.deepEqual(splitConversationId("19:abc@thread.tacv2;messageid=1690"), { conversationId: "19:abc@thread.tacv2", threadKey: "1690" });
  assert.deepEqual(splitConversationId("19:abc@thread.tacv2"), { conversationId: "19:abc@thread.tacv2", threadKey: "" });
});

test("an activity becomes a namespaced, gated inbound message", () => {
  const message = normalizeActivity(ACTIVITY, { botId: BOT_ID });
  assert.equal(message.platform, "msteams");
  assert.equal(message.conversationId, "teams:19:abc@thread.tacv2");
  assert.equal(message.rawConversationId, "19:abc@thread.tacv2");
  assert.equal(message.kind, "channel");
  assert.equal(message.mentionsBot, true);
  assert.equal(message.text, "what is the status?");
  // A channel message is its own thread root, so the reply lands under the user's message.
  assert.equal(message.threadKey, "1690000000000");
  assert.equal(message.raw.tenantId, "tenant-1");
});

test("a personal chat is a DM and needs no mention; a non-message activity is not a turn", () => {
  const dm = normalizeActivity({ ...ACTIVITY, entities: [], text: "hello", conversation: { id: "a:1", conversationType: "personal" } }, { botId: BOT_ID });
  assert.equal(dm.kind, "dm");
  assert.equal(dm.isDM, true);
  assert.equal(dm.threadKey, "", "a 1:1 chat is flat");
  assert.equal(normalizeActivity({ ...ACTIVITY, type: "conversationUpdate" }, { botId: BOT_ID }), null);
  assert.equal(normalizeActivity({ ...ACTIVITY, from: { id: BOT_ID } }, { botId: BOT_ID }), null, "our own echo");
});

test("an attachment download URL is fetched only from Microsoft hosts", () => {
  assert.equal(isAllowedDownloadUrl("https://contoso.sharepoint.com/x/y.pdf"), true);
  assert.equal(isAllowedDownloadUrl("https://eu-api.svc.ms/download?x=1"), true);
  assert.equal(isAllowedDownloadUrl("http://contoso.sharepoint.com/x"), false);
  assert.equal(isAllowedDownloadUrl("https://evil.example/x"), false);
  // The classic SSRF target: the daemon's own admin API.
  assert.equal(isAllowedDownloadUrl("http://127.0.0.1:4747/api/settings"), false);

  const message = normalizeActivity({
    ...ACTIVITY,
    attachments: [
      { contentType: "text/html", content: "<p>mirrored body</p>" },
      { contentType: "application/vnd.microsoft.card.adaptive", content: {} },
      { contentType: "application/vnd.microsoft.teams.file.download.info", name: "plan.pdf", content: { downloadUrl: "https://contoso.sharepoint.com/plan.pdf", fileType: "pdf" } },
      { contentType: "application/vnd.microsoft.teams.file.download.info", name: "evil.pdf", content: { downloadUrl: "https://evil.example/evil.pdf" } },
    ],
  }, { botId: BOT_ID });
  assert.deepEqual(message.attachments.map((a) => a.name), ["plan.pdf", "evil.pdf"]);
  assert.equal(typeof message.attachments[0].download, "function");
  assert.equal(message.attachments[1].download, null, "a non-Microsoft URL is recorded but never fetched");
});

// ── the webhook ───────────────────────────────────────────────────────────────

function fakeRes() {
  return {
    statusCode: 0, body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

test("an unauthenticated POST is refused and never reaches the gateway", async () => {
  let called = 0;
  const handler = createTeamsWebhook({ appId: APP_ID, botId: BOT_ID, jwks: fakeJwks(), onMessage: () => { called += 1; }, log: { warn: () => {} } });
  const res = fakeRes();
  await handler({ body: ACTIVITY, headers: {}, get: () => "" }, res);
  assert.equal(res.statusCode, 401);
  assert.equal(called, 0);
  assert.deepEqual(res.body, { error: "unauthorized" }, "the reason must not be echoed to a prober");
});

test("an authenticated activity is acked immediately and dispatched once", async () => {
  const seen = [];
  const handler = createTeamsWebhook({ appId: APP_ID, botId: BOT_ID, jwks: fakeJwks(), onMessage: (m) => { seen.push(m); }, log: { warn: () => {}, error: () => {} } });
  const auth = `Bearer ${mintToken()}`;
  const req = { body: ACTIVITY, headers: { authorization: auth }, get: () => auth };

  const first = fakeRes();
  await handler(req, first);
  assert.equal(first.statusCode, 200);
  assert.equal(seen.length, 1);

  // Bot Service retries anything it did not get a 2xx for, and Teams can deliver twice by itself.
  const second = fakeRes();
  await handler(req, second);
  assert.equal(second.statusCode, 200);
  assert.equal(seen.length, 1, "a redelivery must not run the turn again");
});

test("an activity naming a non-Bot-Framework serviceUrl is refused", async () => {
  let called = 0;
  const handler = createTeamsWebhook({ appId: APP_ID, botId: BOT_ID, jwks: fakeJwks(), onMessage: () => { called += 1; }, log: { warn: () => {} } });
  const auth = `Bearer ${mintToken({ serviceurl: "https://evil.example/" })}`;
  const res = fakeRes();
  await handler({ body: { ...ACTIVITY, serviceUrl: "https://evil.example/" }, headers: { authorization: auth }, get: () => auth }, res);
  assert.equal(res.statusCode, 401);
  assert.equal(called, 0);
});

test("the dedupe fingerprint distinguishes different activities", () => {
  assert.notEqual(activityFingerprint(ACTIVITY), activityFingerprint({ ...ACTIVITY, id: "other" }));
  assert.equal(activityFingerprint(ACTIVITY), activityFingerprint({ ...ACTIVITY }));
});

// ── connector ─────────────────────────────────────────────────────────────────

function fakeTeamsApi() {
  const calls = [];
  return {
    calls,
    async sendActivity(id, body) { calls.push({ op: "send", id, body }); return { messageId: "act-1" }; },
    async updateActivity(id, activityId, body) { calls.push({ op: "update", id, activityId, body }); },
    async deleteActivity(id, activityId) { calls.push({ op: "delete", id, activityId }); },
    async createConversation(args) { calls.push({ op: "conversation", args }); return "a:dm-1"; },
    async listMembers() { return [{ id: "29:1", name: "Ana Pop", email: "ana@example.com" }]; },
  };
}

test("mention entities travel with the chunk that still contains their tag", async () => {
  const api = fakeTeamsApi();
  const connector = createTeamsConnector({ auth: fakeAuth(), capabilities: teamsAdapter.capabilities, api, botId: BOT_ID });
  const mentions = [{ type: "mention", text: "<at>Ana Pop</at>", mentioned: { id: "29:1", name: "Ana Pop" } }];
  await connector.post({ conversationId: "teams:19:abc@thread.tacv2", threadKey: "1690", text: "<at>Ana Pop</at> done", mentions });
  assert.deepEqual(api.calls[0].body.entities, mentions);
  assert.equal(api.calls[0].id, "19:abc@thread.tacv2");
  assert.equal(api.calls[0].body.threadKey, "1690");
});

test("only a real activity id is used as a thread", () => {
  const connector = createTeamsConnector({ auth: fakeAuth(), capabilities: teamsAdapter.capabilities, api: fakeTeamsApi(), botId: BOT_ID });
  assert.equal(connector.threadFor("1690000000000"), "1690000000000");
  assert.equal(connector.threadFor("spaces/AAA/threads/T"), null);
  assert.equal(connector.supportsThreads("teams:19:abc@thread.tacv2"), true);
  assert.equal(connector.supportsThreads("teams:a:personal-chat"), false);
  assert.equal(connector.supportsThreads("teams:19:group@thread.v2"), false);
});

test("an ephemeral-only notice becomes a 1:1 chat, because Teams has no ephemeral message", async () => {
  const api = fakeTeamsApi();
  const connector = createTeamsConnector({ auth: fakeAuth(), capabilities: teamsAdapter.capabilities, api, botId: BOT_ID, tenantId: "tenant-1" });
  const posted = await connector.post({ conversationId: "19:abc@thread.tacv2", text: "only you", ephemeralTo: "29:user-1" });
  assert.equal(posted.ephemeral, true);
  assert.equal(api.calls[0].op, "conversation");
  assert.equal(api.calls[0].args.botId, BOT_ID);
  assert.equal(api.calls[1].id, "a:dm-1");
});

test("with no transport connected the Teams connector THROWS on a write", async () => {
  const connector = teamsAdapter.createConnector();
  await assert.rejects(connector.post({ conversationId: "19:a", text: "x" }), /cannot post/);
});

test("Teams quote references normalize current entities and legacy HTML without using replyToId", () => {
  const base = { type: "message", id: "200", from: { id: "29:user" }, conversation: { id: "19:quote@thread.v2", conversationType: "groupChat" }, text: "reply", replyToId: "not-a-chat-quote" };
  assert.equal(normalizeActivity(base).replyToId, "");
  const entity = { type: "quotedReply", quotedReply: { messageId: "100" } };
  assert.equal(normalizeActivity({ ...base, entities: [entity] }).replyToId, "100");
  assert.equal(normalizeActivity({ ...base, entities: [entity, entity] }).replyToId, "");
  for (const field of ["isReplyDeleted", "validatedMessageReference"]) {
    assert.equal(normalizeActivity({ ...base, entities: [{ ...entity, quotedReply: { messageId: "100", [field]: field === "isReplyDeleted" } }] }).replyToId, "");
  }
  const html = '<blockquote itemscope="" itemtype="http://schema.skype.com/Reply" itemid="100"><strong itemid="sender">User</strong></blockquote> hello';
  assert.equal(normalizeActivity({ ...base, text: html }).replyToId, "100");
  assert.equal(normalizeActivity({ ...base, attachments: [{ contentType: "text/html", content: html }] }).replyToId, "100");
  assert.equal(normalizeActivity({ ...base, text: '<blockquote itemid="100">ordinary quote</blockquote>' }).replyToId, "");
});

test("Teams connector never sends a synthetic group session key as a channel thread", async () => {
  let sent;
  const connector = createTeamsConnector({ capabilities: teamsAdapter.capabilities, api: { sendActivity: async (id, body) => { sent = { id, body }; return { messageId: "300" }; } } });
  await connector.post({ conversationId: "19:quote@thread.v2", threadKey: "group:100", text: "done" });
  assert.equal(sent.body.threadKey, "");
});
