import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const [status, { postNotice }, { createTeamsControls }, { ensureConversation }, { setUser }, { gatewayRoot }, background] = await Promise.all([
  import("../src/gateway/background-status.js"),
  import("../src/platforms/notify.js"),
  import("../src/platforms/msteams/controls.js"),
  import("../src/platforms/ingest.js"),
  import("../src/config/store.js"),
  import("../src/config/paths.js"),
  import("../src/gateway/background.js"),
]);

const SERVICE = "https://smba.trafficmanager.net/emea/";
const NATIVE = "19:jobs@thread.tacv2";
const JOB = "0f1e2d3c-aaaa-bbbb-cccc-111122223333";
const OTHER_JOB = "9f8e7d6c-aaaa-bbbb-cccc-444455556666";
const log = { warn() {}, error() {}, info() {} };

const { slug } = (await ensureConversation({ conversationId: `teams:${NATIVE}`, rawConversationId: NATIVE, conversationName: "Jobs",
  kind: "channel", isDM: false, platform: "msteams", userId: "29:member" })).entry;
await setUser("29:member", { name: "Member", approved: true });
await setUser("29:stranger", { name: "Stranger", approved: false });

function fakeJobs() {
  const jobs = new Map([
    [JOB, { id: JOB, slug, kind: "agent", label: "nightly report", runtimeMs: 125_000, maxMs: 3_600_000, tail: "step 1\nstep 2\nstep 3", finished: false }],
    [OTHER_JOB, { id: OTHER_JOB, slug: "someone-else", kind: "shell", label: "secret build", runtimeMs: 5_000, maxMs: 60_000, tail: "TOKEN=…", finished: false }],
  ]);
  return {
    status: id => jobs.get(id) || null,
    listForChannel: wanted => [...jobs.values()].filter(job => job.slug === wanted).map(({ id, kind, label, runtimeMs }) => ({ id, kind, label, runtimeMs })),
  };
}

test("a job's status is reported only for its own conversation, and survives completion through its log", async () => {
  const jobs = fakeJobs();
  const running = status.backgroundJobStatus({ jobId: JOB, slug, jobs });
  assert.equal(running.state, "running");
  assert.match(status.backgroundStatusLines(running)[0], /Background agent\*\* nightly report is still running — 2m elapsed/);
  assert.equal(status.backgroundJobStatus({ jobId: OTHER_JOB, slug, jobs }).state, "unknown", "another conversation's job reads nothing");
  assert.equal(status.backgroundJobStatus({ jobId: "../../etc/passwd", slug, jobs }).state, "unknown");

  const finishedId = "abcdef12-0000-0000-0000-000000000000";
  await mkdir(path.join(gatewayRoot(), "logs", "bg"), { recursive: true });
  await writeFile(path.join(gatewayRoot(), "logs", "bg", `${slug}__${finishedId}.log`), "done: 42 rows\n");
  const finished = status.backgroundJobStatus({ jobId: finishedId, slug, jobs });
  assert.equal(finished.state, "finished");
  assert.match(finished.recent, /42 rows/);
  assert.equal(status.backgroundJobStatus({ jobId: finishedId, slug: "someone-else", jobs }).state, "unknown");
});

test("postNotice sends the Adaptive Card only where Adaptive Cards render, and the text everywhere else", async () => {
  const card = status.backgroundStartedCard({ id: JOB, kind: "shell", label: "build" });
  assert.deepEqual(card.actions.map(action => [action.verb, action.data]), [["bgjob.status", { cgAction: "bgjob.status", id: JOB }]]);
  const calls = [];
  const surface = richCards => ({ platform: "x", capabilities: { richCards }, openDm: async () => "",
    post: async payload => { calls.push(["post", richCards, payload]); return {}; },
    postCard: async payload => { calls.push(["card", richCards, payload]); return {}; } });
  for (const richCards of ["adaptive-cards", "cards-v2", "none"]) {
    await postNotice(surface(richCards), { conversationId: "c", text: "started", card });
  }
  assert.deepEqual(calls.map(([kind, richCards]) => [kind, richCards]), [["card", "adaptive-cards"], ["post", "cards-v2"], ["post", "none"]]);
  assert.equal(calls[0][2].text, "started", "the card keeps its text fallback");
  assert.equal(calls[1][2].card, undefined);
});

test("the started notice of a background job carries the status card", async () => {
  const source = await import("node:fs").then(fs => fs.readFileSync(new URL("../src/gateway/background.js", import.meta.url), "utf8"));
  const started = source.match(/async _postStarted\(rec\) \{[\s\S]*?\n  \}/)?.[0] || "";
  assert.match(started, /card: backgroundStartedCard\(rec\)/);
  assert.equal(typeof background.BackgroundJobs, "function");
});

function teams(overrides = {}) {
  const posted = [], cards = [];
  const connector = { platform: "msteams", botId: "28:bot", api: { sendActivity: async () => ({}) },
    async post(payload) { posted.push(payload); return { messageId: "m" }; },
    async postCard(payload) { cards.push(payload); return { messageId: "c" }; } };
  const controls = createTeamsControls({ connector, authorize: async () => assert.fail("no workspace access"), log, ...overrides });
  return { controls, posted, cards };
}
const click = (data, actor = "29:member", conversation = NATIVE, legacy = false) => legacy
  ? { type: "message", id: "a1", from: { id: actor }, recipient: { id: "28:bot" }, conversation: { id: conversation, conversationType: "channel" }, serviceUrl: SERVICE, value: data }
  : { type: "invoke", name: "adaptiveCard/action", id: "a1", replyToId: "notice", from: { id: actor }, recipient: { id: "28:bot" },
    conversation: { id: conversation, conversationType: "channel" }, serviceUrl: SERVICE, value: { action: { type: "Action.Execute", verb: data.cgAction, data } } };
const cardText = result => result.body.value.body.map(item => item.text).join("\n");

test("Check status answers an admitted member privately and refuses a stranger or another conversation's job", async () => {
  const previous = background.getActiveBackgroundJobs();
  background.setActiveBackgroundJobs(fakeJobs());
  try {
    const { controls, posted } = teams();
    const mine = await controls.onInvoke(click({ cgAction: "bgjob.status", id: JOB }));
    assert.match(cardText(mine), /nightly report is still running/);
    assert.match(cardText(mine), /step 3/);
    assert.deepEqual(mine.body.value.actions.map(action => action.title), ["Refresh"]);
    assert.equal(posted.length, 0, "an Execute click is answered in its own response, nothing is posted");

    const stranger = await controls.onInvoke(click({ cgAction: "bgjob.status", id: JOB }, "29:stranger"));
    assert.match(cardText(stranger), /not authorized/);
    assert.doesNotMatch(cardText(stranger), /nightly report/);

    const lifted = await controls.onInvoke(click({ cgAction: "bgjob.status", id: OTHER_JOB }));
    assert.doesNotMatch(cardText(lifted), /secret build|TOKEN/);
    assert.match(cardText(lifted), /no longer running here/);

    const elsewhere = await controls.onInvoke(click({ cgAction: "bgjob.status", id: JOB }, "29:member", "19:unregistered@thread.tacv2"));
    assert.match(cardText(elsewhere), /not authorized/);

    await controls.onInvoke(click({ cgAction: "bgjob.status", id: JOB }, "29:member", NATIVE, true));
    assert.equal(posted.length, 1, "a legacy Submit click gets the status in a private message");
    assert.equal(posted[0].ephemeralTo, "29:member");
    assert.match(posted[0].text, /still running/);
  } finally { background.setActiveBackgroundJobs(previous); }
});

test("/jobs lists the conversation's running work with a status button per job, and refuses a stranger", async () => {
  const previous = background.getActiveBackgroundJobs();
  background.setActiveBackgroundJobs(fakeJobs());
  try {
    const { controls } = teams();
    const replies = [], cards = [];
    const args = (userId, text = "/jobs") => ({ message: { text, trigger: "message", conversationId: `teams:${NATIVE}`, rawConversationId: NATIVE, userId, isDM: false },
      reply: async value => replies.push(value), replyCard: async value => { cards.push(value); return {}; } });
    assert.equal(await controls.onCommand(args("29:member")), true);
    assert.equal(cards.length, 1);
    const listed = cards[0].card.body.map(item => item.text).join("\n");
    assert.match(listed, /nightly report/);
    assert.doesNotMatch(listed, /secret build/);
    assert.deepEqual(cards[0].card.actions.map(action => action.data.id), [JOB]);
    assert.match(cards[0].text, /Background work in this conversation \(1\)/);

    assert.equal(await controls.onCommand(args("29:stranger")), true);
    assert.match(replies.at(-1), /not authorized/);
    assert.equal(await controls.onCommand(args("29:member", "/jobs please")), false, "only the bare command");
  } finally { background.setActiveBackgroundJobs(previous); }
});

test("/jobs with nothing running says so", async () => {
  const previous = background.getActiveBackgroundJobs();
  background.setActiveBackgroundJobs({ status: () => null, listForChannel: () => [] });
  try {
    const { controls } = teams();
    const replies = [];
    await controls.onCommand({ message: { text: "/jobs", trigger: "message", conversationId: `teams:${NATIVE}`, rawConversationId: NATIVE, userId: "29:member", isDM: false },
      reply: async value => replies.push(value), replyCard: null });
    assert.deepEqual(replies, ["No background jobs are running in this conversation."]);
  } finally { background.setActiveBackgroundJobs(previous); }
});
