// Google Chat in the agent directory and agent mail: the live space/roster provider, discovery
// from a Chat space, a full Chat ↔ Chat exchange through the REAL connector, formatter, lanes and
// membership proof (only the Chat REST client and the engine are fakes), the one-platform rule and
// the typed `ask #space …` directive on the non-Slack ingest.
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { createChatApi } = await import("../src/platforms/googlechat/api.js");
const { createGoogleChatAgentDirectory, GOOGLE_CHAT_APP_MEMBER } = await import("../src/platforms/googlechat/agent-directory.js");
const { createGoogleChatConnector } = await import("../src/platforms/googlechat/connector.js");
const { googleChatAdapter } = await import("../src/platforms/googlechat.js");
const { platformSupports } = await import("../src/platforms/registry.js");
const { registerTransport, resetTransports } = await import("../src/platforms/live.js");
const { createConversationControls } = await import("../src/platforms/conversation-controls.js");
const { makeInbound } = await import("../src/platforms/inbound.js");
const { createIngest } = await import("../src/platforms/ingest.js");
const { AgentMail, AgentMailError, getAgentMessage, liveMembership, parseAskDirective, replyAddressable, setActiveAgentMail } = await import("../src/gateway/agent-mail.js");
const { searchAgentDirectory } = await import("../src/gateway/agent-directory.js");
const { setUser, upsertChannelEntry, saveChannelMeta, defaultChannelMeta } = await import("../src/config/store.js");
const { getDb } = await import("../src/db/index.js");

const ANA = "ana@example.com";
const ANA_RESOURCE = "users/111";
const BO = "bo@example.com";
const joined = (name, extra = {}) => ({ name: `x/members/${name}`, state: "JOINED", member: { name, type: "HUMAN" }, ...extra });
const space = (name, displayName, over = {}) => ({ name, displayName, spaceType: "SPACE", accessSettings: { accessState: "PRIVATE" }, spaceUri: `https://chat.google.com/room/${name.split("/")[1]}`, ...over });

function fakeChatApi() {
  const spaces = new Map();
  const rosters = new Map();
  const messages = [];
  const patches = [];
  let n = 0;
  return {
    spaces, rosters, messages, patches,
    async createMessage(spaceName, { text, threadName = "" } = {}) {
      n += 1;
      const thread = threadName || `${spaceName}/threads/t${n}`;
      const name = `${spaceName}/messages/m${n}`;
      messages.push({ space: spaceName, name, text, threadName: thread, newThread: !threadName });
      return { messageId: name, threadName: thread };
    },
    async patchMessage(name, { text }) { patches.push({ name, text }); return { messageId: name }; },
    async deleteMessage() {},
    async getSpace(name) {
      if (!spaces.has(name)) { const error = new Error("not found"); error.status = 404; throw error; }
      return spaces.get(name);
    },
    async listMemberships(name) { return rosters.has(name) ? rosters.get(name) : null; },
    async listMembers() { return []; },
  };
}

async function register(channelId, name, { type = "channel", isDM = false, platform = "googlechat" } = {}) {
  const entry = await upsertChannelEntry(channelId, { name, type, isDM, platform });
  await saveChannelMeta(entry.slug, defaultChannelMeta({ channelId, name, type, isDM, platform }));
  return entry;
}

const settle = async (until, rounds = 4000) => {
  for (let i = 0; i < rounds; i += 1) {
    if (until?.()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
};

test.beforeEach(() => { getDb().exec("DELETE FROM agent_messages"); resetTransports(); });
test.after(() => { resetTransports(); setActiveAgentMail(null); });

// ── the provider ────────────────────────────────────────────────────────────────────────────

test("Google Chat declares the agent directory and its connector carries a validated provider", () => {
  assert.equal(platformSupports("googlechat", "agentDirectory"), true);
  assert.equal(platformSupports("msteams", "agentDirectory"), false, "Teams plugs in by declaring the capability and a provider");
  const connector = createGoogleChatConnector({ auth: { token: async () => "t" }, capabilities: googleChatAdapter.capabilities, api: fakeChatApi() });
  assert.equal(typeof connector.agentDirectory.describeConversation, "function");
  assert.equal(typeof connector.agentDirectory.conversationMembers, "function");
  const legacy = createGoogleChatConnector({ auth: { token: async () => "t" }, capabilities: googleChatAdapter.capabilities, api: { ...fakeChatApi(), listMemberships: undefined } });
  assert.equal(legacy.agentDirectory, undefined, "a client without the roster call has no provider, so every consumer fails closed");
});

test("space metadata: discoverable spaces are public, everything else private; DMs and group chats keep their kind", async () => {
  const api = fakeChatApi();
  api.spaces.set("spaces/OPEN", space("spaces/OPEN", "Sales", { accessSettings: { accessState: "DISCOVERABLE" }, spaceDetails: { description: "Pipeline and deals", guidelines: "Be brief" } }));
  api.spaces.set("spaces/PRIV", space("spaces/PRIV", "Board", { accessSettings: undefined, externalUserAllowed: true, spaceUri: "http://insecure.example/x" }));
  api.spaces.set("spaces/GC", { name: "spaces/GC", spaceType: "GROUP_CHAT" });
  api.spaces.set("spaces/DM", { name: "spaces/DM", spaceType: "DIRECT_MESSAGE", singleUserBotDm: true });
  api.spaces.set("spaces/ODD", { name: "spaces/ODD" });
  api.spaces.set("spaces/SWAP", { ...space("spaces/OTHER", "Swapped") });
  const directory = createGoogleChatAgentDirectory({ api, loadUsers: async () => ({}) });
  const open = await directory.describeConversation({ conversationId: "spaces/OPEN" });
  assert.deepEqual({ type: open.type, private: open.private, name: open.name, purpose: open.purpose, topic: open.topic, shared: open.shared, archived: open.archived },
    { type: "channel", private: false, name: "Sales", purpose: "Pipeline and deals", topic: "Be brief", shared: false, archived: false });
  assert.match(open.url, /^https:\/\/chat\.google\.com\/room\/OPEN$/);
  const priv = await directory.describeConversation({ conversationId: "spaces/PRIV" });
  assert.equal(priv.type, "group", "no access settings is not evidence of a public space");
  assert.equal(priv.shared, true, "external users allowed reads like a shared channel");
  assert.equal(priv.url, "", "only https links are returned");
  assert.equal((await directory.describeConversation({ conversationId: "spaces/GC" })).type, "mpim");
  assert.equal((await directory.describeConversation({ conversationId: "spaces/DM" })).type, "im");
  assert.equal(await directory.describeConversation({ conversationId: "spaces/ODD" }), null, "an unknown kind fails closed");
  assert.equal(await directory.describeConversation({ conversationId: "spaces/SWAP" }), null, "a response for another space is refused");
  assert.equal(await directory.describeConversation({ conversationId: "../spaces/X" }), null);
  await assert.rejects(directory.describeConversation({ conversationId: "spaces/GONE" }), /not found/);
});

test("rosters map users/NNN to the one gateway user recorded for it, list the app itself, and fail closed", async () => {
  const api = fakeChatApi();
  const users = {
    [ANA]: { googleChatUserName: ANA_RESOURCE },
    [BO]: { googleChatUserName: "users/222" },
    "twin-a@example.com": { googleChatUserName: "users/333" },
    "twin-b@example.com": { googleChatUserName: "users/333" },
  };
  api.rosters.set("spaces/A", [
    joined(ANA_RESOURCE), joined("users/222"), joined("users/333"), joined("users/444"),
    joined("users/555", { state: "INVITED" }), { state: "JOINED", member: { name: "users/999", type: "BOT" } },
  ]);
  api.rosters.set("spaces/GROUPED", [joined(ANA_RESOURCE), { state: "JOINED", groupMember: { name: "groups/eng" } }]);
  api.rosters.set("spaces/BAD", [joined("people/1")]);
  const directory = createGoogleChatAgentDirectory({ api, loadUsers: async () => users });
  const members = await directory.conversationMembers({ conversationId: "spaces/A" });
  assert.deepEqual(members.sort(), [ANA, BO, GOOGLE_CHAT_APP_MEMBER, "users/333", "users/444"].sort(),
    "ambiguous and unknown people stay their resource name; invited people and other apps are not members");
  assert.equal(await directory.conversationMembers({ conversationId: "spaces/GROUPED" }), null, "a Google Group member hides readers");
  assert.equal(await directory.conversationMembers({ conversationId: "spaces/BAD" }), null);
  assert.equal(await directory.conversationMembers({ conversationId: "spaces/TRUNCATED" }), null, "a truncated roster proves nothing");
});

test("the REST roster call pages completely, asks for group memberships, and refuses truncated or cyclic pages", async () => {
  const pages = { "": { memberships: [joined("users/1")], nextPageToken: "p2" }, p2: { memberships: [joined("users/2")] } };
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(new URL(url));
    const token = new URL(url).searchParams.get("pageToken") || "";
    return { ok: true, json: async () => pages[token] };
  };
  const api = createChatApi({ auth: { token: async () => "t" }, fetchImpl });
  assert.deepEqual((await api.listMemberships("spaces/A")).map((m) => m.member.name), ["users/1", "users/2"]);
  assert.equal(urls[0].pathname, "/v1/spaces/A/members");
  assert.equal(urls[0].searchParams.get("showGroups"), "true");
  assert.equal(await api.listMemberships("spaces/A", { maxPages: 1 }), null);
  pages.p2 = { memberships: [], nextPageToken: "p2" };
  assert.equal(await api.listMemberships("spaces/A"), null);
  await assert.rejects(api.listMemberships("spaces/../x"), /not a valid resource name/);
});

// ── discovery and membership through the live connector ─────────────────────────────────────

function chatWorld() {
  const api = fakeChatApi();
  const connector = createGoogleChatConnector({ auth: { token: async () => "t" }, capabilities: googleChatAdapter.capabilities, api });
  connector.conversationLanes = createConversationControls();
  registerTransport("googlechat", { snapshot: () => ({ connected: true }), getConnector: () => connector });
  return { api, connector };
}

test("search_agents from a Chat space lists eligible Chat spaces only, never DMs, group chats or Slack channels", async () => {
  const { api } = chatWorld();
  await setUser(ANA, { approved: true, name: "Ana Pop", googleChatUserName: ANA_RESOURCE });
  const roster = [joined(ANA_RESOURCE)];
  for (const [id, name, extra] of [["spaces/DIRSRC", "Dir Source"], ["spaces/DIRSALES", "Dir Sales", { spaceDetails: { description: "Pipeline numbers" } }], ["spaces/DIRGC", "Dir Group Chat", { spaceType: "GROUP_CHAT" }]]) {
    api.spaces.set(id, space(id, name, extra));
    api.rosters.set(id, roster);
    await register(`gchat:${id}`, name);
  }
  await register("C_DIR_SLACK", "dir-slack-sales", { platform: "slack" });
  const result = await searchAgentDirectory({ createdBy: ANA, channelId: "gchat:spaces/DIRSRC", limit: 50 });
  const ids = result.agents.map((agent) => agent.channelId).sort();
  assert.deepEqual(ids, ["gchat:spaces/DIRSALES", "gchat:spaces/DIRSRC"]);
  const sales = result.agents.find((agent) => agent.channelId === "gchat:spaces/DIRSALES");
  assert.equal(sales.platform, "googlechat");
  assert.equal(sales.description, "Pipeline numbers");
  assert.match(sales.url, /^https:\/\/chat\.google\.com\/room\//);
  // A reader of the source who is not in the target hides it (the audience rule is shared).
  api.rosters.set("spaces/DIRSRC", [joined(ANA_RESOURCE), joined("users/777")]);
  assert.deepEqual((await searchAgentDirectory({ createdBy: ANA, channelId: "gchat:spaces/DIRSRC", limit: 50 })).agents.map((a) => a.channelId), ["gchat:spaces/DIRSRC"]);
});

test("liveMembership proves a Chat requester on both spaces by their recorded users/NNN", async () => {
  const { api } = chatWorld();
  await setUser(ANA, { approved: true, googleChatUserName: ANA_RESOURCE });
  api.spaces.set("spaces/M1", space("spaces/M1", "One"));
  api.spaces.set("spaces/M2", space("spaces/M2", "Two"));
  api.rosters.set("spaces/M1", [joined(ANA_RESOURCE)]);
  api.rosters.set("spaces/M2", [joined("users/222")]);
  const result = await liveMembership({ userId: ANA, fromChannelId: "gchat:spaces/M1", toChannelId: "gchat:spaces/M2" });
  assert.deepEqual({ inSource: result.inSource, inTarget: result.inTarget }, { inSource: true, inTarget: false });
  assert.equal(await liveMembership({ userId: ANA, fromChannelId: "gchat:spaces/M1", toChannelId: "C_SLACK" }), null, "cross-platform is unverifiable");
});

// ── agent mail, Chat ↔ Chat ─────────────────────────────────────────────────────────────────

async function mailWorld({ runner } = {}) {
  const world = chatWorld();
  const { api } = world;
  await setUser(ANA, { approved: true, name: "Ana Pop", googleChatUserName: ANA_RESOURCE });
  const ids = { source: "spaces/MAILSRC", target: "spaces/MAILTGT" };
  api.spaces.set(ids.source, space(ids.source, "Marketing"));
  api.spaces.set(ids.target, space(ids.target, "Sales Team"));
  api.rosters.set(ids.source, [joined(ANA_RESOURCE)]);
  api.rosters.set(ids.target, [joined(ANA_RESOURCE), joined("users/222")]);
  const source = await register(`gchat:${ids.source}`, "Marketing");
  const target = await register(`gchat:${ids.target}`, "Sales Team");
  const runs = [];
  const mail = new AgentMail({
    turnMaxMs: 60_000,
    runner: runner || (async (args) => {
      runs.push(args);
      args.onEvent?.({ kind: "tool_use", name: "Read" });
      return args.origin === "agent_message"
        ? { content: "Pipeline: 12 open deals.", engine: "claude" }
        : { content: "Thanks — the pipeline has 12 open deals.", engine: "codex" };
    }),
  });
  return { ...world, ids, source, target, runs, mail };
}

const HOME_THREAD = "spaces/MAILSRC/threads/home";

test("a complete Chat ↔ Chat exchange: a new thread in the target space, both hops through the ingest's surface, the reply brought home", async () => {
  const w = await mailWorld();
  const sent = await w.mail.send({ channelId: "gchat:spaces/MAILSRC", slug: w.source.slug, createdBy: ANA, threadKey: HOME_THREAD, to: "Sales Team", message: "What is the Q4 pipeline? <users/all>", origin: "googlechat_foreground" });
  assert.equal(sent.to.channelId, "gchat:spaces/MAILTGT");
  await settle(() => ["delivered", "failed", "refused"].includes(getAgentMessage(sent.id)?.status));
  const record = getAgentMessage(sent.id);
  assert.equal(record.status, "delivered", record.error);
  assert.match(record.toThreadKey, /^spaces\/MAILTGT\/threads\/t\d+$/, "the session key is the new Chat thread");

  // The opener: a NEW thread in the target space, Markdown persona, the person by name, no live broadcast.
  const opener = w.api.messages.find((m) => m.space === "spaces/MAILTGT" && m.newThread);
  assert.equal(opener.threadName, record.toThreadKey);
  assert.match(opener.text, /^💬 \*\*#Marketing agent\*\* \(for Ana Pop\): What is the Q4 pipeline\?/);
  assert.doesNotMatch(opener.text, /<users\/all>/, "model text cannot broadcast into another space");
  assert.equal(w.api.messages.filter((m) => m.space === "spaces/MAILTGT" && m.newThread).length, 1);

  // The target hop: the agent principal in that thread, Chat's run surface (no Slack workspace or
  // progress card), a working placeholder edited into the labeled answer with its stats footer.
  const targetRun = w.runs.find((r) => r.origin === "agent_message");
  assert.equal(targetRun.channelId, "gchat:spaces/MAILTGT");
  assert.equal(targetRun.threadKey, record.toThreadKey);
  assert.equal(targetRun.authorId, `agent:${w.source.slug}`);
  assert.equal(targetRun.toolset, "agent-message");
  assert.equal(targetRun.workspaceId, undefined);
  assert.equal(targetRun.progressReport, false);
  assert.equal(typeof targetRun.onRuntimeResolved, "function");
  const targetPlaceholder = w.api.messages.find((m) => m.space === "spaces/MAILTGT" && m.threadName === record.toThreadKey && !m.newThread);
  assert.match(targetPlaceholder.text, /Agent is working/);
  const targetAnswer = w.api.patches.filter((p) => p.name === targetPlaceholder.name).at(-1);
  assert.match(targetAnswer.text, /^💬 \*\*#Sales Team agent:\*\* Pipeline: 12 open deals\./);

  // Home: the target's words under its persona in the asking thread, then the origin's own turn as
  // the requester, its answer edited into its own placeholder there.
  const home = w.api.messages.filter((m) => m.space === "spaces/MAILSRC");
  assert.ok(home.every((m) => m.threadName === HOME_THREAD), "everything at home lands in the asking thread");
  assert.ok(home.some((m) => /^💬 \*\*#Sales Team agent:\*\* Pipeline: 12 open deals\./.test(m.text)));
  const continuation = w.runs.find((r) => r.origin === "continuation");
  assert.equal(continuation.authorId, ANA);
  assert.equal(continuation.threadKey, HOME_THREAD);
  assert.equal(continuation.progressReport, false);
  assert.match(continuation.text, /on behalf of Ana Pop, who asked/);
  assert.doesNotMatch(continuation.text, /<@/);
  const homePlaceholder = home.find((m) => /Agent is working/.test(m.text));
  assert.match(w.api.patches.filter((p) => p.name === homePlaceholder.name).at(-1).text, /^💬 \*\*#Marketing agent:\*\* Thanks/);
});

test("the target turn holds the thread's own session lane, and /stop there ends it in both threads", async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const w = await mailWorld({
    runner: async (args) => {
      if (args.origin !== "agent_message") return { content: "ok" };
      await Promise.race([blocked, new Promise((_, reject) => args.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }))]);
      return { content: "late" };
    },
  });
  const lanes = w.connector.conversationLanes;
  const sent = await w.mail.send({ channelId: "gchat:spaces/MAILSRC", slug: w.source.slug, createdBy: ANA, threadKey: HOME_THREAD, to: "gchat:spaces/MAILTGT", message: "Hi" });
  await settle(() => getAgentMessage(sent.id)?.toThreadKey && lanes.steerState("gchat:spaces/MAILTGT", getAgentMessage(sent.id).toThreadKey, ANA) === "own");
  const record = getAgentMessage(sent.id);
  assert.equal(lanes.steerState("gchat:spaces/MAILTGT", record.toThreadKey, BO), "other-author", "another person's message there would queue behind it");
  const replies = [];
  const stopped = await lanes.command({ message: { text: "/stop", conversationId: "gchat:spaces/MAILTGT", userId: ANA }, sessionKey: record.toThreadKey, slug: w.target.slug, meta: {}, authorIsAdmin: false, reply: async (text) => { replies.push(text); } });
  assert.equal(stopped, true);
  await settle(() => getAgentMessage(sent.id)?.status === "failed");
  release();
  assert.match(getAgentMessage(sent.id).error, /stopped in its thread/);
  assert.ok(w.api.messages.some((m) => m.space === "spaces/MAILSRC" && m.threadName === HOME_THREAD && /stopped in its thread/.test(m.text)));
  assert.ok(w.api.messages.some((m) => m.space === "spaces/MAILTGT" && m.threadName === record.toThreadKey && /stopped in its thread/.test(m.text)));
  const placeholder = w.api.messages.find((m) => m.space === "spaces/MAILTGT" && m.threadName === record.toThreadKey && /Agent is working/.test(m.text));
  assert.ok(w.api.patches.some((p) => p.name === placeholder.name && /ended without an answer/.test(p.text)), "the working message never outlives the turn");
  assert.equal(lanes.steerState("gchat:spaces/MAILTGT", record.toThreadKey, ANA), "idle");
});

test("Chat refusals: membership proven live on both spaces, one platform only, a real reply address", async () => {
  const w = await mailWorld();
  const send = (over = {}) => w.mail.send({ channelId: "gchat:spaces/MAILSRC", slug: w.source.slug, createdBy: ANA, threadKey: HOME_THREAD, to: "gchat:spaces/MAILTGT", message: "Hi", ...over });
  const refused = async (promise, code) => assert.rejects(promise, (error) => error instanceof AgentMailError && error.code === code);

  w.api.rosters.set("spaces/MAILTGT", [joined("users/222")]);
  await refused(send(), "membership");
  w.api.rosters.set("spaces/MAILTGT", [joined(ANA_RESOURCE), { state: "JOINED", groupMember: { name: "groups/x" } }]);
  await refused(send(), "unverifiable");
  w.api.rosters.set("spaces/MAILTGT", [joined(ANA_RESOURCE)]);

  await register("C_MAIL_SLACK", "slack-sales", { platform: "slack" });
  await refused(send({ to: "C_MAIL_SLACK" }), "cross_platform");
  await register("teams:19:a@thread.tacv2", "Teams A", { platform: "msteams" });
  await register("teams:19:b@thread.tacv2", "Teams B", { platform: "msteams" });
  await refused(w.mail.send({ channelId: "teams:19:a@thread.tacv2", slug: "teams-a", createdBy: ANA, threadKey: "1700000000", to: "teams:19:b@thread.tacv2", message: "Hi" }), "unsupported");

  // A same-named channel on another platform neither shadows nor ambiguates a Chat space.
  await register("C_MAIL_SALES_TEAM", "Sales Team", { platform: "slack" });
  const sent = await send({ to: "sales team" });
  assert.equal(sent.to.channelId, "gchat:spaces/MAILTGT");

  assert.equal(replyAddressable("gchat:spaces/X", "spaces/X/threads/T"), true);
  assert.equal(replyAddressable("gchat:spaces/X", "spaces/Y/threads/T"), false, "a thread of another space is no address");
  assert.equal(replyAddressable("gchat:spaces/DM1", "gchat:spaces/DM1"), true, "a flat DM's session is the DM itself");
  assert.equal(replyAddressable("gchat:spaces/G1", "group:spaces/G1/messages/1"), false, "a flat group chat session has no reply address");
  assert.equal(replyAddressable("C1", "1700000000.000100"), true);
  assert.equal(replyAddressable("C1", "sched-1-2"), false);
});

// ── the typed directive on the non-Slack ingest ─────────────────────────────────────────────

test("`ask #space …` on Google Chat hands the exact text to agent mail, with quoted names and refusals", async () => {
  assert.deepEqual(parseAskDirective('ask #"Sales Team" what is new?'), { to: "Sales Team", message: "what is new?" });
  assert.deepEqual(parseAskDirective("ask #“Sales Team”: hi"), { to: "Sales Team", message: "hi" });
  assert.deepEqual(parseAskDirective("ask #sales-team hi"), { to: "sales-team", message: "hi" });
  await setUser(ANA, { approved: true, name: "Ana Pop" });
  const posted = [];
  const connector = {
    platform: "googlechat", capabilities: googleChatAdapter.capabilities,
    async post(payload) { posted.push(payload); return { messageId: `spaces/ASK/messages/${posted.length}`, threadKey: payload.threadKey || "" }; },
    async edit() {}, async directory() { return { map: new Map(), maxWords: 1 }; },
  };
  let runs = 0;
  const ingest = createIngest({ connector, run: async () => { runs += 1; return { content: "x" }; }, log: { info: () => {}, warn: () => {} } });
  const message = (text) => makeInbound({ platform: "googlechat", conversationId: "spaces/ASK", conversationName: "Ask Source", kind: "channel", threadKey: "spaces/ASK/threads/one", messageId: `spaces/ASK/messages/${Math.random()}`, userId: ANA, userName: "Ana Pop", text, mentionsBot: true });
  const calls = [];
  setActiveAgentMail({ async send(args) {
    calls.push(args);
    if (args.to === "nowhere") throw new AgentMailError("No single registered channel matches \"nowhere\".");
    return { id: "x", to: { channelId: "gchat:spaces/T", name: "Sales Team", slug: "sales-team" } };
  } });
  try {
    assert.deepEqual(await ingest(message('ask #"Sales Team" what is the pipeline?')), { command: true });
    assert.deepEqual(calls[0], { channelId: "gchat:spaces/ASK", slug: calls[0].slug, createdBy: ANA, threadKey: "spaces/ASK/threads/one", to: "Sales Team", message: "what is the pipeline?", origin: "googlechat_foreground" });
    assert.match(posted.at(-1).text, /Asked the Sales Team agent/);
    assert.equal(posted.at(-1).threadKey, "spaces/ASK/threads/one");
    await ingest(message("ask #nowhere hi"));
    assert.match(posted.at(-1).text, /Not sent: No single registered channel/);
    await ingest(message("ask #sales"));
    assert.match(posted.at(-1).text, /Use `ask #space/);
    assert.equal(runs, 0, "a directive is not an engine turn");
  } finally {
    setActiveAgentMail(null);
  }
});

// ── the confirmation card on Google Chat ────────────────────────────────────────────────────

for (const engine of ["claude", "codex"]) {
  test(`${engine}: send_agent_message in a Chat space posts the durable Cards v2 confirmation in the asking thread and sends only on the click`, async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { createGatewayMcpServer, ctxFromClaims, createDirectDaemonIpc } = await import("../src/mcp/gateway-server.js");
    const { requestApproval } = await import("../src/slack/approvals.js");
    const channelId = `gchat:spaces/CARD${engine.toUpperCase()}`;
    const entry = await register(channelId, `Card ${engine}`);
    await setUser(ANA, { approved: true, name: "Ana Pop", googleChatUserName: ANA_RESOURCE });
    const cards = [];
    const sends = [];
    registerTransport("googlechat", { snapshot: () => ({ connected: true }), getConnector: () => ({
      platform: "googlechat", ready: () => true, capabilities: googleChatAdapter.capabilities,
      postCard: async (payload) => { cards.push(payload); return { messageId: `${channelId.slice(6)}/messages/card`, conversationId: channelId }; },
      updateCard: async () => {},
      post: async () => assert.fail("the confirmation is a native card, never a public text fallback"),
    }) });
    const threadKey = `${channelId.slice(6)}/threads/ask`;
    const ctx = ctxFromClaims({ channelId, slug: entry.slug, authorId: ANA, threadKey, engine, origin: "googlechat_foreground", principalTrusted: true, toolset: "full" }, {
      daemon: createDirectDaemonIpc({
        approval: (body) => requestApproval(null, body),
        "agent-mail": (body) => { sends.push(body); return { ok: true, id: "m1", to: { channelId: "gchat:spaces/T", name: "Sales Team", slug: "sales-team" } }; },
      }),
    });
    const server = createGatewayMcpServer(ctx);
    const client = new Client({ name: `gchat-mail-${engine}`, version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const result = (await client.callTool({ name: "send_agent_message", arguments: { to: "Sales Team", message: "What is the Q4 pipeline?" } })).content.map((c) => c.text).join("\n");
      assert.match(result, /awaiting approval/);
      assert.equal(sends.length, 0, "nothing is sent before the click");
      assert.equal(cards.length, 1);
      assert.equal(cards[0].threadKey, threadKey, "the card sits in the asking thread");
      const text = JSON.stringify(cards[0].card);
      assert.match(text, /Send a message to the agent in Sales Team on your behalf/);
      assert.match(text, /What is the Q4 pipeline\?/);
      const applied = await server.invokeApproved("send_agent_message", { to: "Sales Team", message: "What is the Q4 pipeline?" });
      assert.match(applied.text, /Asked the #Sales Team agent/);
      assert.deepEqual({ channelId: sends[0].channelId, createdBy: sends[0].createdBy, threadKey: sends[0].threadKey }, { channelId, createdBy: ANA, threadKey });
    } finally {
      await client.close();
      await server.close();
    }
  });
}
