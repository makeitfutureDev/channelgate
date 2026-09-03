// Pool of warm PersistentClaudeSessions keyed by "<slug>::<threadKey>". Keeps a thread's
// process alive between messages for fast follow-ups, and guarantees correctness:
//
//  - One warm process per thread, and turns are serialized (a chained promise), so two Slack
//    messages in the same thread never race the same process.
//  - A "fingerprint" of the launch options (cwd + dangerous flag + the full --mcp-config, which
//    embeds both resolved Composio tokens) is stored. If the next message's fingerprint differs
//    — e.g. a different author posts, or an admin toggles a setting — the warm process is torn
//    down and relaunched. This stops user A's personal connection from ever serving user B while
//    also refreshing changed channel/org shared credentials.
//  - Dead processes (idle-terminated or crashed) are evicted; the next message relaunches.
import { PersistentClaudeSession } from "./persistent-session.js";
import { runtimeTargetOr } from "./runtime-target.js";

// WHERE the process runs is part of the launch identity, exactly like the cwd and the resolved
// tokens: a warm process started on the host cannot serve a turn that must run inside the
// channel's container, and a container that was recreated (new image, new mounts, new credential
// mode) is a different environment even though its name did not change. The backend's own
// fingerprint carries that create-time config, so a recreate retires the warm processes that
// belonged to the old one instead of leaving them talking to a container that no longer exists.
function fingerprint({ cwd, mcpConfigJson, dangerouslySkip, fingerprintExtra, target }) {
  const runtime = target?.backend || "host";
  const runtimeFingerprint = typeof target?.runtime?.fingerprint === "function" ? target.runtime.fingerprint(target) : "host";
  return `${cwd}|${dangerouslySkip ? 1 : 0}|${runtime}|${runtimeFingerprint}|${fingerprintExtra || ""}|${mcpConfigJson || ""}`;
}

// Pool size cap: every warm entry holds a live `claude` process for up to the idle window, so an
// unbounded pool piles processes up across many threads. Configurable via WARM_POOL_MAX (default 8).
function maxWarm() {
  const n = Number.parseInt(process.env.WARM_POOL_MAX ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 8;
}

// LRU eviction pick (pure; exported for tests). Given the current entries as
// [{ key, idle, lastUsed }] and the cap, return the keys to terminate so that `entries.length +
// adding` fits within `max` — IDLE entries only (killing a busy one would reject its in-flight
// turn), least-recently-used first. If everything is busy the pool briefly overflows instead.
export function pickEvictions(entries, max, adding = 1) {
  const need = entries.length + adding - max;
  if (need <= 0) return [];
  return entries
    .filter((e) => e.idle)
    .sort((a, b) => a.lastUsed - b.lastUsed)
    .slice(0, need)
    .map((e) => e.key);
}

// Run one turn through the pool. `args` is the launch argv (used only when (re)launching).
// `turnTimeoutMs` is the per-turn watchdog forwarded to send() (see persistent-session.js).
// Factory form keeps the production singleton small while making the replacement/drain contract
// executable with fake sessions. A pool entry may be marked `draining` when a same-thread caller
// needs different launch credentials/config: once marked, no later caller can append to the old
// chain, so awaiting that chain really does establish a safe termination boundary.
export function createSessionPool({
  createSession = (options) => new PersistentClaudeSession(options),
  maxSessions = maxWarm,
} = {}) {
  const pool = new Map(); // key -> { session, fingerprint, chain, pending, lastUsed, draining? }
  let closed = false;

  function shutdownError() {
    return Object.assign(new Error("Warm session pool is shutting down"), { name: "AbortError" });
  }

  async function drainForReplacement(key, entry) {
    if (!entry.draining) {
      entry.draining = entry.chain
        .catch(() => {})
        .then(() => {
          // Another replacement may already have completed while this caller was awaiting.
          if (pool.get(key) !== entry) return;
          entry.session.terminate();
          pool.delete(key);
        });
    }
    await entry.draining;
  }

  // `target` is the RuntimeTarget for this turn (src/runtimes/). run.js has already awaited
  // ensureUp() for it once this turn — the pool never does that itself, so a queued turn cannot
  // start a container behind the orchestrator's back.
  async function runPooled({ key, cwd, args, env, idleMs, mcpConfigJson, dangerouslySkip, fingerprintExtra, target = null, text, turnTimeoutMs, maxSilenceMs, signal, onDelta, onEvent }) {
    if (closed) throw shutdownError();
    const runtime = runtimeTargetOr(target, cwd);
    const fp = fingerprint({ cwd, mcpConfigJson, dangerouslySkip, fingerprintExtra, target: runtime });
    let entry = pool.get(key);

    // Drop a stale entry. A fingerprint change while work is outstanding must wait for the old
    // chain: terminating a BUSY session rejects the other turn with "claude session ended" and
    // was the root of the restart-recovery/live-message race. Marking the entry as draining also
    // prevents an old-fingerprint caller from extending the chain after we captured it.
    while (entry && (!entry.session.alive || entry.fingerprint !== fp || entry.draining)) {
      if (entry.session.alive && (entry.pending > 0 || entry.draining)) {
        await drainForReplacement(key, entry);
      } else if (pool.get(key) === entry) {
        entry.session.terminate();
        pool.delete(key);
      }
      entry = pool.get(key);
    }

    // shutdownPool() may have run while this caller awaited a busy fingerprint drain. Never let
    // that waiter launch a replacement process after the final daemon sweep.
    if (closed) throw shutdownError();

    if (!entry) {
      // At the cap? Terminate the least-recently-used idle sessions to make room for this one.
      const snapshot = [...pool.entries()].map(([k, e]) => ({ key: k, idle: e.session.alive && e.pending === 0 && !e.draining, lastUsed: e.lastUsed }));
      for (const k of pickEvictions(snapshot, maxSessions())) {
        pool.get(k)?.session.terminate();
        pool.delete(k);
      }

      const session = createSession({ cwd, args, env, idleMs, target: runtime });
      session.onDead = () => {
        // Only evict if this exact session is still the mapped one.
        if (pool.get(key)?.session === session) pool.delete(key);
      };
      session.start();
      entry = { session, fingerprint: fp, chain: Promise.resolve(), pending: 0, lastUsed: Date.now(), draining: null };
      pool.set(key, entry);
    }

    // Serialize turns for this thread; keep the chain alive even if a turn rejects. `pending` counts
    // queued + in-flight turns so LRU eviction and fingerprint replacement never kill live work.
    entry.pending++;
    entry.lastUsed = Date.now();
    const settle = () => {
      entry.pending--;
      entry.lastUsed = Date.now();
    };
    const run = entry.chain.then(() => {
      // A stop can land while this turn waits behind the thread's chain — bail before sending
      // (abortPooled tears down the session for the IN-FLIGHT turn; this covers the queued ones).
      if (closed) throw shutdownError();
      if (signal?.aborted) throw Object.assign(new Error("Run aborted while queued"), { name: "AbortError" });
      return entry.session.send(text, { onDelta, onEvent, timeoutMs: turnTimeoutMs, maxSilenceMs });
    });
    entry.chain = run.then(settle, settle);
    return run;
  }

  // True when this thread has a warm session that is actively MID-TURN (steerable). Used by the
  // Slack layer to decide whether a new message can interrupt-steer the running turn or must queue.
  function pooledBusy(key) {
    const entry = pool.get(key);
    return Boolean(entry && !entry.draining && entry.session.alive && entry.session.state === "busy");
  }

  // Steer the in-flight turn for a thread: interrupt it WITHOUT tearing down the warm session, so
  // the next message resumes with its context (see PersistentClaudeSession.interrupt).
  function interruptPooled(key) {
    const entry = pool.get(key);
    if (!entry || entry.draining || !entry.session.alive) return false;
    return entry.session.interrupt();
  }

  // Explicit stop/heal remains immediate. Safe configuration replacement uses the drain path above.
  function abortPooled(key) {
    const entry = pool.get(key);
    if (!entry) return false;
    entry.session.terminate();
    pool.delete(key);
    return true;
  }

  function poolStats() {
    const entries = [...pool.entries()];
    return {
      warm: entries.length,
      keys: entries.map(([key]) => key),
      pending: entries.reduce((count, [, entry]) => count + entry.pending, 0),
      busy: entries.reduce((count, [, entry]) => count + (entry.session.state === "busy" ? 1 : 0), 0),
      draining: entries.reduce((count, [, entry]) => count + (entry.draining ? 1 : 0), 0),
    };
  }

  // Final daemon sweep: terminate every persistent process group, including idle sessions.
  function shutdownPool() {
    closed = true;
    const entries = [...pool.values()];
    for (const { session } of entries) session.terminate();
    pool.clear();
    return entries.length;
  }

  return { runPooled, pooledBusy, interruptPooled, abortPooled, poolStats, shutdownPool };
}

const defaultPool = createSessionPool();

export const runPooled = (options) => defaultPool.runPooled(options);
export const pooledBusy = (key) => defaultPool.pooledBusy(key);
export const interruptPooled = (key) => defaultPool.interruptPooled(key);
export const abortPooled = (key) => defaultPool.abortPooled(key);
export const poolStats = () => defaultPool.poolStats();
export const shutdownPool = () => defaultPool.shutdownPool();
