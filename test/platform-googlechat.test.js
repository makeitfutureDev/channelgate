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
import { parseChatEvent, normalizeMessage, normalizeCardEvent, mentionsBot, resolveThreadKey, createSeenThreads } from "../src/platforms/googlechat/events.js";
import { createGoogleChatConnector, toSpaceName } from "../src/platforms/googlechat/connector.js";
import { googleChatAdapter } from "../src/platforms/googlechat.js";
import { createTransportManager } from "../src/platforms/manager.js";
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

test("a private notice stays in its space with a Google-enforced viewer", async () => {
  const api = fakeChatApi();
  const connector = createGoogleChatConnector({ auth: fakeAuth(), capabilities: googleChatAdapter.capabilities, api });
  const posted = await connector.post({ conversationId: "spaces/AAA", text: "just for you", ephemeralTo: "users/9" });
  assert.equal(posted.ephemeral, true);
  assert.equal(api.calls.at(-1).space, "spaces/AAA");
  assert.deepEqual(api.calls.at(-1).body.privateMessageViewer, { name: 'users/9' });
  assert.equal(api.calls.some(call => call.op === 'dm'), false);
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

test("Pub/Sub acknowledges only successfully accepted events and accepts before ACK", async () => {
  const sequence = [];
  let pulls = 0;
  const puller = createPubSubPuller({ auth: fakeAuth(), subscription: "projects/cg-test/subscriptions/acceptance",
    onEvent: async ({ id }) => { sequence.push(`accept:${id}`); if (id === "retry") throw new Error("durable queue unavailable"); },
    fetchImpl: async (url, init) => {
      if (url.endsWith(":acknowledge")) { sequence.push(`ack:${JSON.parse(init.body).ackIds.join(",")}`); return ok({}); }
      if (++pulls > 1) { puller.stop(); return ok({}); }
      return ok({ receivedMessages: ["saved", "retry"].map((id) => ({ ackId: id, message: { data: Buffer.from(JSON.stringify({ id })).toString("base64") } })) });
    }, log: { error() {} },
  });
  await puller.start();
  assert.deepEqual(sequence, ["accept:saved", "accept:retry", "ack:saved"]);
});

test("stopping a puller never waits for a blocked handler or dispatches the rest of its batch", async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const seen = [];
  const puller = createPubSubPuller({ auth: fakeAuth(), subscription: "projects/cg-test/subscriptions/stopping",
    onEvent: async ({ id }) => { seen.push(id); await blocked; },
    fetchImpl: async () => ok({ receivedMessages: [1, 2].map((id) => ({ ackId: String(id), message: { data: Buffer.from(JSON.stringify({ id })).toString("base64") } })) }),
  });
  const loop = puller.start();
  while (!seen.length) await new Promise((resolve) => setImmediate(resolve));
  await puller.stop();
  assert.deepEqual(seen, [1]);
  release();
  await loop;
  assert.deepEqual(seen, [1]);
});


test("a live Google pull permission failure reaches manager health and stops inbox dispatch", async () => {
  let failPull;
  const response = new Promise((resolve) => { failPull = resolve; });
  let inboxStopped = false;
  const manager = createTransportManager({ platform: "googlechat", log: { error() {} },
    start: (_config, { onFatal }) => startGoogleChat({
      subscription: "projects/cg-test/subscriptions/chat", onMessage() {}, onFatal,
      capabilities: googleChatAdapter.capabilities, log: { info() {}, error() {} },
      deps: { auth: fakeAuth(), api: fakeChatApi(), connector: {},
        inbox: { start() {}, stop() { inboxStopped = true; } },
        fetchImpl: async () => response },
    }),
  });
  assert.equal((await manager.connect({})).connected, true);
  failPull(fail(403, JSON.stringify({ error: { message: "User not authorized" } })));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.snapshot().status, "error");
  assert.equal(manager.getConnector(), null);
  assert.match(manager.snapshot().error, /Pub\/Sub Subscriber.*reconnect Google Chat/);
  assert.equal(inboxStopped, true);
  assert.equal(manager.getTransport().puller.running, false);
  await manager.disconnect();
});

test('Cards v2 create and patch retain controls, private viewer and the original thread', async () => {
  const calls = [];
  const api = createChatApi({ auth: fakeAuth(), fetchImpl: async (url, init) => {
    calls.push({ url: new URL(url), method: init.method, body: JSON.parse(init.body) });
    return ok({ name: 'spaces/AAA/messages/native', thread: { name: 'spaces/AAA/threads/T' } });
  } });
  const connector = createGoogleChatConnector({ api, capabilities: googleChatAdapter.capabilities });
  const card = { header: { title: 'Private controls' }, sections: [{ widgets: [{ buttonList: { buttons: [
    { text: 'Apply', onClick: { action: { function: 'runtime.apply', parameters: [{ key: 'stateId', value: 'abc' }] } } },
  ] } }] }] };
  const sent = await connector.postCard({ conversationId: 'gchat:spaces/AAA', threadKey: 'spaces/AAA/threads/T', card, privateTo: 'ana@example.com' });
  assert.equal(sent.conversationId, 'spaces/AAA');
  assert.equal(sent.ephemeral, true);
  assert.deepEqual(calls[0].body.privateMessageViewer, { name: 'users/ana@example.com' });
  assert.deepEqual(calls[0].body.cardsV2[0].card, card);
  assert.equal(calls[0].body.thread.name, 'spaces/AAA/threads/T');
  assert.equal(calls[0].url.searchParams.get('messageReplyOption'), 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD');
  await connector.updateCard({ conversationId: 'gchat:spaces/AAA', messageId: sent.messageId, card, text: 'Updated' });
  assert.equal(calls[1].method, 'PATCH');
  assert.equal(calls[1].url.searchParams.get('updateMask'), 'text,cardsV2');
  assert.equal(calls[1].body.thread, undefined);
  assert.equal(calls[1].body.privateMessageViewer, undefined, 'updates preserve the existing viewer');
  await assert.rejects(connector.postCard({ conversationId: 'spaces/AAA', threadKey: 'spaces/EVIL/threads/T', card }), /another space/);
  await assert.rejects(connector.updateCard({ conversationId: 'spaces/AAA', messageId: 'spaces/EVIL/messages/M', card }), /another space/);
  await assert.rejects(api.createMessage('spaces/AAA', { threadName: 'spaces/EVIL/threads/T' }), /another space/);
  await assert.rejects(connector.postCard({ conversationId: 'spaces/AAA', card, privateTo: 'users/../bad' }), /private Google Chat/);
  assert.equal(calls.length, 2);
});

test('footer and menu controls survive both private delivery and edits', async () => {
  const api = fakeChatApi();
  const connector = createGoogleChatConnector({ api, capabilities: googleChatAdapter.capabilities });
  const menu = { conversationId: 'gchat:spaces/AAA', sessionKey: 'spaces/AAA/threads/T', authorId: 'ana@example.com' };
  await connector.post({ conversationId: 'spaces/AAA', threadKey: 'spaces/AAA/threads/T', text: 'Answer', footer: '10 tokens', menu, ephemeralTo: 'users/1' });
  const posted = api.calls[0];
  assert.equal(posted.space, 'spaces/AAA');
  assert.match(JSON.stringify(posted.body.cardsV2), /10 tokens|menu.files|menu.secrets|menu.settings/);
  assert.deepEqual(posted.body.privateMessageViewer, { name: 'users/1' });
  await connector.edit({ conversationId: 'spaces/AAA', messageId: 'spaces/AAA/messages/9', text: 'Complete', footer: '20 tokens', menu });
  assert.match(JSON.stringify(api.calls[1].body.cardsV2), /20 tokens/);
  assert.equal(api.calls[1].body.cardsV2[0].card.sections[0].widgets[1].buttonList.buttons.length, 3);
});

test('all three card event envelopes identify the clicking user independently of the bot message', () => {
  const user = { email: 'ana@example.com', name: 'users/1', displayName: 'Ana', type: 'HUMAN' };
  const message = { ...MESSAGE, sender: { name: 'users/bot', type: 'BOT' } };
  const action = { actionMethodName: 'model.apply', parameters: [{ key: 'stateId', value: 'state-1' }, { key: 'userId', value: 'forged@example.com' }] };
  const envelopes = [
    { chat: { buttonClickedPayload: { message, space: SPACE }, user }, commonEventObject: { invokedFunction: 'model.apply', parameters: { stateId: 'state-1', userId: 'forged@example.com' }, formInputs: { model: { stringInputs: { value: ['default'] } } } } },
    { chat: { message, space: SPACE, user, action } },
    { type: 'CARD_CLICKED', message, space: SPACE, user, action },
  ];
  for (const envelope of envelopes) {
    const card = normalizeCardEvent(parseChatEvent(envelope, { 'ce-type': 'google.workspace.chat.widget.v1.clicked' }));
    assert.equal(card.userId, 'ana@example.com');
    assert.equal(card.raw.senderName, 'users/1');
    assert.equal(card.conversationId, 'gchat:spaces/AAA');
    assert.equal(card.messageId, MESSAGE.name);
    assert.equal(card.action.function, 'model.apply');
    assert.equal(card.action.parameters.stateId, 'state-1');
  }
  assert.equal(normalizeCardEvent(parseChatEvent({ ...envelopes[2], space: { name: 'spaces/FOREIGN' } })), null);
  assert.equal(normalizeCardEvent(parseChatEvent({ ...envelopes[2], user: undefined })), null);
  assert.equal(normalizeCardEvent(parseChatEvent({ ...envelopes[2], message: { ...message, thread: { name: 'spaces/FOREIGN/threads/T' } } })), null);
});

test('quoted message metadata is scoped to its own space', () => {
  const normalize = name => normalizeMessage({ space: SPACE, message: { ...MESSAGE, quotedMessageMetadata: { name } } });
  assert.equal(normalize('spaces/AAA/messages/quoted').replyToId, 'spaces/AAA/messages/quoted');
  assert.equal(normalize('spaces/FOREIGN/messages/quoted').replyToId, '');
});

test('stop commands and native buttons dispatch while an engine occupies the same session', async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const received = [];
  const cards = [];
  const transport = await startGoogleChat({ subscription: 'projects/cg-test/subscriptions/control-lane',
    capabilities: googleChatAdapter.capabilities,
    onMessage: async message => { received.push(message.text); if (message.text === 'work') await blocked; },
    onCard: async card => cards.push(card),
    log: {}, deps: { auth: fakeAuth(), api: fakeChatApi(), puller: { start() {}, async stop() {} } },
  });
  const envelope = (id, text) => ({ chat: { messagePayload: { space: SPACE, message: { ...MESSAGE, name: `spaces/AAA/messages/${id}`, text, argumentText: text } } } });
  try {
    await transport.onEvent(envelope('working', 'work'));
    await new Promise(resolve => setImmediate(resolve));
    await transport.onEvent(envelope('stop', '/stop'));
    const cardEnvelope = { chat: { user: { name: 'users/1', email: 'ana@example.com' }, buttonClickedPayload: {
      space: SPACE, message: { ...MESSAGE, sender: { type: 'BOT' } },
    } }, commonEventObject: { invokedFunction: 'settings.open', parameters: { stateId: 'state' } } };
    await transport.onEvent(cardEnvelope, {}, { messageId: 'button-delivery-1' });
    await transport.onEvent(cardEnvelope, {}, { messageId: 'button-delivery-1' });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(received, ['work', '/stop']);
    assert.equal(cards.length, 1);
    assert.equal(cards[0].userId, 'ana@example.com');
    await transport.onEvent({ ...cardEnvelope, chat: { ...cardEnvelope.chat, buttonClickedPayload: { ...cardEnvelope.chat.buttonClickedPayload, space: { name: 'spaces/FOREIGN' } } } }, {}, { messageId: 'invalid' });
    await transport.onEvent({ chat: { messagePayload: { space: SPACE, message: { ...MESSAGE, name: 'spaces/AAA/messages/foreign-thread', thread: { name: 'spaces/FOREIGN/threads/T' } } } } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(cards.length, 1);
    assert.deepEqual(received, ['work', '/stop']);
  } finally { release(); await new Promise(resolve => setImmediate(resolve)); await transport.stop(); }
});

test('Google queued cancellation rechecks all authors and stays confined to its session', async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const received = [];
  const transport = await startGoogleChat({ subscription: 'projects/cg-test/subscriptions/pending-cancellation',
    capabilities: googleChatAdapter.capabilities, onMessage: async (message, context) => { if (context?.queuedNoticeOnly) return; received.push(message.text); if (message.text === 'first') await blocked; },
    log: {}, deps: { auth: fakeAuth(), api: fakeChatApi(), puller: { start() {}, async stop() {} } },
  });
  const event = (id, text, email = 'ana@example.com', thread = 'spaces/AAA/threads/pending') => ({ chat: { messagePayload: { space: SPACE,
    message: { ...MESSAGE, name: `spaces/AAA/messages/${id}`, argumentText: text, text, sender: { type: 'HUMAN', email }, thread: { name: thread } },
  } } });
  try {
    await transport.onEvent(event('first', 'first'));
    await new Promise(resolve => setImmediate(resolve));
    await transport.onEvent(event('own', 'own'));
    await transport.onEvent(event('other', 'other', 'bob@example.com'));
    const scope = { conversationId: 'gchat:spaces/AAA', sessionKey: 'spaces/AAA/threads/pending' };
    assert.deepEqual(await transport.connector.pendingForSession(scope), { count: 2, authors: ['ana@example.com', 'bob@example.com'] });
    assert.deepEqual(await transport.connector.pendingForSession({ ...scope, sessionKey: 'spaces/AAA/threads/other' }), { count: 0, authors: [] });
    assert.deepEqual(await transport.connector.cancelPendingForSession({ ...scope, authorId: 'ana@example.com', authorIsAdmin: false }), { allowed: false, cancelled: 0 });
    assert.equal((await transport.connector.pendingForSession(scope)).count, 2);
    assert.deepEqual(await transport.connector.cancelPendingForSession({ ...scope, authorId: 'admin@example.com', authorIsAdmin: true }), { allowed: true, cancelled: 2 });
    assert.deepEqual(await transport.connector.pendingForSession(scope), { count: 0, authors: [] });
  } finally { release(); await new Promise(resolve => setImmediate(resolve)); await transport.stop(); }
  assert.deepEqual(received, ['first'], 'cancelled requests never invoke the engine');
});

test('Google control commands retain capacity when four engine slots are occupied', async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const received = [];
  const transport = await startGoogleChat({ subscription: 'projects/cg-test/subscriptions/saturated-controls',
    capabilities: googleChatAdapter.capabilities,
    onMessage: async message => { received.push(message.text); if (message.text === 'work') await blocked; },
    log: {}, deps: { auth: fakeAuth(), api: fakeChatApi(), puller: { start() {}, async stop() {} } },
  });
  const event = (id, text, thread) => ({ chat: { messagePayload: { space: SPACE,
    message: { ...MESSAGE, name: `spaces/AAA/messages/${id}`, argumentText: text, text, thread: { name: `spaces/AAA/threads/${thread}` } },
  } } });
  try {
    for (let i = 0; i < 4; i++) await transport.onEvent(event(`slot-${i}`, 'work', `thread-${i}`));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(received.length, 4);
    await transport.onEvent(event('status', '/status', 'thread-0'));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(received, ['work', 'work', 'work', 'work', '/status']);
  } finally { release(); await new Promise(resolve => setImmediate(resolve)); await transport.stop(); }
});

test('registered app-command payloads use the actor and literal command without numeric mappings', () => {
  const user = { email: 'ana@example.com', name: 'users/1', type: 'HUMAN' };
  const envelope = { chat: { user, space: SPACE, appCommandPayload: { space: SPACE,
    appCommandMetadata: { appCommandType: 'SLASH_COMMAND', appCommandId: '731' },
    message: { ...MESSAGE, sender: { email: 'forged@example.com' }, argumentText: '/help', text: '/help', annotations: [] },
  } } };
  const event = parseChatEvent(envelope);
  assert.equal(event.type, 'message');
  assert.equal(event.appCommand, true);
  const message = normalizeMessage(event);
  assert.equal(message.text, '/help');
  assert.equal(message.userId, 'ana@example.com');
  assert.equal(message.raw.senderName, 'users/1');
  assert.equal(message.mentionsBot, true);
  const native = normalizeMessage({ space: SPACE, message: { ...MESSAGE, annotations: [], argumentText: '/settings', slashCommand: { commandId: 23 } } });
  assert.equal(native.mentionsBot, true);
  assert.equal(normalizeMessage({ space: SPACE, message: { ...MESSAGE, annotations: [], argumentText: '/settings' } }).mentionsBot, false);
  assert.equal(normalizeMessage({ ...event, message: { ...event.message, argumentText: '', text: '' } }).text, '', 'the numeric ID never becomes /help');
  const messageAction = parseChatEvent({ chat: { ...envelope.chat, appCommandPayload: { ...envelope.chat.appCommandPayload,
    appCommandMetadata: { appCommandType: 'MESSAGE_ACTION', appCommandId: '731' },
  } } });
  assert.equal(messageAction.type, 'unknown', 'original message text is not a slash-command invocation');
});

test('documented add-on button envelope routes through common parameters without an action field', () => {
  const event = parseChatEvent({ chat: { user: { name: 'users/1', email: 'ana@example.com' },
    buttonClickedPayload: { space: SPACE, message: MESSAGE },
  }, commonEventObject: { parameters: { cgAction: 'settings.page', stateId: 'state', page: '"general"' } } });
  const card = normalizeCardEvent(event);
  assert.equal(card.action.function, 'settings.page');
  assert.equal(card.action.parameters.cgAction, 'settings.page');
  assert.equal(card.userId, 'ana@example.com');
});

test('Google queued notices run promptly without invoking queued work twice', async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const work = [], notices = [];
  let stopped = 0;
  const transport = await startGoogleChat({ subscription: 'projects/cg-test/subscriptions/queue-notices',
    capabilities: googleChatAdapter.capabilities, onStop: () => stopped++,
    onMessage: async (message, context = {}) => {
      if (context.queuedNoticeOnly) { if (context.isQueued()) notices.push({ text: message.text, position: context.position }); return; }
      work.push(message.text);
      if (message.text === 'first') await blocked;
    },
    log: {}, deps: { auth: fakeAuth(), api: fakeChatApi(), puller: { start() {}, async stop() {} } },
  });
  const event = (id, text) => ({ chat: { messagePayload: { space: SPACE, message: { ...MESSAGE,
    name: `spaces/AAA/messages/${id}`, text, argumentText: text, thread: { name: 'spaces/AAA/threads/notices' },
  } } } });
  try {
    await transport.onEvent(event('first', 'first'));
    await new Promise(resolve => setImmediate(resolve));
    await transport.onEvent(event('second', 'second'));
    await transport.onEvent(event('second', 'second'));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(work, ['first']);
    assert.deepEqual(notices, [{ text: 'second', position: 1 }]);
    release();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(work, ['first', 'second']);
  } finally { release(); await new Promise(resolve => setImmediate(resolve)); await transport.stop(); }
  assert.equal(stopped, 1);
});

// Google's documented slash-command MESSAGE: `argumentText` carries ONLY the arguments; the command
// is the SLASH_COMMAND annotation's commandName (text "/debug show code", argumentText " show code").
const slashMessage = (command, args, id = 'slash') => ({ ...MESSAGE, name: `spaces/AAA/messages/${id}`,
  text: `${command}${args}`, argumentText: args, slashCommand: { commandId: '7' },
  annotations: [{ type: 'SLASH_COMMAND', length: command.length, slashCommand: { type: 'INVOKE', commandId: '7', commandName: command, bot: { type: 'BOT' } } }] });

test('documented slash-command events rebuild the command from its annotation, not from argumentText', () => {
  const help = normalizeMessage({ space: SPACE, message: slashMessage('/help', '') });
  assert.equal(help.text, '/help');
  assert.equal(help.mentionsBot, true, 'a registered command addresses the app without a mention');
  const model = normalizeMessage({ space: SPACE, message: slashMessage('/model', ' claude opus') });
  assert.equal(model.text, '/model claude opus', 'arguments never reach the engine as a bare prompt');
  // Tolerate a payload whose argumentText already includes the command, without doubling it.
  assert.equal(normalizeMessage({ space: SPACE, message: { ...slashMessage('/stop', ''), argumentText: '/stop' } }).text, '/stop');
  // No annotation (add-on appCommandPayload): Google's literal message text is the command.
  const addOn = parseChatEvent({ chat: { user: { email: 'ana@example.com', name: 'users/1', type: 'HUMAN' }, appCommandPayload: { space: SPACE,
    appCommandMetadata: { appCommandType: 'SLASH_COMMAND', appCommandId: '9' },
    message: { ...MESSAGE, text: '/settings', argumentText: '', annotations: [] } } } });
  assert.equal(normalizeMessage(addOn).text, '/settings');
  // A typed "@app /help" has no slash metadata: argumentText (mention stripped) stays authoritative.
  assert.equal(normalizeMessage({ space: SPACE, message: { ...MESSAGE, text: '@Bot /help', argumentText: ' /help' } }).text, '/help');
  // A non-command registered invocation is never promoted to the mention bypass.
  const other = normalizeMessage({ space: SPACE, message: { ...slashMessage('/deploy', ' now'), annotations: [{ type: 'SLASH_COMMAND', slashCommand: { commandName: '/deploy' } }] } });
  assert.equal(other.mentionsBot, false);
});

test('documented slash-command /stop takes the control lane while a turn occupies the session', async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const received = [];
  const transport = await startGoogleChat({ subscription: 'projects/cg-test/subscriptions/slash-stop', capabilities: googleChatAdapter.capabilities,
    onMessage: async message => { received.push(message.text); if (message.text === 'long work') await blocked; },
    log: {}, deps: { auth: fakeAuth(), api: fakeChatApi(), puller: { start() {}, async stop() {} } } });
  const thread = { name: 'spaces/AAA/threads/slash' };
  try {
    await transport.onEvent({ chat: { messagePayload: { space: SPACE, message: { ...MESSAGE, name: 'spaces/AAA/messages/work', text: '@Bot long work', argumentText: ' long work', thread } } } });
    await new Promise(resolve => setImmediate(resolve));
    await transport.onEvent({ chat: { messagePayload: { space: SPACE, message: { ...slashMessage('/stop', '', 'stop'), thread } } } });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(received, ['long work', '/stop']);
  } finally { release(); await new Promise(resolve => setImmediate(resolve)); await transport.stop(); }
});

test('clicks and ignored events are logged by path and shape, never dropped silently', async () => {
  const lines = [];
  const log = { info: line => lines.push(line), warn: line => lines.push(line) };
  const cards = [];
  const transport = await startGoogleChat({ subscription: 'projects/cg-test/subscriptions/click-logging',
    capabilities: googleChatAdapter.capabilities, onMessage: async () => {}, onCard: async card => cards.push(card),
    log, deps: { auth: fakeAuth(), api: fakeChatApi(), puller: { start() {}, async stop() {} } },
  });
  try {
    const click = { chat: { user: { name: 'users/1', email: 'ana@example.com' }, buttonClickedPayload: { space: SPACE, message: { ...MESSAGE, sender: { type: 'BOT' } } } },
      commonEventObject: { parameters: { cgAction: 'settings.page', stateId: 'state' } } };
    await transport.onEvent(click, {}, { messageId: 'logged-click' });
    await transport.onEvent({ ...click, chat: { ...click.chat, buttonClickedPayload: { ...click.chat.buttonClickedPayload, space: { name: 'spaces/FOREIGN' } } } }, {}, { messageId: 'bad-click', source: 'http' });
    await transport.onEvent({ chat: { somethingNew: { text: 'private words' } } }, { 'ce-type': 'google.workspace.chat.unknown.v1' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(cards.length, 1);
    assert.ok(lines.includes('[googlechat] card click received via pubsub: settings.page'));
    assert.ok(lines.some(line => /^\[googlechat\] card click dropped \(unrecognized shape\) via http: .*chat=\[user,buttonClickedPayload\]/.test(line)));
    assert.ok(lines.some(line => /^\[googlechat\] event ignored \(unknown\) via pubsub: ce-type=google\.workspace\.chat\.unknown\.v1 .*chat=\[somethingNew\]/.test(line)));
    assert.ok(!lines.some(line => /private words|ana@example/.test(line)));
  } finally { await transport.stop(); }
});
