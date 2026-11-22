import test from "node:test";
import assert from "node:assert/strict";
import { createSign, generateKeyPairSync, randomUUID } from "node:crypto";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const [{ startTeams }, { activityFingerprint }, { getDb }, { createIngest }, { setUser, getChannelEntry, patchChannelMeta }, { teamsAdapter }, { createTeamsControls }, { STEERED }] = await Promise.all([
  import("../src/platforms/msteams/transport.js"),
  import("../src/platforms/msteams/verify.js"),
  import("../src/db/index.js"),
  import("../src/platforms/ingest.js"),
  import("../src/config/store.js"),
  import("../src/platforms/msteams.js"),
  import("../src/platforms/msteams/controls.js"),
  import("../src/platforms/conversation-controls.js"),
]);

const SERVICE = "https://smba.trafficmanager.net/emea/";
const log = { error() {}, warn() {}, info() {} };
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "queue-key", alg: "RS256" };
function token(appId) {
  const head = Buffer.from(JSON.stringify({ alg: "RS256", kid: jwk.kid })).toString("base64url");
  const body = Buffer.from(JSON.stringify({ iss: "https://api.botframework.com", aud: appId,
    exp: Math.floor(Date.now() / 1000) + 60, serviceurl: SERVICE })).toString("base64url");
  const signer = createSign("RSA-SHA256");
  signer.update(`${head}.${body}`);
  return `${head}.${body}.${signer.sign(privateKey, "base64url")}`;
}
const request = (appId, body) => ({ body, headers: { authorization: `Bearer ${token(appId)}` } });
const response = () => ({ status() { return this; }, json() { return this; } });
const row = (appId, body) => getDb().prepare("SELECT * FROM inbound_events WHERE namespace = ? AND event_id = ?")
  .get(`msteams-bot:${appId}`, activityFingerprint(body));
async function until(predicate, what = "expected state") {
  for (let count = 0; count < 400; count++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(`Teams queue did not reach the ${what}`);
}
function channelMessage(appId, nativeId, root, text, author = "29:author") {
  return { type: "message", id: randomUUID(), timestamp: new Date().toISOString(), text,
    conversation: { id: `${nativeId};messageid=${root}`, conversationType: "channel" },
    from: { id: author, name: author }, recipient: { id: `28:${appId}` }, serviceUrl: SERVICE,
    entities: [{ type: "mention", mentioned: { id: `28:${appId}` } }] };
}
const click = (appId, nativeId, data, actor = "29:author", messageId = "card-1") => ({ type: "invoke", name: "adaptiveCard/action",
  id: randomUUID(), replyToId: messageId, from: { id: actor }, recipient: { id: `28:${appId}` },
  conversation: { id: nativeId, conversationType: "channel" }, serviceUrl: SERVICE,
  value: { action: { type: "Action.Execute", verb: data.cgAction, data } } });
const cardText = result => result.body.value.body.map(item => item.text).join(" ");

// Runs each turn until the test releases it, or until its signal aborts (a stop or a steer).
function heldRuns() {
  const seen = [];
  const releases = new Map();
  const run = async args => {
    seen.push(args);
    await new Promise((resolve, reject) => {
      releases.set(args.text, resolve);
      if (args.signal.aborted) { reject(new Error("stopped")); return; }
      args.signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true });
    });
    return { content: `answer to ${args.text}`, engine: "claude" };
  };
  return { seen, run, release: text => releases.get(text)?.(), releaseAll: () => { for (const done of releases.values()) done(); } };
}

async function harness(t) {
  const appId = randomUUID(), held = heldRuns();
  const posted = [], cards = [], updated = [], edited = [];
  const connector = { platform: "msteams", capabilities: teamsAdapter.capabilities, botId: `28:${appId}`, api: { sendActivity: async () => ({}) },
    async post(payload) { posted.push(payload); return { conversationId: payload.conversationId, messageId: `sent-${posted.length}`, threadKey: payload.threadKey || "" }; },
    async postCard(payload) { cards.push(payload); return { conversationId: payload.conversationId, messageId: `card-${cards.length}` }; },
    async updateCard(payload) { updated.push(payload); },
    async edit(payload) { edited.push(payload); },
    async directory() { return { map: new Map(), maxWords: 1 }; },
  };
  await setUser("29:author", { name: "Author", approved: true });
  await setUser("29:other", { name: "Other", approved: true });
  const controls = createTeamsControls({ connector, authorize: async () => assert.fail("queue controls never open a workspace"), log });
  const ingest = createIngest({ connector, run: held.run, log, controls: controls.conversation, queueNotice: controls.queueNotice });
  const current = await startTeams({ appId, onMessage: (message, context) => ingest(message, context), onInvoke: controls.onInvoke, log,
    deps: { auth: { token: async () => "test-token" }, api: {}, jwks: { get: async () => jwk }, connector } });
  t.after(async () => { held.releaseAll(); await current.stop(); });
  const nativeId = `19:${randomUUID()}@thread.tacv2`;
  const send = async (text, author = "29:author", root = "root") => {
    const body = channelMessage(appId, nativeId, root, text, author);
    await current.handler(request(appId, body), response());
    return body;
  };
  return { appId, nativeId, held, posted, cards, updated, edited, connector, controls, send, current };
}

test("a message queued behind running work gets a Steer / Cancel card instead of a bare position", async t => {
  const h = await harness(t);
  await h.send("first");
  await until(() => h.held.seen.length === 1, "first turn");
  const second = await h.send("second");
  await until(() => h.cards.length === 1, "queue card");
  const posted = h.cards[0];
  assert.equal(posted.text, "Queued in this session (position 1).");
  assert.match(posted.card.body[0].text, /queued \(position 1\)/);
  assert.deepEqual(posted.card.actions.map(action => action.title), ["Steer conversation", "Cancel request"]);
  const data = posted.card.actions[0].data;
  assert.deepEqual(Object.keys(data).sort(), ["cgAction", "e", "q"], "the card names the waiting row only, never an identity");
  assert.equal(data.q, "bot");
  assert.equal(data.e, activityFingerprint(second));
  assert.ok(h.posted.every(payload => !/Queued in this session/.test(payload.text || "")), "no second, plain notice");
});

test("Cancel request drops only the waiting message; the running turn keeps going", async t => {
  const h = await harness(t);
  await h.send("first");
  await until(() => h.held.seen.length === 1, "first turn");
  const second = await h.send("second");
  await until(() => h.cards.length === 1, "queue card");
  const result = await h.controls.onInvoke(click(h.appId, h.nativeId, h.cards[0].card.actions[1].data));
  assert.match(cardText(result), /Queued message cancelled/);
  assert.equal(row(h.appId, second).status, "done");
  assert.equal(h.held.seen[0].signal.aborted, false);
  assert.ok(h.updated.some(payload => payload.messageId === "card-1" && /cancelled/.test(payload.text)), "the shared card loses its buttons");
  h.held.release("first");
  await until(() => h.edited.some(payload => /answer to first/.test(payload.text)), "first answer");
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(h.held.seen.length, 1, "a cancelled message never reaches the engine");
  const again = await h.controls.onInvoke(click(h.appId, h.nativeId, h.cards[0].card.actions[0].data));
  assert.match(cardText(again), /already started, finished or been cancelled/);
});

test("Steer conversation interrupts the sender's own run and answers the steered message before older queued ones", async t => {
  const h = await harness(t);
  const first = await h.send("first");
  await until(() => h.held.seen.length === 1, "first turn");
  const second = await h.send("second");
  const third = await h.send("third");
  await until(() => h.cards.length === 2, "two queue cards");
  const thirdCard = h.cards.find(payload => payload.card.actions[0].data.e === activityFingerprint(third));
  const thirdCardId = `card-${h.cards.indexOf(thirdCard) + 1}`;
  const result = await h.controls.onInvoke(click(h.appId, h.nativeId, thirdCard.card.actions[0].data, "29:author", thirdCardId));
  assert.match(cardText(result), /Steering/);
  assert.equal(h.held.seen[0].signal.reason, STEERED);
  await until(() => h.held.seen.length === 2, "steered turn");
  assert.equal(h.held.seen[1].text, "third", "the steered message runs next");
  assert.ok(h.edited.some(payload => /Interrupted to answer your newer message/.test(payload.text)), "the interrupted turn says why it ended");
  assert.equal(row(h.appId, first).status, "done");
  assert.equal(row(h.appId, second).status, "queued", "the older message keeps its place and identity");
  assert.ok(h.updated.some(payload => payload.messageId === thirdCardId && /Steering/.test(payload.text)), "the shared card shows the steer, without buttons");
  h.held.release("third");
  await until(() => h.held.seen.length === 3, "remaining queued turn");
  assert.equal(h.held.seen[2].text, "second");
});

test("only the sender (or an admitted admin) can answer, and a steer never interrupts another person's run", async t => {
  const h = await harness(t);
  await h.send("other's work", "29:other");
  await until(() => h.held.seen.length === 1, "first turn");
  const mine = await h.send("mine");
  await until(() => h.cards.length === 1, "queue card");
  const [steer, cancel] = h.cards[0].card.actions.map(action => action.data);

  const stranger = await h.controls.onInvoke(click(h.appId, h.nativeId, cancel, "29:other"));
  assert.match(cardText(stranger), /belongs to the person who sent that message/);
  assert.equal(row(h.appId, mine).status, "queued");

  const elsewhere = await h.controls.onInvoke(click(h.appId, `19:${randomUUID()}@thread.tacv2`, cancel));
  assert.match(cardText(elsewhere), /different conversation/);
  assert.equal(row(h.appId, mine).status, "queued");

  const steered = await h.controls.onInvoke(click(h.appId, h.nativeId, steer));
  assert.match(cardText(steered), /belongs to another person/);
  assert.deepEqual(steered.body.value.actions.map(action => action.title), ["Steer conversation", "Cancel request"], "the sender keeps both buttons");
  assert.equal(h.held.seen[0].signal.aborted, false);
  assert.equal(row(h.appId, mine).status, "queued");

  await setUser("29:admin", { name: "Admin", approved: true, isAdmin: true });
  const entry = await getChannelEntry(`teams:${h.nativeId}`);
  await patchChannelMeta(entry.slug, () => ({ access: "approved" }));
  const admin = await h.controls.onInvoke(click(h.appId, h.nativeId, cancel, "29:admin"));
  assert.match(cardText(admin), /Queued message cancelled/);
  assert.equal(row(h.appId, mine).status, "done");
  const audit = getDb().prepare("SELECT data FROM events WHERE event = 'teams_queue_choice' ORDER BY id DESC LIMIT 1").get();
  assert.ok(audit, "every answer is audited");
});

test("forged card data cannot reach another lane, another bot's rows or a running message", async t => {
  const h = await harness(t);
  const first = await h.send("first");
  await until(() => h.held.seen.length === 1, "first turn");
  for (const data of [
    { cgAction: "queue.cancel", q: "controls", e: activityFingerprint(first) },
    { cgAction: "queue.cancel", q: "bot", e: "../../etc" },
  ]) {
    const result = await h.controls.onInvoke(click(h.appId, h.nativeId, data));
    assert.doesNotMatch(cardText(result), /Queued message cancelled/);
  }
  assert.equal(row(h.appId, first).status, "running");
  const running = await h.controls.onInvoke(click(h.appId, h.nativeId, { cgAction: "queue.steer", q: "bot", e: activityFingerprint(first) }));
  assert.match(cardText(running), /already started/);
  assert.equal(h.held.seen[0].signal.aborted, false);
});

test("a queued message that starts on its own retires its card, and a steer never jumps another person's queued message", async t => {
  const h = await harness(t);
  await h.send("first");
  await until(() => h.held.seen.length === 1, "first turn");
  await h.send("other's queued", "29:other");
  const mine = await h.send("mine");
  await until(() => h.cards.length === 2, "two queue cards");
  const mineIndex = h.cards.findIndex(payload => payload.card.actions[0].data.e === activityFingerprint(mine));
  const refused = await h.controls.onInvoke(click(h.appId, h.nativeId, h.cards[mineIndex].card.actions[0].data, "29:author", `card-${mineIndex + 1}`));
  assert.match(cardText(refused), /Another person's message is waiting ahead/);
  assert.equal(h.held.seen[0].signal.aborted, false);
  h.held.release("first");
  await until(() => h.held.seen.length === 2, "next queued turn");
  assert.equal(h.held.seen[1].text, "other's queued", "queue order is unchanged");
  const otherIndex = mineIndex === 0 ? 1 : 0;
  await until(() => h.updated.some(payload => payload.messageId === `card-${otherIndex + 1}` && /has started/.test(payload.text)), "started card");
});
