import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const { GeminiLiveSession, buildSetupMessage, geminiLiveUrl, usageByModality, estimateVoiceCost, INPUT_MIME, VOICE_MODELS, isVoiceModel, isVoiceName, parseServerMessage } =
  await import("../src/gateway/voice/gemini-live.js");

class FakeSocket {
  static instances = [];
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; this.listeners = {}; FakeSocket.instances.push(this); }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  emit(type, event = {}) { for (const fn of this.listeners[type] || []) fn(event); }
  open() { this.readyState = 1; this.emit("open"); }
  message(object) { this.emit("message", { data: JSON.stringify(object) }); }
  send(data) { this.sent.push(JSON.parse(data)); }
  close(code = 1000, reason = "") { if (this.readyState === 3) return; this.readyState = 3; this.emit("close", { code, reason }); }
}
const events = (session) => {
  const seen = [];
  for (const name of ["ready", "audio", "input_transcript", "output_transcript", "interrupted", "turn_complete", "tool_call", "tool_cancel", "usage", "go_away", "closed", "error"]) {
    session.on(name, (payload) => seen.push([name, payload]));
  }
  return seen;
};
function connected(options = {}) {
  FakeSocket.instances = [];
  const session = new GeminiLiveSession({ apiKey: "AIza-test-key-0123456789", WebSocketImpl: FakeSocket, setupTimeoutMs: 50, ...options });
  const seen = events(session);
  const socket = session.connect();
  socket.open();
  return { session, socket, seen };
}

test("the URL carries the key and the setup message declares audio, transcription, compression and tools", () => {
  assert.equal(geminiLiveUrl("k-1"), "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=k-1");
  const { setup } = buildSetupMessage({ model: "gemini-3.8-live", voice: "Puck", systemInstruction: "Be brief.",
    tools: [{ name: "run_task", description: "d", parameters: { type: "object", properties: {} }, nonBlocking: true }, { name: "check_tasks", description: "c" }] });
  assert.equal(setup.model, "models/gemini-3.8-live");
  assert.deepEqual(setup.generationConfig.responseModalities, ["AUDIO"]);
  assert.equal(setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, "Puck");
  assert.deepEqual(setup.systemInstruction, { parts: [{ text: "Be brief." }] });
  assert.deepEqual(setup.inputAudioTranscription, {}); assert.deepEqual(setup.outputAudioTranscription, {});
  assert.deepEqual(setup.contextWindowCompression, { slidingWindow: {} });
  assert.deepEqual(setup.sessionResumption, {});
  assert.deepEqual(setup.tools, [{ functionDeclarations: [
    { name: "run_task", description: "d", parameters: { type: "object", properties: {} }, behavior: "NON_BLOCKING" },
    { name: "check_tasks", description: "c" },
  ] }]);
  assert.deepEqual(buildSetupMessage({ handle: "h-1" }).setup.sessionResumption, { handle: "h-1" });
  assert.ok(VOICE_MODELS.every(isVoiceModel)); assert.equal(isVoiceModel("gemini-3.1-flash-live-preview"), false);
  assert.ok(isVoiceName("Kore")); assert.equal(isVoiceName("Alexa"), false);
});

test("a connection sends setup on open, becomes ready on setupComplete, and only then forwards audio", () => {
  const { session, socket, seen } = connected({ model: "gemini-3.8-live", voice: "Kore", systemInstruction: "sys", tools: [{ name: "t" }] });
  assert.equal(socket.sent.length, 1);
  assert.equal(socket.sent[0].setup.model, "models/gemini-3.8-live");
  assert.equal(session.sendAudio(Buffer.from([1, 2])), false, "audio before setupComplete is dropped");
  socket.message({ setupComplete: {} });
  assert.deepEqual(seen.map(([name]) => name), ["ready"]);
  assert.equal(session.sendAudio(Buffer.from([1, 2, 3, 4])), true);
  assert.deepEqual(socket.sent[1], { realtimeInput: { audio: { data: Buffer.from([1, 2, 3, 4]).toString("base64"), mimeType: INPUT_MIME } } });
  assert.equal(session.sendAudio(Buffer.alloc(0)), false);
  assert.equal(session.sendAudio(Buffer.alloc(70_000)), false, "oversized frames are refused");
  assert.equal(session.sendText("hello"), true);
  assert.deepEqual(socket.sent[2], { clientContent: { turns: [{ role: "user", parts: [{ text: "hello" }] }], turnComplete: true } });
});

test("server content becomes audio, transcript, interruption, turn and tool events", () => {
  const { session, socket, seen } = connected();
  socket.message({ setupComplete: {} });
  const pcm = Buffer.from([0, 1, 2, 3]);
  socket.message({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: pcm.toString("base64") } }, { text: "ignored" }] }, outputTranscription: { text: "Hi " } } });
  socket.message({ serverContent: { inputTranscription: { text: "hello there" } } });
  socket.message({ serverContent: { interrupted: true } });
  socket.message({ serverContent: { turnComplete: true } });
  socket.message({ toolCall: { functionCalls: [{ id: "c1", name: "run_task", args: { request: "do it" } }, { name: "check_tasks" }] } });
  socket.message({ toolCallCancellation: { ids: ["c1"] } });
  socket.message("not json");
  const names = seen.map(([name]) => name);
  assert.deepEqual(names, ["ready", "audio", "output_transcript", "input_transcript", "interrupted", "turn_complete", "tool_call", "tool_call", "tool_cancel"]);
  assert.ok(Buffer.isBuffer(seen[1][1]) && seen[1][1].equals(pcm));
  assert.deepEqual(seen[2][1], { text: "Hi " });
  assert.deepEqual(seen[3][1], { text: "hello there", final: true });
  assert.deepEqual(seen[6][1], { id: "c1", name: "run_task", args: { request: "do it" } });
  assert.deepEqual(seen[7][1], { id: "", name: "check_tasks", args: {} });
  assert.deepEqual(seen[8][1], { ids: ["c1"] });
  assert.equal(session.sendToolResponse({ id: "c1", name: "run_task", response: { status: "started" }, scheduling: "SILENT" }), true);
  assert.deepEqual(socket.sent.at(-1), { toolResponse: { functionResponses: [{ id: "c1", name: "run_task", response: { status: "started", scheduling: "SILENT" } }] } });
  session.sendToolResponse({ id: "c2", name: "check_tasks", response: "plain" });
  assert.deepEqual(socket.sent.at(-1).toolResponse.functionResponses[0].response, { result: "plain" });
});

test("usage is cumulative per connection and reported as deltas by modality; cost follows the rate table", () => {
  const { session, socket, seen } = connected();
  socket.message({ setupComplete: {} });
  socket.message({ usageMetadata: { promptTokenCount: 1000, responseTokenCount: 500, totalTokenCount: 1500,
    promptTokensDetails: [{ modality: "AUDIO", tokenCount: 900 }, { modality: "TEXT", tokenCount: 100 }],
    responseTokensDetails: [{ modality: "AUDIO", tokenCount: 480 }, { modality: "TEXT", tokenCount: 20 }] } });
  socket.message({ usageMetadata: { promptTokenCount: 1600, responseTokenCount: 700,
    promptTokensDetails: [{ modality: "AUDIO", tokenCount: 1500 }, { modality: "TEXT", tokenCount: 100 }],
    responseTokensDetails: [{ modality: "AUDIO", tokenCount: 660 }, { modality: "TEXT", tokenCount: 40 }] } });
  const usage = seen.filter(([name]) => name === "usage").map(([, payload]) => payload);
  assert.deepEqual(usage[0].delta, { audioIn: 900, textIn: 100, audioOut: 480, textOut: 20 });
  assert.deepEqual(usage[1].delta, { audioIn: 600, textIn: 0, audioOut: 180, textOut: 20 });
  assert.deepEqual(usage[1].totals, { audioIn: 1500, textIn: 100, audioOut: 660, textOut: 40 });
  assert.deepEqual(usageByModality({ promptTokenCount: 7 }).prompt, { audio: 0, text: 7, other: 0 });
  // 1.5k audio-in × $3/M + 100 text-in × $0.75/M + 660 audio-out × $12/M + 40 text-out × $4.5/M
  assert.equal(estimateVoiceCost("gemini-3.8-live", usage[1].totals), 0.012675);
  assert.equal(estimateVoiceCost("unknown-model", { audioIn: 1_000_000 }), 3);
});

test("a goAway on a resumable session reconnects with the handle and never reports the call closed", () => {
  const { session, socket, seen } = connected();
  socket.message({ setupComplete: {} });
  socket.message({ sessionResumptionUpdate: { newHandle: "h-42", resumable: true } });
  socket.message({ sessionResumptionUpdate: { newHandle: "ignored", resumable: false } });
  assert.equal(session.handle, "h-42");
  socket.message({ goAway: { timeLeft: "10s" } });
  assert.equal(FakeSocket.instances.length, 2, "a second connection was opened");
  const next = FakeSocket.instances[1];
  next.open();
  assert.equal(next.sent[0].setup.sessionResumption.handle, "h-42");
  next.message({ setupComplete: {} });
  assert.deepEqual(seen.filter(([name]) => ["go_away", "closed"].includes(name)).map(([name]) => name), ["go_away"]);
  assert.equal(seen.filter(([name]) => name === "ready").length, 2);
  assert.equal(session.ready, true);
  // The server closing a connection with no reconnection in flight ends the session.
  next.close(1011, "server error");
  assert.deepEqual(seen.at(-1), ["closed", { code: 1011, reason: "server error", resumable: true }]);
  assert.equal(session.closed, true);
});

test("a setup that never completes fails with an error and closing is idempotent", async () => {
  const { session, socket, seen } = connected({ setupTimeoutMs: 10 });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(seen[0][0], "error");
  assert.match(seen[0][1].message, /timed out/);
  assert.equal(socket.readyState, 3);
  assert.equal(seen.at(-1)[0], "closed");
  session.close(); session.close();
  assert.equal(seen.filter(([name]) => name === "closed").length, 1);
  assert.throws(() => session.connect(), /closed/);
  assert.throws(() => new GeminiLiveSession({ apiKey: "", WebSocketImpl: FakeSocket }), /key missing/);
  assert.throws(() => new GeminiLiveSession({ apiKey: "k", WebSocketImpl: null }), /WebSocket client unavailable/);
});

test("binary frames are decoded: ArrayBuffer and typed arrays synchronously, Blobs asynchronously", async () => {
  const { session, socket, seen } = connected();
  assert.equal(socket.binaryType, "arraybuffer", "the client asks for ArrayBuffers, which is how Gemini actually sends its JSON");
  const frame = (object) => { const bytes = Buffer.from(JSON.stringify(object)); return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); };
  socket.emit("message", { data: frame({ setupComplete: {} }) });
  assert.equal(session.ready, true);
  socket.emit("message", { data: new Uint8Array(Buffer.from(JSON.stringify({ serverContent: { outputTranscription: { text: "typed" } } }))) });
  assert.deepEqual(seen.at(-1), ["output_transcript", { text: "typed" }]);
  socket.emit("message", { data: { text: async () => JSON.stringify({ serverContent: { inputTranscription: { text: "blob" } } }) } });
  assert.equal(seen.at(-1)[1].text, "typed", "a Blob is read asynchronously");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen.at(-1), ["input_transcript", { text: "blob", final: true }]);
  socket.emit("message", { data: { text: async () => { throw new Error("unreadable"); } } });
  socket.emit("message", { data: 42 });
  socket.emit("message", { data: new Uint8Array([0xff, 0xfe]) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen.at(-1), ["input_transcript", { text: "blob", final: true }], "undecodable frames are ignored");
  assert.equal(parseServerMessage("{}") !== null, true);
  assert.equal(parseServerMessage(null), null);
});
