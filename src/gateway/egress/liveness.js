// Who is working in a channel RIGHT NOW — the egress proxy's `canUse` input.
//
// Why: a placeholder is only as safe as the moment it may be swapped. A channel's container is a
// shared trust domain, so the proxy gates swaps on live work instead of on who holds the string:
//   • channel / organization / relay grants swap only while the channel has SOME live work — a
//     turn, a background job, a memory review or an SSH session. A container with nothing live has
//     no business talking to a credentialed API.
//   • a PERSONAL grant swaps only while its OWNER has live work in that channel, and never while a
//     DIFFERENT person has live work there — a turn, a background job or an SSH session (the
//     container is shared, so another author's process could otherwise drive the owner's personal
//     token while the owner's turn is running).
//
// In-memory on purpose: liveness is a fact about THIS daemon's processes, and a restart ends
// every one of them (a recovered background job re-marks itself). SSH sessions come from the
// broker's own daemon-local view (ssh-broker.js liveSshSessions), so the SSH-placeholder phase
// needs no second registry.
import { randomUUID } from "node:crypto";
import { liveSshSessions } from "../ssh-broker.js";

export const LIVE_KINDS = Object.freeze(["turn", "job", "ssh", "review"]);

const live = new Map(); // key → { channelId, ownerId, kind, id, since }
// channel → when its LAST live entry was released. The run-capability check (capability-liveness.js)
// allows a short grace after that moment: the engine's final tool call and the daemon's release of
// the turn are not ordered by a lock, so a call that was in flight when the turn ended must still
// land. Bounded: pruned on read, never consulted by the egress proxy (a swap after the turn is the
// thing the proxy exists to refuse).
const recentlyReleased = new Map();
const RECENT_KEEP_MS = 10 * 60 * 1000;
let sshSource = () => liveSshSessions();

// → release(). Idempotent: a second call does nothing, so a finally block and an error path may
// both call it.
export function markLive({ channelId, ownerId = "", kind, id = "" } = {}) {
  if (!LIVE_KINDS.includes(kind)) throw new Error(`unknown liveness kind: ${kind}`);
  const channel = String(channelId || "");
  if (!channel) return () => {};
  const key = `${kind}:${id || randomUUID()}:${randomUUID()}`;
  live.set(key, { channelId: channel, ownerId: String(ownerId || ""), kind, id: String(id || ""), since: Date.now() });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    live.delete(key);
    recentlyReleased.set(channel, Date.now());
    if (recentlyReleased.size > 512) {
      const cutoff = Date.now() - RECENT_KEEP_MS;
      for (const [id, at] of recentlyReleased) if (at < cutoff) recentlyReleased.delete(id);
    }
  };
}

// When the channel's most recent live entry was released (ms epoch), or 0 when none was released
// within the retention window. Read by the run-capability liveness check only.
export function lastReleasedAt(channelId) {
  const at = recentlyReleased.get(String(channelId || "")) || 0;
  if (at && Date.now() - at > RECENT_KEEP_MS) {
    recentlyReleased.delete(String(channelId || ""));
    return 0;
  }
  return at;
}

function sshSessionsIn(channelId) {
  let sessions = [];
  try { sessions = sshSource() || []; } catch { sessions = []; }
  return sessions.filter((session) => session && String(session.channelId || "") === String(channelId || ""));
}

// The most recent live TURN in the channel (a turn's liveness id is its thread key) →
// { threadKey, ownerId } or null. Where an approval card for this channel's traffic is posted.
export function liveTurnIn(channelId) {
  const channel = String(channelId || "");
  let best = null;
  for (const entry of live.values()) {
    if (entry.channelId !== channel || entry.kind !== "turn" || !entry.id) continue;
    if (!best || entry.since > best.since) best = entry;
  }
  return best ? { threadKey: best.id, ownerId: best.ownerId } : null;
}

export function isChannelLive(channelId) {
  const channel = String(channelId || "");
  if (!channel) return false;
  for (const entry of live.values()) if (entry.channelId === channel) return true;
  return sshSessionsIn(channel).length > 0;
}

export function isOwnerLive(channelId, ownerId) {
  const channel = String(channelId || "");
  const owner = String(ownerId || "");
  if (!channel || !owner) return false;
  for (const entry of live.values()) if (entry.channelId === channel && entry.ownerId === owner) return true;
  return sshSessionsIn(channel).some((session) => String(session.userId || "") === owner);
}

// Is a DIFFERENT person working in this channel right now — a turn, a background job or an SSH
// session with a non-empty owner that is not `ownerId`? Ownerless work (a memory review, an HTTP
// run-API turn, which carries no personal scope) does not count.
export function otherOwnerActive(channelId, ownerId) {
  const channel = String(channelId || "");
  const owner = String(ownerId || "");
  if (!channel) return false;
  for (const entry of live.values()) {
    if (entry.channelId === channel && entry.ownerId && entry.ownerId !== owner) return true;
  }
  return sshSessionsIn(channel).some((session) => session.userId && String(session.userId) !== owner);
}

// Is a DIFFERENT person's SSH session open in this channel?
export function otherSshOpen(channelId, ownerId) {
  const owner = String(ownerId || "");
  return sshSessionsIn(channelId).some((session) => String(session.userId || "") !== owner);
}

export function liveSnapshot() {
  return [...live.values()].map((entry) => ({ ...entry }));
}

// Test seams.
export function __setSshSessionSource(fn) {
  sshSource = typeof fn === "function" ? fn : () => liveSshSessions();
}
export function __resetLiveness() {
  live.clear();
  recentlyReleased.clear();
  sshSource = () => liveSshSessions();
}
