// Slack's Agent Sessions — the lifecycle surface Slack introduced in August 2026 for apps declared
// as agents: one session per thread with a status (`processing` shows the standard loading UX and,
// when the app subscribes to `agent_session_stopped`, Slack's NATIVE Stop button), a title, and
// the stop event itself. The legacy `assistant.threads.*` methods keep working through Slack's
// compatibility bridge until February 2027, so every call here goes native first and falls back
// to the legacy method ONCE per process when the workspace or app answers with an error that
// says the new surface is unavailable (not enabled for the workspace, not declared as an agent,
// not subscribed to the stop event, an SDK/method gap). A thread-specific refusal (not a member,
// an unusable thread_ts) is reported as "not accepted" without flipping the mode.
//
// The two surfaces are driven TOGETHER, because each carries something the other does not:
// - the native session status is the lifecycle Slack's client reads — `processing` shows the
//   standard loading UX and the Stop button, `active` clears them. It is NOT cleared when the app
//   posts a message: the caller sends `active` when the turn ends (progress.js does, through its
//   terminal status clear) or the session times out after an hour. It carries no custom phrase.
// - the legacy status carries the compact "is using…" activity line and the prominent loading
//   copy, which the native method does not accept. It keeps working through the bridge.
// A status write therefore asserts the lifecycle natively (once per transition, re-asserted
// every few minutes so a long turn never hits the hour expiry) and then writes the phrase through
// the legacy method. Either surface refusing a thread is remembered for that thread alone.
export const SESSION_STATUS = Object.freeze({ processing: "processing", active: "active", suspended: "suspended", closed: "closed" });

// How often a still-processing session is re-asserted natively. Far inside the hour expiry, far
// above the legacy phrase cadence (every 20s on a quiet turn).
const NATIVE_REASSERT_MS = 5 * 60_000;
// Per-thread lifecycle facts: the last native status Slack accepted and when, and which surface
// refused this thread. Bounded by time so a long-lived daemon cannot grow it without limit.
const THREAD_TTL_MS = 2 * 60 * 60_000;
const threads = new Map();
function threadState(key) {
  const now = Date.now();
  let state = threads.get(key);
  if (state && now - state.touchedAt > THREAD_TTL_MS) {
    threads.delete(key);
    state = null;
  }
  if (!state) {
    state = { native: "", nativeAt: 0, nativeOff: false, legacyOff: false, touchedAt: now };
    threads.set(key, state);
    if (threads.size > 5000) {
      for (const [other, otherState] of threads) {
        if (now - otherState.touchedAt > THREAD_TTL_MS) threads.delete(other);
      }
    }
  }
  state.touchedAt = now;
  return state;
}

// Error codes that mean "the native surface is unavailable here" — fall back to the legacy method
// for the rest of this process. Anything else is a per-call/per-thread refusal.
const LEGACY_FALLBACK_CODES = new Set([
  "unknown_method",
  "method_not_supported",
  "method_deprecated",
  "feature_disabled",
  "feature_not_enabled",
  "agent_sessions_disabled",
  "missing_scope",
  "missing_agent_session_stopped_event_subscription",
  "not_an_agent",
  "app_not_an_agent",
  "invalid_arguments",
  "invalid_arg_name",
  "not_allowed",
]);

const modes = { status: "native", rename: "native" };

export function agentSessionsMode() {
  return { ...modes };
}

// Tests only: forget a learned fallback and every thread's lifecycle facts.
export function resetAgentSessionsMode() {
  modes.status = "native";
  modes.rename = "native";
  threads.clear();
}

function errorCode(error) {
  return String(error?.data?.error || error?.code || error?.message || "").trim();
}

function fallsBackToLegacy(error) {
  return LEGACY_FALLBACK_CODES.has(errorCode(error));
}

function noteFallback(surface, error) {
  modes[surface] = "legacy";
  console.warn(`[slack] agents.sessions ${surface} unavailable (${errorCode(error) || "unknown_error"}) — using the legacy assistant.threads method`);
}

// Set a thread's session status. `phrase` is the activity line ("" clears); a non-empty phrase
// means the session is `processing`, an empty one `active`. `loadingMessages` are the prominent
// loading copy (already normalized by the caller). Resolves true when Slack accepted the write on
// at least one surface, false when this thread can carry no status at all.
export async function setAgentSessionStatus(client, { channel, threadTs, phrase = "", loadingMessages = [], status = "" } = {}) {
  if (!threadTs) return false;
  const state = threadState(`${channel}:${threadTs}`);
  const nativeStatus = status || (phrase ? SESSION_STATUS.processing : SESSION_STATUS.active);
  let nativeAccepted = false;
  if (modes.status === "native" && !state.nativeOff) {
    const now = Date.now();
    // Asserted on every transition; a steady `processing` is re-asserted on a slow cadence so a
    // long turn never hits the hour expiry, and a steady `active` is never repeated.
    const due = state.native !== nativeStatus
      || (nativeStatus === SESSION_STATUS.processing && now - state.nativeAt >= NATIVE_REASSERT_MS);
    if (due) {
      try {
        await client.apiCall("agents.sessions.setStatus", { channel_id: channel, thread_ts: threadTs, status: nativeStatus });
        state.native = nativeStatus;
        state.nativeAt = now;
        nativeAccepted = true;
      } catch (error) {
        if (fallsBackToLegacy(error)) noteFallback("status", error);
        else state.nativeOff = true;
      }
    } else {
      nativeAccepted = true;
    }
  }
  if (state.legacyOff) return nativeAccepted;
  try {
    await client.apiCall("assistant.threads.setStatus", {
      channel_id: channel,
      thread_ts: threadTs,
      status: phrase,
      ...(loadingMessages.length ? { loading_messages: loadingMessages } : {}),
    });
    return true;
  } catch {
    state.legacyOff = true;
    return nativeAccepted;
  }
}

// What a thread's session is known to be, for tests and the stop handler.
export function nativeSessionStatus(channel, threadTs) {
  return threads.get(`${channel}:${threadTs}`)?.native || "";
}

// Name a thread's session. Resolves true when Slack accepted the title.
export async function renameAgentSession(client, { channel, threadTs, title } = {}) {
  const clean = String(title || "").trim().slice(0, 200);
  if (!threadTs || !clean) return false;
  if (modes.rename === "native") {
    try {
      await client.apiCall("agents.sessions.rename", { channel_id: channel, thread_ts: threadTs, title: clean });
      return true;
    } catch (error) {
      if (!fallsBackToLegacy(error)) return false;
      noteFallback("rename", error);
    }
  }
  try {
    await client.apiCall("assistant.threads.setTitle", { channel_id: channel, thread_ts: threadTs, title: clean.slice(0, 120) });
    return true;
  } catch {
    return false;
  }
}

// The `agent_session_stopped` event: the user pressed Slack's native Stop button in a thread whose
// session is `processing`. Returns the thread to stop, or null for a malformed payload.
export function stoppedSessionTarget(event = {}) {
  const channel = String(event?.channel || "").trim();
  const threadTs = String(event?.thread_ts || "").trim();
  const user = String(event?.user || "").trim();
  if (!channel || !threadTs) return null;
  return {
    channel,
    threadTs,
    user,
    streamingMessageTs: Array.isArray(event?.streaming_message_ts) ? event.streaming_message_ts.map(String) : [],
  };
}
