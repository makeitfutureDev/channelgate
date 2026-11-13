import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import express from "express";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const { getDb } = await import("../src/db/index.js");
const { setUser, upsertChannelEntry, getChannelEntry, saveChannelMeta } = await import("../src/config/store.js");
const { saveSettings } = await import("../src/config/settings.js");
const { createRunQueue } = await import("../src/slack/util.js");
const { createCallManager, buildSystemInstruction, TOOL_DECLARATIONS, VOICE_CALL_ORIGIN, VOICE_ENGINE } = await import("../src/gateway/voice/calls.js");
const { createActivityRouter, createActivityGrantUrl, resetActivityStateForTests, activityCallPath } = await import("../src/web/activity.js");
const { CALL_WORKLET_PATH } = await import("../src/web/call-page.js");
const { menuButtons } = await import("../src/slack/footer.js");
const { handleReplyCallAction, REPLY_CALL_ACTION_ID } = await import("../src/slack/call-button.js");
const { RUN_ORIGINS, PRINCIPAL_KIND_BY_ORIGIN } = await import("../src/engines/contract.js");

class FakeSession extends EventEmitter {
  static instances = [];
  constructor(options) { super(); this.options = options; this.ready = false; this.audio = []; this.texts = []; this.responses = []; this.closed = false; FakeSession.instances.push(this); }
  sendAudio(buffer) { if (!this.ready) return false; this.audio.push(buffer); return true; }
  sendText(text) { if (!this.ready) return false; this.texts.push(text); return true; }
  sendToolResponse(response) { this.responses.push(response); return true; }
  close() { this.closed = true; }
  live() { this.ready = true; this.emit("ready"); }
}
const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
async function channel(id = "C_WORK", { type = "channel", access = "approved" } = {}) {
  await upsertChannelEntry(id, { name: `#${id.toLowerCase()}`, type, isDM: type === "im" });
  const entry = await getChannelEntry(id);
  await saveChannelMeta(entry.slug, { access, isDM: type === "im" });
  return entry;
}
function fixture(overrides = {}) {
  FakeSession.instances = [];
  const posted = [], records = [], delivered = [], runs = [], logs = [];
  const client = { chat: { postMessage: async () => ({ ts: "1.1" }) }, conversations: { replies: async () => ({ messages: [] }) } };
  const manager = createCallManager({
    getConfig: () => ({ enabled: true, apiKey: "AIzaTestKey_0123456789abc", model: "gemini-3.8-live", voice: "Kore" }),
    createSession: (options) => new FakeSession(options),
    runner: async (args) => { runs.push(args); await tick(5); return { content: "Done: I built it and ran the tests.", engine: "claude", usage: { input_tokens: 10, output_tokens: 5 } }; },
    queue: createRunQueue(), progress: () => null,
    deliver: async (_client, args) => { delivered.push(args); }, record: async (row) => { records.push(row); },
    post: async (_client, args) => { posted.push(args); return { messageId: `${posted.length}00.000100` }; },
    directory: async () => null, log: async (...args) => { logs.push(args); },
    readThread: async (_client, _channel, _thread, { limit } = {}) => [{ ts: "1", from: "U_MINE", text: "Earlier message" }, { ts: "2", from: "agent", text: "Earlier reply" }].slice(0, limit),
    endCallGraceMs: 5, idleMs: 60_000, ...overrides,
  });
  return { manager, posted, records, delivered, runs, logs, client };
}

beforeEach(async () => {
  resetActivityStateForTests();
  for (const table of ["slack_threads", "sessions", "channels", "channel_meta", "usage", "events"]) getDb().exec(`DELETE FROM ${table}`);
  await setUser("U_MINE", { approved: true, isAdmin: false, name: "Tiberiu" });
  await setUser("U_NOPE", { approved: false, isAdmin: false, name: "Stranger" });
  saveSettings({ voiceCallsEnabled: false, geminiApiKey: "" });
});

test("both Google key shapes are accepted and anything that could break the URL is refused", async () => {
  const { isGeminiApiKey, getVoiceCallConfig } = await import("../src/config/settings.js");
  for (const key of ["AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r", "AQ.Ab1cD2eF3gH4iJ5kL6mN7oP8qR9sT0uV1wX2yZ3aB4cD5eF6gH7i"]) assert.equal(isGeminiApiKey(key), true, key);
  for (const key of ["short", "AQ.key with space 0123456789", "AQ.key&x=1_0123456789abcdef", "AQ.key\"0123456789abcdefgh", "x".repeat(257), 42, null]) assert.equal(isGeminiApiKey(key), false, String(key));
  saveSettings({ voiceCallsEnabled: true, geminiApiKey: "AQ.Ab1cD2eF3gH4iJ5kL6mN7oP8qR9sT0uV1wX2yZ3aB4cD5eF6gH7i" });
  assert.equal(getVoiceCallConfig().apiKey, "AQ.Ab1cD2eF3gH4iJ5kL6mN7oP8qR9sT0uV1wX2yZ3aB4cD5eF6gH7i");
  saveSettings({ voiceCallsEnabled: false, geminiApiKey: "" });
});

test("voice_call is a registered interactive user origin that never escalates", async () => {
  assert.ok(RUN_ORIGINS.includes(VOICE_CALL_ORIGIN));
  assert.equal(PRINCIPAL_KIND_BY_ORIGIN[VOICE_CALL_ORIGIN], "user");
  const { mayEscalate } = await import("../src/gateway/run.js");
  assert.equal(mayEscalate({ meta: { adminMode: true }, isAdminAuthor: true, origin: VOICE_CALL_ORIGIN }), false);
});

test("a call is refused without configuration, for an unknown conversation and for an unapproved caller", async () => {
  await channel();
  const off = fixture({ getConfig: () => ({ enabled: true, apiKey: "" }) });
  await assert.rejects(off.manager.start({ ownerId: "U_MINE", channelId: "C_WORK", client: off.client }), (e) => e.status === 503);
  assert.equal(off.manager.available(), false);
  const f = fixture();
  assert.equal(f.manager.available(), true);
  await assert.rejects(f.manager.start({ ownerId: "U_MINE", channelId: "C_NOPE", client: f.client }), (e) => e.status === 404);
  await assert.rejects(f.manager.start({ ownerId: "U_NOPE", channelId: "C_WORK", client: f.client }), (e) => e.status === 403);
  await assert.rejects(f.manager.start({ ownerId: "U_MINE", channelId: "C_WORK" }), (e) => e.status === 400);
  assert.equal(f.posted.length, 0, "a refused call posts nothing");
  assert.equal(FakeSession.instances.length, 0);
});

test("a call without a thread opens one, with a thread announces itself there and reads the context", async () => {
  await channel();
  const f = fixture();
  const fresh = await f.manager.start({ ownerId: "U_MINE", channelId: "C_WORK", client: f.client, teamId: "T_WORK" });
  assert.equal(fresh.threadTs, "100.000100");
  assert.equal(f.posted[0].threadKey, undefined);
  assert.match(f.posted[0].text, /Voice call.*Tiberiu/);
  assert.equal(fresh.channelName, "#c_work"); assert.equal(fresh.callerName, "Tiberiu"); assert.equal(fresh.model, "gemini-3.8-live");
  const session = FakeSession.instances[0];
  assert.equal(session.options.apiKey, "AIzaTestKey_0123456789abc");
  assert.deepEqual(session.options.tools, TOOL_DECLARATIONS);
  assert.match(session.options.systemInstruction, /voice call with Tiberiu/);
  assert.match(session.options.systemInstruction, /#c_work/);
  assert.match(session.options.systemInstruction, /new and empty/);
  assert.equal(f.manager.size(), 1);
  // The same person calling again replaces their earlier call.
  const bound = await f.manager.start({ ownerId: "U_MINE", channelId: "C_WORK", threadTs: "55.000001", client: f.client, teamId: "T_WORK" });
  assert.equal(f.manager.size(), 1);
  assert.equal(f.manager.get(fresh.id), null);
  assert.equal(bound.threadTs, "55.000001");
  const joined = f.posted.find((p) => p.threadKey === "55.000001");
  assert.match(joined.text, /joined this thread by voice call/);
  const second = FakeSession.instances[1];
  assert.match(second.options.systemInstruction, /Tiberiu: Earlier message\nAgent: Earlier reply/);
  assert.match(buildSystemInstruction({ callerName: "A", channelName: "#x", isAdmin: true }), /organization admin/);
});

test("run_task posts the spoken request, runs a turn as the caller in the bound thread and reports back to the voice", async () => {
  await channel();
  const f = fixture();
  const call = await f.manager.start({ ownerId: "U_MINE", channelId: "C_WORK", threadTs: "55.000001", client: f.client, teamId: "T_WORK" });
  const session = FakeSession.instances[0];
  const seen = [];
  const unsubscribe = f.manager.subscribe(call.id, "U_MINE", (event) => seen.push(event));
  assert.equal(seen[0].type, "state"); assert.equal(seen[0].status, "connecting");
  session.live();
  assert.equal(seen.at(-1).type, "ready");
  session.emit("tool_call", { id: "c1", name: "run_task", args: { request: "Build the voice page and run the tests" } });
  await tick(40);
  assert.deepEqual(session.responses[0], { id: "c1", name: "run_task", response: { status: "started", task: 1 }, scheduling: "SILENT" });
  const request = f.posted.find((p) => /voice call\)/.test(p.text));
  assert.equal(request.threadKey, "55.000001");
  assert.match(request.text, /Tiberiu \(voice call\):\* Build the voice page/);
  assert.equal(f.runs.length, 1);
  assert.equal(f.runs[0].authorId, "U_MINE"); assert.equal(f.runs[0].origin, VOICE_CALL_ORIGIN);
  assert.equal(f.runs[0].threadKey, "55.000001"); assert.equal(f.runs[0].channelId, "C_WORK"); assert.equal(f.runs[0].workspaceId, "T_WORK");
  assert.equal(f.runs[0].untrustedPrincipal, undefined, "the caller is a trusted, authenticated person");
  assert.equal(f.delivered.length, 1); assert.equal(f.delivered[0].footer, true); assert.equal(f.delivered[0].threadKey, "55.000001");
  assert.equal(f.records[0].taskKind, "voice-task"); assert.equal(f.records[0].authorId, "U_MINE"); assert.equal(f.records[0].engine, "claude");
  assert.match(session.texts[0], /^\[gateway\] Task 1 finished\. Result: Done: I built it/);
  const tasks = seen.filter((e) => e.type === "task");
  assert.deepEqual(tasks.map((t) => t.status), ["queued", "running", "done"]);
  assert.match(tasks.at(-1).summary, /Done: I built it/);
  session.emit("tool_call", { id: "c2", name: "check_tasks", args: {} });
  await tick();
  assert.deepEqual(session.responses.at(-1).response.tasks, [{ task: 1, status: "done", request: "Build the voice page and run the tests", summary: "Done: I built it and ran the tests." }]);
  session.emit("tool_call", { id: "c3", name: "read_thread", args: { limit: 1 } });
  await tick();
  assert.deepEqual(session.responses.at(-1).response, { messages: [{ from: "Tiberiu", text: "Earlier message" }] });
  session.emit("tool_call", { id: "c4", name: "run_task", args: { request: "   " } });
  await tick();
  assert.match(session.responses.at(-1).response.error, /empty/);
  session.emit("tool_call", { id: "c5", name: "mystery", args: {} });
  await tick();
  assert.match(session.responses.at(-1).response.error, /Unknown tool/);
  unsubscribe();
  await f.manager.end(call.id, "U_MINE", "test over");
});

test("a failed task is reported in the thread and to the voice without an answer being invented", async () => {
  await channel();
  const f = fixture({ runner: async () => { throw new Error("engine exploded"); } });
  const call = await f.manager.start({ ownerId: "U_MINE", channelId: "C_WORK", threadTs: "55.000001", client: f.client });
  const session = FakeSession.instances[0]; session.live();
  session.emit("tool_call", { id: "c1", name: "run_task", args: { request: "Do the thing" } });
  await tick(30);
  assert.equal(f.delivered.length, 0);
  assert.match(f.posted.at(-1).text, /could not run: engine exploded/);
  assert.match(session.texts[0], /^\[gateway\] Task 1 failed: engine exploded/);
  await f.manager.end(call.id, "U_MINE");
});

test("transcript, audio, hang-up summary and accounting", async () => {
  await channel();
  const f = fixture();
  const call = await f.manager.start({ ownerId: "U_MINE", channelId: "C_WORK", client: f.client });
  const session = FakeSession.instances[0];
  const seen = [];
  f.manager.subscribe(call.id, "U_MINE", (event) => seen.push(event));
  assert.throws(() => f.manager.subscribe(call.id, "U_OTHER", () => {}), (e) => e.status === 404);
  assert.throws(() => f.manager.audio(call.id, "U_OTHER", Buffer.from([1])), (e) => e.status === 404);
  assert.equal(f.manager.audio(call.id, "U_MINE", Buffer.from([1, 2])), false, "audio before the voice is ready is dropped");
  session.live();
  assert.equal(f.manager.audio(call.id, "U_MINE", Buffer.from([1, 2])), true);
  assert.equal(session.audio.length, 1);
  session.emit("audio", Buffer.from([9, 9]));
  assert.deepEqual(seen.at(-1), { type: "audio", data: Buffer.from([9, 9]).toString("base64") });
  session.emit("input_transcript", { text: "Hello " }); session.emit("input_transcript", { text: "agent" });
  session.emit("output_transcript", { text: "Hi Tiberiu" }); session.emit("turn_complete");
  session.emit("interrupted");
  session.emit("input_transcript", { text: "Wait" });
  session.emit("usage", { delta: { audioIn: 1000, textIn: 100, audioOut: 500, textOut: 50 } });
  assert.deepEqual(seen.filter((e) => e.type === "transcript").map((e) => [e.who, e.text]), [["caller", "Hello "], ["caller", "Hello agent"], ["agent", "Hi Tiberiu"], ["caller", "Wait"]]);
  assert.equal(await f.manager.end(call.id, "U_OTHER"), false, "only the caller hangs up");
  assert.equal(await f.manager.end(call.id, "U_MINE", "the caller hung up"), true);
  assert.equal(await f.manager.end(call.id, "U_MINE"), false);
  assert.equal(session.closed, true);
  assert.equal(seen.at(-1).type, "ended"); assert.equal(seen.at(-1).reason, "the caller hung up");
  const summary = f.posted.at(-1);
  assert.equal(summary.threadKey, call.threadTs);
  assert.match(summary.text, /Voice call ended.*1 min · 0 tasks · ~\$0.0093 voice/);
  assert.match(summary.text, /> \*Tiberiu:\* Hello agent\n> \*Agent:\* Hi Tiberiu\n> \*Tiberiu:\* Wait/);
  const usage = f.records.find((r) => r.engine === VOICE_ENGINE);
  assert.equal(usage.taskKind, "voice-call"); assert.equal(usage.model, "gemini-3.8-live"); assert.equal(usage.authorId, "U_MINE");
  assert.deepEqual(usage.result.usage, { input_tokens: 1100, output_tokens: 550 });
  assert.equal(usage.result.costUSD, 0.0093);
  assert.ok(f.logs.some(([name]) => name === "voice_call_ended"));
});

test("end_call hangs up after a short goodbye, and a dead voice connection ends the call with its reason", async () => {
  await channel();
  const f = fixture();
  const first = await f.manager.start({ ownerId: "U_MINE", channelId: "C_WORK", client: f.client });
  const session = FakeSession.instances[0]; session.live();
  session.emit("tool_call", { id: "c1", name: "end_call", args: {} });
  assert.deepEqual(session.responses[0].response, { status: "ending" });
  assert.equal(f.manager.get(first.id)?.status, "live");
  await tick(25);
  assert.equal(f.manager.get(first.id), null);
  await setUser("U_OTHER", { approved: true, name: "Other" });
  const second = await f.manager.start({ ownerId: "U_OTHER", channelId: "C_WORK", client: f.client });
  const seen = [];
  f.manager.subscribe(second.id, "U_OTHER", (event) => seen.push(event));
  FakeSession.instances[1].emit("closed", { reason: "quota exceeded" });
  await tick(10);
  assert.equal(f.manager.get(second.id), null);
  assert.match(seen.at(-1).reason, /voice service closed the connection \(quota exceeded\)/);
  const third = await f.manager.start({ ownerId: "U_OTHER", channelId: "C_WORK", client: f.client });
  await f.manager.endAll("shutdown");
  assert.equal(f.manager.get(third.id), null); assert.equal(f.manager.size(), 0);
});

// ── Browser routes and the Slack button ─────────────────────────────────────────
async function webFixture(t, { manager } = {}) {
  let base;
  const started = [], audio = [], ended = [], listeners = new Map();
  const calls = manager || {
    available: () => true,
    start: async (args) => { started.push(args); return { id: "call-1", threadTs: args.threadTs || "100.000100", channelName: "#c_work", callerName: "Tiberiu", model: "gemini-3.8-live" }; },
    subscribe: (id, ownerId, listener) => { if (id !== "call-1" || ownerId !== "U_MINE") throw Object.assign(new Error("no"), { status: 404 }); listeners.set(id, listener); listener({ type: "state", status: "live", transcript: [], tasks: [] }); return () => listeners.delete(id); },
    audio: (id, ownerId, chunk) => { if (ownerId !== "U_MINE") throw Object.assign(new Error("no"), { status: 404 }); audio.push(chunk.length); return true; },
    end: async (id, ownerId, reason) => { ended.push([id, ownerId, reason]); listeners.get(id)?.({ type: "ended", reason }); return true; },
  };
  const client = { auth: { test: async () => ({ user_id: "B_GATEWAY" }) }, chat: { postEphemeral: async () => ({}), postMessage: async () => ({ ts: "1.1" }) },
    conversations: { replies: async () => ({ messages: [] }), members: async () => ({ members: ["U_MINE"] }) }, users: { info: async () => ({ user: { profile: { display_name: "Atlas" } } }) } };
  const app = express();
  app.use("/activity", createActivityRouter({ getClient: () => client, getTeamId: () => "T_WORK", getBaseUrl: () => base, getBotIdentity: () => ({ userId: "B_GATEWAY", handle: "atlas" }), calls, voiceAvailable: () => true, pollMs: 20 }));
  const server = await new Promise((resolve) => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
  base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { resetActivityStateForTests(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const request = (url, init = {}) => fetch(base + url, { ...init, redirect: "manual" });
  const login = async (next = "") => {
    const launch = createActivityGrantUrl({ baseUrl: base, ownerId: "U_MINE", teamId: "T_WORK", next });
    const response = await request("/activity/exchange", { method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ token: new URL(launch).hash.slice(1) }) });
    assert.equal(response.status, 200);
    const { url } = await response.json(), cookie = response.headers.get("set-cookie").split(";")[0];
    const sessionBase = url.replace(/\/call\?.*$/, "");
    const page = await request(sessionBase, { headers: { cookie } });
    const csrf = /"csrf":"([A-Za-z0-9_-]+)"/.exec(await page.text())?.[1];
    return { url, sessionBase, cookie, csrf, headers: { cookie, Origin: base, "X-CG-CSRF": csrf } };
  };
  return { base, client, request, login, started, audio, ended, listeners };
}

test("a launch may carry the call destination, and the call page is served under the session with its worklet", async (t) => {
  await channel();
  const f = await webFixture(t);
  assert.equal(activityCallPath("C_WORK", "100.000001"), "/call?channel=C_WORK&thread=100.000001");
  assert.equal(activityCallPath("C_WORK"), "/call?channel=C_WORK");
  assert.equal(activityCallPath("../etc", "1.1"), "");
  assert.equal(createActivityGrantUrl({ baseUrl: f.base, ownerId: "U_MINE", teamId: "T_WORK", next: "/settings" }), "", "only the call page may be a launch destination");
  assert.equal(createActivityGrantUrl({ baseUrl: f.base, ownerId: "U_MINE", teamId: "T_WORK", next: "https://evil.example/" }), "");
  const s = await f.login("/call?channel=C_WORK&thread=100.000001");
  assert.match(s.url, /^\/activity\/[A-Za-z0-9_-]{16}\/call\?channel=C_WORK&thread=100\.000001$/);
  const page = await f.request(s.url, { headers: { cookie: s.cookie } });
  assert.equal(page.status, 200);
  const csp = page.headers.get("content-security-policy");
  assert.match(csp, /script-src 'nonce-[A-Za-z0-9_-]+' 'self'/);
  assert.match(csp, /connect-src 'self'/);
  const html = await page.text();
  assert.match(html, /Start call/); assert.match(html, /"channelId":"C_WORK","threadTs":"100.000001","channelName":"#c_work","agent":"Atlas"/);
  assert.match(html, /in the current thread/);
  const worklet = await f.request(CALL_WORKLET_PATH);
  assert.equal(worklet.status, 200); assert.match(worklet.headers.get("content-type"), /javascript/);
  assert.match(await worklet.text(), /registerProcessor\("cg-capture"/);
  assert.equal((await f.request(`${s.sessionBase}/call?channel=C_NOPE`, { headers: { cookie: s.cookie } })).status, 403);
  assert.equal((await f.request(`${s.sessionBase}/call?channel=bad!`, { headers: { cookie: s.cookie } })).status, 400);
  assert.equal((await f.request(`${s.sessionBase}/call?channel=C_WORK`)).status, 401, "no session, no page");
  // The dashboard itself advertises the call link only while voice is available.
  assert.match(await (await f.request(s.sessionBase, { headers: { cookie: s.cookie } })).text(), /"voiceCalls":true/);
});

test("the call routes start, stream, relay audio and end a call for the session owner only", async (t) => {
  await channel();
  const f = await webFixture(t);
  const s = await f.login();
  const noCsrf = await f.request(`${s.sessionBase}/call/start`, { method: "POST", headers: { cookie: s.cookie, Origin: f.base, "Content-Type": "application/json" }, body: JSON.stringify({ channelId: "C_WORK" }) });
  assert.equal(noCsrf.status, 403);
  const bad = await f.request(`${s.sessionBase}/call/start`, { method: "POST", headers: { ...s.headers, "Content-Type": "application/json" }, body: JSON.stringify({ channelId: "nope!" }) });
  assert.equal(bad.status, 400);
  const start = await f.request(`${s.sessionBase}/call/start`, { method: "POST", headers: { ...s.headers, "Content-Type": "application/json" }, body: JSON.stringify({ channelId: "C_WORK", threadTs: "100.000001" }) });
  assert.equal(start.status, 200);
  assert.deepEqual(await start.json(), { id: "call-1", threadTs: "100.000001", channelName: "#c_work", callerName: "Tiberiu", model: "gemini-3.8-live" });
  assert.equal(f.started[0].ownerId, "U_MINE"); assert.equal(f.started[0].teamId, "T_WORK"); assert.equal(f.started[0].botUserId, "B_GATEWAY");
  assert.equal(f.started[0].channelId, "C_WORK"); assert.equal(f.started[0].threadTs, "100.000001");
  const events = await f.request(`${s.sessionBase}/call/call-1/events`, { headers: { cookie: s.cookie } });
  assert.equal(events.status, 200); assert.match(events.headers.get("content-type"), /text\/event-stream/);
  const reader = events.body.getReader(), decoder = new TextDecoder();
  let text = "";
  while (!text.includes('"type":"state"')) { const { value, done } = await reader.read(); if (done) break; text += decoder.decode(value); }
  assert.match(text, /data: \{"type":"state","status":"live"/);
  const pcm = Buffer.alloc(3200, 7);
  const audio = await f.request(`${s.sessionBase}/call/call-1/audio`, { method: "POST", headers: { ...s.headers, "Content-Type": "application/octet-stream" }, body: pcm });
  assert.deepEqual(await audio.json(), { ok: true, accepted: true });
  assert.deepEqual(f.audio, [3200]);
  assert.equal((await f.request(`${s.sessionBase}/call/call-1/audio`, { method: "POST", headers: { ...s.headers, "Content-Type": "application/octet-stream" } })).status, 400);
  assert.equal((await f.request(`${s.sessionBase}/call/call-9/events`, { headers: { cookie: s.cookie } })).status, 404);
  // A page unload ends the call through a beacon that can only carry the CSRF token in the query.
  const end = await f.request(`${s.sessionBase}/call/call-1/end?csrf=${s.csrf}`, { method: "POST", headers: { cookie: s.cookie, Origin: f.base } });
  assert.deepEqual(await end.json(), { ok: true });
  assert.deepEqual(f.ended, [["call-1", "U_MINE", "the caller hung up"]]);
  while (!text.includes('"type":"ended"')) { const { value, done } = await reader.read(); if (done) break; text += decoder.decode(value); }
  assert.match(text, /"type":"ended","reason":"the caller hung up"/);
  assert.equal((await f.request(`${s.sessionBase}/call/call-1/end`, { method: "POST", headers: { cookie: s.cookie, Origin: f.base } })).status, 403, "hang-up needs the CSRF token");
});

test("the reply menu grows a Call button only while voice calls are configured, and its click mints a private launch to the call page", async (t) => {
  await channel();
  assert.deepEqual(menuButtons({ channel: "C_WORK", threadTs: "1.2", authorId: "U_MINE" }).map((b) => b.text.text), ["📂 Files", "🔑 Variables", "⚙️ Settings", "📊 Dashboard"]);
  saveSettings({ voiceCallsEnabled: true, geminiApiKey: "AIzaTestKey_0123456789abc" });
  t.after(() => saveSettings({ voiceCallsEnabled: false, geminiApiKey: "" }));
  const buttons = menuButtons({ channel: "C_WORK", threadTs: "100.000002", authorId: "U_OTHER" });
  assert.deepEqual(buttons.map((b) => b.text.text), ["📂 Files", "🔑 Variables", "⚙️ Settings", "📊 Dashboard", "📞 Call"]);
  const button = buttons.at(-1);
  assert.equal(button.action_id, REPLY_CALL_ACTION_ID);
  assert.deepEqual(JSON.parse(button.value), { o: "open", c: "C_WORK", t: "100.000002", u: "U_OTHER" });
  const f = await webFixture(t);
  const sent = [];
  f.client.chat.postEphemeral = async (payload) => { sent.push(payload); };
  f.client.chat.postMessage = async () => assert.fail("a launch credential must never be public");
  const click = (user, overrides = {}) => handleReplyCallAction({ ack: async () => {}, client: f.client,
    body: { user: { id: user }, channel: { id: "C_WORK" }, team: { id: "T_WORK" } }, action: button }, { teamId: "T_WORK", baseUrl: f.base, ...overrides });
  await click("U_MINE");
  const post = sent.at(-1);
  assert.equal(post.user, "U_MINE"); assert.equal(post.thread_ts, "100.000002");
  const url = post.blocks[1].elements[0].url;
  assert.match(url, /\/activity\/open#[A-Za-z0-9_-]{43}$/);
  const response = await f.request("/activity/exchange", { method: "POST", headers: { Origin: f.base, "Content-Type": "application/json" }, body: JSON.stringify({ token: new URL(url).hash.slice(1) }) });
  assert.equal(response.status, 200);
  assert.match((await response.json()).url, /^\/activity\/[A-Za-z0-9_-]{16}\/call\?channel=C_WORK&thread=100\.000002$/);
  await click("U_NOPE");
  assert.match(sent.at(-1).text, /not authorized/); assert.equal(sent.at(-1).blocks, undefined);
  await click("U_MINE", { available: () => false });
  assert.match(sent.at(-1).text, /not enabled/);
  await click("U_MINE", { baseUrl: "" });
  assert.match(sent.at(-1).text, /Public URL/);
  await handleReplyCallAction({ ack: async () => {}, client: f.client, body: { user: { id: "U_MINE" }, channel: { id: "C_ELSE" }, team: { id: "T_WORK" } }, action: button }, { teamId: "T_WORK", baseUrl: f.base });
  assert.match(sent.at(-1).text, /unavailable/);
});
