// Bound token, HTTP and body reads together. Cancellation must settle even when a test or
// transport implementation ignores AbortSignal, without retrying an uncertain message send.
export async function teamsRequest(operation, { timeoutMs = 15_000, signal } = {}) {
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  if (signal?.aborted) throw signal.reason;
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException('Teams request timed out', 'TimeoutError')), timeoutMs);
  let rejectAborted;
  const aborted = new Promise((_, reject) => {
    rejectAborted = () => reject(controller.signal.reason);
    controller.signal.addEventListener('abort', rejectAborted, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return operation(controller.signal);
    }), aborted]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', rejectAborted);
  }
}
