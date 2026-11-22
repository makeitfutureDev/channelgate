import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const [{ startTeams }, { activityFingerprint }, { getDb, toJson }, { createTeamsControls }, { RECOVERY_RETRY_ACTION }] = await Promise.all([
  import("../src/platforms/msteams/transport.js"),
  import("../src/platforms/msteams/verify.js"),
  import("../src/db/index.js"),
  import("../src/platforms/msteams/controls.js"),
  import("../src/platforms/msteams/recovery-controls.js"),
]);

const SERVICE = "https://smba.trafficmanager.net/emea/";
const log = { error() {}, warn() {}, info() {} };
const activity = (appId, text = "deploy the site", overrides = {}) => ({ type: "message", id: randomUUID(), timestamp: new Date().toISOString(), text,
  conversation: { id: "19:recover@thread.v2", conversationType: "personal" }, from: { id: "29:author", name: "Author" },
  recipient: { id: `28:${appId}` }, serviceUrl: SERVICE, ...overrides });
const row = (appId, body) => getDb().prepare("SELECT * FROM inbound_events WHERE namespace = ? AND event_id = ?").get(`msteams-bot:${appId}`, activityFingerprint(body));
const held = appId => getDb().prepare("SELECT * FROM inbound_events WHERE namespace = ? ORDER BY rowid").all(`msteams-retry:${appId}`);
function seedRunning(appId, body, extra = {}) {
  getDb().prepare("INSERT INTO inbound_events(namespace, event_id, conversation_id, status, created_ms, owner, data) VALUES (?, ?, ?, 'running', ?, 'previous-process', ?)")
    .run(`msteams-bot:${appId}`, activityFingerprint(body), JSON.stringify([`teams:${body.conversation.id}`, `teams:${body.conversation.id}`]), Date.now(),
      toJson({ activity: body, serviceUrl: SERVICE, ...extra }));
}
async function until(predicate, what = "expected state") {
  for (let count = 0; count < 300; count++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(`Teams recovery did not reach the ${what}`);
}
function surface({ cards = true, edits = true } = {}) {
  const calls = [];
  const connector = { botId: "", api: { sendActivity: async () => ({}) },
    async post(payload) { calls.push(["post", payload]); return { messageId: `p${calls.length}`, conversationId: payload.conversationId }; },
    ...(cards ? {
      async postCard(payload) { calls.push(["postCard", payload]); return { messageId: `c${calls.length}` }; },
      async updateCard(payload) { calls.push(["updateCard", payload]); },
    } : {}),
    ...(edits ? { async edit(payload) { calls.push(["edit", payload]); } } : {}),
  };
  return { connector, calls };
}
async function transport(t, appId, connector, onMessage = async () => {}) {
  connector.botId = `28:${appId}`;
  const current = await startTeams({ appId, onMessage, log,
    deps: { auth: { token: async () => "test-token" }, api: {}, jwks: { get: async () => ({}) }, connector } });
  t.after(() => current.stop());
  return current;
}
const click = (appId, data, actor = "29:author", conversation = "19:recover@thread.v2") => ({ type: "invoke", name: "adaptiveCard/action", id: randomUUID(),
  replyToId: "working-1", from: { id: actor }, recipient: { id: `28:${appId}` }, conversation: { id: conversation, conversationType: "personal" },
  serviceUrl: SERVICE, value: { action: { type: "Action.Execute", verb: data.cgAction, data } } });
const cardText = result => result.body.value.body.map(item => item.text).join(" ");

test("a running turn records its working message on its own durable row", async t => {
  const appId = randomUUID(), body = activity(appId);
  const { connector } = surface();
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  getDb().prepare("INSERT INTO inbound_events(namespace, event_id, conversation_id, status, created_ms, owner, data) VALUES (?, ?, ?, 'queued', ?, '', ?)")
    .run(`msteams-bot:${appId}`, activityFingerprint(body), "k", Date.now(), toJson({ activity: body, serviceUrl: SERVICE }));
  await transport(t, appId, connector, async (_message, context) => {
    context.onWorking({ conversationId: "19:recover@thread.v2", messageId: "working-7" });
    await hold;
  });
  await until(() => JSON.parse(row(appId, body)?.data || "{}").working, "recorded working message");
  assert.deepEqual(JSON.parse(row(appId, body).data).working, { conversationId: "19:recover@thread.v2", messageId: "working-7" });
  release();
  await until(() => row(appId, body)?.status === "done", "finished turn");
  assert.equal(row(appId, body).data, "{}", "a finished row keeps nothing");
});

test("after a restart the working message becomes the interruption notice with Run again, and nothing reruns", async t => {
  const appId = randomUUID(), body = activity(appId), delivered = [];
  seedRunning(appId, body, { working: { conversationId: "19:recover@thread.v2", messageId: "working-1" } });
  const { connector, calls } = surface();
  await transport(t, appId, connector, async message => delivered.push(message));
  await until(() => row(appId, body)?.status === "done", "interruption notice");
  assert.equal(delivered.length, 0, "an interrupted request is never replayed by itself");
  assert.deepEqual(calls.map(([kind]) => kind), ["updateCard"], "the working message is replaced, no second message");
  const [, update] = calls[0];
  assert.equal(update.messageId, "working-1");
  assert.match(update.text, /not run again automatically/);
  assert.deepEqual(update.card.actions.map(action => action.title), ["Run again"]);
  const retries = held(appId);
  assert.equal(retries.length, 1);
  assert.equal(retries[0].status, "held");
  assert.equal(update.card.actions[0].data.r, retries[0].event_id, "the card names only the held record");
  assert.deepEqual(Object.keys(update.card.actions[0].data).sort(), ["cgAction", "r"]);
});

test("Run again replays the original request once, for its author only", async t => {
  const appId = randomUUID(), body = activity(appId, "rebuild the report"), delivered = [];
  seedRunning(appId, body);
  const { connector, calls } = surface();
  await transport(t, appId, connector, async message => delivered.push(message.text));
  await until(() => calls.length === 1, "interruption notice");
  assert.equal(calls[0][0], "postCard", "without a recorded working message the notice is a new card");
  const data = calls[0][1].card.actions[0].data;
  const controls = createTeamsControls({ connector, authorize: async () => assert.fail("no workspace access"), log });

  assert.match(cardText(await controls.onInvoke(click(appId, data, "29:other"))), /Only the person who sent/);
  assert.match(cardText(await controls.onInvoke(click(appId, data, "29:author", "19:elsewhere@thread.v2"))), /different conversation/);
  assert.match(cardText(await controls.onInvoke(click(appId, { cgAction: RECOVERY_RETRY_ACTION, r: "../../x" }))), /no longer available/);
  assert.equal(held(appId)[0].status, "held", "refusals change nothing");

  assert.match(cardText(await controls.onInvoke(click(appId, data))), /Running the interrupted request again/);
  await until(() => delivered.length === 1, "replayed request");
  assert.deepEqual(delivered, ["rebuild the report"]);
  assert.ok(calls.some(([kind, payload]) => kind === "updateCard" && payload.messageId === "working-1" && /Running the interrupted request again/.test(payload.text)), "the shared card loses its button");
  assert.match(cardText(await controls.onInvoke(click(appId, data))), /already run again/);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(delivered.length, 1, "one click, one replay");
  const audit = getDb().prepare("SELECT data FROM events WHERE event = 'teams_interrupted_retry' ORDER BY id DESC LIMIT 1").get();
  assert.ok(audit);
});

test("Run again expires after a day, and a surface without cards keeps the plain notice", async t => {
  const appId = randomUUID(), body = activity(appId);
  seedRunning(appId, body);
  const { connector, calls } = surface();
  await transport(t, appId, connector);
  await until(() => calls.length === 1, "interruption notice");
  const data = calls[0][1].card.actions[0].data;
  getDb().prepare("UPDATE inbound_events SET created_ms = ? WHERE namespace = ? AND event_id = ?").run(Date.now() - 25 * 3600 * 1000, `msteams-retry:${appId}`, data.r);
  const controls = createTeamsControls({ connector, authorize: async () => assert.fail("no workspace access"), log });
  assert.match(cardText(await controls.onInvoke(click(appId, data))), /more than 24 hours old/);

  const plainId = randomUUID(), plainBody = activity(plainId);
  seedRunning(plainId, plainBody, { working: { conversationId: "19:recover@thread.v2", messageId: "working-9" } });
  const plain = surface({ cards: false });
  await transport(t, plainId, plain.connector);
  await until(() => plain.calls.length === 1, "plain notice");
  assert.equal(plain.calls[0][0], "edit", "without cards the working message is edited into the notice");
  assert.equal(plain.calls[0][1].messageId, "working-9");
  assert.match(plain.calls[0][1].text, /not run again automatically/);
  assert.equal(held(plainId).length, 0, "no Run again record without a card to offer it");
});

test("ingest reports its working message to the intake before the engine runs", async () => {
  const [{ createIngest }, { setUser }, { teamsAdapter }] = await Promise.all([
    import("../src/platforms/ingest.js"), import("../src/config/store.js"), import("../src/platforms/msteams.js")]);
  await setUser("29:author", { name: "Author", approved: true });
  const noted = [];
  const connector = { platform: "msteams", capabilities: teamsAdapter.capabilities,
    async post(payload) { return { conversationId: payload.conversationId, messageId: "working-42", threadKey: "" }; },
    async edit() {}, async directory() { return { map: new Map(), maxWords: 1 }; } };
  const ingest = createIngest({ connector, log, run: async () => { assert.equal(noted.length, 1, "recorded before the run"); return { content: "ok", engine: "claude" }; } });
  await ingest({ platform: "msteams", conversationId: "teams:19:ingest@thread.v2", rawConversationId: "19:ingest@thread.v2", threadKey: "",
    userId: "29:author", userName: "Author", isDM: true, kind: "dm", mentionsBot: false, text: "hello", attachments: [], trigger: "message", messageId: "m1" },
  { onWorking: placeholder => noted.push(placeholder.messageId) });
  assert.deepEqual(noted, ["working-42"]);
});
