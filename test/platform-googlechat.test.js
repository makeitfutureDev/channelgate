// The Google Chat transport: service-account auth, the Chat REST client, the Pub/Sub pull loop,
// CloudEvents parsing, and the connector. Every network call is a fake — these tests are about the
// rules (what must be signed, what must never reach a URL path, what must not be answered twice),
// not about Google being reachable.
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";

import { ensureTestEnv } from "./helpers.js";
import { parseServiceAccount, createGoogleAuth } from "../src/platforms/googlechat/auth.js";
import { createChatApi, isSpaceName, isMessageName } from "../src/platforms/googlechat/api.js";
import { createPubSubPuller, createDedupe, isSubscriptionName } from "../src/platforms/googlechat/pubsub.js";
import { parseChatEvent, normalizeMessage, mentionsBot, resolveThreadKey, createSeenThreads } from "../src/platforms/googlechat/events.js";
import { createGoogleChatConnector, toSpaceName } from "../src/platforms/googlechat/connector.js";
import { googleChatAdapter } from "../src/platforms/googlechat.js";
import { startGoogleChat } from "../src/platforms/googlechat/transport.js";

ensureTestEnv();

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const SA = {
  type: "service_account",
  project_id: "cg-test",
  client_email: "bot@cg-test.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
};

const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body), arrayBuffer: async () => new ArrayBuffer(0) });
const fail = (status, body = "nope") => ({ ok: false, status, json: async () => ({}), text: async () => body });

function fakeAuth(token = "tok") {
  let resets = 0;
  return { token: async () => token, reset: () => { resets += 1; }, get resets() { return resets; } };
}

// ── service-account auth ──────────────────────────────────────────────────────

test("a pasted OAuth-client JSON is rejected with a message naming the problem", () => {
  assert.throws(() => parseServiceAccount(JSON.stringify({ type: "authorized_user", client_id: "x" })), /service_account key is required/);
  assert.throws(() => parseServiceAccount("not json"), /not valid JSON/);
  assert.throws(() => parseServiceAccount(JSON.stringify({ type: "service_account", client_email: "a@b" })), /no usable private_key/);
  const parsed = parseServiceAccount(JSON.stringify(SA));
  assert.equal(parsed.clientEmail, SA.client_email);
  assert.equal(parsed.projectId, "cg-test");
});

test("the token is minted once, cached until expiry, and re-minted after it lapses", async () => {
  let calls = 0;
  let now = 1_000_000;
  const auth = createGoogleAuth({
    serviceAccount: SA,
    now: () => now,
    fetchImpl: async () => { calls += 1; return ok({ access_token: `t${calls}`, expires_in: 3600 }); },
  });
  assert.equal(await auth.token(), "t1");
  assert.equal(await auth.token(), "t1");
  assert.equal(calls, 1);
  now += 3600_000; // past expiry (minus the 60s margin)
  assert.equal(await auth.token(), "t2");
  assert.equal(calls, 2);
});

test("concurrent callers share ONE refresh rather than each hammering Google's STS", async () => {
  let calls = 0;
  const auth = createGoogleAuth({
    serviceAccount: SA,
    fetchImpl: async () => { calls += 1; await new Promise((r) => setImmediate(r)); return ok({ access_token: "t", expires_in: 3600 }); },
  });
  await Promise.all([auth.token(), auth.token(), auth.token()]);
  assert.equal(calls, 1);
});

test("a rejected key surfaces Google's own description and is marked non-retryable", async () => {
  const auth = createGoogleAuth({
    serviceAccount: SA,
    fetchImpl: async () => fail(400, JSON.stringify({ error: "invalid_grant", error_description: "Invalid JWT Signature." })),
  });
  await assert.rejects(auth.token(), (err) => {
    assert.match(err.message, /Invalid JWT Signature/);
    assert.equal(err.fatal, true);
    return true;
  });
});

test("the signed assertion carries the service account, the scopes, and Google's token endpoint", async () => {
  let body = "";
  const auth = createGoogleAuth({ serviceAccount: SA, fetchImpl: async (_url, init) => { body = init.body; return ok({ access_token: "t", expires_in: 60 }); } });
  await auth.token();
  const assertion = new URLSearchParams(body).get("assertion");
  const claims = JSON.parse(Buffer.from(assertion.split(".")[1], "base64url").toString("utf8"));
  assert.equal(claims.iss, SA.client_email);
  assert.equal(claims.aud, "https://oauth2.googleapis.com/token");
  assert.match(claims.scope, /chat\.bot/);
  assert.match(claims.scope, /pubsub/);
});

// ── Chat REST client ──────────────────────────────────────────────────────────

test("a resource name from the wire can never escape the API URL path", async () => {
  const api = createChatApi({ auth: fakeAuth(), fetchImpl: async () => ok({}) });
  await assert.rejects(api.createMessage("spaces/AAA/../../v1/spaces/EVIL", { text: "x" }), /not a valid resource name/);
  await assert.rejects(api.patchMessage("spaces/AAA/messages/../../x", { text: "x" }), /not a valid resource name/);
  await assert.rejects(api.deleteMessage("https://evil.example/v1/spaces/A/messages/B"), /not a valid resource name/);
  await assert.rejects(api.downloadAttachment("../../etc/passwd"), /not valid/);
  assert.equal(isSpaceName("spaces/AAA-_1"), true);
  assert.equal(isSpaceName("spaces/AAA/messages/1"), false);
  assert.equal(isMessageName("spaces/AAA/messages/abc.def-1"), true);
});

test("a threaded reply MUST carry messageReplyOption, or Chat silently starts a new thread", async () => {
  const seen = [];
  const api = createChatApi({
    auth: fakeAuth(),
    fetchImpl: async (url, init) => { seen.push({ url: String(url), body: JSON.parse(init.body) }); return ok({ name: "spaces/AAA/messages/1", thread: { name: "spaces/AAA/threads/T" } }); },
  });
  await api.createMessage("spaces/AAA", { text: "hi", threadName: "spaces/AAA/threads/T" });
  assert.match(seen[0].url, /messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD/);
  assert.equal(seen[0].body.thread.name, "spaces/AAA/threads/T");

  await api.createMessage("spaces/AAA", { text: "hi" });
  assert.doesNotMatch(seen[1].url, /messageReplyOption/);
  assert.equal(seen[1].body.thread, undefined);
});

test("a patch sends an updateMask and never the immutable thread", async () => {
  const seen = [];
  const api = createChatApi({ auth: fakeAuth(), fetchImpl: async (url, init) => { seen.push({ url: String(url), body: JSON.parse(init.body), method: init.method }); return ok({ name: "spaces/AAA/messages/1" }); } });
  await api.patchMessage("spaces/AAA/messages/1", { text: "edited" });
  assert.equal(seen[0].method, "PATCH");
  assert.match(seen[0].url, /updateMask=text/);
  assert.equal(seen[0].body.thread, undefined);
});

test("a transient 429 is retried; a 403 is not", async () => {
  let calls = 0;
  const api = createChatApi({
    auth: fakeAuth(),
    sleep: async () => {},
    fetchImpl: async () => { calls += 1; return calls === 1 ? fail(429) : ok({ name: "spaces/AAA/messages/1" }); },
  });
  await api.createMessage("spaces/AAA", { text: "x" });
  assert.equal(calls, 2);

  let forbidden = 0;
  const api2 = createChatApi({
    auth: fakeAuth(),
    sleep: async () => {},
    fetchImpl: async () => { forbidden += 1; return fail(403, "app removed from space"); },
  });
  await assert.rejects(api2.createMessage("spaces/AAA", { text: "x" }), /403/);
  assert.equal(forbidden, 1);
});

test("a 401 drops the cached token so the next call re-mints it", async () => {
  const auth = fakeAuth();
  let calls = 0;
  const api = createChatApi({
    auth, sleep: async () => {},
    fetchImpl: async () => { calls += 1; return calls === 1 ? fail(401) : ok({ name: "spaces/AAA/messages/1" }); },
  });
  await api.createMessage("spaces/AAA", { text: "x" });
  assert.equal(auth.resets, 1);
});

test("the member list skips bots and follows pagination", async () => {
  const pages = [
    { memberships: [{ member: { name: "users/1", displayName: "Ana", type: "HUMAN" } }, { member: { name: "users/bot", displayName: "Bot", type: "BOT" } }], nextPageToken: "p2" },
    { memberships: [{ member: { name: "users/2", displayName: "Bo", type: "HUMAN" } }] },
  ];
  let call = 0;
  const api = createChatApi({ auth: fakeAuth(), fetchImpl: async () => ok(pages[call++]) });
  const members = await api.listMembers("spaces/AAA");
  assert.deepEqual(members.map((m) => m.name), ["Ana", "Bo"]);
});

// ── Pub/Sub pull ──────────────────────────────────────────────────────────────

test("a subscription path is validated before it can be used", () => {
  assert.equal(isSubscriptionName("projects/cg-test/subscriptions/chat-events"), true);
  assert.equal(isSubscriptionName("chat-events"), false);
  assert.equal(isSubscriptionName("projects/cg/subscriptions/../../topics/x"), false);
  assert.throws(() => createPubSubPuller({ auth: fakeAuth(), subscription: "nope", onEvent: () => {} }), /projects\/<project>/);
});

test("pulled messages are acked and dispatched", async () => {
  const events = [];
  const calls = [];
  const puller = createPubSubPuller({
    auth: fakeAuth(),
    subscription: "projects/cg-test/subscriptions/chat",
    onEvent: (envelope, attrs) => { events.push({ envelope, attrs }); },
    fetchImpl: async (url, init) => {
      const path = String(url);
      calls.push(path);
      if (path.endsWith(":pull")) {
        if (calls.filter((c) => c.endsWith(":pull")).length > 1) { puller.stop(); return ok({ receivedMessages: [] }); }
        return ok({
          receivedMessages: [{
            ackId: "ack-1",
            message: { messageId: "m1", data: Buffer.from(JSON.stringify({ chat: { messagePayload: { message: { name: "spaces/A/messages/1" } } } })).toString("base64"), attributes: { "ce-type": "google.workspace.chat.message.v1.created" } },
          }],
        });
      }
      return ok({});
    },
    sleep: async () => {},
  });
  await puller.start();
  assert.equal(events.length, 1);
  assert.equal(events[0].attrs["ce-type"], "google.workspace.chat.message.v1.created");
  assert.ok(calls.some((c) => c.endsWith(":acknowledge")), "the batch must be acknowledged");
});

test("a permission error stops the loop instead of retrying forever", async () => {
  let fatal = null;
  let pulls = 0;
  const puller = createPubSubPuller({
    auth: fakeAuth(),
    subscription: "projects/cg-test/subscriptions/chat",
    onEvent: () => {},
    onFatal: (err) => { fatal = err; },
    fetchImpl: async () => { pulls += 1; return fail(403, "missing roles/pubsub.subscriber"); },
    sleep: async () => {},
    log: { error: () => {}, warn: () => {} },
  });
  await puller.start();
  assert.equal(pulls, 1);
  assert.match(fatal.message, /403/);
  assert.equal(puller.running, false);
});

test("a transient failure backs off and retries rather than giving up", async () => {
  let pulls = 0;
  const sleeps = [];
  const puller = createPubSubPuller({
    auth: fakeAuth(),
    subscription: "projects/cg-test/subscriptions/chat",
    onEvent: () => {},
    fetchImpl: async () => { pulls += 1; if (pulls >= 3) puller.stop(); return fail(503); },
    sleep: async (ms) => { sleeps.push(ms); },
    random: () => 1,
    log: { warn: () => {}, info: () => {} },
  });
  await puller.start();
  assert.ok(pulls >= 2, "the loop must retry a 503");
  assert.deepEqual(sleeps.slice(0, 2), [1000, 2000]);
});

test("at-least-once delivery cannot answer the same message twice", () => {
  const dedupe = createDedupe(3);
  assert.equal(dedupe.isDuplicate("a"), false);
  assert.equal(dedupe.isDuplicate("a"), true);
  dedupe.isDuplicate("b"); dedupe.isDuplicate("c"); dedupe.isDuplicate("d");
  assert.equal(dedupe.size, 3, "the window stays bounded");
});

// ── CloudEvents parsing ───────────────────────────────────────────────────────

const MESSAGE = { name: "spaces/AAA/messages/1", text: "@Bot hello", argumentText: " hello", sender: { name: "users/9", displayName: "Ana", email: "ana@example.com", type: "HUMAN" }, annotations: [{ type: "USER_MENTION", userMention: { user: { name: "users/bot", type: "BOT" } } }] };
const SPACE = { name: "spaces/AAA", displayName: "Ops", spaceType: "SPACE" };

test("all three published envelope shapes are understood", () => {
  const attrs = { "ce-type": "google.workspace.chat.message.v1.created" };
  for (const envelope of [
    { chat: { messagePayload: { message: MESSAGE, space: SPACE } } },
    { chat: { message: MESSAGE, space: SPACE } },
    { type: "MESSAGE", message: MESSAGE, space: SPACE },
  ]) {
    const event = parseChatEvent(envelope, attrs);
    assert.equal(event.type, "message");
    assert.equal(event.message.name, MESSAGE.name);
    assert.equal(event.space.name, "spaces/AAA");
  }
});

test("a membership event is recognized, and an unknown one is not mistaken for a message", () => {
  const added = parseChatEvent({ chat: { membershipPayload: { space: SPACE, membership: { member: { name: "users/bot", type: "BOT" } } } } }, { "ce-type": "google.workspace.chat.membership.v1.created" });
  assert.equal(added.type, "membership.added");
  assert.equal(parseChatEvent({ chat: {} }, { "ce-type": "something.else" }).type, "unknown");
  assert.equal(parseChatEvent({}, { "ce-type": "google.workspace.chat.widget.v1.clicked" }).type, "card");
});

test("a mention is read from the annotation, not from the presence of argumentText", () => {
  assert.equal(mentionsBot(MESSAGE), true);
  assert.equal(mentionsBot({ argumentText: "hi", annotations: [] }), false);
  assert.equal(mentionsBot({ annotations: [{ type: "USER_MENTION", userMention: { user: { name: "users/7", type: "HUMAN" } } }] }, "users/bot"), false);
});

test("a DM's first-seen thread is main flow; the same thread again is a real side thread", () => {
  const seen = createSeenThreads();
  assert.equal(resolveThreadKey({ kind: "dm", threadName: "spaces/D/threads/1", seen }), "");
  assert.equal(resolveThreadKey({ kind: "dm", threadName: "spaces/D/threads/1", seen }), "spaces/D/threads/1");
  // A named space threads from the first message — threads are real containers there.
  assert.equal(resolveThreadKey({ kind: "channel", threadName: "spaces/S/threads/9", seen }), "spaces/S/threads/9");
});

test("a normalized message carries the email as identity and the stripped text", () => {
  const message = normalizeMessage({ message: MESSAGE, space: SPACE }, { seen: createSeenThreads() });
  assert.equal(message.platform, "googlechat");
  assert.equal(message.conversationId, "gchat:spaces/AAA", "the stored id is namespaced");
  assert.equal(message.rawConversationId, "spaces/AAA", "the API id is not");
  assert.equal(message.kind, "channel");
  assert.equal(message.userId, "ana@example.com");
  assert.equal(message.text, "hello");
  assert.equal(message.mentionsBot, true);
});

test("a 1:1 space is a DM and its unnamed group sibling is not", () => {
  const dm = normalizeMessage({ message: MESSAGE, space: { name: "spaces/D", spaceType: "DIRECT_MESSAGE" } }, { seen: createSeenThreads() });
  assert.equal(dm.kind, "dm");
  assert.equal(dm.isDM, true);
  const group = normalizeMessage({ message: MESSAGE, space: { name: "spaces/G", spaceType: "SPACE" } }, { seen: createSeenThreads() });
  assert.equal(group.kind, "group");
});

test("a Drive-picker attachment is surfaced as undownloadable rather than dropped", () => {
  const message = normalizeMessage({
    message: { ...MESSAGE, attachment: [{ contentName: "plan.pdf", contentType: "application/pdf", source: "DRIVE_FILE" }] },
    space: SPACE,
  }, { seen: createSeenThreads(), api: {} });
  assert.equal(message.attachments.length, 1);
  assert.equal(message.attachments[0].download, null);
});

// ── connector ─────────────────────────────────────────────────────────────────

function fakeChatApi() {
  const calls = [];
  return {
    calls,
    async createMessage(space, body) { calls.push({ op: "create", space, body }); return { messageId: "spaces/AAA/messages/9", threadName: body.threadName || "" }; },
    async patchMessage(name, body) { calls.push({ op: "patch", name, body }); return { messageId: name }; },
    async deleteMessage(name) { calls.push({ op: "delete", name }); },
    async findDirectMessage(user) { calls.push({ op: "dm", user }); return "spaces/DM1"; },
    async listMembers() { return [{ id: "users/1", name: "Ana Pop", email: "ana@example.com" }, { id: "users/2", name: "Ana Pop", email: "other@example.com" }]; },
  };
}

test("the connector accepts a qualified or a bare space id", () => {
  assert.equal(toSpaceName("gchat:spaces/AAA"), "spaces/AAA");
  assert.equal(toSpaceName("spaces/AAA"), "spaces/AAA");
});

test("only a real thread resource name is used as a thread; a synthetic key posts top-level", async () => {
  const api = fakeChatApi();
  const connector = createGoogleChatConnector({ auth: fakeAuth(), capabilities: googleChatAdapter.capabilities, api });
  assert.equal(connector.threadFor("spaces/AAA/threads/T"), "spaces/AAA/threads/T");
  assert.equal(connector.threadFor("1712345678.000100"), null, "a Slack ts is not a Chat thread");
  await connector.post({ conversationId: "gchat:spaces/AAA", threadKey: "1712345678.000100", text: "hi" });
  assert.equal(api.calls[0].body.threadName, "");
});

test("an ephemeral-only notice becomes a DM instead of a public post", async () => {
  const api = fakeChatApi();
  const connector = createGoogleChatConnector({ auth: fakeAuth(), capabilities: googleChatAdapter.capabilities, api });
  const posted = await connector.post({ conversationId: "spaces/AAA", text: "just for you", ephemeralTo: "users/9" });
  assert.equal(posted.ephemeral, true);
  assert.equal(api.calls.at(-1).space, "spaces/DM1");
});

test("buttons the surface cannot render are named in text, never dropped in silence", async () => {
  const api = fakeChatApi();
  const connector = createGoogleChatConnector({ auth: fakeAuth(), capabilities: googleChatAdapter.capabilities, api });
  await connector.post({ conversationId: "spaces/AAA", text: "May I?", buttons: [{ text: "Approve" }, { text: "Deny" }] });
  assert.match(api.calls[0].body.text, /Approve · Deny/);
});

test("a name two people answer to is never resolved to either of them", async () => {
  const connector = createGoogleChatConnector({ auth: fakeAuth(), capabilities: googleChatAdapter.capabilities, api: fakeChatApi() });
  const directory = await connector.directory("spaces/AAA");
  assert.equal(directory.map.has("ana pop"), false, "an ambiguous name must be dropped");
  assert.equal(directory.map.get("ana@example.com"), "1");
});

// ── adapter + transport wiring ────────────────────────────────────────────────

test("with no transport connected the adapter's connector THROWS on a write", async () => {
  const connector = googleChatAdapter.createConnector();
  await assert.rejects(connector.post({ conversationId: "spaces/A", text: "x" }), /cannot post/);
  assert.equal(connector.ready(), false);
});

test("the transport learns its own bot id, drops bot authors, and never answers a message twice", async () => {
  const delivered = [];
  const transport = await startGoogleChat({
    subscription: "projects/cg-test/subscriptions/chat",
    capabilities: googleChatAdapter.capabilities,
    onMessage: (m) => { delivered.push(m); },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    deps: {
      auth: fakeAuth(),
      api: fakeChatApi(),
      connector: { platform: "googlechat" },
      puller: { start() {}, async stop() {} },
    },
  });

  await transport.onEvent(
    { chat: { membershipPayload: { space: SPACE, membership: { member: { name: "users/bot", type: "BOT" } } } } },
    { "ce-type": "google.workspace.chat.membership.v1.created" },
  );
  assert.equal(transport.botUserId, "users/bot");

  // Our own reply comes back on the same topic. Answering it is an unbounded loop.
  await transport.onEvent({ chat: { messagePayload: { message: { ...MESSAGE, name: "spaces/AAA/messages/bot", sender: { name: "users/bot", type: "BOT" } }, space: SPACE } } }, { "ce-type": "google.workspace.chat.message.v1.created" });
  assert.equal(delivered.length, 0);

  const envelope = { chat: { messagePayload: { message: MESSAGE, space: SPACE } } };
  const attrs = { "ce-type": "google.workspace.chat.message.v1.created" };
  await transport.onEvent(envelope, attrs);
  await transport.onEvent(envelope, attrs); // redelivery
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].text, "hello");
  await transport.stop();
});
