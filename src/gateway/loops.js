// Thread loops: the durable half of native `/loop` support.
//
// `engines/loop-wakeup.js` reads the pacing decision out of the engine stream; this module turns
// it into something that survives the turn. A loop tick is stored as an ordinary row in the
// SCHEDULE store — same table, same tick loop, same concurrency cap and per-channel ceiling — with
// a few extra fields in the record's JSON blob (config-shaped rows keep their whole record in
// `data`, so this needs no migration):
//
//   loop: true          this row is a loop tick, not a user-created schedule
//   loopId              stable id across the re-arms of one loop, so ticks can be traced
//   threadTs            the thread to run in AND deliver into
//   resumeThread: true  run under the THREAD's session (context accumulates across ticks, the way
//                       it does in a terminal) and reply in-thread, instead of announcing a fresh
//                       top-level run the way a normal schedule does
//   ticksRemaining      the runaway budget — every loop is finite even if the model never stops
//
// Two shapes arrive here. A DYNAMIC loop (ScheduleWakeup) is a one-time row that the next tick
// re-arms, so a loop whose turn dies simply stops — the safe direction. An INTERVAL loop
// (CronCreate) is a recurring row, because a fixed cadence should keep its phase even if one tick
// fails; its budget is decremented on each fire instead.
import { randomUUID } from "node:crypto";
import { addSchedule, listForChannel, deleteSchedule, updateSchedule, countEnabledForChannel } from "../config/schedules.js";
import { cronValid, minIntervalMinutes } from "../util/cron.js";
import { getScheduleMaxPerChannel } from "../config/settings.js";
import { postNotice } from "../platforms/notify.js";

// How many ticks one loop may fire before it retires itself. The model is asked to stop on its
// own, and the user can stop the thread, but neither is guaranteed — this is the backstop that
// makes "it looped forever and burned the budget" impossible rather than unlikely.
export const DEFAULT_MAX_TICKS = 24;

// The floor for an INTERVAL loop, in minutes. Deliberately below the ordinary
// `schedule_min_interval` (a runaway guard for unattended crons): a loop is an explicit,
// foreground, budget-capped request in a thread someone is watching, and `/loop 5m` is its most
// common form. The tick budget above is what bounds the total spend.
export const LOOP_MIN_INTERVAL_MINUTES = 1;

function isLoopRow(row) {
  return Boolean(row && row.loop && row.threadTs);
}

// Every live loop row for one thread. Ordinary schedules in the channel are never returned.
export function threadLoops(channelId, threadTs) {
  if (!channelId || !threadTs) return [];
  return listForChannel(channelId).filter((s) => isLoopRow(s) && s.threadTs === threadTs);
}

// Cancel loops and report WHICH ones were dropped, so each affected thread can be told. Pass a
// `threadTs` for one thread; pass none to end every loop in the channel (what the channel-wide
// `/stop` sweep means). Returns the dropped rows — an empty array when there was nothing to stop,
// which is how callers stay quiet on a `stop` in a thread that never looped.
export function stopLoops(channelId, threadTs = null) {
  if (!channelId) return [];
  const rows = threadTs
    ? threadLoops(channelId, threadTs)
    : listForChannel(channelId).filter(isLoopRow);
  return rows.filter((row) => deleteSchedule(row.id, channelId));
}

// Count-returning shorthand for the common single-thread case.
export function stopThreadLoops(channelId, threadTs) {
  return stopLoops(channelId, threadTs).length;
}

// Arm (or re-arm) a thread's loop from a normalized wakeup.
//
// Returns { ok, action, schedule?, reason? }:
//   action "stopped"  — the loop was cancelled (mode "stop", or the budget ran out)
//   action "armed"    — a tick is scheduled; `schedule` is the stored row
//   action "none"     — nothing to do / nothing was running
// A refusal is always explained (`reason`), because a loop that silently fails to re-arm looks
// exactly like a loop that finished on purpose.
export function armLoop({ channelId, slug = "", threadTs, authorId = "", wakeup, maxTicks = DEFAULT_MAX_TICKS }) {
  if (!channelId || !threadTs) return { ok: false, action: "none", reason: "no thread context" };
  if (!wakeup || wakeup.kind !== "loop_wakeup") return { ok: false, action: "none", reason: "not a loop wakeup" };

  const existing = threadLoops(channelId, threadTs);

  if (wakeup.mode === "stop") {
    const dropped = stopThreadLoops(channelId, threadTs);
    return { ok: true, action: dropped ? "stopped" : "none", dropped };
  }

  // The budget carries across a re-arm: a dynamic loop replaces its row every tick, so reading the
  // remaining count off the row being replaced is what makes the cap cumulative rather than a
  // ceiling the model resets simply by scheduling again.
  const carried = existing.reduce((min, row) => {
    const n = Number(row.ticksRemaining);
    return Number.isFinite(n) ? Math.min(min, n) : min;
  }, Number.POSITIVE_INFINITY);
  const remaining = Number.isFinite(carried) ? carried : maxTicks;
  if (remaining <= 0) {
    stopThreadLoops(channelId, threadTs);
    return { ok: false, action: "stopped", reason: `loop tick budget exhausted (${maxTicks} ticks)` };
  }

  const loopId = existing.find((row) => row.loopId)?.loopId || randomUUID().slice(0, 8);

  // A re-arm REPLACES the thread's pending tick. Without this a model that calls ScheduleWakeup
  // twice in one turn (or an interval loop that is re-created) would leave both rows armed and the
  // thread would tick twice per period, compounding every turn.
  stopThreadLoops(channelId, threadTs);

  // The per-channel ceiling is checked AFTER the replace, so a loop re-arming into its own freed
  // slot is never blocked by itself.
  const maxPer = getScheduleMaxPerChannel();
  if (countEnabledForChannel(channelId) >= maxPer) {
    return { ok: false, action: "none", reason: `channel is at its ${maxPer}-schedule limit` };
  }

  const common = {
    channelId,
    slug,
    prompt: wakeup.prompt,
    description: wakeup.reason || "loop tick",
    createdBy: authorId,
    notify: "none", // a loop already lives in a thread someone is watching — never ping per tick
    kind: "task",
  };
  const loopFields = {
    loop: true,
    loopId,
    threadTs,
    resumeThread: true,
    ticksRemaining: remaining,
    loopReason: wakeup.reason || "",
    loopNoop: Boolean(wakeup.noop),
  };

  if (wakeup.mode === "interval") {
    if (!cronValid(wakeup.cron)) return { ok: false, action: "none", reason: `invalid cron "${wakeup.cron}"` };
    const gap = minIntervalMinutes(wakeup.cron);
    if (gap !== null && gap < LOOP_MIN_INTERVAL_MINUTES) {
      return { ok: false, action: "none", reason: `a loop may not tick more often than every ${LOOP_MIN_INTERVAL_MINUTES} min` };
    }
    const schedule = addSchedule({ ...common, cron: wakeup.cron, ...loopFields });
    return { ok: true, action: "armed", schedule, loopId };
  }

  const runAt = new Date(Date.now() + wakeup.delaySeconds * 1_000).toISOString();
  const schedule = addSchedule({ ...common, runAt, once: true, ...loopFields });
  return { ok: true, action: "armed", schedule, loopId };
}

// Arm the thread's next tick AND tell the thread what just happened. Both the live Slack turn and
// a scheduler-driven tick go through here, so a loop announces itself identically wherever it was
// paced from.
//
// The announcement is not decoration. The harness's `/loop` prints its own "next wake-up in N"
// line to a terminal nobody can see from chat, so without this the only visible evidence of a
// running loop would be a reply appearing out of nowhere 20 minutes later — and a loop that failed
// to arm would look exactly like a loop that finished. `client` may be null (tests, no transport);
// the arming still happens, only the notice is skipped.
export async function applyLoopWakeup({ client, channelId, slug = "", threadTs, authorId = "", wakeup }) {
  if (!wakeup || wakeup.kind !== "loop_wakeup") return { ok: false, action: "none" };
  const outcome = armLoop({ channelId, slug, threadTs, authorId, wakeup });

  let notice = "";
  // A stop always names its cause when it has one — "the model asked" and "it hit the tick budget"
  // read identically to the user otherwise, and only one of them means the work may be unfinished.
  if (outcome.action === "stopped") {
    notice = outcome.reason ? `🔁 _Loop stopped — ${outcome.reason}._` : "🔁 _Loop stopped — no further ticks are scheduled._";
  }
  else if (!outcome.ok && outcome.reason) notice = `🔁 _Couldn't schedule the next loop tick: ${outcome.reason}._`;
  else if (outcome.action === "armed") {
    const left = outcome.schedule?.ticksRemaining;
    const budget = Number.isFinite(left) ? ` · ${left} tick${left === 1 ? "" : "s"} left` : "";
    if (wakeup.mode === "interval") {
      notice = `🔁 _Looping on \`${wakeup.cron}\`${budget}. Say \`stop\` in this thread to end it._`;
    } else {
      const mins = Math.round(wakeup.delaySeconds / 60);
      const why = wakeup.reason ? ` — ${wakeup.reason}` : "";
      notice = `🔁 _Next loop tick in ~${mins} min${why}${budget}. Say \`stop\` in this thread to end it._`;
    }
  }

  if (notice && client) {
    try {
      await postNotice(client, { conversationId: channelId, threadKey: threadTs, text: notice });
    } catch {
      /* the answer itself already landed — the loop notice is best-effort */
    }
  }
  return outcome;
}

// Spend one tick of a loop's budget as it fires. Returns the count left AFTER this tick; at zero
// the caller retires the row (a recurring loop would otherwise keep its cron forever).
export function consumeTick(sched) {
  if (!isLoopRow(sched)) return null;
  const left = Math.max(0, (Number(sched.ticksRemaining) || 0) - 1);
  updateSchedule(sched.id, { ticksRemaining: left });
  return left;
}

export { isLoopRow };
