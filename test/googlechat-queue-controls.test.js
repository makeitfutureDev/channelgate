// Google Chat's busy-thread Steer / Cancel card, end to end through the real transport (durable
// intake, queue notices, control lane), the shared ingest and the Chat controls. Every Chat write is
// a recording fake; the engine is a held run released by the test.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const [{ startGoogleChat }, { getDb }, { createIngest }, { setUser, getChannelEntry, patchChannelMeta }, { googleChatAdapter }, { createGoogleChatControls }, { STEERED }, { queuedMessageChatCard }] = await Promise.all([
  import("../src/platforms/googlechat/transport.js"),
  import("../src/db/index.js"),
  import("../src/platforms/ingest.js"),
  import("../src/config/store.js"),
  import("../src/platforms/googlechat.js"),
  import("../src/platforms/googlechat/controls.js"),
  import("../src/platforms/conversation-controls.js"),
  import("../src/platforms/googlechat/queue-controls.js"),
]);

const log = { error() {}, warn() {}, info() {}, log() {} };
const BOT = { name: "users/bot", type: "BOT" };
const people = { ana: { email: "ana@example.com", name: "users/101" }, bob: { email: "bob@example.com", name: "users/102" }, cleo: { email: "cleo@example.com", name: "users/103" } };
await setUser(people.ana.email, { name: "Ana", approved: true, googleChatUserName: people.ana.name });
await setUser(people.bob.email, { name: "Bob", approved: true, googleChatUserName: people.bob.name });

async function until(predicate, what = "expected state") {
  for (let count = 0; count < 400; count++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(`Google Chat queue did not reach the ${what}`);
}

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

const buttonsOf = card => card.sections.flatMap(section => section.widgets).flatMap(widget => widget.buttonList?.buttons || []);
const valuesOf = button => Object.fromEntries(button.onClick.action.parameters.map(({ key, value }) => [key, value]));

async function harness(t) {
  const space = `spaces/Q${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const thread = `${space}/threads/work`;
  const SPACE = { name: space, displayName: "Queue tests", spaceType: "SPACE" };
  const held = heldRuns();
  const posted = [], cards = [], updated = [], edited = [];
  let sent = 0;
  const connector = { platform: "googlechat", capabilities: googleChatAdapter.capabilities, botUserId: BOT.name, api: {},
    async post(payload) { posted.push(payload); return { conversationId: space, messageId: `${space}/messages/post-${++sent}`, threadKey: payload.threadKey || "" }; },
    async postCard(payload) { cards.push(payload); return { conversationId: space, messageId: `${space}/messages/card-${cards.length}`, threadKey: payload.threadKey || "" }; },
    async updateCard(payload) { updated.push(payload); },
    async edit(payload) { edited.push(payload); },
    async remove() {},
    async directory() { return { map: new Map(), maxWords: 1 }; },
  };
  const controls = createGoogleChatControls({ connector, authorize: async () => assert.fail("queue controls never open a workspace"), log });
  const ingest = createIngest({ connector, run: held.run, log, onCommand: controls.onCommand, controls: controls.conversation, queueNotice: controls.queueNotice });
  const subscription = `projects/cg-test/subscriptions/queue-${randomUUID().slice(0, 8)}`;
  const transport = await startGoogleChat({ subscription,
    capabilities: googleChatAdapter.capabilities, onMessage: (message, context) => ingest(message, context), onCard: controls.onCard, log,
    deps: { auth: { token: async () => "t" }, api: {}, connector, puller: { start() {}, async stop() {} } } });
  t.after(async () => { held.releaseAll(); await transport.stop(); });
  const send = async (text, who = people.ana) => {
    const name = `${space}/messages/${randomUUID().slice(0, 8)}`;
    await transport.onEvent({ chat: { messagePayload: { space: SPACE, message: { name, text: `@Bot ${text}`, argumentText: ` ${text}`,
      sender: { name: who.name, email: who.email, displayName: who.email, type: "HUMAN" }, thread: { name: thread },
      annotations: [{ type: "USER_MENTION", userMention: { user: BOT } }] } } } });
    return name;
  };
  // A click on one of the posted cards' buttons, delivered as the HTTP endpoint delivers it.
  const click = async (button, { who = people.ana, cardIndex = 0, onSpace = SPACE } = {}) => {
    const before = updated.length + posted.length + cards.length;
    await transport.onEvent({ chat: { user: { name: who.name, email: who.email, type: "HUMAN" }, buttonClickedPayload: {
      space: onSpace, message: { name: `${onSpace.name}/messages/card-${cardIndex + 1}`, thread: { name: `${onSpace.name}/threads/work` }, sender: BOT },
      action: button.onClick.action } } }, {}, { messageId: `click-${randomUUID()}` });
    await until(() => updated.length + posted.length + cards.length > before, "click answer");
  };
  const row = eventId => getDb().prepare("SELECT status FROM inbound_events WHERE namespace = ? AND event_id = ?").get(`googlechat:${subscription}`, eventId);
  const queueCards = () => cards.filter(payload => payload.card?.header?.title?.startsWith("⏳ Waiting"));
  return { space, SPACE, held, posted, cards, updated, edited, send, click, row, queueCards, controls, connector };
}

test("a Google Chat message queued behind running work gets a Cards v2 Steer / Cancel card", async t => {
  const h = await harness(t);
  await h.send("first");
  await until(() => h.held.seen.length === 1, "first turn");
  const second = await h.send("second");
  await until(() => h.queueCards().length === 1, "queue card");
  const posted = h.queueCards()[0];
  assert.equal(posted.text, "Queued in this session (position 1).", "the position line stays the message text");
  assert.equal(posted.privateTo, undefined, "the card is shared, so an admitted admin can answer it");
  assert.deepEqual(buttonsOf(posted.card).map(button => button.text), ["Steer conversation", "Cancel request"]);
  const values = valuesOf(buttonsOf(posted.card)[0]);
  assert.deepEqual(Object.keys(values).sort(), ["cgAction", "e", "q", "stateId"], "the card names the waiting row only, never an identity");
  assert.equal(JSON.parse(values.q), "chat");
  assert.equal(JSON.parse(values.e), second);
  assert.ok(h.posted.every(payload => !/Queued in this session/.test(payload.text || "")), "no second, plain notice");
});

test("Cancel request drops only the waiting message and removes the shared card's buttons", async t => {
  const h = await harness(t);
  await h.send("first");
  await until(() => h.held.seen.length === 1, "first turn");
  const second = await h.send("second");
  await until(() => h.queueCards().length === 1, "queue card");
  const cardIndex = h.cards.indexOf(h.queueCards()[0]);
  await h.click(buttonsOf(h.queueCards()[0].card)[1], { cardIndex });
  await until(() => h.updated.some(payload => /Queued message cancelled/.test(payload.text)), "cancel outcome");
  const outcome = h.updated.find(payload => /Queued message cancelled/.test(payload.text));
  assert.equal(outcome.messageId, `${h.space}/messages/card-${cardIndex + 1}`);
  assert.equal(outcome.card, null, "the settled card keeps no buttons");
  assert.equal(h.row(second).status, "done");
  assert.equal(h.held.seen[0].signal.aborted, false);
  h.held.release("first");
  await until(() => h.edited.some(payload => /answer to first/.test(payload.text)), "first answer");
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(h.held.seen.length, 1, "a cancelled message never reaches the engine");
  const before = h.updated.length;
  await h.click(buttonsOf(h.queueCards()[0].card)[0], { cardIndex });
  assert.match(h.updated.slice(before).map(payload => payload.text).join(" "), /already started, finished or been cancelled/);
});

test("Steer conversation interrupts the sender's own run and answers the steered message next", async t => {
  const h = await harness(t);
  const first = await h.send("first");
  await until(() => h.held.seen.length === 1, "first turn");
  const second = await h.send("second");
  const third = await h.send("third");
  await until(() => h.queueCards().length === 2, "two queue cards");
  const thirdCard = h.queueCards().find(payload => JSON.parse(valuesOf(buttonsOf(payload.card)[0]).e) === third);
  await h.click(buttonsOf(thirdCard.card)[0], { cardIndex: h.cards.indexOf(thirdCard) });
  await until(() => h.held.seen.length === 2, "steered turn");
  assert.equal(h.held.seen[0].signal.reason, STEERED);
  assert.equal(h.held.seen[1].text, "third", "the steered message runs next");
  await until(() => h.edited.some(payload => /Interrupted to answer your newer message/.test(payload.text)), "interrupted answer");
  assert.ok(h.updated.some(payload => payload.messageId === `${h.space}/messages/card-${h.cards.indexOf(thirdCard) + 1}` && /Steering/.test(payload.text)));
  assert.equal(h.row(first).status, "done");
  assert.equal(h.row(second).status, "queued", "the older message keeps its place and identity");
  const audit = getDb().prepare("SELECT data FROM events WHERE event = 'googlechat_queue_choice' ORDER BY id DESC LIMIT 1").get();
  assert.match(audit?.data || "", /steered/);
  h.held.release("third");
  await until(() => h.held.seen.length === 3, "remaining queued turn");
  assert.equal(h.held.seen[2].text, "second");
});

test("only the sender or an admitted admin can answer, privately, and a steer never interrupts another person's run", async t => {
  const h = await harness(t);
  await h.send("bob's work", people.bob);
  await until(() => h.held.seen.length === 1, "first turn");
  const mine = await h.send("mine");
  await until(() => h.queueCards().length === 1, "queue card");
  const cardIndex = h.cards.indexOf(h.queueCards()[0]);
  const [steer, cancel] = buttonsOf(h.queueCards()[0].card);

  await h.click(cancel, { who: people.bob, cardIndex });
  const refusal = h.posted.at(-1);
  assert.match(refusal.text, /belongs to the person who sent that message/);
  assert.equal(refusal.ephemeralTo, people.bob.name, "a refusal is shown only to the clicker");
  assert.equal(h.row(mine).status, "queued");

  const elsewhere = { name: "spaces/ELSEWHERE", displayName: "Other", spaceType: "SPACE" };
  await h.click(cancel, { cardIndex, onSpace: elsewhere });
  assert.match(h.posted.at(-1).text, /different conversation/);
  assert.equal(h.row(mine).status, "queued");

  await h.click(steer, { cardIndex });
  const still = h.cards.at(-1);
  assert.equal(still.privateTo, people.ana.name, "the sender's 'still queued' answer is private");
  assert.match(JSON.stringify(still.card), /belongs to another person/);
  assert.deepEqual(buttonsOf(still.card).map(button => button.text), ["Steer conversation", "Cancel request"], "the sender keeps both buttons");
  assert.equal(h.held.seen[0].signal.aborted, false);
  assert.equal(h.row(mine).status, "queued");

  await setUser(people.cleo.email, { name: "Cleo", approved: true, isAdmin: true, googleChatUserName: people.cleo.name });
  const entry = await getChannelEntry(`gchat:${h.space}`);
  await patchChannelMeta(entry.slug, () => ({ access: "approved" }));
  await h.click(cancel, { who: people.cleo, cardIndex });
  await until(() => h.row(mine).status === "done", "admin cancel");
  const audit = getDb().prepare("SELECT data FROM events WHERE event = 'googlechat_queue_choice' ORDER BY id DESC LIMIT 1").get();
  assert.match(audit?.data || "", /"admin":true/);
});

test("forged card values cannot reach another lane, a running message or path-shaped ids", async t => {
  const h = await harness(t);
  const first = await h.send("first");
  await until(() => h.held.seen.length === 1, "first turn");
  const forged = values => ({ onClick: { action: { function: values.cgAction, parameters: Object.entries(values).map(([key, value]) => ({ key, value: key === "cgAction" || key === "stateId" ? value : JSON.stringify(value) })) } } });
  for (const values of [{ cgAction: "queue.cancel", stateId: "", q: "controls", e: first }, { cgAction: "queue.cancel", stateId: "", q: "chat", e: "../../etc" }]) {
    await h.click(forged(values));
    const answer = h.cards.at(-1);
    assert.equal(answer.card.header.title, "Action unavailable");
    assert.equal(answer.privateTo, people.ana.name);
    assert.match(JSON.stringify(answer.card), /Invalid queue control/);
  }
  assert.equal(h.row(first).status, "running");
  await h.click(forged({ cgAction: "queue.steer", stateId: "", q: "chat", e: first }));
  assert.match(h.updated.at(-1).text, /already started/);
  assert.equal(h.held.seen[0].signal.aborted, false);
});

test("a queued message that starts on its own retires its card", async t => {
  const h = await harness(t);
  await h.send("first");
  await until(() => h.held.seen.length === 1, "first turn");
  await h.send("second");
  await until(() => h.queueCards().length === 1, "queue card");
  const cardIndex = h.cards.indexOf(h.queueCards()[0]);
  h.held.release("first");
  await until(() => h.updated.some(payload => payload.messageId === `${h.space}/messages/card-${cardIndex + 1}` && /has started/.test(payload.text)), "started card");
});

test("a card answers from its durable row alone, so it keeps working for a fresh controls instance (restart)", async t => {
  const h = await harness(t);
  await h.send("first");
  await until(() => h.held.seen.length === 1, "first turn");
  const second = await h.send("second");
  await until(() => h.queueCards().length === 1, "queue card");
  const cardIndex = h.cards.indexOf(h.queueCards()[0]);
  // A new controls instance has no memory of posted cards, opened state or live lanes.
  const fresh = createGoogleChatControls({ connector: h.connector, authorize: async () => assert.fail("no workspace access"), log });
  const messageId = `${h.space}/messages/card-${cardIndex + 1}`;
  await fresh.onCard({ conversationId: `gchat:${h.space}`, rawConversationId: h.space, messageId, threadKey: `${h.space}/threads/work`,
    userId: people.ana.email, userResourceName: people.ana.name, action: buttonsOf(h.queueCards()[0].card)[1].onClick.action, formInputs: {}, raw: {} });
  assert.equal(h.row(second).status, "done");
  assert.ok(h.updated.some(payload => payload.messageId === messageId && /Queued message cancelled/.test(payload.text)));
});

test("the queue card names the /stop fallback and stays within Chat's card limits", () => {
  const card = queuedMessageChatCard({ queuedEvent: { kind: "chat", eventId: "spaces/A/messages/B.C" } });
  assert.match(card.header.title, /Waiting behind work/);
  assert.match(JSON.stringify(card), /Buttons not responding\? `\/stop`/);
  assert.ok(Buffer.byteLength(JSON.stringify(card)) < 4000);
});
