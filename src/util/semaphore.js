// Tiny counting semaphore (FIFO). Used to cap concurrent engine runs: acquire() resolves to a
// release function once a slot is free; callers hold the slot in a try/finally. No dependencies,
// no timers — just a waiter queue.
//
// Two properties the run orchestrator depends on, both of which a bare counter gets wrong:
//
//   Honest waiting — the caller learns whether it ACTUALLY queued, from inside acquire(), rather
//     than pre-checking `active >= max` and guessing. A pre-check races: a slot can free between
//     the check and the acquire (reporting a wait that never happened) or fill right after it
//     (waiting silently). The status a user sees is only as truthful as this.
//   Cancellable waiting — a stopped run parked in the queue must LEAVE the queue. Otherwise it
//     sits until a slot frees, takes it, and immediately throws — burning a slot that a live run
//     was waiting for, and lengthening every queue behind it.

function abortError() {
  return Object.assign(new Error("Run aborted while queued"), { name: "AbortError" });
}

export function createSemaphore(max = 1) {
  const cap = Math.max(1, Math.floor(Number(max) || 1));
  let active = 0;
  const waiters = []; // { grant, cancel }

  // Hand the next queued waiter a slot if one is free.
  const dispatch = () => {
    if (active >= cap || waiters.length === 0) return;
    active++;
    waiters.shift().grant();
  };

  const makeRelease = () => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active--;
      dispatch();
    };
  };

  return {
    // Resolves (in arrival order) when a slot is free; the returned release() is idempotent.
    //
    // opts.onWait — called ONCE, only when this call genuinely has to queue, with
    //   { position, active, max }. Never called on the fast path, so a run that starts
    //   immediately never claims it was queued.
    // opts.signal — aborting removes this waiter from the queue and rejects with an AbortError.
    async acquire({ signal = null, onWait = null } = {}) {
      if (signal?.aborted) throw abortError();

      // Fast path: a slot is free AND nobody is ahead of us. The waiters check preserves FIFO —
      // without it a late arrival could jump a queue that formed while a slot was being released.
      if (active < cap && waiters.length === 0) {
        active++;
        return makeRelease();
      }

      const position = waiters.length + 1;
      let entry = null;
      let onAbort = null;
      try {
        await new Promise((resolve, reject) => {
          entry = { grant: resolve, cancel: reject };
          waiters.push(entry);
          if (signal) {
            onAbort = () => {
              const i = waiters.indexOf(entry);
              if (i < 0) return; // already granted — the run itself handles the abort
              waiters.splice(i, 1);
              reject(abortError());
            };
            signal.addEventListener("abort", onAbort, { once: true });
          }
          // After enqueueing, so `position` is accurate, and guarded because a reporting callback
          // must never be able to reject an acquire.
          try {
            onWait?.({ position, active, max: cap });
          } catch {
            /* status reporting is best-effort */
          }
        });
      } finally {
        if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      }
      return makeRelease();
    },
    get active() {
      return active;
    },
    get pending() {
      return waiters.length;
    },
    get max() {
      return cap;
    },
  };
}
