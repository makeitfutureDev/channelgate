// Who is working in a channel RIGHT NOW — the egress proxy's `canUse` input.
//
// Why: a placeholder is only as safe as the moment it may be swapped. A channel's container is a
// shared trust domain, so the proxy gates swaps on live work instead of on who holds the string:
//   • channel / organization / relay grants swap only while the channel has SOME live work — a
//     turn, a background job, a memory review or an SSH session. A container with nothing live has
//     no business talking to a credentialed API.
//   • a PERSONAL grant swaps only while its OWNER has live work in that channel, and never while a
//     DIFFERENT person has an SSH session open there (a developer sitting in the container could
//     otherwise drive another author's personal token while that author's turn is running).
//
// In-memory on purpose: liveness is a fact about THIS daemon's processes, and a restart ends
// every one of them (a recovered background job re-marks itself). SSH sessions come from the
// broker's own daemon-local view (ssh-broker.js liveSshSessions), so the SSH-placeholder phase
// needs no second registry.
import { randomUUID } from "node:crypto";
import { liveSshSessions } from "../ssh-broker.js";

export const LIVE_KINDS = Object.freeze(["turn", "job", "ssh", "review"]);

const live = new Map(); // key → { channelId, ownerId, kind, id, since }
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
  };
}

function sshSessionsIn(channelId) {
  let sessions = [];
  try { sessions = sshSource() || []; } catch { sessions = []; }
  return sessions.filter((session) => session && String(session.channelId || "") === String(channelId || ""));
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
  sshSource = () => liveSshSessions();
}
