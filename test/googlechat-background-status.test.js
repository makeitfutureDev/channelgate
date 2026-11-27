// Google Chat access to background work: the Cards v2 "Check status" button on a job's started
// notice and `/jobs`. Answers are private to the clicker; a job is reported only for the
// conversation Google's verified click envelope names.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const [status, { postNotice }, { createGoogleChatControls }, { ensureConversation }, { setUser }, background, { GOOGLE_CHAT_CONTROL_COMMAND, normalizeMessage }, { GOOGLE_CHAT_HELP_TEXT }] = await Promise.all([
  import("../src/gateway/background-status.js"),
  import("../src/platforms/notify.js"),
  import("../src/platforms/googlechat/controls.js"),
  import("../src/platforms/ingest.js"),
  import("../src/config/store.js"),
  import("../src/gateway/background.js"),
  import("../src/platforms/googlechat/events.js"),
  import("../src/platforms/googlechat/help.js"),
]);

const SPACE = "spaces/JOBS";
const JOB = "0f1e2d3c-aaaa-bbbb-cccc-111122223333";
const OTHER_JOB = "9f8e7d6c-aaaa-bbbb-cccc-444455556666";
const log = { warn() {}, error() {}, info() {} };
const member = { email: "member@example.com", name: "users/201" };
const stranger = { email: "stranger@example.com", name: "users/202" };

const { slug } = (await ensureConversation({ conversationId: `gchat:${SPACE}`, rawConversationId: SPACE, conversationName: "Jobs",
  kind: "channel", isDM: false, platform: "googlechat", userId: member.email })).entry;
await setUser(member.email, { name: "Member", approved: true, googleChatUserName: member.name });
await setUser(stranger.email, { name: "Stranger", approved: false });

function fakeJobs() {
  const jobs = new Map([
    [JOB, { id: JOB, slug, kind: "agent", label: "nightly <report>", runtimeMs: 125_000, maxMs: 3_600_000, tail: "step 1\nstep 2\nstep 3", finished: false }],
    [OTHER_JOB, { id: OTHER_JOB, slug: "someone-else", kind: "shell", label: "secret build", runtimeMs: 5_000, maxMs: 60_000, tail: "TOKEN=…", finished: false }],
  ]);
  return {
    status: id => jobs.get(id) || null,
    listForChannel: wanted => [...jobs.values()].filter(job => job.slug === wanted).map(({ id, kind, label, runtimeMs }) => ({ id, kind, label, runtimeMs })),
  };
}
async function withJobs(jobs, body) {
  const previous = background.getActiveBackgroundJobs();
  background.setActiveBackgroundJobs(jobs);
  try { await body(); } finally { background.setActiveBackgroundJobs(previous); }
}

const buttonsOf = card => card.sections.flatMap(section => section.widgets).flatMap(widget => widget.buttonList?.buttons || []);
const textOf = card => card.sections.flatMap(section => section.widgets).map(widget => widget.textParagraph?.text || "").join("\n");

function chat() {
  const posted = [], cards = [], updated = [];
  let n = 0;
  const connector = { platform: "googlechat", botUserId: "users/bot", api: {},
    async post(payload) { posted.push(payload); return { messageId: `${SPACE}/messages/p${++n}` }; },
    async postCard(payload) { cards.push(payload); return { messageId: `${SPACE}/messages/c${++n}` }; },
    async updateCard(payload) { updated.push(payload); } };
  const controls = createGoogleChatControls({ connector, authorize: async () => assert.fail("no workspace access"), log });
  const click = (action, who = member, space = SPACE, messageId = `${space}/messages/notice`) => controls.onCard({
    conversationId: `gchat:${space}`, rawConversationId: space, messageId, threadKey: `${space}/threads/T`,
    userId: who.email, userResourceName: who.name, action, formInputs: {}, raw: {} });
  return { controls, connector, posted, cards, updated, click };
}

test("postNotice sends the Cards v2 card on Google Chat, the Adaptive Card on Teams, and the text elsewhere", async () => {
  const rec = { id: JOB, kind: "shell", label: "build" };
  const card = status.backgroundStartedCard(rec), chatCard = status.backgroundStartedChatCard(rec);
  const calls = [];
  const surface = richCards => ({ platform: "x", capabilities: { richCards }, openDm: async () => "",
    post: async payload => { calls.push(["post", richCards, payload]); return {}; },
    postCard: async payload => { calls.push(["card", richCards, payload]); return {}; } });
  for (const richCards of ["adaptive-cards", "cards-v2", "block-kit", "none"]) {
    await postNotice(surface(richCards), { conversationId: "c", text: "started", card, chatCard });
  }
  assert.deepEqual(calls.map(([kind, richCards]) => [kind, richCards]), [["card", "adaptive-cards"], ["card", "cards-v2"], ["post", "block-kit"], ["post", "none"]]);
  assert.equal(calls[0][2].card, card);
  assert.equal(calls[1][2].card, chatCard);
  assert.equal(calls[1][2].text, "started", "the card keeps its text line");
  const [button] = buttonsOf(chatCard);
  assert.equal(button.text, "Check status");
  assert.deepEqual(button.onClick.action.parameters, [{ key: "cgAction", value: "bgjob.status" }, { key: "stateId", value: "" }, { key: "id", value: JSON.stringify(JOB) }],
    "the button carries only the job id");
  await postNotice(surface("cards-v2"), { conversationId: "c", text: "private", chatCard, ephemeralTo: "users/1" });
  assert.equal(calls.at(-1)[0], "post", "a private notice is never a shared card");
});

test("the started notice of a background job carries the Chat status card", () => {
  const source = readFileSync(new URL("../src/gateway/background.js", import.meta.url), "utf8");
  const started = source.match(/async _postStarted\(rec\) \{[\s\S]*?\n  \}/)?.[0] || "";
  assert.match(started, /card: backgroundStartedCard\(rec\)/);
  assert.match(started, /chatCard: backgroundStartedChatCard\(rec\)/);
});

test("Check status answers an admitted member privately, escaped, and refuses a stranger or another conversation's job", async () => {
  await withJobs(fakeJobs(), async () => {
    const h = chat();
    const button = buttonsOf(status.backgroundStartedChatCard({ id: JOB, kind: "agent", label: "nightly" }))[0];
    await h.click(button.onClick.action);
    const mine = h.cards.at(-1);
    assert.equal(mine.privateTo, member.name, "only the clicker sees the status");
    assert.match(textOf(mine.card), /nightly &lt;report&gt; is still running — 2m elapsed/);
    assert.match(textOf(mine.card), /<b>Background agent<\/b>/);
    assert.match(textOf(mine.card), /step 3/);
    assert.deepEqual(buttonsOf(mine.card).map(item => item.text), ["Refresh"]);

    // Refresh on the private status card repaints it instead of adding another message.
    await h.click(buttonsOf(mine.card)[0].onClick.action, member, SPACE, `${SPACE}/messages/c1`);
    assert.equal(h.cards.length, 1);
    assert.equal(h.updated.at(-1).messageId, `${SPACE}/messages/c1`);

    await h.click(button.onClick.action, stranger);
    assert.match(h.posted.at(-1).text, /not authorized/);
    assert.equal(h.posted.at(-1).ephemeralTo, stranger.name);
    assert.equal(h.cards.length, 1, "nothing about the job reaches a stranger");

    const lifted = buttonsOf(status.backgroundStartedChatCard({ id: OTHER_JOB, kind: "shell", label: "x" }))[0];
    await h.click(lifted.onClick.action);
    assert.doesNotMatch(JSON.stringify(h.cards.at(-1)), /secret build|TOKEN/);
    assert.match(textOf(h.cards.at(-1).card), /no longer running here/);

    const before = h.cards.length;
    await h.click(button.onClick.action, member, "spaces/UNREGISTERED");
    assert.match(h.posted.at(-1).text, /not authorized/);
    assert.equal(h.cards.length, before);
  });
});

test("/jobs lists the conversation's running work privately with a status button per job, and refuses a stranger", async () => {
  await withJobs(fakeJobs(), async () => {
    const h = chat();
    const replies = [];
    const args = (who, text = "/jobs") => ({ message: { text, trigger: "message", conversationId: `gchat:${SPACE}`, rawConversationId: SPACE,
      threadKey: `${SPACE}/threads/T`, userId: who.email, isDM: false, raw: { senderName: who.name } }, reply: async value => replies.push(value) });
    assert.equal(await h.controls.onCommand(args(member)), true);
    const listed = h.cards.at(-1);
    assert.equal(listed.privateTo, member.name);
    assert.match(listed.card.header.title, /Background work in this conversation \(1\)/);
    assert.match(textOf(listed.card), /nightly &lt;report&gt;/);
    assert.doesNotMatch(JSON.stringify(listed.card), /secret build/);
    assert.deepEqual(buttonsOf(listed.card).map(item => JSON.parse(item.onClick.action.parameters.find(p => p.key === "id").value)), [JOB]);

    assert.equal(await h.controls.onCommand(args(stranger)), true);
    assert.match(replies.at(-1), /not authorized/);
    assert.equal(await h.controls.onCommand(args(member, "/jobs please")), false, "only the bare command");

    // Without the sender's Chat resource name the same list arrives as text.
    await h.controls.onCommand({ ...args(member), message: { ...args(member).message, raw: {} } });
    assert.match(replies.at(-1), /Background work in this conversation \(1\):/);
  });
});

test("/jobs with nothing running says so", async () => {
  await withJobs({ status: () => null, listForChannel: () => [] }, async () => {
    const h = chat();
    await h.controls.onCommand({ message: { text: "/jobs", trigger: "message", conversationId: `gchat:${SPACE}`, rawConversationId: SPACE,
      threadKey: "", userId: member.email, isDM: false, raw: { senderName: member.name } }, reply: async () => assert.fail("card expected") });
    assert.match(textOf(h.cards.at(-1).card), /No background jobs are running in this conversation/);
  });
});

test("/jobs takes the control lane, bypasses the mention gate as a registered command, and is in /help", () => {
  assert.ok(GOOGLE_CHAT_CONTROL_COMMAND.test("/jobs"));
  const message = normalizeMessage({ space: { name: SPACE, displayName: "Jobs", spaceType: "SPACE" },
    message: { name: `${SPACE}/messages/m`, text: "/jobs", argumentText: "", slashCommand: { commandId: 9 }, sender: { email: member.email },
      annotations: [{ type: "SLASH_COMMAND", slashCommand: { commandName: "/jobs", commandId: 9 } }] } });
  assert.equal(message.text, "/jobs");
  assert.equal(message.mentionsBot, true);
  assert.match(GOOGLE_CHAT_HELP_TEXT, /`\/jobs` — List running background jobs\./);
  assert.match(GOOGLE_CHAT_HELP_TEXT, /Check status/);
  assert.match(GOOGLE_CHAT_HELP_TEXT, /with Steer and Cancel buttons/);
});
