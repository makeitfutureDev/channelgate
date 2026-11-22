// Which surface creates an approved thread-fork batch. A surface whose transport implements
// `runThreadForks` on its live connector (Google Chat) creates the threads itself; Slack keeps its
// own Bolt batch runner. A surface whose transport is down refuses instead of guessing.
import { platformOfConversation } from "./ids.js";
import { DEFAULT_PLATFORM, platformOr, platformSupports } from "./registry.js";
import { liveConnector } from "./live.js";

export async function runApprovedThreadForks(record, { runSlack } = {}) {
  const platform = platformOfConversation(record?.action?.channelId || record?.channelId);
  const adapter = platformOr(platform);
  if (!platformSupports(platform, "threadForks")) throw new Error(`Thread forks are not available on ${adapter.label}.`);
  if (platform === DEFAULT_PLATFORM) return runSlack(record);
  const connector = liveConnector(platform);
  if (typeof connector?.runThreadForks !== "function") throw new Error(`${adapter.label} is not connected, so the approved forks were not created. Ask again once it is connected.`);
  return connector.runThreadForks(record);
}
