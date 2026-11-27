import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const load = (name: string) => import(name);
const { processMessageEvent } = await load("../src/slack/message-pipeline.js");
const { startThreadMarkerSync } = await load("../src/slack/thread-done-marker.js");
const { createActivityRouter, createActivityGrantUrl } = await load("../src/web/activity.js");
const { default: express } = await load("express");
const { createCallManager } = await load("../src/gateway/voice/calls.js");
const { saveSettings } = await load("../src/config/settings.js");
const { setUser, getChannelEntry, upsertChannelEntry, saveChannelMeta } = await load("../src/config/store.js");
const { useFakeRuntime, createFakeRuntimeBackend } = await load("./runtime-fake.js");
const { runQueue } = await import("../src/gateway/thread-turn-owner.ts");
const { stopActiveTurn } = await import("../src/gateway/stop-active-turn.ts");
const { saveVoiceRequest, beginVoiceExecution } = await import("../src/gateway/voice/turn-recovery.ts");
const { recoverRuns, takeStaleRuns } = await load("../src/gateway/active-runs.js");

async function until(ready: () => boolean, label: string) {
  for (let i = 0; i < 500; i++) { if (ready()) return; await delay(10); }
  assert.fail(label);
}

test("stop an active Slack turn and promote the caller's voice request exactly once", { timeout: 30_000 }, async t => {
  const author = "U_TYPED", caller = "U_SPOKEN", channel = "C_HANDOFF", thread = "1700000000.123456";
  await setUser(author, { approved: true });
  await setUser(caller, { approved: true });
  await saveSettings({ engine: "claude", engineFallback: false, memoryReviewEvery: 0 });
  process.env.SESSION_KEEPALIVE = "0";
  const backend = createFakeRuntimeBackend(), spawn = backend.spawn;
  backend.spawn = (target: unknown, spec: object) => spawn(target, { ...spec, cmd: process.execPath, args: ["-e", "setTimeout(() => {}, 30000)"] });
  await useFakeRuntime(backend);
  const root = { type: "message", channel, channel_type: "channel", user: author, text: "<@UBOT> Wait for the next instruction", ts: thread };
  const posts: string[] = [], markers: string[] = [];
  let echoSent!: () => void;
  const echo = new Promise<void>(resolve => { echoSent = resolve; });
  t.after(() => echoSent());
  const ok = async () => ({ ok: true });
  const client = {
    chat: { postMessage: async ({ text }: {text: string}) => { posts.push(text); if (text.startsWith("🎙️")) await echo; return { ok: true, ts: "1800000000." + posts.length.toString().padStart(6,"0") }; }, update: ok, delete: ok },
    reactions: Object.fromEntries(["add","remove"].map(op => [op, async ({name, timestamp}: {name:string; timestamp:string}) => {
      if (name === "arrow_forward") { assert.equal(timestamp, thread); markers.push(op); } return ok();
    }])),
    users: { info: async () => ({ user: { id: author } }), list: async () => ({ members: [] }) },
    conversations: {
      info: async () => ({ channel: { id: channel, name: "handoff", is_channel: true } }),
      members: async () => ({ members: [author, caller] }), history: async () => ({ messages: [] }),
      replies: async ({ts, latest}: {ts: string; latest?: string}) => ({ messages: ts === thread && (!latest || latest === thread) ? [root] : [] }),
    },
  };
  const slack = { getClient: () => client, snapshot: () => ({ connected: true }), onConnected: () => () => {} };
  t.after(startThreadMarkerSync({ slack }));
  const entry = await upsertChannelEntry(channel, { name: "handoff", type: "channel" });
  await saveChannelMeta(entry.slug, { channelId: channel, access: "approved" });
  const queueKey = entry.slug + "::" + thread;
  const first = processMessageEvent(root, client, { botUserId: "UBOT", teamId: "T_TEST" });
  t.after(async () => { for (const h of runQueue.handles(queueKey)) h.controller?.abort(); await first; });
  await until(() => backend.calls.spawn.length === 1 && markers.includes("add"), "typed turn did not start");
  const responses: unknown[] = [];
  const provider = Object.assign(new EventEmitter(), { ready: true, close() {}, sendText() {}, sendToolResponse(response: unknown) { responses.push(response); } });
  let finishVoice!: () => void;
  const voice = new Promise<void>(resolve => { finishVoice = resolve; });
  const runs: Record<string,string>[] = [], delivered: string[] = [];
  const manager = createCallManager({
    getConfig: () => ({ enabled: true, apiKey: "test", model: "fixture" }), createSession: () => provider,
    runner: async (args: Record<string,string>) => { runs.push(args); await voice; return { content: "spoken result", engine: "claude" }; },
    progress: () => null, directory: async () => null, saveMemory: async () => ({}),
    deliver: async (_: unknown, args: {result:{content:string}}) => { delivered.push(args.result.content); },
  });
  const call = await manager.start({ ownerId: caller, channelId: channel, threadTs: thread, client, teamId: "T_TEST" });
  t.after(async () => { finishVoice(); await manager.end(call.id, caller); });
  const request = { id: "tool-1", name: "run_task", args: { request: "Check the voice follow-up" } };
  provider.emit("tool_call", request); provider.emit("tool_call", request);
  await until(() => responses.length === 2 && runQueue.count(queueKey) === 2, "voice task did not queue");
  const { getDb } = await load("../src/db/index.js");
  const record = getDb().prepare("SELECT data FROM active_runs WHERE id=?").get("voice:" + call.id + ":tool-1");
  assert.equal(JSON.parse(record.data).voiceExecutionStarted, false, "provider acknowledgement has a recoverable queued request during slow echo");
  echoSent();
  const app = express();
  let base = "";
  app.use(express.json());
  app.use("/activity", createActivityRouter({ getClient: () => client, getTeamId: () => "T_TEST", getBaseUrl: () => base }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  base = "http://127.0.0.1:" + server.address().port;
  const grant = createActivityGrantUrl({ ownerId: caller, teamId: "T_TEST", baseUrl: base });
  const exchange = await fetch(base + "/activity/exchange", { method: "POST", headers: { Origin: base, "Content-Type": "application/json" },
    body: JSON.stringify({ token: new URL(grant).hash.slice(1) }) });
  assert.equal(exchange.status, 200);
  const {url} = await exchange.json(), cookie = exchange.headers.get("set-cookie")!.split(";")[0];
  const activity = async () => {
    const response = await fetch(base + url + "/api/threads", { headers: { cookie } });
    assert.equal(response.status, 200);
    const page = await response.json();
    return page.rows.find((row: {threadTs: string}) => row.threadTs === thread)?.turnState;
  };
  for (let refresh = 0; refresh < 2; refresh++) {
    const state = await activity();
    assert.deepEqual(state?.active, { origin: "slack_foreground", mine: false });
    assert.deepEqual(state?.queued, [{ origin: "voice_call", mine: true }]);
  }
  const control = { ...root, text: "<@UBOT> stop active", thread_ts: thread, ts: "1700000001.123456" };
  await processMessageEvent(control, client, { botUserId: "UBOT", teamId: "T_TEST" });
  await first;
  await until(() => runs.length === 1, "queued voice never started");
  assert.deepEqual((await activity())?.active, { origin: "voice_call", mine: true });
  assert.equal(runs[0].authorId, caller); assert.equal(runs[0].origin, "voice_call"); assert.equal(runs[0].threadKey, thread);
  assert.match(stopActiveTurn({ slug: entry.slug, channelId: channel, threadKey: thread, actor: author, admin: false, eventId: control.ts }), /already stopped/);
  assert.deepEqual(markers, ["add"]);
  finishVoice();
  await until(() => !runQueue.isActive(queueKey) && markers.includes("remove"), "running marker stayed on the idle thread");
  assert.deepEqual(delivered, ["spoken result"]); assert.equal(runs.length, 1); assert.deepEqual(markers, ["add","remove"]);
});

test("restart resumes only unstarted voice work with current caller access", async () => {
  const channelId = "C_RESTART", authorId = "U_RESTART";
  await upsertChannelEntry(channelId, { name: "voice-restart", type: "channel" });
  const {slug} = await getChannelEntry(channelId);
  await saveChannelMeta(slug, { access: "approved" }); await setUser(authorId, { approved: true });
  const base = { slug, channelId, authorId, workspaceId: "T_TEST", isDM: false, text: "continue my queued request" };
  for (const id of ["queued","already-started","revoked"]) saveVoiceRequest({ ...base, id, threadKey: id, authorId: id === "revoked" ? "U_REVOKED" : authorId });
  assert.ok(beginVoiceExecution("already-started"));
  const posts: string[] = [], runs: Record<string,string>[] = [];
  const client = { chat: { postMessage: async ({text}:{text:string}) => { posts.push(text); return { ts: "91.1" }; } } };
  await recoverRuns(takeStaleRuns(), { slack: { getClient: () => client, snapshot: () => ({ connected:true, teamId:"T_TEST" }) },
    runner: async (args:Record<string,string>) => { runs.push(args); return { content: "recovered voice", engine: "claude", usage: { input_tokens: 1 } }; },
    deliver: async () => {}, usageRecorder: async () => {}, });
  assert.deepEqual(runs.map(r => [r.threadKey,r.authorId,r.origin]), [["queued",authorId,"voice_call"]]);
  assert.ok(posts.some(p => p.includes("outcome is unknown")));
  assert.ok(posts.some(p => p.includes("current access")));
  assert.deepEqual(takeStaleRuns(), []);
});
