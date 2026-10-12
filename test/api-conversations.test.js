// Exercise real API admission and SQLite persistence with a recording Slack client. The driver
// completes synchronously so these checks never launch an engine or consume the in-flight cap.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { startApiRun, getApiJob } = await import("../src/gateway/api-runs.js");
const { getDb, toJson } = await import("../src/db/index.js");
const { upsertChannelEntry, saveChannelMeta } = await import("../src/config/store.js");

let sequence = 0;
async function fixture() {
  const id = `C_API_CONV_${++sequence}`;
  const name = `api-conversation-${sequence}`;
  const entry = await upsertChannelEntry(id, { name, type: "channel" });
  await saveChannelMeta(entry.slug, { channelId: id, name, type: "channel", platform: "slack", template: "custom", allowedMcps: [] });
  const roots = new Map();
  const calls = { posts: [], roots: [], history: [], permalinks: [], driven: [] };
  const control = { connected: true, historyError: null, historyResponse: null, postError: null, permalinkError: null };
  const client = {
    chat: {
      postMessage: async (input) => {
        calls.posts.push(input);
        if (!input.thread_ts) calls.roots.push(input);
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (control.postError) throw control.postError;
        const ts = `${1700000000 + sequence}.${String(calls.posts.length).padStart(6, "0")}`;
        if (!input.thread_ts) roots.set(`${input.channel}:${ts}`, { ts, text: input.text });
        return { ok: true, channel: input.channel, ts };
      },
      getPermalink: async (input) => {
        calls.permalinks.push(input);
        if (control.permalinkError) throw control.permalinkError;
        return { ok: true, permalink: `https://example.slack.com/archives/${input.channel}/p${input.message_ts.replace(".", "")}` };
      },
    },
    conversations: {
      history: async (input) => {
        calls.history.push(input);
        if (control.historyError) throw control.historyError;
        if (control.historyResponse) return control.historyResponse;
        const root = roots.get(`${input.channel}:${input.oldest}`);
        return { ok: true, messages: root ? [root] : [] };
      },
    },
  };
  const slack = { snapshot: () => ({ connected: control.connected }), getClient: () => client };
  const driver = (job) => {
    calls.driven.push(job.id);
    job.status = "completed";
    job.completedMs = Date.now();
    getDb().prepare("UPDATE api_jobs SET status = ?, data = ? WHERE id = ?").run(job.status, toJson(job), job.id);
  };
  const run = (input = {}) => startApiRun({ message: "Process the next external event", channel: id, conversationKey: "gmail:thread-1", slack, driver, ...input });
  return { id, entry, name, roots, calls, control, slack, driver, run };
}

const slackError = (error) => Object.assign(new Error(`Slack failure: ${error}`), { code: "slack_webapi_platform_error", data: { ok: false, error } });

test("a conversation creates one root then reuses it across resolved channel aliases", async () => {
  const f = await fixture();
  const first = await f.run();
  assert.equal(first.ok, true);
  assert.equal(first.threadReused, false);
  assert.ok(first.threadTs);
  assert.match(first.threadPermalink, /\/archives\//);
  assert.equal(first.conversationKey, "gmail:thread-1");
  assert.equal(first.sessionId, null, "keyed admission must let the queued turn resolve the session");
  assert.equal(first.resumeCommand, null);
  for (const alias of [f.entry.slug, f.name, `#${f.name}`]) {
    const next = await f.run({ channel: alias });
    assert.equal(next.ok, true, alias);
    assert.notEqual(next.jobId, first.jobId, "a new event creates a new job");
    assert.equal(next.threadTs, first.threadTs);
    assert.equal(next.threadPermalink, first.threadPermalink);
    assert.equal(next.threadReused, true);
    assert.equal(next.reused, false, "conversation reuse is independent of event deduplication");
  }
  assert.equal(f.calls.roots.length, 1);
  assert.equal(f.calls.driven.length, 4);
  assert.equal(f.calls.posts.length, 4, "each new event remains visible in the reused thread");
  for (const reply of f.calls.posts.slice(1)) assert.equal(reply.thread_ts, first.threadTs);
  for (const probe of f.calls.history) assert.deepEqual(probe, { channel: f.id, oldest: first.threadTs, latest: first.threadTs, inclusive: true, limit: 1 });
});

test("simultaneous first events for one conversation create exactly one root", async () => {
  const f = await fixture();
  const starts = await Promise.all(Array.from({ length: 6 }, (_, i) => f.run({ idempotencyKey: `event-concurrent-${f.id}-${i}` })));
  assert.ok(starts.every((s) => s.ok));
  assert.equal(new Set(starts.map((s) => s.jobId)).size, 6);
  assert.equal(new Set(starts.map((s) => s.threadTs)).size, 1);
  assert.equal(starts.filter((s) => !s.threadReused).length, 1);
  assert.equal(f.calls.roots.length, 1);
  assert.equal(f.calls.driven.length, 6);
});

test("conversation keys are isolated by resolved channel and distinct key", async () => {
  const a = await fixture();
  const b = await fixture();
  const first = await a.run();
  const otherKey = await a.run({ conversationKey: "gmail:thread-2" });
  const otherChannel = await b.run({ slack: a.slack });
  assert.ok(first.ok && otherKey.ok && otherChannel.ok);
  assert.equal(a.calls.roots.length, 3);
  assert.equal(otherKey.threadReused, false);
  assert.equal(otherChannel.threadReused, false);
  const rows = getDb().prepare("SELECT channel_id, conversation_key, thread_ts FROM api_conversations WHERE channel_id IN (?, ?) ORDER BY channel_id, conversation_key").all(a.id, b.id);
  assert.equal(rows.length, 3);
  assert.equal(new Set(rows.map((r) => `${r.channel_id}:${r.thread_ts}`)).size, 3);
  assert.equal((await a.run()).threadTs, first.threadTs);
});

test("persistent conversation mapping outlives job retention and a fresh process reopening SQLite", async () => {
  const f = await fixture();
  const first = await f.run();
  getDb().prepare("DELETE FROM api_jobs WHERE id = ?").run(first.jobId);
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { readFileSync } from "node:fs";
    const input = JSON.parse(readFileSync(0, "utf8"));
    const { startApiRun } = await import(input.apiModule);
    const { getDb } = await import(input.dbModule);
    const client = {
      chat: {
        postMessage: async (message) => {
          assert.equal(message.channel, input.channel);
          assert.equal(message.thread_ts, input.threadTs, "restart must reuse the root, never post another one");
          return { ok: true, channel: input.channel, ts: "1700999999.000001" };
        },
        getPermalink: async () => ({ ok: true, permalink: input.permalink }),
      },
      conversations: {
        history: async (query) => {
          assert.deepEqual(query, { channel: input.channel, oldest: input.threadTs, latest: input.threadTs, inclusive: true, limit: 1 });
          return { ok: true, messages: [{ ts: input.threadTs }] };
        },
      },
    };
    const second = await startApiRun({
      message: "Next event after process restart", channel: input.channel, conversationKey: "gmail:thread-1",
      slack: { snapshot: () => ({ connected: true }), getClient: () => client },
      driver: (job) => {
        job.status = "completed";
        getDb().prepare("UPDATE api_jobs SET status = ?, data = ? WHERE id = ?").run(job.status, JSON.stringify(job), job.id);
      },
    });
    console.log("CONVERSATION_REOPEN_RESULT:" + JSON.stringify(second));
  `], {
    env: { ...process.env }, encoding: "utf8", timeout: 20_000,
    input: JSON.stringify({ channel: f.id, threadTs: first.threadTs, permalink: first.threadPermalink,
      apiModule: new URL("../src/gateway/api-runs.js", import.meta.url).href,
      dbModule: new URL("../src/db/index.js", import.meta.url).href }),
  });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  const resultLine = child.stdout.split("\n").find((line) => line.startsWith("CONVERSATION_REOPEN_RESULT:"));
  assert.ok(resultLine, "child process returns its own reopened-database result");
  const second = JSON.parse(resultLine.slice("CONVERSATION_REOPEN_RESULT:".length));
  assert.equal(second.ok, true);
  assert.equal(second.threadReused, true);
  assert.equal(second.threadTs, first.threadTs);
  assert.equal(second.threadPermalink, first.threadPermalink);
  assert.equal(f.calls.roots.length, 1);
});

test("event idempotency returns the original job without checking or posting the thread again", async () => {
  const f = await fixture();
  const idempotencyKey = `dedupe-${f.id}`;
  const [a, b] = await Promise.all([f.run({ idempotencyKey }), f.run({ idempotencyKey })]);
  assert.equal(a.jobId, b.jobId);
  assert.deepEqual([a.reused, b.reused].sort(), [false, true]);
  assert.equal(a.threadTs, b.threadTs);
  f.control.connected = false;
  const retry = await f.run({ idempotencyKey });
  assert.equal(retry.ok, true, "a duplicate does not require Slack to reconnect");
  assert.equal(retry.jobId, a.jobId);
  assert.equal(retry.threadReused, false, "the original event's thread disposition remains stable");
  assert.equal(f.calls.roots.length, 1);
  assert.equal(f.calls.history.length, 0);
  assert.equal(f.calls.driven.length, 1);
});

test("the 15-minute event TTL expires independently of the durable conversation", async () => {
  const f = await fixture();
  const idempotencyKey = `expired-${f.id}`;
  const first = await f.run({ idempotencyKey });
  const job = getApiJob(first.jobId);
  job.createdMs = Date.now() - 16 * 60_000;
  getDb().prepare("UPDATE api_jobs SET created_ms = ?, data = ? WHERE id = ?").run(job.createdMs, toJson(job), job.id);
  const next = await f.run({ idempotencyKey });
  assert.equal(next.ok, true);
  assert.notEqual(next.jobId, first.jobId);
  assert.equal(next.reused, false);
  assert.equal(next.threadReused, true);
  assert.equal(next.threadTs, first.threadTs);
  assert.equal(f.calls.roots.length, 1);
});

test("idempotency cannot hand another channel or conversation a previously admitted thread", async () => {
  const a = await fixture();
  const b = await fixture();
  const idempotencyKey = `scope-collision-${a.id}`;
  const first = await a.run({ idempotencyKey });
  for (const input of [{ channel: b.id }, { conversationKey: "gmail:another-conversation" }]) {
    const denied = await a.run({ idempotencyKey, ...input });
    assert.equal(denied.ok, false);
    assert.equal(denied.code, 409);
    assert.equal(denied.threadTs, undefined);
  }
  assert.equal(a.calls.roots.length, 1);
  assert.equal(a.calls.driven.length, 1);
  assert.equal((await a.run({ channel: a.entry.slug, idempotencyKey })).jobId, first.jobId);
});

test("a pending same-event start rejects a collision from another resolved channel", async () => {
  const a = await fixture();
  const b = await fixture();
  const idempotencyKey = `pending-scope-${a.id}`;
  const [first, collision] = await Promise.all([
    a.run({ idempotencyKey }),
    a.run({ idempotencyKey, channel: b.id }),
  ]);
  assert.equal(first.ok, true);
  assert.equal(collision.ok, false);
  assert.equal(collision.code, 409);
  assert.equal(a.calls.roots.length, 1);
  assert.equal(a.calls.driven.length, 1);
});

test("invalid conversation keys and destinations reject before a root or engine", async () => {
  const f = await fixture();
  for (const conversationKey of ["", " ", null, 7, {}, [], "x".repeat(201), "bad\nkey", "bad\u0000key"]) {
    const result = await f.run({ conversationKey });
    assert.equal(result.ok, false, JSON.stringify(conversationKey));
    assert.equal(result.code, 400);
  }
  for (const channel of [undefined, "cg-api", "C_UNKNOWN_CONVERSATION", "teams:wrong-platform"]) {
    const result = await f.run({ channel });
    assert.equal(result.ok, false, String(channel));
    assert.equal(result.code, 400);
  }
  const foreign = await upsertChannelEntry("teams:conversation-123", { name: "api-foreign", type: "channel", platform: "msteams" });
  await saveChannelMeta(foreign.slug, { channelId: foreign.channelId, name: "api-foreign", platform: "msteams", type: "channel" });
  assert.equal((await f.run({ channel: foreign.slug })).code, 400);
  assert.equal(f.calls.roots.length, 0);
  assert.equal(f.calls.driven.length, 0);
});

test("a 200-character key is accepted without truncation", async () => {
  const f = await fixture();
  const key = "x".repeat(200);
  const result = await f.run({ conversationKey: key });
  assert.equal(result.ok, true);
  assert.equal(result.conversationKey, key);
  assert.equal((await f.run({ conversationKey: key })).threadTs, result.threadTs);
});

test("keyed runs fail closed when Slack is disconnected or kickoff fails", async () => {
  const f = await fixture();
  f.control.connected = false;
  const disconnected = await f.run();
  assert.equal(disconnected.ok, false);
  assert.equal(disconnected.code, 503);
  f.control.connected = true;
  f.control.postError = slackError("not_in_channel");
  assert.equal((await f.run()).code, 503);
  assert.equal(f.calls.driven.length, 0);
  assert.equal(getDb().prepare("SELECT count(*) AS n FROM api_conversations WHERE channel_id = ?").get(f.id).n, 0);
  f.control.postError = null;
  assert.equal((await f.run()).ok, true, "a failed creation releases the key for retry");
});

test("deleted roots are recreated once and the durable mapping is replaced", async () => {
  const f = await fixture();
  const first = await f.run();
  f.roots.delete(`${f.id}:${first.threadTs}`);
  const starts = await Promise.all([f.run(), f.run()]);
  assert.ok(starts.every((s) => s.ok));
  assert.notEqual(starts[0].threadTs, first.threadTs);
  assert.equal(starts[0].threadTs, starts[1].threadTs);
  assert.deepEqual(starts.map((s) => s.threadReused).sort(), [false, true]);
  assert.equal(f.calls.roots.length, 2);
  const row = getDb().prepare("SELECT thread_ts, thread_permalink FROM api_conversations WHERE channel_id = ? AND conversation_key = ?").get(f.id, "gmail:thread-1");
  assert.equal(row.thread_ts, starts[0].threadTs);
  assert.equal(row.thread_permalink, starts[0].threadPermalink);
});

test("definitive missing-message errors replace the root", async () => {
  for (const error of ["message_not_found", "thread_not_found"]) {
    const f = await fixture();
    const first = await f.run();
    f.control.historyError = slackError(error);
    const next = await f.run();
    assert.equal(next.ok, true, error);
    assert.equal(next.threadReused, false);
    assert.notEqual(next.threadTs, first.threadTs);
    assert.equal(f.calls.roots.length, 2);
  }
});

test("permission, rate, network and malformed history errors never replace a root or run headless", async () => {
  const f = await fixture();
  const first = await f.run();
  for (const error of ["missing_scope", "not_in_channel", "channel_not_found", "ratelimited", "invalid_auth"]) {
    f.control.historyError = slackError(error);
    const result = await f.run();
    assert.equal(result.ok, false, error);
    assert.equal(result.code, 503);
  }
  f.control.historyError = Object.assign(new Error("socket disconnected"), { code: "ECONNRESET" });
  assert.equal((await f.run()).code, 503);
  f.control.historyError = null;
  f.control.historyResponse = { ok: true };
  assert.equal((await f.run()).code, 503, "missing messages is not proof of deletion");
  f.control.historyResponse = null;
  assert.equal(f.calls.roots.length, 1);
  assert.equal(f.calls.driven.length, 1);
  assert.equal((await f.run()).threadTs, first.threadTs, "the mapping remains usable after recovery");
});

test("a different timestamp returned by Slack does not prove the mapped root exists", async () => {
  const f = await fixture();
  const first = await f.run();
  f.control.historyResponse = { ok: true, messages: [{ ts: "1000.000000" }] };
  const result = await f.run();
  assert.equal(result.ok, true);
  assert.equal(result.threadReused, false);
  assert.notEqual(result.threadTs, first.threadTs);
});

test("a deleted-message tombstone recreates the mapped root", async () => {
  const f = await fixture();
  const first = await f.run();
  f.control.historyResponse = { ok: true, messages: [{ ts: first.threadTs, subtype: "tombstone" }] };
  const next = await f.run();
  assert.equal(next.ok, true);
  assert.equal(next.threadReused, false);
  assert.notEqual(next.threadTs, first.threadTs);
  assert.equal(f.calls.roots.length, 2);
});

test("failure posting a reused event keeps the root and admits no engine", async () => {
  const f = await fixture();
  const first = await f.run();
  f.control.postError = slackError("ratelimited");
  const failed = await f.run();
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 503);
  assert.equal(f.calls.roots.length, 1);
  assert.equal(f.calls.driven.length, 1);
  f.control.postError = null;
  const retry = await f.run();
  assert.equal(retry.ok, true);
  assert.equal(retry.threadTs, first.threadTs);
  assert.equal(retry.threadReused, true);
});

test("case and surrounding spaces remain part of the caller's conversation key", async () => {
  const f = await fixture();
  const keys = ["gmail:Thread-1", "gmail:thread-1", " gmail:thread-1 "];
  const results = [];
  for (const conversationKey of keys) results.push(await f.run({ conversationKey }));
  assert.ok(results.every((r) => r.ok));
  assert.equal(new Set(results.map((r) => r.threadTs)).size, keys.length);
  assert.deepEqual(results.map((r) => r.conversationKey), keys);
});

test("the root binding is durable before optional permalink lookup", async () => {
  const f = await fixture();
  let observed = false;
  f.slack.getClient().chat.getPermalink = async ({ message_ts }) => {
    const row = getDb().prepare("SELECT thread_ts, thread_permalink FROM api_conversations WHERE channel_id = ? AND conversation_key = ?").get(f.id, "gmail:thread-1");
    assert.equal(row?.thread_ts, message_ts);
    assert.equal(row?.thread_permalink, null);
    observed = true;
    throw slackError("internal_error");
  };
  assert.equal((await f.run()).ok, true);
  assert.equal(observed, true);
  assert.equal(f.calls.roots.length, 1);
});

test("permalink lookup failure does not block conversation creation or reuse", async () => {
  const f = await fixture();
  f.control.permalinkError = slackError("missing_scope");
  const first = await f.run();
  assert.equal(first.ok, true);
  assert.equal(first.threadPermalink, null);
  const next = await f.run();
  assert.equal(next.ok, true);
  assert.equal(next.threadTs, first.threadTs);
  assert.equal(next.threadPermalink, null);
  assert.equal(f.calls.roots.length, 1);
});

test("omitting conversationKey retains independent roots and legacy headless fallback", async () => {
  const f = await fixture();
  const a = await f.run({ conversationKey: undefined });
  const b = await f.run({ conversationKey: undefined });
  assert.ok(a.ok && b.ok);
  assert.notEqual(a.threadTs, b.threadTs);
  assert.equal(a.threadReused, false);
  assert.equal(a.conversationKey, null);
  assert.ok(a.sessionId, "legacy admission still pre-mints its independent session");
  f.control.connected = false;
  const headless = await f.run({ conversationKey: undefined });
  assert.equal(headless.ok, true);
  assert.equal(headless.slackThread, false);
  assert.equal(headless.threadTs, null);
  assert.equal(headless.threadPermalink, null);
  assert.equal(headless.threadReused, false);
  assert.equal(f.calls.history.length, 0);
  assert.equal(getDb().prepare("SELECT count(*) AS n FROM api_conversations WHERE channel_id = ?").get(f.id).n, 0);
});
