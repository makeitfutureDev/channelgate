// The App Home personal work list. Every read and click uses the Slack interaction's viewer;
// neither button values nor stored thread ownership can grant channel or sudo-thread access.
import { getChannelEntry, getChannelMeta, getUser, listChannels } from "../config/store.js";
import { isAuthorized } from "../gateway/modes.js";
import { getThreadSudo } from "../gateway/thread-engine.js";
import { platformOfConversation } from "../platforms/ids.js";
import { listConversationMemberIds } from "./members.js";
import { listPendingApprovals } from "./approvals.js";
import { clearDone, markDone } from "../gateway/followups.js";
import { inspectThreadCompletion } from "../gateway/thread-completion.js";
import {
  getSlackThread, indexSlackThread, skipSlackThreadCandidate, setSlackThreadDone, updateSlackThreadRootCompletion, slackThreadCandidates,
  slackThreadsForUser, slackThreadRuntime, slackThreadStatus,
} from "../gateway/slack-threads.js";

export const HOME_THREADS_ACTION = /^cg_home_threads_(filter|page|refresh|history|done|reopen)$/;
export const HOME_THREADS_PAGE_SIZE = 10;
const HISTORY_BATCH = 10;
const LABELS = { active: "Active", all: "All open", working: "Working", waiting: "Waiting", idle: "Idle", done: "Completed", error: "Error" };
const ICONS = { working: "🟢", waiting: "🟡", idle: "⚪", done: "✅", error: "🔴" };
const RANK = { working: 0, waiting: 1, error: 2, idle: 3, done: 4 };
const esc = (value) => String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/[*_~`]/g, "");
const button = (text, action, value) => ({ type: "button", text: { type: "plain_text", text }, action_id: `cg_home_threads_${action}`, value: JSON.stringify(value) });

export function normalizeThreadView(value = {}) {
  const page = Number(value.page);
  return { filter: Object.hasOwn(LABELS, value.filter) ? value.filter : "active", page: Number.isSafeInteger(page) && page >= 0 ? Math.min(page, 1000000) : 0 };
}

async function accessContext(client, userId) {
  const user = await getUser(userId) || {};
  const membership = new Map();
  let unavailable = false;
  return {
    user,
    get unavailable() { return unavailable; },
    async allows(entry, threadTs = "") {
      if (!entry || platformOfConversation(entry.channelId) !== "slack") return false;
      const meta = await getChannelMeta(entry.slug);
      if (!meta || !isAuthorized(meta, userId, Boolean(entry.isDM || meta.isDM), { isAdminUser: user.isAdmin === true, isApprovedUser: user.approved === true })) return false;
      // Public channels need gateway admission. Private/group/DM conversation names and content
      // require actual Slack membership even for an organization admin, with no stale cache.
      if (!["channel", "C"].includes(entry.type)) {
        if (!membership.has(entry.channelId)) {
          try { membership.set(entry.channelId, await listConversationMemberIds(client, entry.channelId)); }
          catch { unavailable = true; membership.set(entry.channelId, []); }
        }
        if (!membership.get(entry.channelId).includes(userId)) return false;
      }
      if (threadTs && !user.isAdmin && await getThreadSudo(entry.slug, threadTs)) return false;
      return true;
    },
  };
}

async function readRoot(client, channelId, threadTs) {
  const page = await client.conversations.replies({ channel: channelId, ts: threadTs, limit: 1 });
  if (page?.ok === false) throw Object.assign(new Error("Thread unavailable"), { code: page.error || "thread_unavailable" });
  return page?.messages?.find((m) => m.ts === threadTs) || null;
}

const permanentMissing = (error) => ["thread_not_found", "message_not_found"].includes(error?.data?.error || error?.code || error?.message);
const channelUnavailable = (error) => ["channel_not_found", "not_in_channel", "is_archived"].includes(error?.data?.error || error?.code || error?.message);
const humanRoot = (root) => root?.user && !root.bot_id && !["bot_message", "tombstone"].includes(root.subtype);

export async function homeThreadsSnapshot(client, userId, requested = {}, { reader = null, discover = true, reconcile = true, force = false } = {}) {
  const view = normalizeThreadView(requested);
  const access = await accessContext(client, userId);
  const channels = await listChannels();
  const byId = new Map(channels.map((c) => [c.channelId, c]));
  const candidates = discover ? slackThreadCandidates(channels.filter((c) => platformOfConversation(c.channelId) === "slack")) : [];
  const rootCache = new Map();
  const hiddenChannels = new Set();
  let scanned = 0;
  let moreHistory = !discover; // Unknown until an explicit history scan; keep its control available.
  let unavailable = false;
  const rootFor = async (channelId, ts) => {
    const key = `${channelId}::${ts}`;
    if (!rootCache.has(key)) rootCache.set(key, await readRoot(client, channelId, ts));
    return rootCache.get(key);
  };
  for (const candidate of discover ? candidates : []) {
    if (scanned >= HISTORY_BATCH) { moreHistory = true; break; }
    if (hiddenChannels.has(candidate.channelId)) continue;
    if (!await access.allows(byId.get(candidate.channelId), candidate.threadTs)) continue;
    scanned++;
    try {
      const root = await rootFor(candidate.channelId, candidate.threadTs);
      if (!humanRoot(root)) skipSlackThreadCandidate(candidate);
      else indexSlackThread({ channelId: candidate.channelId, slug: candidate.slug, root });
    } catch (error) {
      if (permanentMissing(error)) skipSlackThreadCandidate(candidate);
      else if (channelUnavailable(error)) hiddenChannels.add(candidate.channelId);
      else { unavailable = true; moreHistory = true; break; } // respect transient failures/rate limits
    }
  }
  const runtime = slackThreadRuntime({ pendingApprovals: listPendingApprovals() });
  const eligible = new Map();
  for (const row of slackThreadsForUser(userId)) {
    if (hiddenChannels.has(row.channel_id)) continue;
    const entry = byId.get(row.channel_id);
    if (!await access.allows(entry, row.thread_ts)) continue;
    eligible.set(`${row.channel_id}::${row.thread_ts}`, { ...row, channelName: entry.name || "Direct message", status: slackThreadStatus(row, runtime) });
  }
  const verified = new Set();
  const verify = async (row) => {
    const key = `${row.channel_id}::${row.thread_ts}`;
    const inspected = reader
      ? await reader.inspect(client, row.channel_id, row.thread_ts, { force })
      : await inspectThreadCompletion(client, row.channel_id, row.thread_ts);
    const root = inspected.root;
    if (!humanRoot(root) || root.user !== userId) {
      if (humanRoot(root)) indexSlackThread({ channelId: row.channel_id, slug: row.slug, root });
      else skipSlackThreadCandidate({ channelId: row.channel_id, slug: row.slug, threadTs: row.thread_ts });
      eligible.delete(key);
      return false;
    }
    updateSlackThreadRootCompletion(row.channel_id, root, inspected);
    const current = getSlackThread(row.channel_id, row.thread_ts);
    Object.assign(row, current, { status: slackThreadStatus(current, runtime) });
    verified.add(key);
    return true;
  };
  const runBatch = async (items, work) => {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(reader?.concurrency || 1, items.length) }, async () => {
      while (next < items.length) await work(items[next++]);
    }));
  };
  const verifySafely = async (row) => {
    if (unavailable || hiddenChannels.has(row.channel_id) || verified.has(`${row.channel_id}::${row.thread_ts}`)) return;
    try { await verify(row); }
    catch (error) {
      if (permanentMissing(error)) {
        skipSlackThreadCandidate({ channelId: row.channel_id, slug: row.slug, threadTs: row.thread_ts });
        eligible.delete(`${row.channel_id}::${row.thread_ts}`);
      } else if (channelUnavailable(error)) hiddenChannels.add(row.channel_id);
      else unavailable = true;
    }
  };
  // Only explicit reconciliation scans offscreen rows; ordinary navigation verifies its window.
  if (reconcile) await runBatch([...eligible.values()].sort((a, b) => a.checked_ms - b.checked_ms).slice(0, HISTORY_BATCH), verifySafely);
  const selection = () => [...eligible.values()]
    .filter((r) => !hiddenChannels.has(r.channel_id))
    .filter((r) => ["all", "active"].includes(view.filter) ? r.status !== "done" : r.status === view.filter)
    .sort((a, b) => RANK[a.status] - RANK[b.status] || b.last_message_ms - a.last_message_ms || Number(b.thread_ts) - Number(a.thread_ts));
  let filtered;
  let pages;
  let page;
  let window;
  // Root reconciliation may change a filter, reorder All, or remove the last row on a page.
  // Rebuild the window before rendering, with a bounded number of reads and the same root cache.
  for (let attempt = 0; attempt < 3; attempt++) {
    filtered = selection();
    pages = Math.max(1, Math.ceil(filtered.length / HOME_THREADS_PAGE_SIZE));
    page = Math.min(view.page, pages - 1);
    window = filtered.slice(page * HOME_THREADS_PAGE_SIZE, (page + 1) * HOME_THREADS_PAGE_SIZE);
    const before = window.map((r) => `${r.channel_id}::${r.thread_ts}`).join("|");
    await runBatch(window, verifySafely);
    filtered = selection();
    pages = Math.max(1, Math.ceil(filtered.length / HOME_THREADS_PAGE_SIZE));
    page = Math.min(view.page, pages - 1);
    window = filtered.slice(page * HOME_THREADS_PAGE_SIZE, (page + 1) * HOME_THREADS_PAGE_SIZE);
    if (unavailable || window.map((r) => `${r.channel_id}::${r.thread_ts}`).join("|") === before) break;
  }
  const linked = new Map();
  await runBatch(window, async (row) => {
    if (!verified.has(`${row.channel_id}::${row.thread_ts}`)) { unavailable = true; return; }
    try {
      const link = reader ? await reader.permalink(client, row.channel_id, row.thread_ts)
        : await client.chat.getPermalink({ channel: row.channel_id, message_ts: row.thread_ts });
      if (!/^https:\/\//.test(link?.permalink || "")) { unavailable = true; return; }
      linked.set(`${row.channel_id}::${row.thread_ts}`, { ...row, url: link.permalink });
    } catch { unavailable = true; }
  });
  const rows = window.map((row) => linked.get(`${row.channel_id}::${row.thread_ts}`)).filter(Boolean);
  return { ...view, page, pages, total: filtered.length, rows, moreHistory, unavailable: unavailable || access.unavailable || hiddenChannels.size > 0 };
}

// Only local display state participates: unchanged Activity pages never poll Slack history.
export function homeThreadsRefreshKey(userId) {
  const runtime = slackThreadRuntime({ pendingApprovals: listPendingApprovals() });
  return JSON.stringify(slackThreadsForUser(userId).map((row) => [
    row.channel_id, row.thread_ts, row.title, row.last_message_ms, slackThreadStatus(row, runtime),
  ]).sort((a, b) => `${a[0]}:${a[1]}`.localeCompare(`${b[0]}:${b[1]}`)));
}

export function homeThreadBlocks(snapshot) {
  const { rows = [], filter = "active", page = 0, pages = 1, total = 0, moreHistory = false, unavailable = false } = snapshot;
  const state = { filter, page };
  const blocks = [
    { type: "divider" },
    { type: "section", text: { type: "mrkdwn", text: "*My threads* · ✅ / 👍 / Done hides completed work. Reopen from Completed." } },
    { type: "actions", elements: [
      { type: "static_select", action_id: "cg_home_threads_filter", placeholder: { type: "plain_text", text: "Status" },
        initial_option: { text: { type: "plain_text", text: LABELS[filter] }, value: filter },
        options: Object.entries(LABELS).map(([value, label]) => ({ text: { type: "plain_text", text: label }, value })) },
      button("Refresh", "refresh", state),
    ] },
  ];
  if (!rows.length) blocks.push({ type: "section", text: { type: "mrkdwn", text: "_No visible threads in this view._" } });
  for (const row of rows) {
    const title = String(row.title || "Open thread");
    const at = row.last_message_ms;
    const date = Number.isFinite(at) && at > 0
      ? `<!date^${Math.floor(at / 1000)}^{date_short_pretty} at {time}|${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC>`
      : "Unavailable";
    const done = row.status === "done";
    blocks.push(
      { type: "divider" },
      { type: "section", text: { type: "mrkdwn", text: `<${row.url}|${esc(title.length > 110 ? title.slice(0, 107) + "…" : title)}>\n${esc(row.channelName)} · ${ICONS[row.status]} ${done ? "Done" : LABELS[row.status]} · Last message ${date}` },
        accessory: { ...button(done ? "Reopen" : "✓ Done", done ? "reopen" : "done", { ...state, channelId: row.channel_id, threadTs: row.thread_ts }), ...(done ? {} : { style: "primary" }) } },
    );
  }
  const navigation = [];
  if (page > 0) navigation.push(button("Previous", "page", { filter, page: page - 1 }));
  if (page + 1 < pages) navigation.push(button("Next", "page", { filter, page: page + 1 }));
  if (moreHistory) navigation.push(button("Load older threads", "history", state));
  if (navigation.length) blocks.push({ type: "actions", elements: navigation });
  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `Page ${page + 1} of ${pages} · ${total} indexed thread${total === 1 ? "" : "s"} in this view${moreHistory ? " · Older tracked threads are indexed in small batches; use Load older threads." : ""}${unavailable ? " · Some threads could not be verified. Refresh later." : ""}` }] });
  return blocks;
}

export function registerHomeThreadActions(app, { publishHome } = {}) {
  app.action("cg_home_threads_open", async ({ ack }) => { await ack(); });
  app.action(HOME_THREADS_ACTION, async ({ ack, body, action, client }) => {
    await ack();
    const userId = body?.user?.id;
    if (!userId) return;
    try {
      const kind = action.action_id?.split("_").at(-1);
      const value = kind === "filter" ? { filter: action.selected_option?.value } : JSON.parse(action.value || "{}");
      const view = { ...normalizeThreadView(value),
        ...(["refresh", "history"].includes(kind) ? { forceThreads: true, discoverThreads: true } : {}) };
      if (["done", "reopen"].includes(kind)) {
        const row = getSlackThread(String(value.channelId || ""), String(value.threadTs || ""));
        if (!row || row.starter_id !== userId) return;
        const access = await accessContext(client, userId);
        const entry = await getChannelEntry(row.channel_id);
        if (!await access.allows(entry && { ...entry, channelId: row.channel_id }, row.thread_ts)) return;
        const root = await readRoot(client, row.channel_id, row.thread_ts);
        if (!root || root.user !== userId || root.bot_id) return;
        updateSlackThreadRootCompletion(row.channel_id, root);
        setSlackThreadDone(row.channel_id, row.thread_ts, userId, kind === "done");
        if (kind === "done") markDone(userId, row.channel_id, row.thread_ts);
        else clearDone(userId, row.channel_id, row.thread_ts);
      }
      await publishHome(client, userId, view);
    } catch (error) {
      console.error("[slack] Home threads error:", error.message);
    }
  });
}
