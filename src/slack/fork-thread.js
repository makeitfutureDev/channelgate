import { indexSlackFork } from "../gateway/slack-threads.js";
import { setThreadEngine, setThreadModel, setThreadEffort, setThreadClean } from "../gateway/thread-engine.js";
import { renameAgentSession } from "./agent-sessions.js";
import { pendingForkThreads } from "./fork-state.js";

export async function forkPermalink(client, channel, ts) {
  try {
    const result = await client.chat.getPermalink({ channel, message_ts: ts });
    if (result?.permalink) return result.permalink;
  } catch { /* fallback is a valid Slack archive URL */ }
  return `https://slack.com/archives/${channel}/p${String(ts).replace(".", "")}`;
}

// Both fork entry points use the same root, Activity ownership, settings and backlink setup.
// onCreated journals the remote root BEFORE any later step can fail; never retry an uncertain POST.
export async function createForkThread(client, { channelId, slug, sourceThreadTs, authorId, botUserId, title, activityTitle,
  sourceUrl, handoffNote = "", engine, model, effort, clean, onCreated = async () => {} }) {
  const root = await client.chat.postMessage({ channel: channelId, text: `↪️ <@${authorId}> Fork: ${title}`, unfurl_links: false, unfurl_media: false });
  if (!root?.ts) throw new Error("Slack did not return a thread timestamp for the fork; creation is uncertain. Do not retry automatically.");
  const forkKey = String(root.ts), pendingKey = `${slug}::${forkKey}`;
  await onCreated(forkKey);
  if (!indexSlackFork({ channelId, slug, threadTs: forkKey, sourceThreadTs, creatorId: authorId, botUserId, title: activityTitle })) throw new Error("Could not record the fork's Activity ownership.");
  void renameAgentSession(client, { channel: channelId, threadTs: forkKey, title: activityTitle }).catch(() => {});
  pendingForkThreads.add(pendingKey);
  try {
    await setThreadEngine(slug, forkKey, engine);
    await setThreadModel(slug, forkKey, model);
    await setThreadEffort(slug, forkKey, effort);
    await setThreadClean(slug, forkKey, clean);
    const request = await client.chat.postMessage({ channel: channelId, thread_ts: forkKey, text: `↪️ Fork of <${sourceUrl}|this thread>${handoffNote}`, unfurl_links: false, unfurl_media: false });
    if (!request?.ts) throw new Error("Slack did not return a message timestamp for the fork request.");
    return { forkKey, requestTs: String(request.ts) };
  } catch (error) {
    pendingForkThreads.delete(pendingKey);
    throw error;
  }
}
