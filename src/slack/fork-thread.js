import { indexSlackFork } from "../gateway/slack-threads.js";
import { setThreadEngine, getThreadEngine, getThreadLicensePool, setThreadModel, setThreadEffort, setThreadClean } from "../gateway/thread-engine.js";
import { harnessSelection, readLicensePool, LICENSE_POOL_ANY } from "../gateway/license-pool.js";
import { effectiveMeta } from "../gateway/effective-meta.js";
import { harnessOf, isEngineId } from "../engines/registry.js";
import { renameAgentSession } from "./agent-sessions.js";
import { pendingForkThreads } from "./fork-state.js";

export async function forkPermalink(client, channel, ts) {
  try {
    const result = await client.chat.getPermalink({ channel, message_ts: ts });
    if (result?.permalink) return result.permalink;
  } catch { /* fallback is a valid Slack archive URL */ }
  return `https://slack.com/archives/${channel}/p${String(ts).replace(".", "")}`;
}

// The rest of a fork's license selection. A fork is pinned to the license its source session runs
// on, and the licenses the source may move to when that one fails travel with it: the source
// thread's own pool when the thread is pinned, else the conversation's selection for that harness.
// The session may already sit on a later license of the selection — then the fork starts there and
// keeps the others. A license outside the selection (a model shortcut named it) carries nothing.
export async function forkLicensePool({ slug, sourceThreadTs, engine, meta = {} }) {
  const harness = harnessOf(engine);
  if (!harness || !isEngineId(engine)) return "";
  const pinned = await getThreadEngine(slug, sourceThreadTs);
  const source = pinned
    ? { engine: pinned, licensePool: await getThreadLicensePool(slug, sourceThreadTs) }
    : harnessSelection(harness, effectiveMeta(meta));
  if (harnessOf(source.engine) !== harness) return "";
  const pool = readLicensePool(source.licensePool);
  if (pool === LICENSE_POOL_ANY) return LICENSE_POOL_ANY;
  const selection = [source.engine, ...(Array.isArray(pool) ? pool : [])];
  if (!selection.includes(engine)) return "";
  const rest = [...new Set(selection)].filter((id) => id !== engine && isEngineId(id) && harnessOf(id) === harness);
  return rest.length ? rest : "";
}

// Both fork entry points use the same root, Activity ownership, settings and backlink setup.
// onCreated journals the remote root BEFORE any later step can fail; never retry an uncertain POST.
// `licensePool` is the rest of the source's license selection ("" | "any" | [ids]): a fork keeps
// moving between the same licenses its source could (forkLicensePool below).
export async function createForkThread(client, { channelId, slug, sourceThreadTs, authorId, botUserId, title, activityTitle,
  sourceUrl, handoffNote = "", engine, licensePool = "", model, effort, clean, onCreated = async () => {} }) {
  const root = await client.chat.postMessage({ channel: channelId, text: `↪️ <@${authorId}> Fork: ${title}`, unfurl_links: false, unfurl_media: false });
  if (!root?.ts) throw new Error("Slack did not return a thread timestamp for the fork; creation is uncertain. Do not retry automatically.");
  const forkKey = String(root.ts), pendingKey = `${slug}::${forkKey}`;
  await onCreated(forkKey);
  if (!indexSlackFork({ channelId, slug, threadTs: forkKey, sourceThreadTs, creatorId: authorId, botUserId, title: activityTitle })) throw new Error("Could not record the fork's Activity ownership.");
  void renameAgentSession(client, { channel: channelId, threadTs: forkKey, title: activityTitle }).catch(() => {});
  pendingForkThreads.add(pendingKey);
  try {
    await setThreadEngine(slug, forkKey, engine, { licensePool });
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
