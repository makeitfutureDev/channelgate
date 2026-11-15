import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv, tempDir } from "./helpers.js";
ensureTestEnv();
process.env.CG_FS_ROOT = process.env.TMPDIR;
const { setUser, upsertChannelEntry, saveChannelMeta } = await import("../src/config/store.js");
const { saveSettings } = await import("../src/config/settings.js");
const { saveSession } = await import("../src/gateway/sessions.js");
const { prepareThreadForkApproval } = await import("../src/gateway/thread-fork-approvals.js");
const { createApprovalRequest, getApprovalRequest, approvalActionKey, recoverInterruptedApprovalExecutions } = await import("../src/gateway/approval-requests.js");
const { runThreadForkBatch } = await import("../src/slack/thread-fork-batch.js");
const { createForkThread } = await import("../src/slack/fork-thread.js");
const { getSlackThread } = await import("../src/gateway/slack-threads.js");
const { runQueue } = await import("../src/slack/message-lifecycle.js");
const { pendingForkThreads, pendingForkSources } = await import("../src/slack/fork-state.js");
let serial = 0;
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function fixture() {
  const n = ++serial, slug = `batch-${n}`, channelId = `C_BATCH_${n}`, authorId = `U_BATCH_${n}`, threadKey = `1800.${n}`;
  saveSettings({ engine: "claude", engineEnabled: { claude: true, codex: true } });
  await setUser(authorId, { name: "Batch User", approved: true });
  await upsertChannelEntry(channelId, { name: slug, type: "channel", isDM: false });
  await saveChannelMeta(slug, { channelId, access: "approved", workDir: tempDir("batch-") });
  await saveSession(slug, threadKey, `source-${n}`, "claude", null, JSON.stringify({ backend: "container", scope: "project" }));
  const action = await prepareThreadForkApproval({ channelId, slug, createdBy: authorId, threadKey, origin: "slack_foreground", toolset: "full", principalTrusted: true }, {
    forks: [{ title: "First topic", prompt: "Discuss the first topic." }, { title: "Second topic", prompt: "Discuss the second topic." }],
  });
  const record = createApprovalRequest({ id: `batch-${n}`, actionKey: approvalActionKey(action), status: "executing", channelId, slug, authorId, action, decidedBy: authorId });
  const posted = [], renamed = [];
  let next = 2000;
  const client = { chat: {
    postMessage: async message => { const ts = `${++next}.${n}`; posted.push({ ...message, ts }); return { ts }; },
    getPermalink: async ({ message_ts }) => ({ permalink: `https://slack.test/${message_ts}` }),
  }, apiCall: async (method, args) => { renamed.push({ method, args }); return { ok: true }; } };
  const slack = { snapshot: () => ({ connected: true, botUserId: "UBOT", teamId: "TEAM" }), getClient: () => client };
  return { action, record, posted, renamed, client, slack, key: `${slug}::${threadKey}` };
}

test("batch waits for the source, snapshots every child from the same session and releases only after all clones", async () => {
  const f = await fixture(), source = { aborted: false }, accepted = defer(), children = [];
  await runQueue.acquire(f.key, source);
  const result = runThreadForkBatch(f.record, { slack: f.slack, process: (event, client, options) => {
    const done = defer(); children.push({ event, options, done });
    if (children.length === 2) accepted.resolve();
    return done.promise;
  } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.posted.filter(m => !m.thread_ts).length, 0);
  runQueue.release(f.key, source);
  await accepted.promise;
  assert.equal(pendingForkSources.has(f.key), true);
  const waiting = { aborted: false }; let promoted = false;
  const acquire = runQueue.acquire(f.key, waiting).then(() => { promoted = true; });
  children[0].options.syntheticFork.onSourceForked();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(promoted, false);
  assert.equal(pendingForkSources.has(f.key), true);
  children[1].options.syntheticFork.onSourceForked();
  const outcome = await result;
  await acquire;
  assert.equal(promoted, true);
  runQueue.release(f.key, waiting);
  assert.equal(pendingForkSources.has(f.key), false);
  assert.match(outcome.message, /Created 2\/2/);
  assert.equal(children[0].options.syntheticFork.sourceSessionId, f.action.sourceSessionId);
  assert.equal(children[1].options.syntheticFork.sourceSessionId, f.action.sourceSessionId);
  assert.deepEqual(children.map(c => c.event.user), [f.action.authorId, f.action.authorId]);
  for (const [i, child] of children.entries()) {
    const activity = getSlackThread(f.action.channelId, child.event.thread_ts);
    assert.equal(activity.starter_id, f.action.authorId);
    assert.equal(activity.fork_source_ts, f.action.threadKey);
    assert.ok(activity.title.endsWith(f.action.forks[i].title));
    assert.ok(f.renamed.some(r => r.args.title === activity.title));
    assert.ok(f.posted.some(m => m.thread_ts === child.event.thread_ts && m.text === f.action.forks[i].prompt));
    child.done.resolve();
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pendingForkThreads.size, 0);
});

test("one failed create preserves siblings and journals a root even when its setup fails", async () => {
  const f = await fixture();
  let calls = 0;
  const result = await runThreadForkBatch(f.record, { slack: f.slack,
    create: async (client, args) => {
      calls++;
      if (calls === 1) { await args.onCreated("2999.1"); throw new Error("Activity write failed"); }
      return createForkThread(client, args);
    }, process: async (event, client, options) => { options.syntheticFork.onSourceForked(); },
  });
  assert.equal(calls, 2);
  assert.match(result.message, /Created 2\/2/);
  assert.match(result.message, /need attention/);
  const rows = getApprovalRequest(f.record.id).forks;
  assert.equal(rows[0].threadTs, "2999.1");
  assert.equal(rows[0].status, "created_with_error");
  assert.ok(rows[1].threadTs);
  assert.ok(f.posted.some(m => m.thread_ts === f.action.threadKey && m.text.includes("https://slack.test/2999.1")));
  recoverInterruptedApprovalExecutions();
  const recovered = getApprovalRequest(f.record.id);
  assert.equal(recovered.status, "failed");
  assert.equal(recovered.forks[0].threadTs, "2999.1", "restart retains partial roots and never reopens execution");
});

test("uncertain Slack create is never retried and remaining topics continue", async () => {
  const f = await fixture(); let creates = 0;
  const outcome = await runThreadForkBatch(f.record, { slack: f.slack, create: async (client, args) => {
    if (++creates === 1) throw new Error("Slack transport timeout; creation uncertain");
    return createForkThread(client, args);
  }, process: async () => {} });
  assert.equal(creates, 2);
  assert.match(outcome.message, /Created 1\/2/);
  assert.ok(f.posted.some(m => /creation uncertain/.test(m.text)));
});

test("stop cancels a queued batch without creating children", async () => {
  const f = await fixture(), source = { aborted: false };
  await runQueue.acquire(f.key, source);
  const work = runThreadForkBatch(f.record, { slack: f.slack, process: async () => {} });
  await new Promise(resolve => setImmediate(resolve));
  runQueue.abort(f.key);
  await assert.rejects(work, /stopped/);
  runQueue.release(f.key, source);
  assert.equal(f.posted.filter(m => !m.thread_ts).length, 0);
});

test("synchronous child startup failure releases the source guard and preserves its created link", async () => {
  const f = await fixture();
  const outcome = await runThreadForkBatch(f.record, { slack: f.slack, process: () => { throw new Error("start failed"); } });
  assert.match(outcome.message, /Created 2\/2/);
  assert.equal(pendingForkSources.has(f.key), false);
  assert.equal(runQueue.isActive(f.key), false);
  assert.ok(f.posted.some(m => /first response failed: start failed/.test(m.text)));
});


test("a wholly failed batch is a failed approval, not an applied success", async () => {
  const f = await fixture(); let calls = 0;
  const outcome = await runThreadForkBatch(f.record, { slack: f.slack,
    create: async () => { calls++; throw new Error("Slack unavailable"); }, process: async () => {} });
  assert.equal(calls, 2);
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /No forks were confirmed created/);
  assert.ok(f.posted.some(m => /Created 0\/2/.test(m.text)));
});

test("failure to post the index retains the created links on the approval outcome", async () => {
  const f = await fixture();
  const post = f.client.chat.postMessage;
  f.client.chat.postMessage = async message => {
    if (message.text.startsWith("Created ")) throw new Error("index delivery failed");
    return post(message);
  };
  const outcome = await runThreadForkBatch(f.record, { slack: f.slack, process: async () => {} });
  assert.equal(outcome.ok, true);
  assert.match(outcome.message, /index could not be posted/);
  assert.match(outcome.message, /https:\/\/slack.test/);
});
