// How many ChatGPT voice minutes a sign-in has used recently.
//
// ChatGPT voice runs on a plan's separate rolling voice allowance (about five hours wide). OpenAI
// does not expose what is left of it — the Codex CLI and the Hermes plugin both meter locally — so
// the gateway counts its own: every ChatGPT call writes one `voice_chatgpt_usage` event when it
// ends (the sign-in it used, the audio time OpenAI reported, the connected time), and any
// allowance status OpenAI sends mid-call is written at once as `voice_chatgpt_limit`. The meter
// sums the window from those events plus the calls still running. Events, not a new table: one
// row per call is all the meter needs, and the events table is already indexed by name and time.
// Only this gateway's calls are counted — the same plan used in the ChatGPT apps is invisible here.
import { getDb } from "../../db/index.js";
import { logEvent } from "../../util/logger.js";

export const VOICE_WINDOW_MS = 5 * 60 * 60 * 1000;
export const VOICE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export const USAGE_EVENT = "voice_chatgpt_usage";
export const LIMIT_EVENT = "voice_chatgpt_limit";
export const MAX_ALLOWANCE_MINUTES = 24 * 60;

export interface ChatgptCallUsage { callId: string; login: string; ownerId: string; audioMs: number; connectedMs: number; planType?: string }
export interface LiveChatgptCall { login: string; ownerId: string; usedMs: number }
export interface VoiceMeter {
  login: string;
  windowMs: number;
  usedMs: number;            // everyone on this sign-in, last 5 hours, live calls included
  ownUsedMs: number;         // the asking person's share of usedMs ("" owner → 0)
  weekMs: number;            // everyone, last 7 days
  calls: number;             // calls counted in the 5-hour window (live included)
  allowanceMs: number;       // the admin's estimate of the plan's 5-hour allowance; 0 = unknown
  remainingMs: number | null;// allowance − used, never below 0; null when the allowance is unknown
  limit: { status: string; resetAt: number } | null; // OpenAI said the allowance is used up, until resetAt
}

let liveSource: () => LiveChatgptCall[] = () => [];
// The call manager reports its running ChatGPT calls, so a meter read mid-call is current.
export function setLiveChatgptUsageSource(source: () => LiveChatgptCall[]): void { liveSource = typeof source === "function" ? source : () => []; }

// What a finished call used: OpenAI's audio duration when it reported one, else the connected time.
export function callUsedMs({ audioMs = 0, connectedMs = 0 }: { audioMs?: number; connectedMs?: number }): number {
  const audio = Math.max(0, Number(audioMs) || 0);
  return audio > 0 ? audio : Math.max(0, Number(connectedMs) || 0);
}

export async function recordChatgptCallUsage(usage: ChatgptCallUsage, log = logEvent): Promise<void> {
  await log(USAGE_EVENT, { author: usage.ownerId, callId: usage.callId, login: usage.login, audioMs: Math.round(Math.max(0, usage.audioMs)),
    connectedMs: Math.round(Math.max(0, usage.connectedMs)), usedMs: Math.round(callUsedMs(usage)), planType: String(usage.planType || "") });
}
export async function recordChatgptLimit({ login, ownerId, status, resetSeconds }: { login: string; ownerId: string; status: string; resetSeconds: number }, log = logEvent, now = Date.now): Promise<void> {
  await log(LIMIT_EVENT, { author: ownerId, login, status: String(status).slice(0, 60), resetAt: now() + Math.max(0, Number(resetSeconds) || 0) * 1000 });
}

type Row = { ts: string; author: string; data: string | null };
function rows(event: string, sinceMs: number): Row[] {
  try {
    return getDb().prepare("SELECT ts, author, data FROM events WHERE event = ? AND ts >= ? ORDER BY id").all(event, new Date(sinceMs).toISOString()) as Row[];
  } catch { return []; }
}
const parse = (data: string | null): Record<string, unknown> => { try { return data ? JSON.parse(data) as Record<string, unknown> : {}; } catch { return {}; } };

export function chatgptVoiceMeter({ login, ownerId = "", allowanceMinutes = 0, now = Date.now() }: { login: string; ownerId?: string; allowanceMinutes?: number; now?: number }): VoiceMeter {
  let usedMs = 0, ownUsedMs = 0, weekMs = 0, calls = 0;
  for (const row of rows(USAGE_EVENT, now - VOICE_WEEK_MS)) {
    const data = parse(row.data);
    if (data.login !== login) continue;
    const used = Math.max(0, Number(data.usedMs) || 0);
    weekMs += used;
    if (Date.parse(row.ts) >= now - VOICE_WINDOW_MS) {
      usedMs += used; calls += 1;
      if (ownerId && row.author === ownerId) ownUsedMs += used;
    }
  }
  for (const live of liveSource()) {
    if (live.login !== login) continue;
    const used = Math.max(0, Number(live.usedMs) || 0);
    usedMs += used; weekMs += used; calls += 1;
    if (ownerId && live.ownerId === ownerId) ownUsedMs += used;
  }
  let limit: VoiceMeter["limit"] = null;
  for (const row of rows(LIMIT_EVENT, now - VOICE_WINDOW_MS)) {
    const data = parse(row.data);
    const resetAt = Number(data.resetAt) || 0;
    if (data.login === login && resetAt > now) limit = { status: String(data.status || "limit reached"), resetAt };
  }
  const minutes = Math.min(Math.max(Math.round(Number(allowanceMinutes) || 0), 0), MAX_ALLOWANCE_MINUTES);
  const allowanceMs = minutes * 60_000;
  return { login, windowMs: VOICE_WINDOW_MS, usedMs, ownUsedMs, weekMs, calls, allowanceMs,
    remainingMs: allowanceMs ? Math.max(0, allowanceMs - usedMs) : null, limit };
}

// "12 min used in the last 5 hours · about 18 min left" — the one wording every surface shows.
export function describeVoiceMeter(meter: VoiceMeter, { own = false, now = Date.now() }: { own?: boolean; now?: number } = {}): string {
  const min = (ms: number) => `${Math.round(ms / 60_000)} min`;
  const parts = [`${min(meter.usedMs)} used in the last 5 hours${own && meter.ownUsedMs ? ` (${min(meter.ownUsedMs)} by you)` : ""}`];
  if (meter.limit) parts.push(`allowance used up — renews in about ${Math.max(1, Math.ceil((meter.limit.resetAt - now) / 60_000))} min`);
  else if (meter.remainingMs !== null) parts.push(`about ${min(meter.remainingMs)} left of ${min(meter.allowanceMs)}`);
  return parts.join(" · ");
}
