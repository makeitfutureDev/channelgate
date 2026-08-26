// Restart recovery for interactive Slack turns. Engine subprocesses run in detached process groups
// so stop/restart can kill their MCP grandchildren too; controlled daemon shutdown explicitly
// terminates those groups before launchd/systemd relaunches the gateway. The answer only ever lives
// in an in-memory Promise, so a restart can otherwise leave the thread stuck on a "Working…"
// placeholder with no follow-up. This module makes turns durable the same way background.js makes
// shell jobs durable: while a turn runs we persist a row in `active_runs` (written at start, deleted
// in the run's finally unless the daemon is shutting down). Rows marked `awaitingChoice` are durable
// busy-thread cards and remain pending across boot; every other row still present at boot was
// interrupted, so startup auto-re-runs it, resuming the same thread/session when possible and posting
// the answer into the thread. The user asked for auto re-run, so that's the policy.
import { getDb, toJson, fromJson } from "../db/index.js";
import { EventEmitter } from "node:events";
import { logEvent } from "../util/logger.js";
import { engineLabel, isEngineId } from "../engines/registry.js";
import { runMessage, isEmptyResult } from "./run.js";
import { deliverResult } from "../slack/deliver.js";
import { startProgress } from "../slack/progress.js";
import { getDirectory } from "../slack/directory.js";
import { recordUsage, createUsageBank } from "./usage.js";
import { maybeDiagnoseRunError } from "./diagnosis.js";
import { modelLabel } from "./model-info.js";
import { runQueue } from "../slack/message-lifecycle.js";
import { isForceStopping } from "./shutdown.js";
import { postNotice } from "../platforms/notify.js";


// In-process change signal for the admin dashboard's SSE feed. The database remains the source of
// truth; listeners only use this as an invalidation hint and re-read the complete snapshot. Disable
// the default listener warning because several open admin tabs are legitimate subscribers.
const changes = new EventEmitter();
changes.setMaxListeners(0);

export function onActiveRunsChanged(listener) {
  changes.on("change", listener);
  return () => changes.off("change", listener);
}

export function shouldClearActiveRun({ terminal = false, forceStopping = isForceStopping() } = {}) {
  return Boolean(terminal) || !forceStopping;
}

function announceChange() {
  changes.emit("change");
}

// Mark a turn as in-flight. Foreground Slack ids include the message timestamp after the
// `<slug>::<threadKey>` queue key, so the active turn and accepted turns queued behind it retain
// independent durable rows. `rec` carries
// everything needed to re-run identically: channelId, slug, authorId, threadKey, text (the exact
// prompt built for the run, incl. provenance/thread-context/attachment notes), attachments,
// startedAt. Best-effort — persistence must never break a live run.
export function recordActiveRun(id, rec) {
  try {
    getDb()
      .prepare("INSERT INTO active_runs(id, data) VALUES(?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data")
      .run(id, toJson({ id, ...rec }));
    announceChange();
  } catch {
    /* best-effort */
  }
}

// Enrich an already-persisted turn once runMessage has resolved the runtime that will actually
// spawn. Merge instead of replacing so restart recovery keeps the original prompt/attachments.
// Called again if Claude falls back to Codex, keeping the dashboard truthful mid-turn.
export function updateActiveRunRuntime(id, { engine = "", model = "" } = {}) {
  try {
    const row = getDb().prepare("SELECT data FROM active_runs WHERE id = ?").get(id);
    const rec = row ? fromJson(row.data, null) : null;
    if (!rec) return false;
    recordActiveRun(id, { ...rec, engine, model });
    return true;
  } catch {
    return false;
  }
}

// Clear the in-flight marker when a turn finishes (success, error, or user-stop). Called from the
// run's finally, so a normally-completed turn leaves no row → it is never re-run.
export function clearActiveRun(id) {
  try {
    const result = getDb().prepare("DELETE FROM active_runs WHERE id = ?").run(id);
    if (result.changes) announceChange();
  } catch {
    /* best-effort */
  }
}

// Busy-thread messages waiting for a Slack steer/queue click use the same durable table as active
// turns, distinguished by `awaitingChoice`. Keeping the pending row here lets one atomic
// transaction replace it with the accepted active-run row, so there is no restart loss window
// between a button click and queue ownership.
export function recordPendingRunChoice(id, rec) {
  try {
    getDb()
      .prepare("INSERT INTO active_runs(id, data) VALUES(?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data")
      .run(id, toJson({ id, ...rec, awaitingChoice: true }));
    announceChange();
    return true;
  } catch {
    return false;
  }
}

export function getPendingRunChoice(id) {
  try {
    const row = getDb().prepare("SELECT data FROM active_runs WHERE id = ?").get(id);
    const rec = row ? fromJson(row.data, null) : null;
    return rec?.awaitingChoice ? rec : null;
  } catch {
    return null;
  }
}

export function listPendingRunChoices() {
  try {
    return getDb()
      .prepare("SELECT data FROM active_runs ORDER BY rowid")
      .all()
      .map((row) => fromJson(row.data, null))
      .filter((rec) => rec?.awaitingChoice);
  } catch {
    return [];
  }
}

export function clearPendingRunChoice(id) {
  const rec = getPendingRunChoice(id);
  if (!rec) return false;
  clearActiveRun(id);
  return true;
}

export function clearPendingRunChoices({ channelId = "", threadKey = null } = {}) {
  const matches = listPendingRunChoices().filter((rec) =>
    (!channelId || rec.channelId === channelId) && (threadKey == null || rec.threadKey === threadKey));
  for (const rec of matches) clearActiveRun(rec.id);
  return matches;
}

export function acceptPendingRunChoice(choiceId, runId, rec) {
  const db = getDb();
  try {
    db.exec("BEGIN IMMEDIATE");
    const row = db.prepare("SELECT data FROM active_runs WHERE id = ?").get(choiceId);
    const pending = row ? fromJson(row.data, null) : null;
    if (!pending?.awaitingChoice) {
      db.exec("ROLLBACK");
      return false;
    }
    db.prepare("DELETE FROM active_runs WHERE id = ?").run(choiceId);
    db.prepare("INSERT INTO active_runs(id, data) VALUES(?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data")
      .run(runId, toJson({ id: runId, ...rec }));
    db.exec("COMMIT");
    announceChange();
    return true;
  } catch {
    try { db.exec("ROLLBACK"); } catch { /* transaction never opened or already ended */ }
    return false;
  }
}

// A user stop can cover the active turn plus every accepted turn queued behind it. Clear their
// durable rows synchronously before the Slack acknowledgement is posted; owners may still unwind
// asynchronously, but a concurrent process exit must never replay work the user already stopped.
export function clearActiveRunHandles(handles = []) {
  let cleared = 0;
  for (const handle of handles) {
    if (!handle?.runId) continue;
    clearActiveRun(handle.runId);
    cleared++;
  }
  return cleared;
}

// Snapshot the currently in-flight turns (for the admin dashboard's "Active sessions" KPI). During
// normal operation every row here is a turn being processed right now — recordActiveRun wrote it at
// start and the run's finally deletes it. Read-only; never mutates. Best-effort (returns [] if the
// DB is momentarily unreadable). The caller resolves channel/author names + drops the prompt text.
// `recoveryPending` rows are excluded too: takeStaleRuns stamps them at boot and they survive
// across boots whenever Slack is unreachable, so an unfiltered read reported turns from a daemon
// that died days ago as "running right now", forever. recoverRuns un-stamps a row the moment it
// actually replays it.
export function listActiveRuns() {
  try {
    return getDb()
      .prepare("SELECT data FROM active_runs ORDER BY rowid")
      .all()
      .map((r) => fromJson(r.data, null))
      .filter((rec) => rec && !rec.awaitingChoice && !rec.recoveryPending);
  } catch {
    return [];
  }
}

// Safe API projection for the admin dashboard. In particular, never return the persisted prompt or
// attachments. A DM's channel index often carries its internal `dm-U…` slug as the name, so use the
// known peer/author's display name instead.
export function activeRunForApi(run, { channels = {}, users = {} } = {}) {
  const channel = channels[run.channelId] || {};
  const authorName = users[run.authorId]?.name || run.authorId || "";
  const slug = run.slug || channel.slug || "";
  const isDm = Boolean(channel.isDM || channel.type === "im" || /^dm-/i.test(slug));
  const storedChannelName = channel.name || slug || run.channelId || "";
  const channelName = isDm && authorName && authorName !== run.authorId ? `${authorName} (DM)` : storedChannelName;
  const engine = isEngineId(run.engine) ? run.engine : "";
  const model = typeof run.model === "string" ? run.model : "";
  return {
    id: run.id,
    channelId: run.channelId,
    slug,
    channelName,
    authorId: run.authorId,
    authorName,
    engine,
    engineName: engine ? engineLabel(engine) : "",
    model,
    modelName: engine ? (model ? modelLabel({ engine, model }) : "CLI default") : "",
    startedAt: run.startedAt || null,
    attempts: run.attempts || 0,
  };
}

// Snapshot every interrupted run at boot while retaining `awaitingChoice` rows. Call this ONCE at
// boot, BEFORE Slack (re)connects — the snapshot is what recoverRuns replays, so fresh messages
// arriving after connect (their ids carry the new message ts) are never mistaken for stale turns.
// Rows are NOT deleted here: deletion happens only at a terminal delivery boundary (the replay
// delivered/failed visibly, was explicitly stopped, or exhausted its attempt cap). If Slack is
// unreachable at recovery, the rows simply survive for the next boot instead of being lost.
// recoverRuns persists the bumped per-row attempt counter before each replay — that's the durable
// per-row claim that keeps a crash mid-replay from re-running the same turn forever.
// Only rows that can never replay (corrupt JSON, no channel/thread) are dropped here: that IS
// their terminal state. Pending cards remain clickable.
export function takeStaleRuns() {
  const db = getDb();
  try {
    const rows = db.prepare("SELECT id, data FROM active_runs ORDER BY rowid").all()
      .map((row) => ({ id: row.id, rec: fromJson(row.data, null) }));
    const del = db.prepare("DELETE FROM active_runs WHERE id = ?");
    const stamp = db.prepare("UPDATE active_runs SET data = ? WHERE id = ?");
    const stale = [];
    let dropped = 0;
    for (const { id, rec } of rows) {
      if (rec?.awaitingChoice) continue;
      if (!rec?.channelId || !rec?.threadKey) {
        del.run(id); // unreplayable — keeping it would only leak rows
        dropped++;
        continue;
      }
      const snapshot = { ...rec, id: rec.id || id };
      // Mark the surviving row as "waiting to be replayed", not "running". Since rows are no longer
      // deleted here, a boot with Slack down leaves them in place indefinitely — and the dashboard
      // read (listActiveRuns) would otherwise count those ghosts as live sessions forever.
      try {
        stamp.run(toJson({ ...snapshot, recoveryPending: true }), id);
      } catch {
        /* best-effort — the replay below is what actually matters */
      }
      stale.push(snapshot);
    }
    if (dropped || stale.length) announceChange();
    return stale;
  } catch {
    return []; // DB unreadable — nothing to recover
  }
}

// How many boot-recovery attempts one turn gets before we give up loudly. Attempt-capped
// re-tracking replaced the old "never re-track replays" policy: that policy silently LOST a turn
// whenever a restart interrupted the replay itself (the next boot had no row for it). The cap
// keeps the original crash-loop protection: a turn that keeps killing the daemon stops after
// MAX_RECOVER_ATTEMPTS boots instead of looping forever.
const MAX_RECOVER_ATTEMPTS = 2;

// Auto re-run the interrupted turns captured by takeStaleRuns(). Runs sequentially so a restart
// with several interrupted threads doesn't spawn a burst of `claude` processes at once. Each turn
// re-runs as its original author (so their mode/tokens/permissions apply unchanged) and posts the
// answer back into the same thread. Best-effort throughout — one failed turn never blocks the rest.
export async function recoverRuns(stale, {
  slack,
  runner = runMessage,
  deliver = deliverResult,
  usageRecorder = recordUsage,
  progressFactory = startProgress,
  directoryResolver = getDirectory,
  forceStopping = isForceStopping,
} = {}) {
  if (!stale?.length) return;
  const client = slack?.snapshot?.().connected ? slack.getClient?.() ?? null : null;
  if (!client) {
    // No Slack client → we can't deliver the answer, so re-running would just burn a turn silently.
    // The durable rows stay untouched (takeStaleRuns no longer deletes), so the next boot retries.
    await logEvent("run_recover_skip", { count: stale.length, reason: "slack not connected" });
    return;
  }
  await logEvent("run_recover_begin", { count: stale.length });
  for (const rec of stale) {
    if (rec?.awaitingChoice) continue;
    if (!rec?.channelId || !rec?.threadKey) continue;
    const id = rec.id || `${rec.slug}::${rec.threadKey}`;
    const runKey = `${rec.slug || rec.channelId}::${rec.threadKey}`;
    // Slack reconnects BEFORE this runs (it needs a client to deliver), so a redelivered copy of
    // this same message can beat recovery into the queue. Run ids encode the triggering message,
    // so a live turn under this id IS this turn — replaying it would answer twice. The live run
    // owns the row and clears it when it finishes.
    if (runQueue.hasRun(runKey, id)) {
      await logEvent("run_recover_skip", { slug: rec.slug, channel: rec.channelId, threadKey: rec.threadKey, reason: "already live" });
      continue;
    }
    const attempts = (rec.attempts || 0) + 1;
    if (attempts > MAX_RECOVER_ATTEMPTS) {
      // The attempt cap is this turn's explicit terminal failure — only now is its row deleted.
      clearActiveRun(id);
      await logEvent("run_recover_giveup", { slug: rec.slug, channel: rec.channelId, threadKey: rec.threadKey, attempts });
      try {
        await postNotice(client, {
          conversationId: rec.channelId,
          threadKey: rec.threadKey,
          text: "⚠️ I was interrupted repeatedly while working on your last message and have stopped retrying — please resend it (or `continue`) when you're ready.",
        });
      } catch {
        /* ignore */
      }
      continue;
    }
    await logEvent("run_recover", { slug: rec.slug, channel: rec.channelId, threadKey: rec.threadKey, attempts });
    // Heads-up so the dangling "Working…" placeholder above it is explained and the thread shows
    // the turn is being picked up again before the (possibly slow) re-run finishes.
    try {
      await postNotice(client, {
        conversationId: rec.channelId,
        threadKey: rec.threadKey,
        text: "🔁 I was interrupted by a gateway restart while working on your last message — picking it back up now…",
      });
    } catch {
      /* non-fatal */
    }
    // Re-track the replay with the bumped attempt counter, so a restart landing mid-replay
    // retries on the next boot (up to the cap) instead of silently dropping the turn.
    // …and drop the boot stamp: from here on this row IS a live run again.
    recordActiveRun(id, { ...rec, id, attempts, recoveryPending: undefined });
    const handle = { aborted: false, controller: new AbortController(), authorId: rec.authorId, recovery: true, runId: id };
    // Start native progress without delaying recovery on directory hydration. The mutable object is
    // shared with the formatter, so later name resolution applies to subsequent streamed deltas.
    const liveDirectory = { map: new Map(), maxWords: 5 };
    let status = null;
    let statusClosed = false;
    const stopStatus = async () => {
      if (!status || statusClosed) return;
      statusClosed = true;
      await Promise.resolve(status.stop?.()).catch(() => {});
    };
    let terminal = false;
    // Set when this replay produced NOTHING the user can see (neither the answer nor the failure
    // notice reached Slack). The row must then outlive the run — the finally below clears it
    // otherwise, and the turn would be lost with no trace.
    let keepRow = false;
    const markTerminal = () => {
      terminal = true;
      clearActiveRun(id);
    };
    // Idempotent, pre-delivery accounting for this replay (see createUsageBank).
    const bankUsage = createUsageBank(usageRecorder);
    try {
      // Recovery used to bypass the Slack pipeline's per-thread queue. Once Socket Mode reconnected,
      // a live message could therefore race this replay into the same session and replace its warm
      // process. Use the exact same queue key/ownership contract as foreground Slack turns.
      await runQueue.acquire(runKey, handle);
      if (handle.aborted) {
        markTerminal();
        continue;
      }
      if (forceStopping()) continue;
      // A recovered turn is still an interactive Slack turn. Reconnect it to the same two native
      // surfaces as a foreground run whenever the Slack SDK supports native streaming. Older SDKs
      // and test clients retain the safe final-only delivery path instead of losing the recovery.
      if (typeof client.chatStream === "function" && typeof client.apiCall === "function") {
        Promise.resolve()
          .then(() => directoryResolver(client))
          .then((directory) => {
            if (!directory?.map) return;
            liveDirectory.map = directory.map;
            liveDirectory.maxWords = Math.max(1, Math.min(5, Number(directory.maxWords) || 1));
          })
          .catch(() => {});
        try {
          status = progressFactory?.("stream", client, rec.channelId, rec.threadKey, {
            authorId: rec.authorId,
            teamId: rec.workspaceId || process.env.CG_SLACK_TEAM_ID || "",
            isDM: rec.isDM ?? String(rec.channelId).startsWith("D"),
            dir: liveDirectory,
          }) || null;
        } catch (error) {
          await logEvent("run_recover_progress_unavailable", { slug: rec.slug, error: error.message }).catch(() => {});
          status = null;
        }
      }
      const result = await runner({
        channelId: rec.channelId,
        authorId: rec.authorId,
        workspaceId: rec.workspaceId || process.env.CG_SLACK_TEAM_ID || "",
        text: rec.text,
        threadKey: rec.threadKey,
        attachments: Array.isArray(rec.attachments) ? rec.attachments : [],
        origin: "recovery", // replayed after a restart with nobody watching — never escalates
        signal: handle.controller.signal,
        onDelta: status?.onDelta,
        onEvent: status?.onEvent,
        // Match the live Slack launch fingerprint, including the progress-report MCP capability,
        // across the restart boundary.
        progressReport: true,
        onRuntimeResolved: (runtime) => {
          updateActiveRunRuntime(id, runtime);
          status?.onRuntimeResolved?.(runtime);
        },
      });
      // The engine already spent these tokens whether or not Slack ever accepts the answer, and
      // every branch below (steered handoff, empty-result failure, delivery) is downstream of that
      // spend — so bank the accounting here, once, before any of them.
      await bankUsage({ channelId: rec.channelId, slug: rec.slug, authorId: rec.authorId, engine: result.engine, taskKind: "interactive", result });
      if (handle.steered && (result.interrupted || isEmptyResult(result))) {
        // Warm Claude recovery was intentionally interrupted by an explicit steer choice. Keep
        // partial/empty output hidden; its usage is already banked above.
        markTerminal();
        await stopStatus();
        continue;
      }
      // Zero work (empty text, 0 tokens) = failure in disguise (usually a broken session state
      // after the kill) — route it through the failure path below, not a "(no output)" success.
      if (isEmptyResult(result)) throw new Error("resumed run returned an empty result (0 tokens — the session may be in a bad state)");
      // Native recovery progress owns the streamed answer and persistent toolbox. A client without
      // that capability keeps the old safe, chunked final-only delivery path.
      if (status?.ownsFinal) {
        await status.finalize(result);
        statusClosed = true;
      } else {
        await stopStatus();
        // Compatibility fallback for an injected/legacy non-owning progress surface.
        await deliver(client, { channel: rec.channelId, threadKey: rec.threadKey, result });
      }
      // Delivery is the user-visible terminal boundary. Clear the durable row even if shutdown
      // enters its forced phase while bookkeeping finishes, or boot would duplicate it.
      markTerminal();
    } catch (err) {
      await stopStatus();
      if (handle.steered && handle.controller.signal.aborted) {
        // A live message explicitly steered this recovered turn. Its successor owns the thread;
        // do not report the intentional process abort as a failed restart recovery.
        markTerminal();
        continue;
      }
      if (handle.aborted) {
        markTerminal(); // an explicit stop already told the thread; never replay it
        continue;
      }
      if (forceStopping()) continue; // final sweep interrupted us; keep the row for next boot
      await logEvent("run_recover_error", { slug: rec.slug, error: err.message });
      let told = false;
      try {
        await postNotice(client, {
          conversationId: rec.channelId,
          threadKey: rec.threadKey,
          text: `⚠️ I tried to resume your last message after a restart, but it failed: ${err.message}. Send it again and I'll retry.`,
        });
        told = true;
      } catch {
        /* ignore */
      }
      // Failed recoveries deserve the same self-diagnosis as failed interactive runs (the module
      // rate-limits and refuses recursion; fire-and-forget so recovery never stalls on it).
      maybeDiagnoseRunError({ client, err, channelId: rec.channelId, slug: rec.slug, threadKey: rec.threadKey, authorId: rec.authorId })
        .catch((e) => console.warn("[diagnosis] failed:", e.message));
      // "Terminal" means the USER saw something. Here the answer never landed (that's why we're in
      // the catch) — so if the failure notice ALSO failed to post, nothing visible happened and
      // deleting the row would silently drop the turn. Keep it; the attempt cap above is the
      // terminal bound, and the next boot retries.
      if (told) markTerminal();
      else keepRow = true;
    } finally {
      await stopStatus();
      runQueue.release(runKey, handle);
      if (!keepRow && shouldClearActiveRun({ terminal, forceStopping: forceStopping() })) clearActiveRun(id);
    }
  }
  await logEvent("run_recover_done", { count: stale.length });
}
