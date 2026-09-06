// Activity bookkeeping for channel containers: leases, idle stop, and the max-running cap.
//
// "Idle" is not "no foreground turn". A background job, a memory-review run and a scheduled run
// all outlive the turn that started them, so each holds a LEASE, and a container with any lease is
// never stopped no matter how quiet it looks. Stopping is also not removing: a stopped container
// restarts in under a second with its writable layer intact (measured 0.18 s on this host), so the
// idle sweep costs a channel nothing but memory it was not using.
//
// The cap works the same way round: before creating or starting a container we make room by
// stopping the least-recently-used IDLE one. If every slot is leased we WAIT and say so — the
// alternative, killing someone's running job to make room, is never the right answer.
import { activeEditorLeases } from "./editor-lease.js";
export const DEFAULT_SWEEP_MS = 60_000;
export const DEFAULT_SLOT_POLL_MS = 2_000;
export const DEFAULT_SLOT_WAIT_MS = 5 * 60_000;

export function createContainerReaper({
  now = () => Date.now(),
  log = () => {},
  stopContainer = async () => {},
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.()),
  sweepMs = DEFAULT_SWEEP_MS,
  slotPollMs = DEFAULT_SLOT_POLL_MS,
  slotWaitMs = DEFAULT_SLOT_WAIT_MS,
} = {}) {
  const entries = new Map(); // name → { name, target, leases:Map, lastActivity, running, idleMinutes }
  let timer = null;
  let leaseSeq = 0;

  function ensureEntry(name, target = null) {
    let entry = entries.get(name);
    if (!entry) {
      entry = { name, target, leases: new Map(), lastActivity: now(), running: false, idleMinutes: 10 };
      entries.set(name, entry);
    }
    if (target) {
      entry.target = target;
      const minutes = Number(target?.settings?.idleMinutes);
      if (Number.isFinite(minutes) && minutes > 0) entry.idleMinutes = minutes;
    }
    return entry;
  }

  function touch(name, target = null) {
    const entry = ensureEntry(name, target);
    entry.lastActivity = now();
    return entry;
  }

  function markRunning(name, target = null, { lastActivity = now() } = {}) {
    const entry = ensureEntry(name, target);
    entry.running = true;
    entry.lastActivity = lastActivity;
    return entry;
  }

  function markStopped(name) {
    const entry = entries.get(name);
    if (!entry) return;
    entry.running = false;
    entry.lastActivity = now();
  }

  function forget(name) {
    entries.delete(name);
  }

  // `exclude` names lease ids that must NOT count as "someone else is inside". The caller that
  // needs it is the one asking whether a container can be rebuilt right now: run.js takes its own
  // lease BEFORE ensureUp (so the idle reaper cannot stop the environment out from under a turn
  // that is about to spawn), and counting that lease made every turn look busy to itself — which is
  // how a recreate could be deferred forever on a channel where nothing else was running.
  function leaseCount(name, { exclude = null } = {}) {
    const entry = entries.get(name);
    if (!entry) return 0;
    const ids = exclude == null ? [] : (Array.isArray(exclude) ? exclude : [exclude]);
    let own = 0;
    for (const id of ids) if (id && entry.leases.has(id)) own += 1;
    return Math.max(0, entry.leases.size - own) + (entry.target ? activeEditorLeases(entry.target).length : 0);
  }

  // Contract: synchronous, returns { id, release() }. release() doubles as an activity record — the
  // idle clock starts when the last lease goes away, not when the turn began. The `id` is the
  // handle a holder passes back to leaseCount({ exclude }) to ask "is anyone ELSE inside?".
  function acquireLease(target, lease = {}) {
    const name = target?.container?.name || "";
    if (!name) return { id: "", release() {} };
    const entry = ensureEntry(name, target);
    const id = `${lease.kind || "run"}:${lease.id || `l${++leaseSeq}`}`;
    entry.leases.set(id, { kind: lease.kind || "run", id, at: now() });
    entry.lastActivity = now();
    let released = false;
    return {
      id,
      release() {
        if (released) return;
        released = true;
        entry.leases.delete(id);
        entry.lastActivity = now();
      },
    };
  }

  function idleFor(entry) {
    return now() - entry.lastActivity;
  }

  function isIdle(entry) {
    return entry.running && leaseCount(entry.name) === 0 && idleFor(entry) >= entry.idleMinutes * 60_000;
  }

  async function stopEntry(entry, reason) {
    try {
      await stopContainer(entry.name, { target: entry.target, reason });
      markStopped(entry.name);
      log(`[container] stopped ${entry.name} (${reason})`);
      return true;
    } catch (error) {
      log(`[container] could not stop ${entry.name}: ${error?.message || error}`);
      return false;
    }
  }

  // One sweep. Exposed so tests drive it directly instead of racing a real interval.
  async function tick() {
    const stopped = [];
    for (const entry of [...entries.values()]) {
      if (!isIdle(entry)) continue;
      if (await stopEntry(entry, `idle ${entry.idleMinutes}m`)) stopped.push(entry.name);
    }
    return stopped;
  }

  function runningEntries() {
    return [...entries.values()].filter((entry) => entry.running);
  }

  // Make room for `name` before a create/start. Returns { waitedMs, stopped: [...] }.
  async function reserveSlot(name, { maxRunning = 8, announce = null, reason = "max running containers" } = {}) {
    const started = now();
    let announced = false;
    const stopped = [];
    for (;;) {
      const running = runningEntries().filter((entry) => entry.name !== name);
      if (running.length < Math.max(1, maxRunning)) return { waitedMs: now() - started, stopped };
      const victim = running
        .filter((entry) => leaseCount(entry.name) === 0)
        .sort((a, b) => a.lastActivity - b.lastActivity)[0];
      if (victim) {
        if (await stopEntry(victim, reason)) {
          stopped.push(victim.name);
          continue;
        }
        // Could not stop it — do not spin on the same victim; fall through to the wait below.
      }
      if (now() - started >= slotWaitMs) {
        throw new Error(
          `all ${maxRunning} container slots are busy with active runs — this channel's container could not start within ${Math.round(slotWaitMs / 1000)}s. `
          + "Raise Settings → Container runtime → max running, or wait for a run to finish.",
        );
      }
      if (!announced) {
        announced = true;
        log(`[container] waiting for a container slot (${running.length}/${maxRunning} busy)`);
        try {
          announce?.("Waiting for a container slot — every channel container is busy with an active run.");
        } catch {
          /* announcing must never fail a run */
        }
      }
      await sleep(slotPollMs);
    }
  }

  function startTimer() {
    if (timer) return timer;
    timer = setInterval(() => {
      tick().catch((error) => log(`[container] reaper sweep failed: ${error?.message || error}`));
    }, sweepMs);
    timer.unref?.();
    return timer;
  }

  function stopTimer() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  function snapshot() {
    return [...entries.values()].map((entry) => ({
      name: entry.name,
      running: entry.running,
      leases: leaseCount(entry.name),
      editorLeases: entry.target ? activeEditorLeases(entry.target).length : 0,
      idleMs: idleFor(entry),
      idleMinutes: entry.idleMinutes,
      slug: entry.target?.slug || "",
      platform: entry.target?.platform || "",
    }));
  }

  return {
    acquireLease, leaseCount, touch, markRunning, markStopped, forget, ensureEntry,
    tick, reserveSlot, startTimer, stopTimer, snapshot, runningEntries, isIdle,
    get size() {
      return entries.size;
    },
  };
}
