// In-process notifications that a piece of gateway configuration was WRITTEN — a channel's meta
// (its secrets, MCP selection, mode switches), a user's record (personal secrets, Composio token)
// or the organization's shared secrets. Consumers that hold a prepared copy of that state for a
// long-lived process — an SSH session's files (gateway/ssh-broker.js) — re-prepare on the event
// instead of waiting for their periodic refresh, so a secret an admin just added is on the next
// `claude` a developer starts. Emitted AFTER the write commits; the payload names only what
// changed (a slug, a user id), never a value. Every write path in this daemon is in-process, so
// the events are complete for it; the host-backend stdio MCP child writes through its own
// connection and this emitter never sees those (they are refreshed by the periodic tick).
import { EventEmitter } from "node:events";

export const CONFIG_CHANGE_KINDS = Object.freeze(["channel-meta", "user", "org-env"]);

const emitter = new EventEmitter();
emitter.setMaxListeners(50);

export function onConfigChange(listener) {
  emitter.on("change", listener);
  return () => emitter.off("change", listener);
}

export function emitConfigChange(kind, detail = {}) {
  if (!CONFIG_CHANGE_KINDS.includes(kind)) throw new TypeError(`unknown config change kind: ${kind}`);
  // Listeners run on the next tick, and a throwing listener never fails the write that fired it.
  queueMicrotask(() => {
    try { emitter.emit("change", { kind, ...detail }); } catch { /* a listener's problem, logged by it */ }
  });
}
