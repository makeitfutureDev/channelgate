import { randomUUID } from "node:crypto";
import { getUser } from "../config/store.js";
import { threadForkTarget } from "../gateway/thread-fork-approvals.js";
import { transitionApprovalRequest } from "../gateway/approval-requests.js";
import { ForkBatch } from "../gateway/fork-batch.ts";
import { resolveForkSettings } from "../gateway/fork-settings.ts";
import { abortPooled } from "../engines/session-pool.js";
import { assertEngineSelectable } from "../engines/selection.js";
import { isForceStopping } from "../gateway/shutdown.js";
import { runQueue } from "./message-lifecycle.js";
import { pendingForkThreads, pendingForkSources } from "./fork-state.js";
import { createForkThread, forkPermalink } from "./fork-thread.js";

const plain = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

// Runs only from the durable approval executor. Queueing here cannot deadlock the proposing
// engine: its MCP call has already returned pending. The approval CAS owns this batch once.
export async function runThreadForkBatch(record, { slack, process, create = createForkThread } = {}) {
  const snapshot = slack?.snapshot?.();
  const client = snapshot?.connected ? slack.getClient?.() : null;
  if (!client) throw new Error("Slack is not connected.");
  const action = record.action, { channelId, slug, threadKey, authorId } = action;
  const sourceRunKey = `${slug}::${threadKey}`;
  const handle = { aborted: false, controller: new AbortController(), authorId, runId: `fork-batch-${record.id}-${randomUUID()}` };
  const batch = new ForkBatch(action.forks, rows => {
    // The durable Slack approval format calls the root timestamp threadTs.
    const journal = rows.map(({ threadKey, ...row }) => threadKey ? { ...row, threadTs: threadKey } : row);
    if (!transitionApprovalRequest(record.id, "executing", "executing", { forks: journal })) throw new Error("The fork batch is no longer executing.");
  });
  const rows = batch.rows;
  const post = text => client.chat.postMessage({ channel: channelId, thread_ts: threadKey, text, unfurl_links: false, unfurl_media: false });
  let guard = false;
  try {
    // Reserve synchronously before the first await so later source turns cannot overtake us.
    const acquired = runQueue.acquire(sourceRunKey, handle).then(() => null, error => error);
    await post(`⏳ Approved ${rows.length} forks. Waiting for the source turn to finish before copying its context.`).catch(() => {});
    const queueError = await acquired;
    if (queueError) throw queueError;
    if (handle.aborted || isForceStopping()) throw new Error("The fork batch was stopped before creation.");
    const target = await threadForkTarget(action); // current access, lane, session and cwd
    await assertEngineSelectable(target.sourceEngine, { channelId, meta: target.meta });
    pendingForkSources.add(sourceRunKey);
    guard = true;
    abortPooled(sourceRunKey);
    const settings = await resolveForkSettings({ slug, threadKey, engine: target.sourceEngine, meta: target.meta });
    const sourceUrl = await forkPermalink(client, channelId, threadKey);
    const cutoff = Date.now() / 1000;
    const creator = (await getUser(authorId))?.name || authorId;
    const run = process || (await import("./message-pipeline.js")).processMessageEvent;
    await batch.start({
      stopped: () => handle.aborted || isForceStopping(),
      authorize: () => threadForkTarget(action),
      create: async (fork, { row, created, startTurn }) => {
        const child = await create(client, {
          channelId, slug, sourceThreadTs: threadKey, authorId, botUserId: snapshot.botUserId || "",
          title: plain(fork.title), activityTitle: `↪️ ${creator} Fork: ${fork.title}`.replace(/\s+/g, " ").slice(0, 160),
          sourceUrl, ...settings, onCreated: created,
        });
        row.url = await forkPermalink(client, channelId, child.forkKey);
        // Show the exact approved opening prompt in the child, separately from its compact title.
        await client.chat.postMessage({ channel: channelId, thread_ts: child.forkKey, text: plain(fork.prompt), unfurl_links: false, unfurl_media: false });
        startTurn(release => {
          const work = Promise.resolve().then(() => run({ type: "message", channel: channelId, channel_type: target.entry.isDM ? "im" : "channel", user: authorId,
            ts: child.requestTs, thread_ts: child.forkKey, text: fork.prompt, files: [] }, client, {
            botUserId: snapshot.botUserId || "", teamId: snapshot.teamId || "", bypassMention: true,
            syntheticFork: {
              sourceSessionId: target.sourceSessionId,
              // Do not let the first child release the batch's source guard. The barrier below
              // releases it only after EVERY child has copied the immutable source (or failed).
              sourceRunKey: "", onSourceForked: release,
              fallbackHistory: settings.clean ? null : { sourceThreadTs: threadKey, currentTs: String(cutoff), completedReplyCutoff: cutoff, sourceUrl, childEngine: target.sourceEngine },
            },
          }));
          void Promise.resolve(work).catch(async error => {
            await client.chat.postMessage({ channel: channelId, thread_ts: child.forkKey, text: `The fork's first response failed: ${plain(error.message)}` }).catch(() => {});
          }).finally(() => { pendingForkThreads.delete(`${slug}::${child.forkKey}`); release(); });
        });
      },
      failed: async row => {
        if (row.threadKey) {
          pendingForkThreads.delete(`${slug}::${row.threadKey}`);
          row.url ||= await forkPermalink(client, channelId, row.threadKey);
        }
      },
    });
    const created = rows.filter(row => row.threadKey).length;
    const message = `Created ${created}/${rows.length} forks:\n` + rows.map((row, i) =>
      `${i + 1}. ${row.url ? `<${row.url}|${plain(row.title)}>` : plain(row.title)} — ${row.error ? plain(row.error) : row.status === "starting" ? "first response requested" : row.status}`).join("\n");
    const indexPosted = await post(message).then(() => true, () => false);
    // Wait only for native snapshot acceptance, not for child answers. All children run through
    // the ordinary pipeline's admission, license and concurrency gates and durable active_runs.
    if (!created) return { ok: false, error: `No forks were confirmed created. See the per-topic results in this thread. ${rows.find(row => row.error)?.error || "The batch was cancelled."}` };
    const failed = rows.filter(row => row.error || row.status === "cancelled").length;
    return { ok: true, completed: true, label: "thread forks", message: `Created ${created}/${rows.length} forks.${failed ? ` ${failed} topic(s) need attention.` : ""} ${indexPosted ? "The index and per-topic results are in this thread." : `The index could not be posted. Created threads: ${rows.filter(row => row.url).map(row => row.url).join(", ")}`}` };
  } finally {
    await batch.waitForCopies();
    if (guard) pendingForkSources.delete(sourceRunKey);
    runQueue.release(sourceRunKey, handle);
  }
}
