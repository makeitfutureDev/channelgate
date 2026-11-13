// The daemon's client for Google's Gemini Live API (bidirectional audio over one WebSocket).
//
// This is the only module that knows the wire protocol: the `setup` message, the realtime audio
// frames, transcription events, function calls and the goAway/session-resumption dance. It owns no
// gateway state and never touches Slack — gateway/voice/calls.js drives it. The WebSocket class is
// injected so tests exercise every message path with a fake socket, and production uses Node's
// built-in client (no `ws` dependency).
//
// Audio in: raw 16-bit little-endian PCM, 16 kHz, mono, base64 ("audio/pcm;rate=16000").
// Audio out: the same encoding at 24 kHz, delivered as base64 `inlineData` parts.
import { EventEmitter } from "node:events";

export const GEMINI_LIVE_HOST = "generativelanguage.googleapis.com";
export const GEMINI_LIVE_PATH = "/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
export const INPUT_MIME = "audio/pcm;rate=16000";
export const OUTPUT_SAMPLE_RATE = 24_000;
export const DEFAULT_VOICE_MODEL = "gemini-3.8-live";
export const DEFAULT_VOICE_NAME = "Kore";
// The models the admin UI offers. Every one of them speaks the same setup and supports the
// function-calling shapes calls.js relies on (3.1 Flash Live does not call functions, so it is
// deliberately absent).
export const VOICE_MODELS = Object.freeze(["gemini-3.8-live", "gemini-2.5-flash-native-audio-preview-12-2025"]);
export const VOICE_NAMES = Object.freeze(["Kore", "Puck", "Charon", "Fenrir", "Aoede", "Leda", "Orus", "Zephyr"]);
const SETUP_TIMEOUT_MS = 15_000;
const MAX_AUDIO_FRAME_BYTES = 64 * 1024;

export function geminiLiveUrl(apiKey, { host = GEMINI_LIVE_HOST } = {}) {
  const url = new URL(`wss://${host}${GEMINI_LIVE_PATH}`);
  url.searchParams.set("key", apiKey);
  return url.toString();
}

export function isVoiceModel(value) { return VOICE_MODELS.includes(value); }
export function isVoiceName(value) { return VOICE_NAMES.includes(value); }

// The first message of every connection. `handle` resumes a session a previous connection carried.
export function buildSetupMessage({ model = DEFAULT_VOICE_MODEL, voice = DEFAULT_VOICE_NAME, systemInstruction = "", tools = [], handle = "" } = {}) {
  const setup = {
    model: `models/${model}`,
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
    },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    contextWindowCompression: { slidingWindow: {} },
    sessionResumption: handle ? { handle } : {},
  };
  if (systemInstruction) setup.systemInstruction = { parts: [{ text: String(systemInstruction) }] };
  if (Array.isArray(tools) && tools.length) setup.tools = [{ functionDeclarations: tools.map(normalizeDeclaration) }];
  return { setup };
}

function normalizeDeclaration(tool) {
  const declaration = { name: tool.name, description: tool.description || "" };
  if (tool.parameters) declaration.parameters = tool.parameters;
  if (tool.nonBlocking) declaration.behavior = "NON_BLOCKING";
  return declaration;
}

// Usage per modality from a usageMetadata message, in tokens. Missing details count as text.
export function usageByModality(usage = {}) {
  const sum = (details, fallback) => {
    const out = { audio: 0, text: 0, other: 0 };
    if (Array.isArray(details) && details.length) {
      for (const row of details) {
        const n = Number(row?.tokenCount) || 0;
        const modality = String(row?.modality || "").toUpperCase();
        if (modality === "AUDIO") out.audio += n; else if (modality === "TEXT") out.text += n; else out.other += n;
      }
    } else out.text = Number(fallback) || 0;
    return out;
  };
  return {
    prompt: sum(usage.promptTokensDetails, usage.promptTokenCount),
    response: sum(usage.responseTokensDetails, usage.responseTokenCount),
    total: Number(usage.totalTokenCount) || 0,
  };
}

// USD per 1M tokens, by model and modality (Gemini API pricing page, paid tier, November 2026).
export const VOICE_RATES = Object.freeze({
  "gemini-3.8-live": { audioIn: 3, textIn: 0.75, audioOut: 12, textOut: 4.5 },
  "gemini-2.5-flash-native-audio-preview-12-2025": { audioIn: 3, textIn: 0.5, audioOut: 12, textOut: 2 },
});
export function estimateVoiceCost(model, totals) {
  const rates = VOICE_RATES[model] || VOICE_RATES[DEFAULT_VOICE_MODEL];
  const perM = (n, rate) => (Number(n) || 0) * rate / 1_000_000;
  return Number((perM(totals.audioIn, rates.audioIn) + perM(totals.textIn, rates.textIn)
    + perM(totals.audioOut, rates.audioOut) + perM(totals.textOut, rates.textOut)).toFixed(6));
}

// Gemini delivers its JSON as BINARY WebSocket frames. With `binaryType = "arraybuffer"` they
// arrive as ArrayBuffers and parse synchronously; a Blob (a client that ignores binaryType) is
// read asynchronously. Anything that is not valid JSON is ignored, never fatal.
function decodeFrame(data) {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  return null;
}
function parseJson(text) {
  try { return typeof text === "string" ? JSON.parse(text) : null; } catch { return null; }
}
export function parseServerMessage(data) {
  const text = decodeFrame(data);
  if (text !== null) return parseJson(text);
  if (data && typeof data.text === "function") return data.text().then(parseJson, () => null);
  return null;
}

// One live session. Events:
//   ready                 — setupComplete arrived; audio may flow
//   audio (Buffer)        — 24 kHz PCM16 chunk from the model
//   input_transcript ({ text, final }) / output_transcript ({ text })
//   interrupted           — the user spoke over the model; drop queued playback
//   turn_complete
//   tool_call ({ id, name, args })
//   tool_cancel ({ ids })
//   usage ({ prompt, response, total }) — cumulative per connection, see calls.js
//   go_away ({ timeLeft }) — the connection is ending; a resumable session reconnects itself
//   closed ({ code, reason, resumable })
//   error (Error)
export class GeminiLiveSession extends EventEmitter {
  constructor({ apiKey, model = DEFAULT_VOICE_MODEL, voice = DEFAULT_VOICE_NAME, systemInstruction = "", tools = [],
    WebSocketImpl = globalThis.WebSocket, host = GEMINI_LIVE_HOST, setupTimeoutMs = SETUP_TIMEOUT_MS, now = Date.now } = {}) {
    super();
    if (!apiKey) throw new Error("Gemini API key missing");
    if (typeof WebSocketImpl !== "function") throw new Error("WebSocket client unavailable");
    this.apiKey = apiKey; this.model = model; this.voice = voice; this.systemInstruction = systemInstruction; this.tools = tools;
    this.WebSocketImpl = WebSocketImpl; this.host = host; this.setupTimeoutMs = setupTimeoutMs; this.now = now;
    this.socket = null; this.ready = false; this.closed = false; this.handle = ""; this.reconnecting = false;
    this.connections = 0;
    // Token totals already accounted (usageMetadata is cumulative within one connection).
    this.accounted = { audioIn: 0, textIn: 0, audioOut: 0, textOut: 0 };
    this.lastUsage = null;
  }

  connect() {
    if (this.closed) throw new Error("session closed");
    const socket = new this.WebSocketImpl(geminiLiveUrl(this.apiKey, { host: this.host }));
    this.socket = socket; this.ready = false; this.connections += 1; this.lastUsage = null;
    const generation = this.connections;
    let setupTimer = setTimeout(() => { if (!this.ready && this.socket === socket) this._fail(new Error("Gemini Live setup timed out"), socket); }, this.setupTimeoutMs);
    setupTimer.unref?.();
    socket.addEventListener("open", () => {
      if (this.socket !== socket) return;
      this._send(buildSetupMessage({ model: this.model, voice: this.voice, systemInstruction: this.systemInstruction, tools: this.tools, handle: this.handle }), socket);
    });
    try { socket.binaryType = "arraybuffer"; } catch { /* a client without the property delivers Blobs, parsed below */ }
    const accept = (message) => {
      if (!message || this.socket !== socket) return;
      if (message.setupComplete !== undefined) { clearTimeout(setupTimer); this.ready = true; this.reconnecting = false; this.emit("ready", { generation }); return; }
      this._handle(message);
    };
    socket.addEventListener("message", (event) => {
      if (this.socket !== socket) return;
      const parsed = parseServerMessage(event.data);
      if (parsed && typeof parsed.then === "function") parsed.then(accept, () => {}); else accept(parsed);
    });
    socket.addEventListener("error", (event) => {
      if (this.socket !== socket) return;
      this._fail(new Error(event?.message || event?.error?.message || "Gemini Live connection error"), socket);
    });
    socket.addEventListener("close", (event) => {
      clearTimeout(setupTimer);
      if (this.socket !== socket) return;
      this.socket = null; this.ready = false;
      if (this.closed) return;
      if (this.reconnecting && this.handle) { this.reconnecting = false; try { this.connect(); return; } catch (error) { this.emit("error", error); } }
      this.closed = true;
      this.emit("closed", { code: event?.code ?? 0, reason: String(event?.reason || ""), resumable: Boolean(this.handle) });
    });
    return socket;
  }

  _fail(error, socket) {
    this.emit("error", error);
    try { socket.close(); } catch { /* already closed */ }
  }

  _send(message, socket = this.socket) {
    if (!socket || socket.readyState !== 1) return false;
    socket.send(JSON.stringify(message));
    return true;
  }

  _handle(message) {
    if (message.usageMetadata) this._usage(message.usageMetadata);
    if (message.sessionResumptionUpdate) {
      const update = message.sessionResumptionUpdate;
      if (update.resumable && typeof update.newHandle === "string" && update.newHandle) this.handle = update.newHandle;
    }
    if (message.goAway) {
      this.emit("go_away", { timeLeft: message.goAway.timeLeft || "" });
      // Reconnect proactively on the same session; the server closes this socket shortly anyway.
      if (this.handle && !this.closed) { this.reconnecting = true; try { this.socket?.close(); } catch { /* fine */ } }
    }
    const content = message.serverContent;
    if (content) {
      if (content.interrupted) this.emit("interrupted");
      for (const part of content.modelTurn?.parts || []) {
        const data = part?.inlineData?.data;
        if (typeof data === "string" && data) {
          const buffer = Buffer.from(data, "base64");
          if (buffer.length) this.emit("audio", buffer);
        }
      }
      if (content.inputTranscription && typeof content.inputTranscription.text === "string") this.emit("input_transcript", { text: content.inputTranscription.text, final: content.inputTranscription.finished !== false });
      if (content.outputTranscription && typeof content.outputTranscription.text === "string") this.emit("output_transcript", { text: content.outputTranscription.text });
      if (content.turnComplete) this.emit("turn_complete");
    }
    if (message.toolCall) {
      for (const call of message.toolCall.functionCalls || []) {
        if (!call || typeof call.name !== "string") continue;
        this.emit("tool_call", { id: String(call.id || ""), name: call.name, args: call.args && typeof call.args === "object" ? call.args : {} });
      }
    }
    if (message.toolCallCancellation) this.emit("tool_cancel", { ids: (message.toolCallCancellation.ids || []).map(String) });
  }

  // usageMetadata is cumulative for the connection; emit only the growth so callers can add it.
  _usage(raw) {
    const usage = usageByModality(raw);
    const current = { audioIn: usage.prompt.audio, textIn: usage.prompt.text + usage.prompt.other, audioOut: usage.response.audio, textOut: usage.response.text + usage.response.other };
    const previous = this.lastUsage || { audioIn: 0, textIn: 0, audioOut: 0, textOut: 0 };
    const delta = {};
    for (const key of Object.keys(current)) delta[key] = Math.max(0, current[key] - previous[key]);
    this.lastUsage = current;
    for (const key of Object.keys(delta)) this.accounted[key] += delta[key];
    this.emit("usage", { delta, totals: { ...this.accounted } });
  }

  sendAudio(chunk) {
    if (!this.ready || !Buffer.isBuffer(chunk) || !chunk.length) return false;
    if (chunk.length > MAX_AUDIO_FRAME_BYTES) return false;
    return this._send({ realtimeInput: { audio: { data: chunk.toString("base64"), mimeType: INPUT_MIME } } });
  }

  sendText(text) {
    if (!this.ready) return false;
    return this._send({ clientContent: { turns: [{ role: "user", parts: [{ text: String(text) }] }], turnComplete: true } });
  }

  // A `scheduling` of INTERRUPT / WHEN_IDLE / SILENT only matters for NON_BLOCKING functions.
  sendToolResponse({ id, name, response, scheduling = "" }) {
    if (!this.ready) return false;
    const body = response && typeof response === "object" ? { ...response } : { result: response };
    if (scheduling) body.scheduling = scheduling;
    return this._send({ toolResponse: { functionResponses: [{ id, name, response: body }] } });
  }

  close() {
    if (this.closed) return;
    this.closed = true; this.reconnecting = false;
    const socket = this.socket;
    this.socket = null; this.ready = false;
    try { socket?.close(); } catch { /* fine */ }
    this.emit("closed", { code: 1000, reason: "closed by gateway", resumable: false });
  }
}

export function createGeminiLiveSession(options) {
  const session = new GeminiLiveSession(options);
  session.connect();
  return session;
}
