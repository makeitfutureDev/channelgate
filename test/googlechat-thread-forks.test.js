// Thread forks in Google Chat, end to end through the real transport (durable intake, session holds,
// control lane), the shared ingest, the shared approval backend and the Google Chat fork runner.
// Every Chat write is a recording fake; each engine turn is a fake run the test can hold.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const [{ startGoogleChat }, { createIngest }, store, { googleChatAdapter }, { createGoogleChatControls }, forksModule,
  { saveSession }, approvalsModule, approvalRequests, { prepareThreadForkApproval, describeThreadForks, executeThreadForkApproval, threadForkOrigin },
  { runApprovedThreadForks }, live, { listPlatformThreadsForUser }, { register: registerThreadForkTool }, { GOOGLE_CHAT_CONTROL_COMMAND, GOOGLE_CHAT_QUEUED_COMMAND },
  { GOOGLE_CHAT_HELP_TEXT }] = await Promise.all([
  import("../src/platforms/googlechat/transport.js"),
  import("../src/platforms/ingest.js"),
  import("../src/config/store.js"),
  import("../src/platforms/googlechat.js"),
  import("../src/platforms/googlechat/controls.js"),
  import("../src/platforms/googlechat/thread-forks.js"),
  import("../src/gateway/sessions.js"),
  import("../src/slack/approvals.js"),
  import("../src/gateway/approval-requests.js"),
  import("../src/gateway/thread-fork-approvals.js"),
  import("../src/platforms/thread-fork-dispatch.js"),
  import("../src/platforms/live.js"),
  import("../src/gateway/platform-threads.js"),
  import("../src/mcp/tools/thread-forks.js"),
  import("../src/platforms/googlechat/events.js"),
  import("../src/platforms/googlechat/help.js"),
]);
const { createGoogleChatThreadForks, parseForkCommand, FORK_NOT_THREADED, FORK_FLAT_CHAT, googleChatThreadUrl } = forksModule;
const { requestApproval, lookupApproval, applyApprovalDecision, setDurableApprovalExecutor } = approvalsModule;
const { getApprovalRequest } = approvalRequests;

const log = { error() {}, warn() {}, info() {}, log() {} };
const BOT = { name: "users/bot", type: "BOT" };
const people = {
  ana: { email: "ana.fork@example.com", name: "users/201" },
  bob: { email: "bob.fork@example.com", name: "users/202" },
  root: { email: "root.fork@example.com", name: "users/203" },
};
await store.setUser(people.ana.email, { name: "Ana", approved: true, googleChatUserName: people.ana.name });
await store.setUser(people.bob.email, { name: "Bob", approved: true, googleChatUserName: people.bob.name });
await store.setUser(people.root.email, { name: "Root", approved: true, isAdmin: true, googleChatUserName: people.root.name });

async function until(predicate, what = "expected state") {
  for (let count = 0; count < 600; count++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(`Google Chat forks did not reach the ${what}`);
}
const settle = () => new Promise(resolve => setTimeout(resolve, 40));

// Every turn waits for the test unless auto-released; a fork turn reports its native copy when released.
function heldRuns({ auto = false } = {}) {
  const seen = [];
  const releases = new Map();
  const run = async args => {
    seen.push(args);
    if (!auto) {
      await new Promise((resolve, reject) => {
        releases.set(args.threadKey + "|" + args.text, resolve);
        if (args.signal.aborted) { reject(new Error("stopped")); return; }
        args.signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true });
      });
    }
    if (args.forkSourceSessionId) args.onForkSessionResolved?.(`child-of-${args.forkSourceSessionId}`);
    return { content: `answer to ${args.text}`, engine: "claude" };
  };
  return { seen, run,
    release: (threadKey, text) => releases.get(threadKey + "|" + text)?.(),
    releaseAll: () => { for (const done of releases.values()) done(); } };
}

async function harness(t, { threading = "THREADED_MESSAGES", spaceType = "SPACE", auto = true, failRoot = 0, displayName = "Fork tests" } = {}) {
  const space = `spaces/F${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const thread = `${space}/threads/source`;
  const SPACE = { name: space, ...(displayName ? { displayName } : {}), spaceType };
  const held = heldRuns({ auto });
  const posted = [], cards = [], updated = [], edited = [];
  let sent = 0, roots = 0;
  const connector = { platform: "googlechat", capabilities: googleChatAdapter.capabilities, botUserId: BOT.name, ready: () => true,
    api: { getSpace: async name => ({ name, spaceType, spaceThreadingState: threading }) },
    async post(payload) {
      const top = !payload.threadKey;
      if (top && ++roots === failRoot) throw new Error("Chat refused the post");
      posted.push(payload);
      const id = ++sent;
      return { conversationId: space, messageId: `${space}/messages/post-${id}`, threadKey: payload.threadKey || `${space}/threads/fork-${id}` };
    },
    async postCard(payload) { cards.push(payload); return { conversationId: space, messageId: `${space}/messages/card-${cards.length}`, threadKey: payload.threadKey || "" }; },
    async updateCard(payload) { updated.push(payload); },
    async edit(payload) { edited.push(payload); },
    async remove() {},
    async directory() { return { map: new Map(), maxWords: 1 }; },
  };
  const controls = createGoogleChatControls({ connector, authorize: async () => assert.fail("no workspace controls here"), log });
  const forks = createGoogleChatThreadForks({ connector, conversation: controls.conversation, log });
  connector.threadForkRefusal = forks.refusal;
  connector.runThreadForks = forks.runApproved;
  const onCommand = async args => await forks.guard(args) || await forks.command(args) || controls.onCommand(args);
  const ingest = createIngest({ connector, run: held.run, log, onCommand, controls: controls.conversation, queueNotice: controls.queueNotice });
  const subscription = `projects/cg-test/subscriptions/fork-${randomUUID().slice(0, 8)}`;
  const transport = await startGoogleChat({ subscription, capabilities: googleChatAdapter.capabilities,
    onMessage: (message, options) => options?.fork ? forks.runChild(ingest, message, options) : ingest(message, options), onCard: controls.onCard, log,
    deps: { auth: { token: async () => "t" }, api: {}, connector, puller: { start() {}, async stop() {} } } });
  live.registerTransport("googlechat", { getConnector: () => connector, snapshot: () => ({ connected: true }) });
  t.after(async () => { held.releaseAll(); await transport.stop(); live.unregisterTransport("googlechat"); });
  const send = async (text, who = people.ana, threadName = thread) => {
    const name = `${space}/messages/${randomUUID().slice(0, 8)}`;
    await transport.onEvent({ chat: { messagePayload: { space: SPACE, message: { name, text: `@Bot ${text}`, argumentText: ` ${text}`,
      sender: { name: who.name, email: who.email, displayName: who.email, type: "HUMAN" }, thread: { name: threadName }, threadReply: true,
      annotations: [{ type: "USER_MENTION", userMention: { user: BOT } }] } } } });
    return name;
  };
  const channelId = `gchat:${space}`;
  // One completed turn registers the conversation; the source thread then holds a container session.
  const prime = async () => {
    await send("hello");
    if (!auto) { await until(() => held.seen.length === 1, "priming turn"); held.release(thread, "hello"); }
    await until(() => edited.some(p => /answer to hello/.test(p.text || "")), "priming answer");
    const entry = await store.getChannelEntry(channelId);
    await saveSession(entry.slug, thread, "source-session", "claude", null, JSON.stringify({ backend: "container", scope: "project" }));
    return entry.slug;
  };
  return { space, thread, SPACE, channelId, held, posted, cards, updated, send, prime, forks, connector, transport,
    roots: () => posted.filter(p => !p.threadKey), childRuns: () => held.seen.filter(a => a.forkSourceSessionId) };
}

const forkItems = [{ title: "Pricing", prompt: "Discuss pricing for our marker." }, { title: "Onboarding", prompt: "Discuss onboarding for our marker." }];
const ctxFor = (h, slug, who = people.ana) => ({ slug, channelId: h.channelId, createdBy: who.email, threadKey: h.thread, toolset: "full", principalTrusted: true, origin: "googlechat_foreground" });

async function propose(h, slug, items = forkItems) {
  const action = await prepareThreadForkApproval(ctxFor(h, slug), { forks: items });
  const response = await requestApproval({ getClient: () => null }, {
    channelId: h.channelId, slug, authorId: people.ana.email, threadKey: h.thread, toolName: "propose_thread_forks",
    approvalType: "agent", requiredTier: "owner", toolInput: { details: describeThreadForks(action.forks) }, durableAction: action,
    approveText: `Create ${items.length} forks`, denyText: "Cancel",
  });
  assert.equal(response.pending, true, response.reason);
  return response.approvalId;
}
function approve(id, actorId = people.ana.email) {
  setDurableApprovalExecutor(record => executeThreadForkApproval(record, { runBatch: saved => runApprovedThreadForks(saved, { runSlack: () => assert.fail("not Slack") }) }));
  const found = lookupApproval(id);
  return applyApprovalDecision({ id, entry: found.entry, durable: found.durable, decision: "approve", actorId, actorLabel: actorId });
}
const buttonsOf = card => card.sections.flatMap(section => section.widgets).flatMap(widget => widget.buttonList?.buttons || []);

test("the fork tool registers for a trusted Google Chat foreground turn only, and Slack is unchanged", () => {
  const tools = ctx => { const names = []; registerThreadForkTool({ registerTool: name => names.push(name) }, { text: () => ({}), ...ctx }); return names; };
  const base = { toolset: "full", principalTrusted: true };
  assert.deepEqual(tools({ ...base, channelId: "gchat:spaces/AAA", threadKey: "spaces/AAA/threads/T", origin: "googlechat_foreground" }), ["propose_thread_forks"]);
  // A DM's flat session key still gets the tool, so the call can say why it cannot fork there.
  assert.deepEqual(tools({ ...base, channelId: "gchat:spaces/AAA", threadKey: "gchat:spaces/AAA", origin: "googlechat_foreground" }), ["propose_thread_forks"]);
  for (const ctx of [
    { ...base, channelId: "gchat:spaces/AAA", threadKey: "spaces/AAA/threads/T", origin: "slack_foreground" },
    { ...base, channelId: "gchat:spaces/AAA", threadKey: "spaces/AAA/threads/T", origin: "schedule" },
    { ...base, channelId: "gchat:spaces/AAA", threadKey: "spaces/AAA/threads/T", origin: "googlechat_foreground", principalTrusted: false },
    { ...base, channelId: "gchat:spaces/AAA", threadKey: "spaces/AAA/threads/T", origin: "googlechat_foreground", toolset: "agent-message" },
    { ...base, channelId: "teams:19:abc@thread.tacv2", threadKey: "1", origin: "googlechat_foreground" },
    { ...base, channelId: "C123", threadKey: "gchat:spaces/AAA", origin: "slack_foreground" },
  ]) assert.deepEqual(tools(ctx), [], JSON.stringify(ctx));
  assert.deepEqual(tools({ ...base, channelId: "C123", threadKey: "1800000000.000100", origin: "slack_foreground" }), ["propose_thread_forks"]);
  assert.equal(threadForkOrigin("googlechat"), "googlechat_foreground");
  assert.equal(threadForkOrigin("nowhere"), "");
});

test("/fork is a registered Chat command that waits in the session queue, and help lists it", () => {
  assert.ok(GOOGLE_CHAT_CONTROL_COMMAND.test("/fork compare plans"));
  assert.ok(GOOGLE_CHAT_QUEUED_COMMAND.test("/fork compare plans"));
  assert.ok(!GOOGLE_CHAT_QUEUED_COMMAND.test("/stop"));
  assert.deepEqual(parseForkCommand("/fork compare plans"), { task: "compare plans" });
  assert.match(parseForkCommand("/fork").error, /\/fork <new message>/);
  assert.match(parseForkCommand("/fork :fast try it").error, /Model shortcuts are not available/);
  assert.equal(parseForkCommand("/forklift"), null);
  assert.match(GOOGLE_CHAT_HELP_TEXT, /`\/fork <new message>`/);
  assert.equal(googleChatThreadUrl("spaces/AAA", "spaces/AAA/threads/T1"), "https://chat.google.com/room/AAA/T1");
  assert.equal(googleChatThreadUrl("spaces/AAA", "spaces/BBB/threads/T1"), "");
});

test("one Create N forks card; approval returns at once; children are new threads that start from the source copy", async t => {
  const h = await harness(t);
  const slug = await h.prime();
  await store.saveChannelMeta(slug, { ...await store.getChannelMeta(slug), autoMode: true });
  const id = await propose(h, slug);
  assert.equal(await propose(h, slug), id, "an identical pending proposal reuses its card");
  assert.equal(h.cards.length, 1, "one card even in Auto mode");
  const card = h.cards[0];
  assert.equal(card.threadKey, h.thread, "the card is in the source thread");
  assert.deepEqual(buttonsOf(card.card).map(b => b.text).slice(0, 2), ["Create 2 forks", "Cancel"]);
  for (const item of forkItems) assert.ok(JSON.stringify(card.card).includes(item.prompt));
  assert.equal(h.roots().length, 0, "no child exists before approval");

  const outcome = await approve(id);
  assert.equal(outcome.ok, true, outcome.error);
  await until(() => h.childRuns().length === 2, "two child turns");
  assert.equal(getApprovalRequest(id).status, "consumed");
  const roots = h.roots();
  assert.deepEqual(roots.map(p => p.text), ["↪️ Ana Fork: Pricing", "↪️ Ana Fork: Onboarding"]);
  const children = h.childRuns();
  assert.deepEqual(children.map(a => a.text).sort(), forkItems.map(item => item.prompt).sort());
  for (const args of children) {
    assert.equal(args.forkSourceSessionId, "source-session", "each child copies the same source session");
    assert.equal(args.authorId, people.ana.email, "the requester authors the opening turn");
    assert.equal(args.origin, "googlechat_foreground");
    assert.ok(h.posted.some(p => p.threadKey === args.threadKey && p.text.endsWith(args.text)), "the child runs its own posted request");
    assert.match(args.threadKey, new RegExp(`^${h.space}/threads/fork-`));
    assert.notEqual(args.threadKey, h.thread);
    assert.equal(args.channelId, h.channelId);
    assert.equal(typeof args.getForkFallbackContext, "function", "a refused native copy can continue from the source thread's history");
  }
  assert.equal(new Set(children.map(a => a.threadKey)).size, 2);
  const pricing = children.find(a => a.text === forkItems[0].prompt);
  const request = h.posted.find(p => p.threadKey === pricing.threadKey && /Fork of/.test(p.text));
  assert.match(request.text, new RegExp(`\\(https://chat.google.com/room/${h.space.slice(7)}/source\\)`));
  assert.match(request.text, /Discuss pricing for our marker\./);
  await until(() => h.posted.some(p => p.threadKey === h.thread && /^Created 2\/2 forks:/.test(p.text)), "index");
  const index = h.posted.find(p => p.threadKey === h.thread && /^Created 2\/2 forks:/.test(p.text)).text;
  assert.match(index, /\[Pricing\]\(https:\/\/chat\.google\.com\/room\/.+\) — first response requested/);
  const rows = getApprovalRequest(id).forks;
  assert.deepEqual(rows.map(r => r.status), ["starting", "starting"]);
  assert.deepEqual([...rows.map(r => r.threadKey)].sort(), children.map(a => a.threadKey).sort());
  const activity = listPlatformThreadsForUser(people.ana.email).filter(r => children.some(a => a.threadKey === r.thread_ts));
  assert.equal(activity.length, 2, "each fork is its own Activity row");
  assert.ok(activity.every(r => r.starter_id === people.ana.email && /^↪️ Ana Fork: /.test(r.title)));
  // A second click is refused: the approval executed once.
  const again = await approve(id).catch(error => ({ ok: false, error: error.message }));
  assert.equal(again.ok, false);
  await settle();
  assert.equal(h.roots().length, 2);
});

test("an approved batch waits for the running source turn and holds the source until every child copied it", async t => {
  const h = await harness(t, { auto: false });
  const slug = await h.prime();
  await h.send("long work");
  await until(() => h.held.seen.some(a => a.text === "long work"), "long source turn");
  const id = await propose(h, slug);
  assert.equal((await approve(id)).ok, true);
  await settle();
  assert.equal(h.roots().length, 0, "nothing is copied while the source turn runs");
  assert.ok(h.posted.some(p => p.threadKey === h.thread && /Waiting for the source turn to finish/.test(p.text)));
  // A later source message waits in the durable queue while the fork holds the source.
  await h.send("after the fork");
  h.held.release(h.thread, "long work");
  await until(() => h.childRuns().length === 2, "children start after the source turn");
  await settle();
  assert.ok(!h.held.seen.some(a => a.text === "after the fork"), "the source stays held until every child copied it");
  const [first, second] = h.childRuns();
  h.held.release(first.threadKey, first.text);
  await settle();
  assert.ok(!h.held.seen.some(a => a.text === "after the fork"), "one copy is not enough");
  h.held.release(second.threadKey, second.text);
  await until(() => h.held.seen.some(a => a.text === "after the fork"), "the held source message runs after every copy");
  h.held.releaseAll();
});

test("/stop in the source thread cancels a batch still waiting for the source turn", async t => {
  const h = await harness(t, { auto: false });
  const slug = await h.prime();
  await h.send("long work");
  await until(() => h.held.seen.some(a => a.text === "long work"), "long source turn");
  const id = await propose(h, slug);
  assert.equal((await approve(id)).ok, true);
  await h.send("/stop");
  await until(() => h.posted.some(p => p.threadKey === h.thread && /stopped before creation\. Nothing was created\./.test(p.text)), "cancel notice");
  assert.equal(h.roots().length, 0);
  assert.equal(h.childRuns().length, 0);
});

test("a failed create keeps the created link, names the failure and is not retried", async t => {
  const h = await harness(t, { failRoot: 2 });
  const slug = await h.prime();
  const items = [...forkItems, { title: "Support", prompt: "Discuss support for our marker." }];
  const id = await propose(h, slug, items);
  assert.equal((await approve(id)).ok, true);
  await until(() => h.posted.some(p => p.threadKey === h.thread && /^Created 2\/3 forks:/.test(p.text)), "partial index");
  const index = h.posted.find(p => /^Created 2\/3 forks:/.test(p.text)).text;
  assert.match(index, /1\. \[Pricing\]\(https:/);
  assert.match(index, /2\. Onboarding — Chat refused the post/);
  assert.match(index, /3\. \[Support\]\(https:/);
  const rows = getApprovalRequest(id).forks;
  assert.deepEqual(rows.map(r => r.status), ["starting", "failed", "starting"]);
  await settle();
  assert.equal(h.roots().length, 2, "the failed topic is not posted again");
});

test("DMs, group chats and unthreaded spaces are refused with the reason; a revoked requester is refused", async t => {
  const flat = await harness(t, { threading: "UNTHREADED_MESSAGES" });
  const slug = await flat.prime();
  await assert.rejects(prepareThreadForkApproval(ctxFor(flat, slug), { forks: forkItems }), new RegExp(FORK_NOT_THREADED.slice(0, 40)));
  await assert.rejects(prepareThreadForkApproval({ ...ctxFor(flat, slug), origin: "slack_foreground" }, { forks: forkItems }), /foreground Google Chat turn/);
  const group = await harness(t, { spaceType: "GROUP_CHAT", displayName: "" });
  const groupSlug = await group.prime();
  assert.equal((await store.getChannelEntry(group.channelId)).type, "mpim");
  await assert.rejects(prepareThreadForkApproval(ctxFor(group, groupSlug), { forks: forkItems }), new RegExp(FORK_FLAT_CHAT.slice(0, 40)));

  const h = await harness(t);
  const ready = await h.prime();
  await store.setUser(people.bob.email, { name: "Bob", approved: false, googleChatUserName: people.bob.name });
  t.after(() => store.setUser(people.bob.email, { name: "Bob", approved: true, googleChatUserName: people.bob.name }));
  await assert.rejects(prepareThreadForkApproval(ctxFor(h, ready, people.bob), { forks: forkItems }), /no longer authorized/);
  live.unregisterTransport("googlechat");
  await assert.rejects(prepareThreadForkApproval(ctxFor(h, ready), { forks: forkItems }), /Google Chat is not connected/);
  await assert.rejects(runApprovedThreadForks({ action: { channelId: h.channelId } }, { runSlack: () => assert.fail("not Slack") }), /Google Chat is not connected/);
  await assert.rejects(runApprovedThreadForks({ action: { channelId: "teams:19:x@thread.tacv2" } }, { runSlack: () => assert.fail("not Slack") }), /Microsoft Teams is not connected/);
});

test("only the requester or an admin can create the forks", async t => {
  const h = await harness(t);
  const slug = await h.prime();
  const id = await propose(h, slug);
  const found = lookupApproval(id);
  const refused = await approvalsModule.handlePlatformApproval({ id, conversationId: h.channelId, messageId: found.entry.msgTs, actorId: people.bob.email, decision: "approve" });
  assert.equal(refused.ok, false, "another member cannot approve");
  assert.equal(h.roots().length, 0);
  const admin = await approvalsModule.handlePlatformApproval({ id, conversationId: h.channelId, messageId: found.entry.msgTs, actorId: people.root.email, decision: "approve" });
  assert.equal(admin.ok, true, admin.error);
  await until(() => h.childRuns().length === 2, "admin-approved children");
});

test("/fork starts one forked thread, refuses a DM, and its text never runs as a command", async t => {
  const h = await harness(t);
  await h.prime();
  await h.send("/fork /clear the cache plan");
  await until(() => h.childRuns().length === 1, "fork child");
  const child = h.childRuns()[0];
  assert.equal(child.text, "/clear the cache plan", "the child's request is text, not a /clear");
  assert.equal(child.forkSourceSessionId, "source-session");
  assert.equal(h.roots()[0].text, "↪️ Ana Fork: /clear the cache plan");
  await until(() => h.posted.some(p => p.threadKey === h.thread && /^↪️ Fork started in \[a new thread\]\(https:/.test(p.text)), "fork link");

  const dm = await harness(t, { spaceType: "DIRECT_MESSAGE" });
  const name = `${dm.space}/messages/${randomUUID().slice(0, 8)}`;
  await dm.transport.onEvent({ chat: { messagePayload: { space: { name: dm.space, spaceType: "DIRECT_MESSAGE" }, message: { name, text: "/fork try again", argumentText: "/fork try again",
    sender: { name: people.ana.name, email: people.ana.email, displayName: "Ana", type: "HUMAN" }, thread: { name: `${dm.space}/threads/x` }, annotations: [] } } } });
  await until(() => dm.posted.some(p => /Can't fork this thread: Google Chat direct messages and group chats have no threads/.test(p.text)), "DM refusal");
  assert.ok(!dm.posted.some(p => /Fork:/.test(p.text)), "no fork root in a DM");
  assert.equal(dm.childRuns().length, 0);
});

test("/fork typed while the source works waits its turn in the session queue", async t => {
  const h = await harness(t, { auto: false });
  await h.prime();
  await h.send("long work");
  await until(() => h.held.seen.some(a => a.text === "long work"), "long source turn");
  await h.send("/fork try the other approach");
  await settle();
  assert.equal(h.roots().length, 0, "the fork does not pass the running turn");
  h.held.release(h.thread, "long work");
  await until(() => h.childRuns().length === 1, "queued fork child");
  assert.equal(h.childRuns()[0].text, "try the other approach");
  h.held.releaseAll();
});

test("a fork turn left queued by a restart still runs once from its saved source session", async t => {
  const h = await harness(t);
  await h.prime();
  const seen = [];
  const forks = createGoogleChatThreadForks({ connector: h.connector, conversation: { execute: async () => ({}) }, log });
  const message = { platform: "googlechat", conversationId: h.channelId, rawConversationId: h.space, threadKey: `${h.space}/threads/later` };
  await forks.runChild(async (m, options) => { seen.push(options.fork); return {}; }, message, { fork: { id: "unknown-after-restart", sourceSessionId: "source-session", sourceThreadKey: h.thread, cutoff: new Date().toISOString(), clean: true } });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].sourceSessionId, "source-session");
  assert.equal(seen[0].fallbackContext, null, "a clean source carries no history fallback");
  assert.doesNotThrow(() => seen[0].onSourceForked());
});
