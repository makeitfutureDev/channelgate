import type { runQueue } from "../thread-turn-owner.ts";
import { finishActiveRun } from "../active-runs.js";
import { getDb } from "../../db/index.js";
import { getChannelEntry } from "../../config/store.js";
import { accessContext } from "../../slack/home-threads.js";

type VoiceRequest = {
  id: string; channelId: string; threadKey: string; authorId: string; slug: string;
  workspaceId: string; botUserId?: string; isDM: boolean; text: string;
};

// An accepted voice request outlives the provider connection. INSERT-only keeps a duplicate
// callback from resetting the execution checkpoint on an already-running request.
export function saveVoiceRequest(request: VoiceRequest) {
  getDb().prepare("INSERT INTO active_runs(id,data) VALUES(?,?)").run(request.id, JSON.stringify({
    ...request, startedAt: new Date().toISOString(), origin: "voice_call", slackThreadTs: request.threadKey,
    voiceExecutionStarted: false,
  }));
}

export function beginVoiceExecution(id: string) {
  return getDb().prepare(`UPDATE active_runs SET data=json_set(data,'$.voiceExecutionStarted',json('true'))
    WHERE id=? AND json_extract(data,'$.origin')='voice_call' AND json_extract(data,'$.voiceExecutionStarted')=0`)
    .run(id).changes === 1;
}

export async function canResumeVoice(client: Parameters<typeof accessContext>[0], rec: Pick<VoiceRequest, "channelId" | "authorId" | "slug" | "threadKey">) {
  const entry = await getChannelEntry(rec.channelId);
  const access = await accessContext(client, rec.authorId);
  if (entry?.slug !== rec.slug || (!access.user.approved && !access.user.isAdmin)) return false;
  const allowed = await access.allows({ ...entry, channelId: rec.channelId }, rec.threadKey);
  if (access.unavailable) throw new Error("Slack membership verification is temporarily unavailable.");
  return allowed;
}

// Admission is synchronous through the durable write and queue claim. A voice callback can
// be acknowledged immediately afterwards, even if a previous request occupies the thread.
export function reserveVoiceTurn(queue: typeof runQueue, request: VoiceRequest) {
  const key = request.slug + "::" + request.threadKey;
  const handle = { aborted: false, controller: new AbortController(), authorId: request.authorId,
    runId: request.id, origin: "voice_call", channelId: request.channelId, threadKey: request.threadKey,
    durable: true, voice: true };
  saveVoiceRequest(request);
  const acquired = queue.acquire(key, handle);
  if (!queue.hasRun(key, request.id)) {
    finishActiveRun(request.id);
    return { accepted: false as const, acquired };
  }
  return { accepted: true as const, handle, key, acquired };
}
