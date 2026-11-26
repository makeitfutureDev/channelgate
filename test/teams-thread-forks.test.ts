import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv, tempDir } from "./helpers.js";
import type { ForkDescriptor } from "../src/platforms/channel-forks.ts";
ensureTestEnv();
process.env.CG_FS_ROOT = process.env.TMPDIR;

const { createTeamsThreadForks, teamsForkInbound, teamsForkThreadUrl } = await import("../src/platforms/msteams/thread-forks.ts");
const { createTeamsApi } = await import("../src/platforms/msteams/api.js");
const { createTeamsConnector } = await import("../src/platforms/msteams/connector.js");
const { startTeams } = await import("../src/platforms/msteams/transport.js");
const { createConversationControls } = await import("../src/platforms/conversation-controls.js");
const { teamsAdapter } = await import("../src/platforms/msteams.js");
const { registerTransport, unregisterTransport } = await import("../src/platforms/live.js");
const { prepareThreadForkApproval, executeThreadForkApproval } = await import("../src/gateway/thread-fork-approvals.js");
const { createApprovalRequest, getApprovalRequest, approvalActionKey } = await import("../src/gateway/approval-requests.js");
const { getPlatformThread } = await import("../src/gateway/platform-threads.js");
const { saveSession } = await import("../src/gateway/sessions.js");
const { setUser, upsertChannelEntry, saveChannelMeta } = await import("../src/config/store.js");

async function until(predicate: () => boolean) {
  for (let n = 0; n < 400; n++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail("Teams fork did not finish");
}

test("Teams forks use separate channel roots, requester-attributed durable opening turns and one source snapshot", async t => {
  const id = "19:fixture@thread.tacv2", channelId = `teams:${id}`, author = "29:alice", source = "100";
  const auth = { token: async () => "fixture" };
  const requests: {thread: string; text: string; id: string}[] = [];
  let next = 100;
  const apiOptions = { auth, fetchImpl: async (input: string | URL | Request, init?: RequestInit) => {
    const path = decodeURIComponent(new URL(String(input)).pathname);
    assert.ok(path.endsWith("/activities"));
    const conversation = path.split("/").at(-2);
    const [channel, thread = ""] = conversation!.split(";messageid=");
    assert.equal(channel, id);
    const text = JSON.parse(String(init?.body)).text;
    const messageId = String(++next);
    requests.push({ thread, text, id: messageId });
    return Response.json({ id: messageId });
  } };
  const api = createTeamsApi(apiOptions);
  const capabilities = teamsAdapter.capabilities;
  const apiArgs = { api, auth, botId: "28:fork-app", capabilities, tenantId: "" };
  const connector = createTeamsConnector(apiArgs);
  const conversation = createConversationControls();
  const forks = createTeamsThreadForks({ connector, conversation });
  Object.assign(connector, { threadForkRefusal: forks.refusal, runThreadForks: forks.runApproved, settleFork: forks.settle });
  type Inbound = ReturnType<typeof teamsForkInbound>;
  const children: {message: Inbound; source: string; descriptor: ForkDescriptor}[] = [];
  const transportArgs = { appId: "fork-app", capabilities, deps: { connector, api, auth },
    onMessage: async (message: Inbound, options: {fork: ForkDescriptor}) => forks.runChild(async (child, opts) => {
      const typed = opts as {fork: {sourceSessionId: string; onSourceForked: () => void}};
      children.push({ message: child, source: typed.fork.sourceSessionId, descriptor: options.fork });
      typed.fork.onSourceForked();
    }, message, options) };
  const transport = await startTeams(transportArgs);
  registerTransport("msteams", { getConnector: () => connector, snapshot: () => ({ connected: true }) });
  t.after(async () => { unregisterTransport("msteams"); await transport.stop(); });
  await setUser(author, { approved: true, name: "Alice" });
  const entry = await upsertChannelEntry(channelId, { name: "teams-fork-channel", type: "channel", isDM: false });
  await saveChannelMeta(entry.slug, { channelId, access: "approved", workDir: tempDir("teams-forks") });
  await saveSession(entry.slug, source, "source-session", "codex", null, JSON.stringify({ backend: "container", scope: "project" }));
  const sourceMessage = { conversationId: channelId, threadKey: source, text: "/fork /clear", userId: author, trigger: "message" };
  await forks.command({ message: sourceMessage, sessionKey: source, entry, reply: async text => assert.fail(text) });
  await until(() => children.length === 1 && requests.some(r => r.thread === source && /Fork started/.test(r.text)));
  const first = children[0].message;
  assert.equal(first.text, "/clear");
  assert.equal(first.userId, author);
  assert.equal(first.conversationId, channelId);
  assert.equal(first.mentionsBot, true);
  const firstRoot = requests.find(r => !r.thread)!;
  assert.equal(first.threadKey, firstRoot.id);
  assert.equal(first.messageId, requests.find(r => r.thread === first.threadKey)!.id);
  assert.equal(getPlatformThread(channelId, first.threadKey)?.starter_id, author);
  assert.ok(requests.some(r => r.text.includes(teamsForkThreadUrl(id, first.threadKey))));

  const ctx = { channelId, slug: entry.slug, createdBy: author, threadKey: source, toolset: "full", principalTrusted: true, origin: "msteams_foreground" };
  const action = await prepareThreadForkApproval(ctx, { forks: [{ title: "One", prompt: "first" }, { title: "Two", prompt: "second" }] });
  const record = createApprovalRequest({ id: "teams-batch", actionKey: approvalActionKey(action), status: "executing", channelId, slug: entry.slug,
    authorId: author, action, decidedBy: author });
  const result = await executeThreadForkApproval(record, { runBatch: forks.runApproved });
  assert.equal(result.ok, true);
  await until(() => children.length === 3 && requests.some(r => r.thread === source && /Created 2\/2 forks/.test(r.text)));
  assert.equal(new Set(children.map(child => child.message.threadKey)).size, 3);
  assert.ok(children.every(c => c.source === "source-session" && c.message.userId === author));
  const journal = getApprovalRequest(record.id).forks;
  assert.deepEqual(journal.map((row: {threadKey: string}) => row.threadKey), children.slice(1).map(c => c.message.threadKey));
  assert.deepEqual(children.slice(1).map(c => c.message.text), ["first", "second"]);

  // A saved child can outlive its source snapshot. Restoring a queue after a /clear or an
  // access-lane change must not reuse that earlier session.
  await saveSession(entry.slug, source, "new-source-session", "codex", null, JSON.stringify({ backend: "container", scope: "project" }));
  await forks.runChild(async () => assert.fail("stale source snapshot began a child turn"), first, { fork: children[0].descriptor });
  assert.ok(requests.some(r => r.thread === first.threadKey && /source session, access level or working folder changed/i.test(r.text)));

  for (const [type, raw] of [["im", "a:direct"], ["mpim", "19:group@thread.v2"]]) {
    const flat = `teams:${raw}`;
    const flatEntry = await upsertChannelEntry(flat, { name: type, type, isDM: type === "im" });
    await saveChannelMeta(flatEntry.slug, { channelId: flat, access: "approved" });
    await assert.rejects(prepareThreadForkApproval({ ...ctx, channelId: flat, slug: flatEntry.slug, threadKey: flat },
      { forks: [{ title: "flat", prompt: "no child" }] }), /Use a Teams channel/);
  }
  assert.equal(requests.filter(r => !r.thread).length, 3);
});

test("an uncertain Teams fork write receives one attempt", async () => {
  let sends = 0;
  const options = { auth: { token: async () => "fixture" }, fetchImpl: async () => {
    sends++; return Response.json({ error: "unavailable" }, { status: 503 });
  }, attempts: 3, baseDelayMs: 0 };
  const api = createTeamsApi(options);
  const post = { text: "fork root", retry: false };
  await assert.rejects(api.sendActivity("19:channel@thread.tacv2", post), /503/);
  assert.equal(sends, 1);
});
