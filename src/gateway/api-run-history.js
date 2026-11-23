// Read-only history of HTTP API runs for the Activity dashboard's Automations page. Kept apart
// from api-runs.js (which drags in the whole run orchestrator) so the dashboard reads the durable
// `api_jobs` rows directly. An API run is grouped by the credential that started it: a channel
// API token (its own source) or the organization API key (admin-only, the fixed `api` principal).
import { getDb, fromJson } from "../db/index.js";
import { listApiTokens } from "./api-tokens.js";
import { costHistoryStart, costVisibleAt } from "../ee/cost-history.js";

export const API_SOURCE_PREFIX = "api:";
export const ORG_KEY_SOURCE = "api:org-key";
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // api_jobs rows are pruned after 7 days anyway
const ROW_CAP = 2000;
const LIVE = new Set(["running", "queued"]);

export const apiSourceId = (job) => job.principalKind === "user" && job.apiTokenId ? `${API_SOURCE_PREFIX}${job.apiTokenId}` : ORG_KEY_SOURCE;

// The task status a dashboard shows for one job, the automations' vocabulary.
export function apiRunStatus(job) {
  if (LIVE.has(job.status)) return job.status;
  if (job.status === "stopped") return "skipped";
  if (job.status === "interrupted") return "interrupted";
  if (job.status === "failed") return "failed";
  return job.taskStatus || "unreported";
}

function jobsForChannel(channelId, now = Date.now()) {
  let rows;
  try {
    rows = getDb().prepare("SELECT data FROM api_jobs WHERE created_ms >= ? ORDER BY created_ms DESC LIMIT ?").all(now - WINDOW_MS, ROW_CAP);
  } catch {
    return [];
  }
  return rows.map((r) => fromJson(r.data, null)).filter((j) => j && j.channelId === channelId);
}

// Who sees which source: an admin sees every source (the organization key included); anyone else
// only the runs of tokens they created — the API tokens page's own rule (api-tokens.js).
function sourceVisible(id, tokens, { isAdmin, userId }) {
  if (isAdmin) return true;
  if (id === ORG_KEY_SOURCE) return false;
  const token = tokens.get(id.slice(API_SOURCE_PREFIX.length));
  return Boolean(token && userId && token.createdBy === userId);
}
const tokenMap = (channelId) => new Map(listApiTokens({ channelId }).map((t) => [String(t.id), t]));
const visibleCost = (job, nowDate, start) => typeof job.costUSD === "number" && costVisibleAt(job.completedMs ?? job.createdMs, nowDate, start) ? job.costUSD : null;

// Grouped API sources of one conversation the viewer may see.
export function apiSourcesForChannel(channelId, { isAdmin = false, userId = "", now = Date.now() } = {}) {
  const tokens = tokenMap(channelId);
  const nowDate = new Date(now);
  const start = costHistoryStart(nowDate);
  const groups = new Map();
  for (const job of jobsForChannel(channelId, now)) {
    const id = apiSourceId(job);
    if (!sourceVisible(id, tokens, { isAdmin, userId })) continue;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(job);
  }
  return [...groups.entries()].map(([id, jobs]) => {
    const token = id === ORG_KEY_SOURCE ? null : tokens.get(id.slice(API_SOURCE_PREFIX.length));
    const statuses = jobs.map(apiRunStatus);
    const finished = statuses.filter((s) => !LIVE.has(s) && s !== "skipped");
    const good = finished.filter((s) => s === "succeeded" || s === "no-op").length;
    const reported = finished.filter((s) => s !== "unreported").length;
    return {
      id,
      title: id === ORG_KEY_SOURCE ? "API runs · organization API key" : `API runs · token “${token?.name || "deleted token"}”`,
      kind: "API",
      revoked: Boolean(token?.revokedAt),
      runs: {
        total: jobs.length,
        running: statuses.filter((s) => LIVE.has(s)).length,
        lastStatus: statuses.find((s) => !LIVE.has(s)) || statuses[0] || null,
        lastStartedAt: jobs[0]?.createdMs ? new Date(jobs[0].createdMs).toISOString() : null,
        // Only runs that carried a task report can say whether the work succeeded.
        successRate: reported ? good / reported : null,
        costUsd: jobs.reduce((sum, j) => sum + (visibleCost(j, nowDate, start) ?? 0), 0),
      },
    };
  });
}

// One API source's recent runs in the Automations run-row shape.
export function apiSourceRuns(channelId, sourceId, { isAdmin = false, userId = "", limit = 30, now = Date.now() } = {}) {
  if (!sourceVisible(sourceId, tokenMap(channelId), { isAdmin, userId })) throw Object.assign(new Error("Automation denied"), { status: 403 });
  const nowDate = new Date(now);
  const start = costHistoryStart(nowDate);
  return jobsForChannel(channelId, now).filter((j) => apiSourceId(j) === sourceId).slice(0, limit).map((j) => ({
    id: j.id,
    status: apiRunStatus(j),
    startedAt: j.startedMs ? new Date(j.startedMs).toISOString() : null,
    completedAt: j.completedMs ? new Date(j.completedMs).toISOString() : null,
    durationMs: j.durationMs ?? null,
    summary: j.outcome?.summary || (String(j.message || "").slice(0, 300) || null),
    error: j.error || null,
    engine: j.engine || null,
    model: j.model || null,
    costUsd: visibleCost(j, nowDate, start),
    connections: j.outcome?.connections || [],
    deliveryStatus: j.webhookPending ? "webhook pending" : j.deliveryPending ? "Slack delivery pending" : null,
    taskStatus: j.taskStatus || null,
  }));
}
