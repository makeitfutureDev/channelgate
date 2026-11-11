// Lightweight invalidation hints. Subscribers must re-read state and reauthorize their viewer;
// these notifications contain no thread content and are never an authorization decision.
const listeners = new Set();

export function onThreadChanged(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifyThreadChanged({ channelId = "", threadTs = "" } = {}) {
  for (const listener of listeners) {
    try { listener({ channelId, threadTs }); } catch { /* observers cannot break a turn */ }
  }
}
