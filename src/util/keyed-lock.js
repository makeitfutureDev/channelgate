// Small process-local exclusion lock. A Codex provider thread may be referenced by more than one
// gateway key (primary/fallback/recovery), so the Slack per-thread queue alone cannot prevent two
// `exec resume` processes from branching the same cumulative token counter concurrently.
const tails = new Map();

export async function acquireKeyedLock(namespace, key, { signal = null } = {}) {
  const lockKey = `${namespace}:${String(key || "")}`;
  const prior = tails.get(lockKey) || Promise.resolve();
  let releaseGate;
  const gate = new Promise((resolve) => { releaseGate = resolve; });
  const tail = prior.catch(() => {}).then(() => gate);
  tails.set(lockKey, tail);
  const ready = prior.catch(() => {});
  const cancelQueued = () => ready.finally(() => {
    releaseGate();
    if (tails.get(lockKey) === tail) tails.delete(lockKey);
  });
  if (signal?.aborted) {
    cancelQueued();
    throw Object.assign(new Error("Run aborted while waiting for its provider session"), { name: "AbortError" });
  }
  let onAbort;
  try {
    await (signal
      ? Promise.race([
          ready,
          new Promise((_, reject) => {
            onAbort = () => reject(Object.assign(new Error("Run aborted while waiting for its provider session"), { name: "AbortError" }));
            signal.addEventListener("abort", onAbort, { once: true });
          }),
        ])
      : ready);
  } catch (error) {
    cancelQueued();
    throw error;
  } finally {
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseGate();
    if (tails.get(lockKey) === tail) tails.delete(lockKey);
  };
}

export function keyedLockCount() {
  return tails.size;
}
