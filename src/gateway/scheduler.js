// Daemon-side cron runner. Every minute it reads the schedule store (which the scheduler MCP
// server may have just written from a gated AI run) and fires any enabled schedule whose cron
// matches the current minute: it runs the saved prompt as a fresh Claude session in that channel
// (as the schedule's creator) and posts the result to the channel.
import { getSchedules, updateSchedule, deleteSchedule, getSchedulerCursor, saveSchedulerCursor, claimScheduleMinute } from "../config/schedules.js";
import { getAcks, addAck, updateAck, deleteAck } from "../config/acks.js";
import { plainFailureText } from "../util/process-outcome.js";
import { cronMatches, elapsedMinutes } from "../util/cron.js";
import { runMessage as defaultRunMessage } from "./run.js";
import { applyLoopWakeup, consumeTick, isLoopRow, stopThreadLoops } from "./loops.js";
import { logEvent } from "../util/logger.js";
import { createUsageBank } from "./usage.js";
import { deliverResult } from "../slack/deliver.js";
import { runQueue } from "../slack/message-lifecycle.js";
import { postNotice, postDirectMessage, automationTarget } from "../platforms/notify.js";

const MAX_CONCURRENT_SCHED = 5; // most schedules allowed to run at once (runaway fan-out backstop)
// How many times a one-time schedule may actually EXECUTE before we stop retrying it. Only a real
// execution counts: Slack being unreachable never burns an attempt, so an outage postpones the
// schedule instead of consuming it.
const MAX_ONCE_ATTEMPTS = 2;
let slackRef = null;
const running = new Set(); // schedule ids currently executing
const firedThisMinute = new Map(); // id -> minute key, to avoid double-fire within a minute

// One-time ("run at") schedules delete themselves once they've run; recurring ones never do.
function isOneTime(sched) {
  return Boolean(sched.once || sched.runAt);
}

// Retire a one-time schedule at its DELIVERY boundary. It used to be deleted up front, before
// runSchedule even started — so a restart (or a Slack outage) in the middle of the run destroyed
// the only record that the task was ever supposed to happen. The row now survives until its output
// is actually in the channel; `running`/`firedThisMinute`/`runAttempts` handle double-firing.
function retireOneTime(sched) {
  if (isOneTime(sched)) deleteSchedule(sched.id);
}

function minuteKey(d) {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}-${d.getHours()}-${d.getMinutes()}`;
}

// The notify ping prefix: @channel, @person, or nothing ("none" = quiet, no notification).
function notifyPrefix(sched) {
  if (sched.notify === "channel") return "<!channel> ";
  if (sched.notify === "user" && sched.notifyUserId) return `<@${sched.notifyUserId}> `;
  return "";
}

// The text of a reminder post, without the label the renderer is about to add. People (and agents
// writing a `create_schedule` prompt) naturally phrase a reminder as "Reminder: review the QA
// results", and the "⏰ *Reminder:*" prefix then stuttered — "⏰ *Reminder:* Reminder: review the
// QA results" (QA ART-001). Exactly ONE leading label is removed, so a deliberate
// "Reminder: Reminder: …" still shows one and text that merely mentions the word keeps it.
export function reminderBody(text) {
  return String(text || "").trim().replace(/^reminders?\s*:\s*/i, "").trim();
}

export function scheduleDayKey(now = new Date()) {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// Resolve the Slack thread used by an ordinary scheduled task. Daily-thread schedules keep one
// visible top-level anchor per server-local calendar day; later fires reuse it without another
// channel-level banner. Persist immediately after Slack accepts the anchor, before the engine run,
// so a daemon restart mid-run still finds the correct thread.
export async function taskDeliveryThread(client, sched, title, now = new Date()) {
  // Channel delivery intentionally skips the "Running" anchor. The result is posted top-level
  // after the run, giving admins a true channel-vs-thread choice rather than a cosmetic label.
  if (sched.delivery === "channel") return null;
  if (sched.delivery === "daily-thread") {
    const date = scheduleDayKey(now);
    if (sched.dailyThreadDate === date && sched.dailyThreadTs) return sched.dailyThreadTs;
    const anchor = await postNotice(client, {
      conversationId: sched.channelId,
      text: `${notifyPrefix(sched)}⏰ *Running:* ${title}`,
    });
    const anchorThread = anchor?.threadKey || anchor?.messageId || null;
    if (anchorThread) {
      updateSchedule(sched.id, { dailyThreadDate: date, dailyThreadTs: anchorThread });
      sched.dailyThreadDate = date;
      sched.dailyThreadTs = anchorThread;
    }
    return anchorThread;
  }

  const announcement = await postNotice(client, {
    conversationId: sched.channelId,
    text: `${notifyPrefix(sched)}⏰ *Running:* ${title}`,
  });
  return announcement?.threadKey || announcement?.messageId || null;
}

// The session key for ONE fire of a schedule. Two properties, both deliberate:
//
//  1. It is SYNTHETIC — never a Slack thread_ts, so it can never collide with a human thread's
//     session (slack/thread-keys.js resolves it to "there is no thread; post top-level").
//  2. It is unique per FIRE, because a scheduled run is contractually a fresh, context-less
//     session every time (gateway-usage/references/reminders.md, and the `create_schedule` tool
//     description say so in as many words).
//
// It used to be built from the run's delivery thread, which only LOOKED per-fire: `standard`
// delivery announces every run, so each fire brought a new announcement ts — but `daily-thread`
// delivery reuses ONE anchor for the whole server-local day, so every later fire of that day
// landed on the previous fire's key and RESUMED its session (QA AUT-DAILY-THREAD-01: fire 1
// isNewSession:true, fire 2 isNewSession:false, same key). Threading the delivery is `threadTs`'s
// job and only `threadTs`'s job; the session key must not be derived from it.
//
// The stamp is monotonic rather than a bare `Date.now()` so that two fires landing in the same
// millisecond (one tick catching up several minutes at once) still get different keys.
let lastFireStamp = 0;
export function scheduleSessionKey(sched, now = Date.now()) {
  const stamp = Number(now);
  lastFireStamp = Math.max(Number.isFinite(stamp) ? stamp : Date.now(), lastFireStamp + 1);
  return `sched-${sched.id}-${lastFireStamp}`;
}

export async function runSchedule(sched, { runner: runMessage = defaultRunMessage, deliver = deliverResult } = {}) {
  if (running.has(sched.id)) return;
  running.add(sched.id);
  const client = automationTarget(slackRef, sched.channelId);
  let threadTs = sched.executionThread || null;
  try {
    if (!client) {
      // No destination transport = no delivery. A one-time schedule keeps its durable row (and its full attempt
      // budget) so the next tick after the outage still runs it, instead of being deleted unrun.
      await logEvent("schedule_skip", { id: sched.id, reason: "destination transport not connected" });
      return;
    }
    if (isOneTime(sched) && sched.executionState === "delivered") {
      retireOneTime(sched);
      return;
    }
    // A completed output can be retried without re-running its tools. A previous execution
    // without that checkpoint has unknown external effects and requires a human reconciliation.
    if (sched.pendingDelivery) {
      await deliver(client, { channel: sched.channelId, threadKey: threadTs || undefined,
        result: sched.pendingDelivery, trustedPrefix: sched.delivery === "channel" ? notifyPrefix(sched) : "" });
      await finishScheduleDelivery(client, sched, sched.pendingDelivery, threadTs);
      return;
    }
    if (sched.executionState === "running" || (isOneTime(sched) && sched.runAttempts > 0 && !sched.executionState && sched.kind !== "reminder")) {
      updateSchedule(sched.id, { enabled: false, executionState: "interrupted", lastStatus: "interrupted: external actions unknown; inspect before retrying" });
      await postNotice(client, { conversationId: sched.channelId, threadKey: threadTs || "",
        text: "⏰ A scheduled task was interrupted before its result was saved. It was paused without running again because external actions may already have happened. Inspect the task before explicitly retrying." });
      return;
    }
    // Only now, with a client in hand, does this count as an execution of a one-time schedule.
    // Persisting the bumped counter first is the durable claim that keeps a schedule which crashes
    // (or fails) mid-run from re-firing every minute forever.
    if (isOneTime(sched)) {
      const attempts = (sched.runAttempts || 0) + 1;
      if (attempts > MAX_ONCE_ATTEMPTS) {
        deleteSchedule(sched.id);
        await logEvent("schedule_giveup", { id: sched.id, channel: sched.channelId, attempts });
        try {
          await postNotice(client, { conversationId: sched.channelId, text: `⏰ Scheduled task *${(sched.description || sched.prompt || sched.id).trim()}* failed ${MAX_ONCE_ATTEMPTS} times and was cancelled. Schedule it again when you're ready.` });
        } catch {
          /* ignore */
        }
        return;
      }
      updateSchedule(sched.id, { runAttempts: attempts });
    }
    await logEvent("schedule_run", { id: sched.id, channel: sched.channelId, slug: sched.slug });
    const title = (sched.description || sched.prompt || "scheduled task").trim();

    // Reminder schedules post a SINGLE message (the reminder text) — no Claude run, no token cost,
    // no duplicate restatement. When ack is set, track the message so the escalation chain runs if
    // nobody reacts ✅.
    if (sched.kind === "reminder") {
      const raw = (sched.prompt || sched.description || "").trim() || title;
      // Strip a leading "Reminder:" the author already wrote — the renderer adds its own label.
      // The ack title travels into the 2nd notice ("🔔 *Reminder — 2nd notice:* …") and the
      // creator's DM, so it is stripped on the same rule rather than stuttering one step later.
      const body = reminderBody(raw) || raw;
      const ackTitle = reminderBody(title) || title;
      const ackHint = sched.ack ? `\n\n_React :${sched.ackEmoji || "white_check_mark"}: to acknowledge._` : "";
      const posted = await postNotice(client, {
        conversationId: sched.channelId,
        text: `${notifyPrefix(sched)}⏰ *Reminder:* ${body}${ackHint}`,
      });
      if (sched.ack && posted?.messageId) {
        const escalateAfterMin = sched.escalateAfterMin ?? 120;
        addAck({
          scheduleId: sched.id,
          channelId: sched.channelId,
          slug: sched.slug,
          messageTs: posted.messageId,
          threadTs: posted.messageId,
          text: body,
          title: ackTitle,
          createdBy: sched.createdBy,
          notifyUserId: sched.notifyUserId,
          notify: sched.notify,
          ackEmoji: sched.ackEmoji || "white_check_mark",
          nextAt: new Date(Date.now() + escalateAfterMin * 60_000).toISOString(),
          escalateAfterMin,
          dmAfterMin: sched.dmAfterMin ?? 60,
          escalationStyle: sched.escalationStyle || "thread",
        });
      }
      updateSchedule(sched.id, { lastRun: new Date().toISOString(), lastStatus: "ok" });
      retireOneTime(sched); // the reminder is posted — that IS this schedule's delivery
      return;
    }

    // A LOOP tick (gateway/loops.js) is not a standalone task: its thread is already open and
    // someone is reading it. So it skips the top-level announcement entirely and — unlike every
    // other schedule, which gets a deliberately synthetic session key — runs under the THREAD's
    // own session, which is what lets a loop accumulate context across ticks the way `/loop` does
    // in a terminal instead of restarting blind every time.
    const loopTick = isLoopRow(sched) && Boolean(sched.resumeThread);
    if (loopTick) {
      threadTs = sched.threadTs;
    } else {
      // 1. Announce the run (with the configured @channel / @person ping), then thread the result.
      try {
        threadTs = await taskDeliveryThread(client, sched, title);
      } catch {
        /* announce failed (e.g. missing scope) — still run + post the result */
      }
    }

    // 2. Run the saved prompt in the channel's folder, as the schedule's creator (its tokens/mode).
    // Origin "schedule": nobody is watching this turn, and create_schedule is pre-approved in
    // every channel — so injected content processed during an admin's turn could have planted this
    // prompt. It runs under the folder's permission allowlist, never with the sandbox off.
    // The session key is deliberately synthetic and per-FIRE (scheduleSessionKey) — it is NOT a
    // Slack thread_ts, and it is NOT derived from the delivery thread. Anything that needs to POST
    // into the run's thread (approval cards) takes the announcement's real ts from
    // slack/approvals.js instead.
    // The ONE exception is a loop tick, which is defined by continuing a human thread: it uses that
    // thread's real key on purpose, and therefore has to take the per-thread queue below.
    const bankUsage = createUsageBank();
    // A loop tick is the ONE schedule that runs on a real thread key, so it is the one that can
    // collide with live Slack work: two processes resuming the same session id at once, the second
    // replacing the first's warm process mid-turn. Restart recovery hit exactly this and solved it
    // by joining the foreground per-thread FIFO — a tick joins the same queue, for the same reason.
    // Every other schedule keeps its synthetic key, which by construction collides with nothing.
    const loopRunKey = loopTick ? `${sched.slug}::${sched.threadTs}` : "";
    const loopHandle = loopTick ? { aborted: false, controller: new AbortController(), authorId: sched.createdBy, loop: true } : null;
    if (loopTick) await runQueue.acquire(loopRunKey, loopHandle);
    let result;
    try {
      // A `stop` in the thread while this tick waited its turn already deleted the loop row and
      // marked the handle aborted. Honor it rather than spending a turn nobody is waiting for.
      if (loopTick && loopHandle.aborted) {
        await logEvent("loop_tick_aborted", { id: sched.id, loopId: sched.loopId, channel: sched.channelId });
        return;
      }
      sched.executionState = "running";
      updateSchedule(sched.id, { executionState: "running", executionThread: threadTs });
      result = await runMessage({
        channelId: sched.channelId,
        authorId: sched.createdBy,
        text: sched.prompt,
        threadKey: loopTick ? sched.threadTs : scheduleSessionKey(sched),
        signal: loopHandle?.controller.signal ?? null,
        origin: "schedule",
      });
    } finally {
      if (loopTick) runQueue.release(loopRunKey, loopHandle);
    }

    sched.executionState = "completed";
    sched.pendingDelivery = result;
    updateSchedule(sched.id, { executionState: "completed", pendingDelivery: result, executionThread: threadTs });

    // 3. The AI's reply, in the announcement's thread — through the same sanitize/chunk pipeline
    // as every unattended reply (deliverResult). The tokens are already spent, so the ledger is
    // written before delivery: a Slack failure must not erase the spend.
    await bankUsage({ channelId: sched.channelId, slug: sched.slug, authorId: sched.createdBy, engine: result.engine, taskKind: "scheduled", result });
    await deliver(client, {
      channel: sched.channelId,
      threadKey: threadTs || undefined,
      result,
      trustedPrefix: sched.delivery === "channel" ? notifyPrefix(sched) : "",
    });
    await finishScheduleDelivery(client, sched, result, threadTs);

  } catch (err) {
    updateSchedule(sched.id, { lastRun: new Date().toISOString(), lastStatus: `error: ${err.message}`,
      ...(sched.executionState === "running" ? { enabled: false, executionState: "interrupted" } : {}) });
    await logEvent("schedule_error", { id: sched.id, error: err.message });
    try {
      if (client) await postNotice(client, { conversationId: sched.channelId, threadKey: threadTs || "", text: `⏰ Scheduled run failed: ${plainFailureText(err.message) || "the run failed"}` });
    } catch {
      /* ignore */
    }
  } finally {
    running.delete(sched.id);
    // Release the DURABLE claim too. runDueForMinute stamps `running: true` on a one-time schedule
    // before starting it, but nothing ever cleared it: a failure, or a postpone because Slack was
    // down, left the surviving row flagged as running forever — a task the UI shows as permanently
    // in-flight. (updateSchedule is a no-op once retireOneTime has deleted the row.)
    if (isOneTime(sched)) {
      try {
        updateSchedule(sched.id, { running: false, runningSince: "" });
      } catch {
        /* row already gone — nothing to release */
      }
    }
  }
}

async function finishScheduleDelivery(client, sched, result, threadTs) {
  const loopTick = isLoopRow(sched) && Boolean(sched.resumeThread);
  updateSchedule(sched.id, { lastRun: new Date().toISOString(), lastStatus: "ok", executionState: "delivered", pendingDelivery: null, executionThread: null });
  // A loop spends one tick of its budget per delivered fire, then re-arms from whatever pacing
  // decision the model made during THIS tick. `armLoop` replaces the thread's pending row, so a
  // dynamic loop hands off cleanly; a loop that decided to stop (or ran out of budget) leaves
  // nothing armed. Silence would be indistinguishable from "the loop finished on purpose", so a
  // budget stop always says so in the thread.
  if (loopTick) {
    const left = consumeTick(sched);
    const outcome = left === 0 ? null : await applyLoopWakeup({
      client,
      channelId: sched.channelId,
      slug: sched.slug,
      threadTs: sched.threadTs,
      authorId: sched.createdBy,
      wakeup: result.loopWakeup,
    });
    if (left === 0) {
      stopThreadLoops(sched.channelId, sched.threadTs);
      await logEvent("loop_budget_exhausted", { id: sched.id, loopId: sched.loopId, channel: sched.channelId });
      try {
        await postNotice(client, { conversationId: sched.channelId, threadKey: sched.threadTs, text: "🔁 _Loop stopped — it reached its tick budget. Say what you'd like next to start another._" });
      } catch {
        /* the answer itself already landed — the notice is best-effort */
      }
    } else if (outcome?.action === "armed") {
      await logEvent("loop_rearmed", { id: outcome.schedule?.id, loopId: outcome.loopId, channel: sched.channelId, ticksLeft: left });
    }
  }
  retireOneTime(sched); // executed AND delivered — only now may the durable row go
}

// Escalation pass for reminder acknowledgments. An unacknowledged reminder steps stage1 → (2nd
// notice in the channel/thread) → stage2 → (DM the creator) → close. Each step reschedules the
// next via `nextAt`; a ✅ (handled in slack/app.js) deletes the entry, ending the chain.
let acksTicking = false;
async function processAcks(now) {
  if (acksTicking) return;
  const due = getAcks().filter((a) => {
    const t = Date.parse(a.nextAt);
    return Number.isFinite(t) && t <= now.getTime();
  });
  if (!due.length) return;
  acksTicking = true;
  try {
    for (const ack of due) {
      const client = automationTarget(slackRef, ack.channelId);
      if (!client) continue;
      try {
        if (ack.stage === "sent1") {
          const prefix = ack.notify === "channel" ? "<!channel> " : ack.notify === "user" && ack.notifyUserId ? `<@${ack.notifyUserId}> ` : "";
          const msg = `${prefix}🔔 *Reminder — 2nd notice:* ${ack.title || ack.text} — still not acknowledged. React :${ack.ackEmoji}: when done.`;
          const repost = await postNotice(client, {
            conversationId: ack.channelId,
            threadKey: ack.escalationStyle === "toplevel" ? "" : ack.threadTs,
            text: msg,
          });
          // The 2nd notice invites a ✅, so make reacting on IT acknowledge too — not just the original.
          const messageTsList = repost?.messageId ? [...(ack.messageTsList || [ack.messageTs]), repost.messageId] : ack.messageTsList;
          updateAck(ack.id, { stage: "sent2", messageTsList, nextAt: new Date(now.getTime() + (ack.dmAfterMin ?? 60) * 60_000).toISOString() });
          await logEvent("ack_escalate", { id: ack.id, stage: "sent2" });
        } else if (ack.stage === "sent2") {
          if (ack.createdBy) {
            let permalink = "";
            try { const p = await client.chat.getPermalink({ channel: ack.channelId, message_ts: ack.messageTs }); permalink = p?.permalink || ""; } catch { /* optional */ }
            try {
              const body = `👋 Your reminder — *${ack.title || ack.text}* — still hasn't been acknowledged after two notices.`;
              await postDirectMessage(client, { userId: ack.createdBy, text: body,
                blocks: [
                  { type: "section", text: { type: "mrkdwn", text: body } },
                  ...(permalink ? [{ type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "View conversation" }, url: permalink }] }] : []),
                ],
              });
            } catch (e) { await logEvent("ack_dm_error", { id: ack.id, error: e.message }); }
          }
          deleteAck(ack.id);
          await logEvent("ack_escalate", { id: ack.id, stage: "dm_done" });
        } else {
          deleteAck(ack.id);
        }
      } catch (e) {
        await logEvent("ack_error", { id: ack.id, error: e.message });
      }
    }
  } finally {
    acksTicking = false;
  }
}

// Is this schedule due right now? One-time ("run at") schedules fire once their runAt has passed;
// recurring schedules fire when their cron matches the current minute.
function isDue(sched, now) {
  if (needsRecovery(sched)) return true;
  if (sched.once || sched.runAt) {
    const t = Date.parse(sched.runAt);
    return Number.isFinite(t) && t <= now.getTime();
  }
  return cronMatches(sched.cron, now);
}

function needsRecovery(sched) {
  return Boolean(sched.pendingDelivery || ["queued", "running"].includes(sched.executionState));
}

// Evaluate one minute's due schedules against a shared per-tick snapshot (`scheds`) — the table
// is read once per tick, not once per caught-up minute. `now` is the wall-clock the cron/runAt
// checks run against — the live minute keeps full seconds precision; caught-up (past) minutes use
// the minute start. `firedOnce` collects schedule ids already started THIS tick: their rows
// may already be gone, but the snapshot still contains them, so a later caught-up minute in the
// same tick must skip them (firedThisMinute is keyed per minute and won't).
// Returns { deferred, started }: `deferred` is true when the concurrency cap cut the minute short,
// which the caller MUST NOT treat as "this minute is done".
function runDueForMinute(now, scheds, firedOnce, runOptions) {
  const mk = minuteKey(now);
  const started = [];
  let deferred = false;
  for (const sched of scheds) {
    if (!sched.enabled) continue;
    if (firedOnce.has(sched.id)) continue;
    if (running.has(sched.id)) continue; // never claim a minute for work that cannot start
    if (!isDue(sched, now)) continue;
    const recurring = !isOneTime(sched);
    const recovering = needsRecovery(sched);
    const minuteMs = Math.floor(now.getTime() / 60_000) * 60_000;
    if (!recovering) {
      if (firedThisMinute.get(sched.id) === minuteMs) continue;
      if (!sched.lastCronFireMs && sched.lastFireMinute === mk) continue;
      if (recurring) {
        // Minute precision preserves existing cron semantics for newly created schedules in
        // the current minute, while preventing startup catch-up before creation/re-enable.
        const eligible = Date.parse(sched.cronEligibleSince || sched.createdAt);
        if (Number.isFinite(eligible) && minuteMs < Math.floor(eligible / 60_000) * 60_000) continue;
        if (Number(sched.lastCronFireMs || 0) >= minuteMs) continue;
        // Upgrade bridge: older daemons wrote lastRun but had no epoch claim. Conservatively
        // exclude already executed minutes before enabling bounded startup catch-up.
        if (!sched.lastCronFireMs && Date.parse(sched.lastRun) >= minuteMs) continue;
      }
    }
    // Fan-out ceiling: if too many schedules are already executing, leave the rest for the next
    // tick rather than stampeding the host.
    if (running.size >= MAX_CONCURRENT_SCHED) {
      logEvent("schedule_deferred", { id: sched.id, reason: `concurrency cap ${MAX_CONCURRENT_SCHED}` });
      deferred = true;
      break;
    }
    if (recurring && !recovering) {
      // No connected transport means no attempt: leave the cursor behind this minute so a
      // brief outage recovers it within the same bounded catch-up window.
      if (!automationTarget(slackRef, sched.channelId)) {
        deferred = true;
        continue;
      }
      const claimed = claimScheduleMinute(sched.id, minuteMs, mk, sched);
      if (!claimed) { deferred = true; continue; }
      Object.assign(sched, claimed);
    } else if (!recovering) {
      updateSchedule(sched.id, { lastFireMinute: mk });
    }
    firedThisMinute.set(sched.id, minuteMs);
    // A schedule can start only once per tick. A catch-up snapshot must not pretend a busy
    // run started again, overwrite its checkpoint, or consume another cron minute's claim.
    firedOnce.add(sched.id);
    if (isOneTime(sched)) {
      updateSchedule(sched.id, { running: true, runningSince: new Date().toISOString() });
    }
    started.push(runSchedule(sched, runOptions));
  }
  return { deferred, started };
}

let lastTickMs = null; // when the previous tick ran — lets a late tick catch up skipped minutes

// Run one scheduler tick. Returns a promise that settles when every schedule this tick started has
// finished (used by tests; the interval ignores it).
export function tick(nowMs = Date.now(), runOptions = {}) {
  // Evaluate every minute elapsed since the last tick, not just "now": setInterval drifts, and a
  // tick pair at 08:59:58 / 09:01:02 would otherwise never test 09:00, silently skipping a
  // "0 9 * * *" cron for the whole day. elapsedMinutes caps the catch-up window (5 min) so a long
  // sleep doesn't replay hours of crons, and firedThisMinute guards double-fires per minute key.
  if (lastTickMs === null) {
    const saved = getSchedulerCursor();
    // First upgraded boot has no cursor; consider only the same five-minute bounded window.
    lastTickMs = saved > 0 ? Math.min(saved, nowMs) - 60_000 : nowMs - 5 * 60_000;
  }
  const scheds = getSchedules(); // one table read per tick, shared across caught-up minutes
  const firedOnce = new Set();
  const started = [];
  let nextTickFrom = nowMs;
  for (const minuteMs of elapsedMinutes(lastTickMs, nowMs)) {
    const outcome = runDueForMinute(nowMs - minuteMs < 60_000 ? new Date(nowMs) : new Date(minuteMs), scheds, firedOnce, runOptions);
    started.push(...outcome.started);
    if (outcome.deferred) {
      // The cap left due schedules unprocessed in THIS minute. Advancing lastTickMs past it would
      // retire the minute unevaluated — and a cron that matches only that minute (say "0 9 * * *")
      // is then lost for the whole day. Rewind the watermark into the previous minute so the next
      // tick re-evaluates this one (and every later minute) from scratch; firedThisMinute keeps
      // the schedules that DID start from firing twice.
      nextTickFrom = minuteMs - 60_000;
      break;
    }
  }
  saveSchedulerCursor(nextTickFrom);
  lastTickMs = nextTickFrom;
  // Drive any due reminder-acknowledgment escalations (independent of schedule firing).
  processAcks(new Date(nowMs));
  // prune old minute markers
  if (firedThisMinute.size > 500) firedThisMinute.clear();
  return Promise.allSettled(started);
}

// Reset the module's tick bookkeeping (tests only — the daemon has exactly one scheduler).
export function resetSchedulerState() {
  lastTickMs = null;
  firedThisMinute.clear();
  running.clear();
}

// Start immediately after restart recovery, rather than waiting another minute. Catch-up reads
// the durable cursor, and claims are saved before any reminder post or task execution begins.
// `immediate:false` lets deterministic tests supply their own clock through tick().
export function startScheduler({ slack, immediate = true } = {}) {
  slackRef = slack;
  const runTick = async () => {
    try { await tick(); }
    catch (error) { console.error("[scheduler] tick failed:", error.message); }
  };
  const timer = setInterval(runTick, 60_000);
  timer.unref?.();
  if (immediate) runTick();
  console.log("[scheduler] cron loop started (checks every minute)");
  return timer;
}
