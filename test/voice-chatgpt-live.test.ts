import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const live = await import("../src/gateway/voice/chatgpt-live.ts");
const { chooseVoiceProvider } = await import("../src/gateway/voice/providers.ts");

type Sent = { url: string; init: { method: string; headers: Record<string, string>; body: string } };
const JWT = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJlLXZhbHVlLWxvbmc";

function fakeFetch(status: number, body: string, location = "/v1/live/rtc_abc123") {
  const sent: Sent[] = [];
  const impl = async (url: string, init: Sent["init"]) => {
    sent.push({ url, init });
    return { ok: status >= 200 && status < 300, status, headers: { get: (name: string) => (name.toLowerCase() === "location" ? location : null) }, text: async () => body };
  };
  return { sent, impl };
}

class FakeSocket {
  static last: FakeSocket | null = null;
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  closed: [number | undefined, string | undefined] | null = null;
  onopen: ((event?: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
  url: string;
  init?: { headers?: Record<string, string> };
  constructor(url: string, init?: { headers?: Record<string, string> }) { this.url = url; this.init = init; FakeSocket.last = this; }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close(code?: number, reason?: string) { this.closed = [code, reason]; }
  open() { this.readyState = 1; this.onopen?.(); }
  receive(message: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify(message) }); }
}

test("the call is created on the Codex backend with the sign-in, Codex's v3 headers and the browser's offer", async () => {
  const f = fakeFetch(201, "v=0\r\nanswer\r\n", "/v1/live/rtc_core_test");
  const session = live.buildChatgptSession({ instructions: "Be the phone line.", initialItems: [{ role: "user", text: "hi" }] });
  const created = await live.createChatgptCall({ sdp: "v=0\r\noffer\r\n", token: "ACCESS", accountId: "acct-1", session, fetchImpl: f.impl });
  assert.equal(created.sdp, "v=0\r\nanswer\r\n");
  assert.equal(created.callId, "rtc_core_test");
  assert.match(created.sessionId, /^[0-9a-f-]{36}$/);
  const [sent] = f.sent;
  assert.equal(sent.url, "https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas");
  assert.equal(sent.init.method, "POST");
  assert.equal(sent.init.headers.Authorization, "Bearer ACCESS");
  assert.equal(sent.init.headers["ChatGPT-Account-ID"], "acct-1");
  assert.equal(sent.init.headers["openai-alpha"], "quicksilver=v2");
  assert.equal(sent.init.headers["x-session-id"], created.sessionId);
  assert.equal(sent.init.headers["Content-Type"], "application/json");
  const body = JSON.parse(sent.init.body);
  assert.equal(body.sdp, "v=0\r\noffer\r\n");
  assert.deepEqual(body.session, {
    model: "gpt-live-1.1-codex", instructions: "Be the phone line.", delegation: { type: "client", ack_filler: true },
    initial_items: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
  });
  assert.equal(live.buildChatgptSession({ model: "gpt-9" }).model, "gpt-live-1.1-codex", "an unknown model falls back to the default");
});

test("a refused or malformed call fails with a bounded reason and never echoes a token", async () => {
  await assert.rejects(live.createChatgptCall({ sdp: "not sdp", token: "T", session: {}, fetchImpl: fakeFetch(200, "v=0").impl }), (e: { status?: number }) => e.status === 400);
  const refused = fakeFetch(401, `{"error":"bad token ${JWT}"}`);
  await assert.rejects(live.createChatgptCall({ sdp: "v=0", token: "T", session: {}, fetchImpl: refused.impl }), (e: Error & { status?: number }) => {
    assert.equal(e.status, 502);
    assert.match(e.message, /HTTP 401/); assert.match(e.message, /Settings → Engines/);
    assert.doesNotMatch(e.message, /eyJhbGci/);
    return true;
  });
  await assert.rejects(live.createChatgptCall({ sdp: "v=0", token: "T", session: {}, fetchImpl: fakeFetch(429, "slow down").impl }), /voice allowance/);
  await assert.rejects(live.createChatgptCall({ sdp: "v=0", token: "T", session: {}, fetchImpl: fakeFetch(200, "v=0", "").impl }), /without a usable call/);
  assert.equal(live.callIdFromLocation("/v1/realtime/calls/calls/rtc_avas_test"), "rtc_avas_test");
  assert.equal(live.callIdFromLocation("/v1/live/a b"), "");
  assert.equal(live.callIdFromLocation(null), "");
});

test("the control channel joins the call with the same headers and maps GPT-Live events to the call manager's", () => {
  const session = new live.ChatgptLiveSession({ callId: "rtc_1", token: "ACCESS", accountId: "acct-1", sessionId: "s-1", WebSocketImpl: FakeSocket as never, sidebandBase: "wss://example.test/v1/live/" });
  const socket = FakeSocket.last!;
  assert.equal(socket.url, "wss://example.test/v1/live/rtc_1");
  assert.equal(socket.init?.headers?.Authorization, "Bearer ACCESS");
  assert.equal(socket.init?.headers?.["ChatGPT-Account-ID"], "acct-1");
  assert.equal(socket.init?.headers?.["openai-alpha"], "quicksilver=v2");
  const seen: [string, unknown][] = [];
  for (const name of ["ready", "input_transcript", "output_transcript", "turn_complete", "delegation", "usage", "error", "closed"]) session.on(name, (value) => seen.push([name, value]));
  assert.equal(session.sendText("too early"), false, "nothing is sent before the channel is open");
  socket.open();
  socket.receive({ type: "session.started", session: { id: "rtc_1" } });
  socket.receive({ type: "input_transcript.added", item: { text: "build the " } });
  socket.receive({ type: "output_transcript.added", item: { text: "On it." } });
  socket.receive({ type: "turn.done", turn: { role: "assistant", transcript: "On it." } });
  socket.receive({ type: "delegation.created", item: { id: "item_1", type: "delegation", target: "client", content: [{ type: "input_text", text: "Build the export" }] } });
  socket.receive({ type: "delegation.created", item: { id: "item_2", type: "delegation", target: "server", content: [] } });
  socket.receive({ type: "session.usage.updated", usage: { audio_duration_ms: 61_000 }, usage_limit: { status: "exceeded", reset_seconds: 600 } });
  socket.receive({ type: "error", error: { message: "boom" } });
  socket.receive({ type: "something.new" });
  assert.deepEqual(seen.map(([name]) => name), ["ready", "input_transcript", "output_transcript", "turn_complete", "delegation", "usage", "error"]);
  assert.deepEqual(seen[1][1], { text: "build the " });
  assert.deepEqual(seen[4][1], { id: "item_1", text: "Build the export" });
  assert.deepEqual(seen[5][1], { audioMs: 61_000, limit: { status: "exceeded", resetSeconds: 600 } });
  assert.equal((seen[6][1] as Error).message, "boom");
  // Speakable results, quiet commentary, delegation answers; long text is split ≤500 bytes.
  session.sendText("[gateway] Task 1 finished.");
  session.sendContext("[gateway] the agent is running tests");
  session.sendToolResponse({ id: "item_1", name: "run_task", response: { status: "started", task: 1 } });
  session.sendText("ă".repeat(400));
  assert.deepEqual(socket.sent[0], { type: "session.context.append", channel: "speakable", content: [{ type: "input_text", text: "[gateway] Task 1 finished." }] });
  assert.deepEqual(socket.sent[1], { type: "session.context.append", channel: "commentary", content: [{ type: "input_text", text: "[gateway] the agent is running tests" }] });
  assert.deepEqual(socket.sent[2], { type: "delegation.context.append", delegation_item_id: "item_1", channel: "speakable", content: [{ type: "input_text", text: '[gateway result for run_task] {"status":"started","task":1}' }] });
  const pieces = socket.sent.slice(3).map((m) => (m.content as { text: string }[])[0].text);
  assert.equal(pieces.join(""), "ă".repeat(400));
  assert.ok(pieces.every((p) => Buffer.byteLength(p) <= 500));
  assert.equal(session.sendAudio(), false, "audio never passes the gateway");
  session.close();
  assert.deepEqual(socket.sent.at(-1), { type: "session.close" });
  assert.deepEqual(socket.closed, [1000, "closed by gateway"]);
  assert.deepEqual(seen.at(-1), ["closed", { code: 1000, reason: "closed by gateway" }]);
  session.close();
  assert.equal(seen.filter(([name]) => name === "closed").length, 1);
});

test("the voice uses only a ChatGPT sign-in: the default Codex login or a ChatGPT-sign-in license", async () => {
  const asked: unknown[] = [];
  const resolve = async (options: { candidates?: string[] }) => { asked.push(options); return { token: "ACCESS", source: "chatgpt", accountId: "acct", planType: "pro" }; };
  assert.deepEqual(await live.resolveChatgptVoiceLogin("codex", { resolve }), { token: "ACCESS", accountId: "acct", planType: "pro", error: "" });
  assert.deepEqual(asked[0], {}, "the default login is the one Codex runs use");
  const license = await live.resolveChatgptVoiceLogin("codex-lic-0a1b2c3d", { resolve, record: () => ({ kind: "codex-login" }), home: (id: string) => `/homes/${id}` });
  assert.equal(license.token, "ACCESS");
  assert.deepEqual(asked[1], { candidates: ["/homes/codex-lic-0a1b2c3d/auth.json"] });
  assert.match((await live.resolveChatgptVoiceLogin("codex-lic-0a1b2c3d", { resolve, record: () => null })).error, /no longer exists/);
  assert.match((await live.resolveChatgptVoiceLogin("codex-lic-0a1b2c3d", { resolve, record: () => ({ kind: "codex-api" }) })).error, /no longer exists/);
  const apiKey = await live.resolveChatgptVoiceLogin("codex", { resolve: async () => ({ token: "sk-x", source: "api-key" }) });
  assert.equal(apiKey.token, ""); assert.match(apiKey.error, /only accepts a ChatGPT sign-in/);
  const signedOut = await live.resolveChatgptVoiceLogin("codex", { resolve: async () => ({ token: "", source: "none", error: "Codex is not signed in" }) });
  assert.match(signedOut.error, /Codex is not signed in/);
  assert.equal((await live.resolveChatgptVoiceLogin("../../etc", { resolve })).token, "ACCESS", "a malformed id falls back to the default login");
});

test("startChatgptLiveCall returns OpenAI's answer and a joined control channel, or the login's reason", async () => {
  const f = fakeFetch(200, "v=0\r\nanswer");
  const started = await live.startChatgptLiveCall({ sdp: "v=0\r\noffer", loginId: "codex", instructions: "x", fetchImpl: f.impl, WebSocketImpl: FakeSocket as never,
    resolveLogin: async () => ({ token: "ACCESS", accountId: "acct", planType: "plus", error: "" }) });
  assert.equal(started.answer, "v=0\r\nanswer"); assert.equal(started.planType, "plus");
  assert.equal(started.session.callId, "rtc_abc123");
  assert.equal(FakeSocket.last?.url, "wss://api.openai.com/v1/live/rtc_abc123");
  await assert.rejects(live.startChatgptLiveCall({ sdp: "v=0", resolveLogin: async () => ({ token: "", accountId: "", planType: "", error: "not signed in" }) }),
    (e: Error & { status?: number }) => e.status === 503 && /not signed in/.test(e.message));
});

test("the provider is the caller's choice when it is on, ChatGPT only for WebRTC clients", () => {
  const both = { gemini: true, chatgpt: true, defaultProvider: "gemini" as const };
  assert.equal(chooseVoiceProvider(both, { preferred: "chatgpt", webrtc: true }), "chatgpt");
  assert.equal(chooseVoiceProvider(both, { preferred: "chatgpt", webrtc: false }), "gemini", "the iPhone app falls back to Gemini");
  assert.equal(chooseVoiceProvider({ ...both, defaultProvider: "chatgpt" }, { webrtc: true }), "chatgpt");
  assert.equal(chooseVoiceProvider({ gemini: false, chatgpt: true, defaultProvider: "gemini" }, { preferred: "gemini", webrtc: true }), "chatgpt");
  assert.equal(chooseVoiceProvider({ gemini: false, chatgpt: true, defaultProvider: "chatgpt" }, { webrtc: false }), "");
  assert.equal(chooseVoiceProvider({ gemini: true, chatgpt: false, defaultProvider: "chatgpt" }, { preferred: "chatgpt", webrtc: true }), "gemini");
});
