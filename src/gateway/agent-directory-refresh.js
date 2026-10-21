// Platform metadata is a cache for operator inspection, never an authorization source. Every
// recommendation obtains live metadata AND proves the whole response audience may see it.
import { getChannelsIndex } from "../config/store.js";
import { metaGet, metaSet } from "../db/index.js";
import { parseConversationId } from "../platforms/ids.js";
import { liveConnector } from "../platforms/live.js";
import { platformSupports } from "../platforms/registry.js";

export const AGENT_DIRECTORY_METADATA_KEY = "agent_directory_metadata_v1";
const MAX_CHANNELS = 10_000;
const MAX_MEMBERS = 10_000;
const bounded = (value, max) => typeof value === "string" ? value.slice(0, max) : "";

function descriptor(value, platform, verifiedAt) {
  if (!value || !["channel", "group", "im", "mpim"].includes(value.type)) return null;
  const purpose = bounded(value.purpose, 1000);
  const topic = bounded(value.topic, 1000);
  return {
    platform, name: bounded(value.name, 160), purpose, topic,
    description: [purpose, topic].filter(Boolean).join(" — ").slice(0, 2000),
    url: bounded(value.url, 1000), type: value.type,
    isDM: value.type === "im", isGroupDM: value.type === "mpim",
    private: value.type !== "channel", shared: value.shared === true, archived: value.archived === true,
    verifiedAt,
  };
}

export function readAgentDirectoryMetadata({ read = metaGet } = {}) {
  try {
    const raw = read(AGENT_DIRECTORY_METADATA_KEY);
    if (!raw || raw.length > 50_000_000) return {};
    const parsed = JSON.parse(raw);
    const out = {};
    for (const [id, value] of Object.entries(parsed.channels || {}).slice(0, MAX_CHANNELS)) {
      const clean = descriptor(value, bounded(value?.platform, 40), bounded(value?.verifiedAt, 40));
      if (clean && ["channel", "group"].includes(clean.type)) out[id] = clean;
    }
    return out;
  } catch { return {}; }
}

export async function reconcileAgentDirectory({
  listChannels = getChannelsIndex, connectorFor = liveConnector, now = Date.now,
  read = metaGet, write = metaSet, shouldStop = () => false,
} = {}) {
  const index = await listChannels();
  const previous = readAgentDirectoryMetadata({ read });
  const channels = {};
  const summary = { updated: 0, failed: 0, unsupported: 0, removed: 0 };
  const verifiedAt = new Date(now()).toISOString();
  const entries = Object.entries(index || {}).slice(0, MAX_CHANNELS);
  for (const [channelId] of entries) {
    if (shouldStop()) return { ...summary, cancelled: true };
    const { platform, id } = parseConversationId(channelId);
    const directory = platformSupports(platform, "agentDirectory") ? connectorFor(platform)?.agentDirectory : null;
    if (!directory?.describeConversation) {
      summary.unsupported += 1;
      if (previous[channelId]) channels[channelId] = previous[channelId];
      continue;
    }
    try {
      const clean = descriptor(await directory.describeConversation({ conversationId: id }), platform, verifiedAt);
      if (clean && ["channel", "group"].includes(clean.type)) { channels[channelId] = clean; summary.updated += 1; }
      else if (clean) { /* DMs and group DMs have no directory entry, even in the metadata cache. */ }
      else { summary.failed += 1; if (previous[channelId]) channels[channelId] = previous[channelId]; }
    } catch {
      summary.failed += 1;
      if (previous[channelId]) channels[channelId] = previous[channelId];
    }
  }
  if (shouldStop()) return { ...summary, cancelled: true };
  summary.removed = Object.keys(previous).filter((id) => !Object.hasOwn(index || {}, id)).length;
  write(AGENT_DIRECTORY_METADATA_KEY, JSON.stringify({ version: 1, updatedAt: verifiedAt, channels }));
  return summary;
}

const eligibleDestination = (value) => value && !value.archived && ["channel", "group"].includes(value.type);
function memberSet(value) {
  if (!Array.isArray(value) || !value.length || value.length > MAX_MEMBERS
      || value.some((id) => typeof id !== "string" || !id)) return null;
  return new Set(value);
}

// A requester's membership alone cannot authorize disclosing a private channel to everybody in
// the source conversation. Public destinations use the same conservative audience proof.
export async function prepareDirectoryVerifier({ createdBy, channelId }, {
  connectorFor = liveConnector, now = Date.now,
} = {}) {
  const deny = async () => null;
  if (!createdBy || !channelId) return deny;
  const source = parseConversationId(channelId);
  const directory = platformSupports(source.platform, "agentDirectory") ? connectorFor(source.platform)?.agentDirectory : null;
  if (!directory?.describeConversation || !directory?.conversationMembers) return deny;
  let sourceInfo, audience;
  try {
    sourceInfo = descriptor(await directory.describeConversation({ conversationId: source.id }), source.platform, new Date(now()).toISOString());
    audience = memberSet(await directory.conversationMembers({ conversationId: source.id }));
  } catch { return deny; }
  if (!sourceInfo || sourceInfo.archived || sourceInfo.isGroupDM || !audience?.has(createdBy)
      || (sourceInfo.isDM && audience.size !== 2)) return deny;
  return async (entry) => {
    const target = parseConversationId(entry?.channelId);
    if (!target.id || target.platform !== source.platform) return null;
    if (entry.channelId === channelId) return eligibleDestination(sourceInfo) ? { visible: true, ...sourceInfo } : null;
    try {
      const info = descriptor(await directory.describeConversation({ conversationId: target.id }), target.platform, new Date(now()).toISOString());
      if (!eligibleDestination(info)) return null;
      // Public and shared sources can acquire readers beyond today's roster. Never disclose a
      // private destination there, even if every current member happens to belong to it.
      if (info.private && (sourceInfo.type === "channel" || sourceInfo.shared)) return null;
      const members = memberSet(await directory.conversationMembers({ conversationId: target.id }));
      if (!members || [...audience].some((id) => !members.has(id))) return null;
      return { visible: true, ...info };
    } catch { return null; }
  };
}

export async function verifyDirectoryChannel({ entry, createdBy, channelId }, dependencies) {
  return (await prepareDirectoryVerifier({ createdBy, channelId }, dependencies))(entry);
}

export function nextAgentDirectoryRefreshDelay(at = Date.now()) {
  const next = new Date(at);
  next.setHours(3, 0, 0, 0);
  if (next.getTime() <= at) next.setDate(next.getDate() + 1);
  return next.getTime() - at;
}

// Built-in daemon housekeeping: no engine turn, schedule row, or language-model spend. A new
// local-calendar deadline on each tick honors DST instead of drifting through a 24-hour interval.
export function startAgentDirectoryRefresh({
  reconcile = reconcileAgentDirectory, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout, log = console,
} = {}) {
  let stopped = false;
  let timer;
  let running = null;
  const refresh = () => {
    if (stopped) return Promise.resolve(null);
    if (!running) {
      running = Promise.resolve().then(() => reconcile({ shouldStop: () => stopped }))
        .catch(() => { if (!stopped) log.warn?.("[agent-directory] metadata refresh failed; live discovery remains fail closed"); })
        .finally(() => { running = null; });
    }
    return running;
  };
  const arm = () => {
    if (stopped) return;
    timer = setTimer(() => { refresh().finally(arm); }, nextAgentDirectoryRefreshDelay(now()));
    timer?.unref?.();
  };
  arm();
  void refresh();
  return {
    refresh,
    stop() { stopped = true; if (timer !== undefined) clearTimer(timer); },
  };
}
