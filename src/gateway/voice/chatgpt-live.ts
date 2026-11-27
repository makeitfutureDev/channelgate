// Voice calls on a ChatGPT sign-in: OpenAI's GPT-Live, reached the way the Codex CLI reaches it.
//
// A ChatGPT sign-in cannot open the all-in-one realtime WebSocket (Codex itself refuses: "realtime
// conversation requires API key auth"). It CAN create a WebRTC call on the Codex backend and join
// that call's control channel. So the media and the control are split:
//
//   browser ── WebRTC (microphone up, speech down) ──────────────▶ OpenAI
//   gateway ── POST {CHATGPT_REALTIME_CALLS_URL} (browser's SDP offer) → SDP answer + call id
//   gateway ── WebSocket {SIDEBAND_BASE}<call id> (transcripts, delegations, context) ◀▶ OpenAI
//
// The access token never reaches a browser: the gateway creates the call and holds the control
// channel, so transcripts, delegations (the voice's only "tool"), Slack logging and accounting stay
// on the daemon exactly as they do for Gemini. Protocol: Codex realtime v3 ("frameless bidi",
// header `openai-alpha: quicksilver=v2`, model gpt-live-1.1-codex), read from openai/codex
// codex-rs (core/src/realtime_conversation.rs, codex-api/src/endpoint/realtime_call.rs and
// realtime_websocket/*) at bee5dc5, 2026-11-27. It is the Codex CLI's own internal endpoint, not a
// published API: it can change without notice.
//
// The session object deliberately mirrors GeminiLiveSession (events ready / input_transcript /
// output_transcript / turn_complete / usage / error / closed, methods sendText / sendToolResponse /
// close) so gateway/voice/calls.js drives both. Where Gemini emits `tool_call`, GPT-Live emits
// `delegation` ({ id, text }): the caller's request, which calls.js routes (delegation-router.ts).
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { resolveContainerCodexToken } from "../codex-token-relay.js";
import { licenseLoginHome, licenseRecord } from "../../engines/license-state.js";
import { DEFAULT_CHATGPT_VOICE_LOGIN, DEFAULT_CHATGPT_VOICE_MODEL, isChatgptVoiceLogin, isChatgptVoiceModel } from "./providers.ts";

export const CHATGPT_REALTIME_CALLS_URL = "https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas";
export const SIDEBAND_BASE = "wss://api.openai.com/v1/live/";
const CONTEXT_APPEND_MAX_BYTES = 500;
const MAX_SDP_BYTES = 64 * 1024;
const MAX_INSTRUCTION_CHARS = 24_000;
const MAX_TOOL_RESULT_CHARS = 3_000;
const CALL_ID_RE = /^[A-Za-z0-9_-]{1,200}$/;

export interface ChatgptVoiceCredential { token: string; accountId: string; planType: string; error: string }

// The access token (never the refresh token) of the chosen ChatGPT sign-in, renewed by the same
// relay every container Codex run uses. An API-key login is refused: the Codex backend's voice
// endpoint only takes a ChatGPT sign-in.
type CodexTokenResolver = (options: { candidates?: string[] }) => Promise<{ token?: string; source?: string; accountId?: string; planType?: string; error?: string } | null>;
export async function resolveChatgptVoiceLogin(loginId = DEFAULT_CHATGPT_VOICE_LOGIN, deps: {
  resolve?: CodexTokenResolver; record?: (id: string) => unknown; home?: (id: string) => string;
} = {}): Promise<ChatgptVoiceCredential> {
  const resolve = deps.resolve || (resolveContainerCodexToken as unknown as CodexTokenResolver);
  const id = isChatgptVoiceLogin(loginId) ? String(loginId) : DEFAULT_CHATGPT_VOICE_LOGIN;
  let token: Awaited<ReturnType<CodexTokenResolver>>;
  if (id === DEFAULT_CHATGPT_VOICE_LOGIN) token = await resolve({});
  else {
    const record = (deps.record || licenseRecord)(id) as { kind?: string } | null;
    if (!record || record.kind !== "codex-login") return { token: "", accountId: "", planType: "", error: `The ChatGPT sign-in ${id} chosen for voice calls no longer exists. An administrator picks another under Settings → Calls.` };
    token = await resolve({ candidates: [path.join((deps.home || licenseLoginHome)(id), "auth.json")] });
  }
  if (token?.source !== "chatgpt" || !token.token) {
    const why = token?.source === "api-key" ? "it holds an API key, and the ChatGPT voice endpoint only accepts a ChatGPT sign-in" : token?.error || "it is not signed in";
    return { token: "", accountId: "", planType: "", error: `The ChatGPT sign-in for voice calls cannot be used: ${why}.` };
  }
  return { token: token.token, accountId: String(token.accountId || ""), planType: String(token.planType || ""), error: "" };
}

// Headers for the call creation AND the control channel (Codex sends the same set to both).
export function chatgptRealtimeHeaders({ token, accountId = "", sessionId = "" }: { token: string; accountId?: string; sessionId?: string }): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "openai-alpha": "quicksilver=v2",
    // The Codex backend serves Codex clients; this request is the one the Codex CLI makes for its
    // own voice mode, on the same sign-in the gateway's Codex runs already use.
    originator: "codex_cli_rs",
    "User-Agent": "ChannelGate voice",
  };
  if (accountId) headers["ChatGPT-Account-ID"] = accountId;
  if (sessionId) headers["x-session-id"] = sessionId;
  return headers;
}

export function buildChatgptSession({ model = DEFAULT_CHATGPT_VOICE_MODEL, instructions = "", initialItems = [] as { role: "user" | "assistant"; text: string }[] } = {}): Record<string, unknown> {
  const session: Record<string, unknown> = {
    model: isChatgptVoiceModel(model) ? model : DEFAULT_CHATGPT_VOICE_MODEL,
    instructions: String(instructions).slice(0, MAX_INSTRUCTION_CHARS),
    // Every request the voice cannot answer itself comes to the gateway; `ack_filler` lets the
    // voice say "let me check" naturally while the gateway works.
    delegation: { type: "client", ack_filler: true },
  };
  if (initialItems.length) session.initial_items = initialItems.map((item) => ({
    type: "message", role: item.role, content: [{ type: item.role === "assistant" ? "output_text" : "input_text", text: String(item.text) }],
  }));
  return session;
}

export function callIdFromLocation(location: string | null): string {
  const raw = String(location || "").split("?")[0].replace(/\/+$/, "");
  const id = raw.slice(raw.lastIndexOf("/") + 1);
  return CALL_ID_RE.test(id) ? id : "";
}

// Split text the way Codex does (≤500 UTF-8 bytes per append, on a character boundary).
export function contextChunks(text: string, max = CONTEXT_APPEND_MAX_BYTES): string[] {
  const chunks: string[] = [];
  let current = "";
  let size = 0;
  for (const char of String(text)) {
    const bytes = Buffer.byteLength(char);
    if (size + bytes > max && current) { chunks.push(current); current = ""; size = 0; }
    current += char; size += bytes;
  }
  if (current || !chunks.length) chunks.push(current);
  return chunks;
}

// A tool result as the voice reads it. JSON keeps every field the voice may need, labelled.
export function renderToolResult(name: string, response: unknown): string {
  const body = typeof response === "string" ? response : JSON.stringify(response ?? {});
  return `[gateway result for ${name}] ${body}`.slice(0, MAX_TOOL_RESULT_CHARS);
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>;
export interface CreatedCall { sdp: string; callId: string; sessionId: string }

// Exchange the browser's SDP offer for OpenAI's answer. Throws with the vendor's status and a
// bounded detail (never the token) when the backend refuses.
export async function createChatgptCall({ sdp, token, accountId = "", session, fetchImpl = fetch as unknown as FetchLike, timeoutMs = 20_000 }: {
  sdp: string; token: string; accountId?: string; session: Record<string, unknown>; fetchImpl?: FetchLike; timeoutMs?: number;
}): Promise<CreatedCall> {
  const offer = String(sdp || "");
  if (!offer.startsWith("v=") || Buffer.byteLength(offer) > MAX_SDP_BYTES) throw Object.assign(new Error("The browser's call offer is malformed."), { status: 400 });
  const sessionId = randomUUID();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(CHATGPT_REALTIME_CALLS_URL, {
      method: "POST", signal: controller.signal,
      headers: { ...chatgptRealtimeHeaders({ token, accountId, sessionId }), "Content-Type": "application/json", Accept: "application/sdp, text/plain, */*" },
      body: JSON.stringify({ sdp: offer, session }),
    });
    const text = await response.text();
    if (!response.ok) {
      const detail = text.replace(/eyJ[A-Za-z0-9_.-]{20,}/g, "<jwt>").replace(/\s+/g, " ").trim().slice(0, 300);
      const hint = response.status === 401 || response.status === 403 ? " (the ChatGPT sign-in was refused — check it under Settings → Engines)"
        : response.status === 429 ? " (the plan's voice allowance may be used up; it renews on a rolling window)" : "";
      throw Object.assign(new Error(`ChatGPT voice refused the call: HTTP ${response.status}${detail ? ` ${detail}` : ""}${hint}`), { status: 502 });
    }
    const callId = callIdFromLocation(response.headers.get("location"));
    if (!text.startsWith("v=") || !callId) throw Object.assign(new Error("ChatGPT voice answered without a usable call."), { status: 502 });
    return { sdp: text, callId, sessionId };
  } catch (error) {
    if ((error as { name?: string })?.name === "AbortError") throw Object.assign(new Error("ChatGPT voice did not answer in time."), { status: 504 });
    throw error;
  } finally { clearTimeout(timer); }
}

type SocketLike = {
  readyState: number;
  onopen: ((event?: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event?: unknown) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
};
type SocketFactory = new (url: string, init?: { headers?: Record<string, string> }) => SocketLike;

function decode(data: unknown): Record<string, unknown> | null {
  try {
    const text = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8")
      : data instanceof ArrayBuffer ? Buffer.from(data).toString("utf8") : ArrayBuffer.isView(data) ? Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8") : "";
    const parsed = text ? JSON.parse(text) : null;
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}
const obj = (value: unknown): Record<string, unknown> => (value && typeof value === "object" ? value as Record<string, unknown> : {});
const str = (value: unknown): string => (typeof value === "string" ? value : "");

// The control channel of one call. Events (see the file header for the mapping to Gemini's):
//   ready · input_transcript { text } · output_transcript { text } · turn_complete
//   delegation { id, text } · usage { audioMs, limit } · error (Error) · closed { code, reason }
export class ChatgptLiveSession extends EventEmitter {
  readonly callId: string;
  ready = false;
  closed = false;
  private socket: SocketLike | null = null;

  constructor({ callId, token, accountId = "", sessionId = "", WebSocketImpl = globalThis.WebSocket as unknown as SocketFactory, sidebandBase = SIDEBAND_BASE }: {
    callId: string; token: string; accountId?: string; sessionId?: string; WebSocketImpl?: SocketFactory; sidebandBase?: string;
  }) {
    super();
    this.callId = callId;
    const socket = new WebSocketImpl(`${sidebandBase}${encodeURIComponent(callId)}`, { headers: chatgptRealtimeHeaders({ token, accountId, sessionId }) });
    this.socket = socket;
    socket.onopen = () => { if (this.closed) return; this.ready = true; this.emit("ready"); };
    socket.onmessage = (event) => { const message = decode(event?.data); if (message) this.handle(message); };
    socket.onerror = () => { if (!this.closed) this.emit("error", new Error("The ChatGPT voice control channel reported an error.")); };
    socket.onclose = (event) => this.finish(Number(event?.code) || 1006, str(event?.reason));
  }

  private handle(message: Record<string, unknown>): void {
    const type = str(message.type);
    if (type === "session.started" || type === "session.updated") { if (!this.ready) { this.ready = true; this.emit("ready"); } return; }
    if (type === "input_transcript.added" || type === "output_transcript.added") {
      const text = str(obj(message.item).text) || str(message.delta);
      if (text) this.emit(type === "input_transcript.added" ? "input_transcript" : "output_transcript", { text });
      return;
    }
    if (type === "turn.done") { this.emit("turn_complete"); return; }
    if (type === "delegation.created") {
      const item = obj(message.item);
      if (item.type !== "delegation" || (item.target !== undefined && item.target !== "client")) return;
      const id = str(item.id);
      const text = (Array.isArray(item.content) ? item.content : []).map((part) => obj(part)).filter((part) => part.type === "input_text").map((part) => str(part.text)).join("").trim();
      if (id) this.emit("delegation", { id, text });
      return;
    }
    if (type === "session.usage.updated") {
      const usage = obj(message.usage);
      const limit = obj(message.usage_limit);
      this.emit("usage", { audioMs: Number(usage.audio_duration_ms) || 0, limit: limit.status ? { status: str(limit.status), resetSeconds: Number(limit.reset_seconds) || 0 } : null });
      return;
    }
    if (type === "error") {
      const error = obj(message.error);
      this.emit("error", new Error(str(error.message) || str(message.message) || "ChatGPT voice error"));
    }
  }

  private sendJson(message: Record<string, unknown>): boolean {
    if (!this.ready || this.closed || !this.socket) return false;
    try { this.socket.send(JSON.stringify(message)); return true; } catch { return false; }
  }
  private append(type: "session.context.append" | "delegation.context.append", text: string, channel: "speakable" | "commentary", itemId = ""): boolean {
    let ok = true;
    for (const chunk of contextChunks(text)) {
      ok = this.sendJson({ type, ...(itemId ? { delegation_item_id: itemId } : {}), channel, content: [{ type: "input_text", text: chunk }] }) && ok;
    }
    return ok;
  }

  // Something the voice should say (a task result, a navigation notice).
  sendText(text: string): boolean { return this.append("session.context.append", String(text), "speakable"); }
  // Quiet context the voice may use when asked, without speaking it now ("the agent is running tests").
  sendContext(text: string): boolean { return this.append("session.context.append", String(text), "commentary"); }
  // The answer to a delegation (calls.js routes each delegation to one of its tools).
  sendToolResponse({ id, name, response }: { id: string; name: string; response: unknown; scheduling?: string }): boolean {
    return this.append("delegation.context.append", renderToolResult(name, response), "speakable", id);
  }
  // Audio rides WebRTC between the browser and OpenAI; nothing is relayed through the gateway.
  sendAudio(): boolean { return false; }

  close(): void {
    if (this.closed) return;
    this.sendJson({ type: "session.close" });
    const socket = this.socket;
    this.finish(1000, "closed by gateway");
    try { socket?.close(1000, "closed by gateway"); } catch { /* already closed */ }
  }
  private finish(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true; this.ready = false; this.socket = null;
    this.emit("closed", { code, reason });
  }
}

export interface ChatgptCallOptions {
  sdp: string; loginId?: string; model?: string; instructions?: string; initialItems?: { role: "user" | "assistant"; text: string }[];
  resolveLogin?: typeof resolveChatgptVoiceLogin; fetchImpl?: FetchLike; WebSocketImpl?: SocketFactory; sidebandBase?: string;
}
// Create the call for the browser's offer and join its control channel. → { session, answer }.
export async function startChatgptLiveCall(options: ChatgptCallOptions): Promise<{ session: ChatgptLiveSession; answer: string; planType: string }> {
  const login = await (options.resolveLogin || resolveChatgptVoiceLogin)(options.loginId || DEFAULT_CHATGPT_VOICE_LOGIN);
  if (login.error) throw Object.assign(new Error(login.error), { status: 503 });
  const created = await createChatgptCall({
    sdp: options.sdp, token: login.token, accountId: login.accountId, fetchImpl: options.fetchImpl,
    session: buildChatgptSession({ model: options.model, instructions: options.instructions, initialItems: options.initialItems }),
  });
  const session = new ChatgptLiveSession({ callId: created.callId, token: login.token, accountId: login.accountId, sessionId: created.sessionId,
    WebSocketImpl: options.WebSocketImpl, sidebandBase: options.sidebandBase });
  return { session, answer: created.sdp, planType: login.planType };
}
