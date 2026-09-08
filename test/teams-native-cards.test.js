import test from "node:test";
import assert from "node:assert/strict";
import { createSign, generateKeyPairSync } from "node:crypto";
import { approvalCard, modelSettingsCard, formCard, settingsCard, messageCard, adaptiveCardAttachment } from "../src/platforms/msteams/cards.js";
import { normalizeTeamsInteraction, createTeamsInteractionHandler } from "../src/platforms/msteams/interactions.js";
import { createTeamsWebhook } from "../src/platforms/msteams/webhook.js";
import { createTeamsApi, DEFAULT_SERVICE_URL } from "../src/platforms/msteams/api.js";
import { createTeamsConnector } from "../src/platforms/msteams/connector.js";

const APP = "11111111-2222-3333-4444-555555555555";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "card-key", use: "sig", alg: "RS256" };
function token(key = privateKey) {
  const head = Buffer.from(JSON.stringify({ alg: "RS256", kid: "card-key" })).toString("base64url");
  const body = Buffer.from(JSON.stringify({ iss: "https://api.botframework.com", aud: APP, exp: Math.floor(Date.now()/1000)+60, serviceurl: DEFAULT_SERVICE_URL })).toString("base64url");
  const signer = createSign("RSA-SHA256"); signer.update(`${head}.${body}`);
  return `${head}.${body}.${signer.sign(key, "base64url")}`;
}
const activity = (data = {}) => ({ type: "invoke", name: "adaptiveCard/action", id: "invoke-1", from: { id: "29:real", aadObjectId: "aad" },
  conversation: { id: "19:chat@thread.v2" }, serviceUrl: DEFAULT_SERVICE_URL, replyToId: "123",
  channelData: { tenant: { id: "tenant" } }, value: { action: { type: "Action.Execute", verb: "approval.respond", data: { id: "approval-1", decision: "approve", scope: "once", ...data } } } });
function response() { return { code: null, body: null, status(value) { this.code = value; return this; }, json(value) { this.body = value; return this; } }; }

test("native approval/model/settings cards provide Execute with Submit fallback and bounded preview", () => {
  const approval = approvalCard({ id: "one", details: "x".repeat(10_000), scopes: ["once", "thread", "forever"] });
  assert.match(approval.body[1].text, /Preview truncated/);
  assert.equal(approval.actions[0].verb, "approval.respond");
  assert.equal(approval.actions[0].fallback.type, "Action.Submit");
  assert.equal(approval.actions[0].fallback.data.decision, "approve");
  assert.equal(approval.actions[1].associatedInputs, "none");
  assert.equal(approval.body[2].choices[2].value, "forever");
  const model = modelSettingsCard({ catalog: Array.from({ length: 60 }, (_, i) => ({ id: `model-${i}`, label: `Model ${i}` })), current: { model: "model-1" } });
  assert.equal(model.body[2].choices.length, 50);
  assert.equal(model.body[2].value, "model-1");
  assert.match(model.body.at(-1).text, /truncated/);
  assert.equal(settingsCard({ items: [{ id: "models", label: "Models" }] }).actions[0].data.section, "models");
  assert.equal(adaptiveCardAttachment(messageCard({ text: "ok" })).contentType, "application/vnd.microsoft.card.adaptive");
  assert.throws(() => adaptiveCardAttachment({ type: "AdaptiveCard", body: [{ text: "x".repeat(25_000) }] }), /size/);
});

test("card forms reject reserved fields, unsupported approval scope and excess inputs", () => {
  assert.throws(() => formCard({ fields: [{ id: "actorId" }] }), /reserved/);
  assert.throws(() => formCard({ fields: [{ id: "field" }, { id: "field" }] }), /reserved/);
  assert.throws(() => approvalCard({ id: "one", scopes: ["administrator"] }), /scopes/);
  assert.throws(() => formCard({ fields: Array.from({ length: 13 }, (_, i) => ({ id: `f${i}` })) }), /12/);
  const form = formCard({ fields: [{ id: "enabled", type: "toggle", value: true }, { id: "note", multiline: true }] });
  assert.equal(form.body[1].value, "true");
  assert.equal(form.body[2].maxLength, 1000);
});

test("interaction authority comes exclusively from signed envelope, form scopes are validated", async () => {
  const event = normalizeTeamsInteraction(activity({ actorId: "29:admin", conversationId: "teams:other", serviceUrl: "https://evil.example", aadObjectId: "fake" }));
  assert.equal(event.actorId, "29:real");
  assert.equal(event.conversationId, "teams:19:chat@thread.v2");
  assert.equal(event.responseMessageId, "123");
  assert.equal(event.data.actorId, undefined);
  assert.equal(event.aadObjectId, "aad");
  assert.throws(() => normalizeTeamsInteraction(activity({ scope: "administrator" })), /scope/);
  assert.throws(() => normalizeTeamsInteraction(activity({ arbitrary: { nested: true } })), /scalar/);
  assert.throws(() => normalizeTeamsInteraction({ ...activity(), from: {} }), /actor/);
  let called = false;
  const denied = createTeamsInteractionHandler({ dispatch: async () => { called = true; }, authorize: async () => false });
  assert.equal((await denied(activity())).status, 403);
  assert.equal(called, false);
});

test("legacy Submit and task forms use same trusted identity parser", () => {
  const base = activity();
  const legacy = normalizeTeamsInteraction({ ...base, type: "message", value: { cgAction: "model.save", model: "model-1", scope: "thread" } });
  assert.equal(legacy.action, "model.save");
  assert.equal(legacy.data.model, "model-1");
  const task = normalizeTeamsInteraction({ ...base, name: "task/submit", value: { data: { cgAction: "settings.save", enabled: true } } });
  assert.equal(task.action, "settings.save");
  assert.throws(() => normalizeTeamsInteraction({ ...base, name: "malicious/invoke" }), /Unsupported/);
});

test("signed invoke waits for dispatcher response and retries share a single outcome", async () => {
  let finish, calls = 0;
  const pending = new Promise(resolve => { finish = resolve; });
  const handler = createTeamsWebhook({ appId: APP, jwks: { get: async () => jwk }, onMessage: () => assert.fail("invoke is not a text message"),
    onInvoke: async () => { calls++; await pending; return { status: 200, body: { statusCode: 200, type: "application/vnd.microsoft.card.adaptive", value: messageCard({ text: "Saved" }) } }; } });
  const req = { body: activity(), headers: { authorization: `Bearer ${token()}` } };
  const first = response(), second = response();
  const a = handler(req, first), b = handler(req, second);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(first.code, null);
  assert.equal(calls, 1);
  finish(); await Promise.all([a,b]);
  assert.equal(first.code, 200);
  assert.deepEqual(first.body, second.body);
  assert.equal(first.body.value.body[1].text, "Saved");
});

test("forged invoke signatures and forged service URLs never reach card dispatcher", async () => {
  let calls = 0;
  const { privateKey: wrong } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const handler = createTeamsWebhook({ appId: APP, jwks: { get: async () => jwk }, onMessage() {}, onInvoke: async () => { calls++; return { status: 200 }; }, log: { warn() {} } });
  for (const req of [{ body: activity(), headers: { authorization: `Bearer ${token(wrong)}` } }, { body: { ...activity(), serviceUrl: "https://evil.example" }, headers: { authorization: `Bearer ${token()}` } }]) {
    const res = response(); await handler(req, res); assert.equal(res.code, 401);
  }
  assert.equal(calls, 0);
});

test("connector native card send/update attach AdaptiveCard while ordinary text stays unchanged", async () => {
  const sent = [];
  const api = createTeamsApi({ auth: { token: async () => "token" }, fetchImpl: async (url, init) => { sent.push({ url, ...init }); return { ok: true, json: async () => ({ id: "message" }) }; } });
  const connector = createTeamsConnector({ api, capabilities: {} });
  const card = messageCard({ text: "hello" });
  const record = await connector.postCard({ conversationId: "teams:19:chat", threadKey: "123", card });
  assert.equal(record.messageId, "message");
  assert.equal(JSON.parse(sent[0].body).attachments[0].content.type, "AdaptiveCard");
  await connector.updateCard({ conversationId: "teams:19:chat", messageId: "message", card });
  assert.equal(sent[1].method, "PUT");
  assert.equal(JSON.parse(sent[1].body).attachments[0].content.type, "AdaptiveCard");
  await connector.post({ conversationId: "teams:19:chat", text: "ordinary" });
  assert.equal(JSON.parse(sent[2].body).text, "ordinary");
  assert.equal(JSON.parse(sent[2].body).attachments, undefined);
});

test("card dispatcher failures return a safe visible card without leaking internal errors", async () => {
  const handler = createTeamsInteractionHandler({ dispatch: async () => { throw new Error("secret=private-value"); } });
  const result = await handler(activity());
  assert.equal(result.status, 200);
  assert.equal(result.body.value.type, "AdaptiveCard");
  assert.ok(!JSON.stringify(result).includes("private-value"));
});
