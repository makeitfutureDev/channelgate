// Paused ordinary inboxes leave source requests in SQLite. Status, stop and approvals use
// separate control inboxes and remain responsive while child sessions copy the source.
export function forkSessionHolds(wake: () => void) {
  const holds = new Map<string, number>();
  return {
    isReady: (key: string) => !holds.has(key),
    acquire({ conversationId, sessionKey }: { conversationId: string; sessionKey: string }) {
      const key = JSON.stringify([conversationId, sessionKey]);
      holds.set(key, (holds.get(key) || 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const remaining = (holds.get(key) || 1) - 1;
        if (remaining) holds.set(key, remaining); else holds.delete(key);
        wake();
      };
    },
  };
}
