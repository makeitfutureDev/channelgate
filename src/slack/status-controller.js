import { getActiveBackgroundJobs } from "../gateway/background.js";
import { listForChannel as listSchedulesForChannel } from "../config/schedules.js";
import { poolStats } from "../engines/session-pool.js";
import { getChannelMeta } from "../config/store.js";
import { modeLabel } from "../gateway/modes.js";
import { resolveRuntime } from "../runtimes/resolve.js";
import { claudeLoginExpiryWarning, describeClaudeLogin, resolveClaudeLogin } from "../gateway/claude-login.js";
import { runQueue } from "./message-lifecycle.js";

function fmtAgo(ms) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

// One line naming WHERE this channel's turns run. On the host that is a single word — it is the
// answer nobody has to think about. For an isolated runtime it is the first thing anyone debugging
// a container channel needs: which container, which image, what state it is in, and how long it
// has been up. Everything comes from the backend's own describe(); this only renders it, so a
// backend that reports less simply says less.
export function formatRuntimeLine(info) {
  const backend = String(info?.backend || "container");
  const parts = [];
  if (info.containerName) parts.push(`\`${info.containerName}\``);
  if (info.image) parts.push(`image ${info.image}`);
  if (info.state) parts.push(info.state);
  if (info.upSince) {
    const since = Date.parse(info.upSince);
    if (Number.isFinite(since)) parts.push(`up ${fmtAgo(Date.now() - since)}`);
  }
  if (info.warm) parts.push("warm");
  if (info.reason) parts.push(info.reason);
  return `*📦 Runtime*: ${backend}${parts.length ? ` — ${parts.join(" · ")}` : ""}`;
}

// One line naming what this channel is ALLOWED to do — its mode AND, in both directions, the
// Allow-network switch. /status listed jobs, schedules, runtime and login but never the channel's
// own capabilities, so "can I reach the internet from here?" had no answer anywhere in chat: the
// mode label said nothing when the switch was off, and an off switch reads exactly like a switch
// nobody ever touched. Detailed form, because this IS the place someone comes to ask.
export function formatCapabilityLine(meta = {}) {
  return `*🎚️ Mode*: ${modeLabel(meta, { detail: true })}`;
}

// Never let it be the thing that breaks /status — same rule as the runtime line below.
async function capabilityStatusLine(slug) {
  try {
    return formatCapabilityLine((await getChannelMeta(slug)) || {});
  } catch (error) {
    return `*🎚️ Mode*: unavailable — ${error.message}`;
  }
}

// Never let the runtime line be the thing that breaks /status: an unavailable or misconfigured
// backend is exactly when someone types it.
async function runtimeStatusLine(slug) {
  try {
    const meta = (await getChannelMeta(slug)) || {};
    const target = resolveRuntime(slug, meta);
    return formatRuntimeLine(await target.runtime.describe(target));
  } catch (error) {
    return `*📦 Runtime*: unavailable — ${error.message}`;
  }
}

// One line naming WHOSE Claude subscription answers a turn here, and when that login dies. It is a
// daemon-wide fact rather than a channel one, but it is the fact people are missing at exactly the
// moment they type /status: a login that expired is indistinguishable, from the chat side, from an
// engine that has gone quiet. Pure so it can be tested without a filesystem.
export function formatClaudeLoginLine(login, warning = "") {
  const described = describeClaudeLogin(login);
  if (described.kind === "none") return `*🔑 Claude login*: ⚠️ none — ${described.detail}`;
  const where = described.kind === "operator" ? ` (\`${described.configDir}\`)` : "";
  const expiry = described.expiresAt ? ` · session expires ${new Date(described.expiresAt).toISOString().slice(0, 10)}` : "";
  return `*🔑 Claude login*: ${warning ? "⚠️ " : ""}${described.kind}${where}${expiry}`;
}

// Never let it be the thing that breaks /status — same rule as the runtime line.
function claudeLoginStatusLine() {
  try {
    const login = resolveClaudeLogin();
    return formatClaudeLoginLine(login, claudeLoginExpiryWarning(login));
  } catch (error) {
    return `*🔑 Claude login*: unavailable — ${error.message}`;
  }
}

export async function buildStatusReport(slug, channelId) {
  const parts = [];
  const background = getActiveBackgroundJobs?.();
  const jobs = background?.listForChannel ? background.listForChannel(slug) : [];
  if (jobs.length) {
    parts.push(`*🛠️ Background jobs (${jobs.length})*`);
    for (const job of jobs.slice(0, 10)) parts.push(`• ${job.kind === "agent" ? "🤖 " : ""}${job.label} — running ${fmtAgo(job.runtimeMs)}`);
  }
  let schedules = [];
  try { schedules = listSchedulesForChannel(channelId); } catch { schedules = []; }
  if (schedules.length) {
    parts.push(`*⏰ Scheduled (${schedules.length})*`);
    for (const schedule of schedules.slice(0, 15)) {
      const when = schedule.once || schedule.runAt
        ? `once @ ${schedule.runAt ? new Date(schedule.runAt).toLocaleString() : "?"}`
        : `cron \`${schedule.cron}\``;
      parts.push(`• ${schedule.enabled ? "" : "(off) "}${schedule.description || schedule.prompt || "task"} — ${when}`);
    }
  }
  const warmKeys = (poolStats().keys || []).filter((key) => key.startsWith(`${slug}::`));
  const liveRuns = runQueue.keys()
    .filter((key) => key.startsWith(`${slug}::`))
    .reduce((count, key) => count + runQueue.count(key), 0);
  parts.push(`*⚡ Now*: ${liveRuns} run${liveRuns === 1 ? "" : "s"} in flight · ${warmKeys.length} warm session${warmKeys.length === 1 ? "" : "s"}`);
  const capabilityLine = await capabilityStatusLine(slug);
  const runtimeLine = await runtimeStatusLine(slug);
  const loginLine = claudeLoginStatusLine();
  if (!jobs.length && !schedules.length && !liveRuns) return `Nothing is running or scheduled in this channel right now. ✨\n${capabilityLine}\n${runtimeLine}\n${loginLine}`;
  parts.push(capabilityLine, runtimeLine, loginLine);
  return parts.join("\n");
}
