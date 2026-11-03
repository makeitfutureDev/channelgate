// A run capability is authority only while its conversation has live work.
//
// The signed capability a container run holds (mcp-capability.js) is a bearer: anything inside
// the shared-uid container can copy it, and until now it stayed valid for its whole TTL (6 h for a
// turn, 12 h for an SSH session) after the turn that minted it had ended. The daemon already keeps
// an exact, in-memory record of what is live in every channel for the egress proxy
// (egress/liveness.js: turns, background jobs and agents, memory reviews, SSH sessions). The
// control socket consults the same record: a capability whose channel has nothing live is refused
// with one fixed sentence, whatever its expiry says.
//
// Channel-level on purpose, not per token: the registry has no per-jti entries, every spawn path
// already registers its channel, and the warm engine pool keeps one process (and one capability)
// across turns — the check must refuse calls BETWEEN turns, never kill the process. Residual: a
// copied token works while SOME work is live in that same channel, which is the container's own
// trust domain anyway.
//
// Grace: the engine's last tool call and the daemon's release of the turn are not ordered by a
// lock (src/gateway/run.js releases in its finally, after the result event; a Stop hook or a last
// memory save can still be in flight), so a call within CAPABILITY_GRACE_MS of the channel's last
// release is honoured. 30 s is what covers that race; nothing longer is needed because every
// other legitimate caller (a background job, a review, an SSH session) is registered for its own
// whole life.
import { isChannelLive, lastReleasedAt } from "./egress/liveness.js";
import { logEvent } from "../util/logger.js";

export const CAPABILITY_IDLE_REASON = "This run's gateway capability is no longer active: its conversation has no live work.";
export const CAPABILITY_GRACE_MS = 30_000;

// Is this channel live, or within the post-release grace?
export function capabilityChannelLive(channelId, { now = Date.now(), graceMs = CAPABILITY_GRACE_MS } = {}) {
  if (isChannelLive(channelId)) return true;
  const released = lastReleasedAt(channelId);
  return released > 0 && now - released <= graceMs;
}

// Throttle the audit row: a wedged client can retry in a tight loop, and one row per (jti, tool)
// a minute says everything the operator needs.
const recentlyLogged = new Map();
const LOG_EVERY_MS = 60_000;

// Wrap a capability verifier so that a valid signature is still refused while its channel is idle.
// `verify` is the signature/expiry check; `tool` names the call for the audit row when known.
export function withCapabilityLiveness(verify, { now = Date.now, log = logEvent } = {}) {
  return ({ tool = "" } = {}) => {
    const checked = verify();
    if (!checked.ok) return checked;
    const claims = checked.claims || {};
    if (capabilityChannelLive(claims.channelId, { now: now() })) return checked;
    const key = `${claims.jti || ""}:${tool}`;
    const at = now();
    if (!recentlyLogged.has(key) || at - recentlyLogged.get(key) > LOG_EVERY_MS) {
      recentlyLogged.set(key, at);
      if (recentlyLogged.size > 2048) recentlyLogged.clear();
      // Fire-and-forget: the refusal must not wait on the events table.
      Promise.resolve(log("capability_refused_idle", { channel: claims.channelId || "", slug: claims.slug || "", author: claims.authorId || "", jti: claims.jti || "", tool, origin: claims.origin || "" })).catch(() => {});
    }
    return { ok: false, reason: CAPABILITY_IDLE_REASON };
  };
}

export function __resetCapabilityLivenessLog() {
  recentlyLogged.clear();
}
