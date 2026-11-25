// The App Home personal work list. Every read and click uses the Slack interaction's viewer;
// neither button values nor stored thread ownership can grant channel or sudo-thread access.
import { slackActorId } from "./actor.js";
import { getChannelEntry, getChannelMeta, getUser, listChannels } from "../config/store.js";
import { onConfigChange } from "../config/change-events.js";
import { acquireKeyedLock } from "../util/keyed-lock.js";
import { isAuthorized } from "../gateway/modes.js";
import { getThreadSudo } from "../gateway/thread-engine.js";
import { platformOfConversation } from "../platforms/ids.js";
import { cachedConversationMemberIds } from "./members.js";
import { listPendingApprovals } from "./approvals.js";
import { clearDone, markDone } from "../gateway/followups.js";
import { syncThreadDoneMarker } from "./thread-done-marker.js";
import { notifyThreadChanged } from "../gateway/thread-changes.js";
import { inspectThreadCompletion } from "../gateway/thread-completion.js";
import {
  getSlackThread, getSlackThreadParticipant, indexSlackThread, slackThreadRootOwner, skipSlackThreadCandidate, setSlackThreadDone, updateSlackThreadRootCompletion, slackThreadCandidates,
  eligibleSlackThreadsForUser, isSlackThreadEligible, slackThreadIsDone, slackThreadRuntime, slackThreadStatus, slackThreadWorkingSince, liveSlackThreadCandidates,
} from "../gateway/slack-threads.js";

// Previous and Next share one actions block, and Slack rejects a view whose block repeats an
// action_id, so each page button has its own id. `page` stays admitted for Home views published
// before the split (their single Next/Previous button still carries a valid page).
export const HOME_THREADS_ACTION = /^cg_home_threads_(filter|page|prev|next|refresh|history|done|reopen|doneall)$/;
export const HOME_THREADS_PAGE_SIZE = 10;
const HISTORY_INDEX_BATCH = 100;
const HISTORY_BATCH = 10;
const LABELS = { active: "Active", all: "All open", working: "Working", waiting: "Waiting", idle: "Idle", done: "Completed", later: "Later", error: "Error" };
const ICONS = { working: "🟢", waiting: "🟡", idle: "⚪", done: "✅", later: "🕒", error: "🔴" };
const RANK = { working: 0, waiting: 1, error: 2, idle: 3, later: 4, done: 5 };
const esc = (value) => String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/[*_~`]/g, "");
const button = (text, action, value) => ({ type: "button", text: { type: "plain_text", text }, action_id: `cg_home_threads_${action}`, value: JSON.stringify(value) });

const isActivityDM = (entry) => Boolean(entry?.isDM || entry?.type === "im" || /^D[A-Z0-9]+$/.test(entry?.channelId || ""));

// Resolve display text only after the caller has checked conversation access. DM storage names
// may be opaque Slack IDs or legacy dm-* slugs; only the registered peer supplies a name.
export async function activityChannelName(entry) {
  if (!isActivityDM(entry)) return entry?.name || "Conversation";
  const meta = await getChannelMeta(entry.slug);
  const peer = meta?.dmUserId ? await getUser(meta.dmUserId) : null;
  const name = String(peer?.name || "").trim();
  return name ? `Personal conversation with ${name}` : "Personal conversation";
}

export function normalizeThreadView(value = {}) {
  const page = Number(value.page);
  return { filter: Object.hasOwn(LABELS, value.filter) ? value.filter : "active", page: Number.isSafeInteger(page) && page >= 0 ? Math.min(page, 1000000) : 0 };
}

const MEMBERSHIP_PREFETCH_CONCURRENCY = 6;

export async function accessContext(client, userId) {
  const user = await getUser(userId) || {};
  const membership = new Map();
  const metas = new Map(); // one settings read per conversation per access check pass
  let unavailable = false;
  const members = (channelId) => {
    if (!membership.has(channelId)) {
      membership.set(channelId, cachedConversationMemberIds(client, channelId).catch(() => { unavailable = true; return []; }));
    }
    return membership.get(channelId);
  };
  return {
    user,
    get unavailable() { return unavailable; },
    // Warm the membership of several private conversations at once (bounded), so the checks
    // that follow do not wait on Slack one conversation at a time.
    async prefetch(entries, concurrency = MEMBERSHIP_PREFETCH_CONCURRENCY) {
      const ids = [...new Set([...entries].filter((e) => e && !["channel", "C"].includes(e.type)
        && platformOfConversation(e.channelId) === "slack").map((e) => e.channelId))];
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, async () => {
        while (next < ids.length) await members(ids[next++]);
      }));
    },
    async allows(entry, threadTs = "") {
      if (!entry || platformOfConversation(entry.channelId) !== "slack") return false;
      if (!metas.has(entry.slug)) metas.set(entry.slug, getChannelMeta(entry.slug));
      const meta = await metas.get(entry.slug);
      if (!meta || entry.disabled || entry.archived || entry.deleted || meta.disabled || meta.archived || meta.deleted
        || (meta.botMembership && meta.botMembership !== "member") || !isAuthorized(meta, userId, Boolean(entry.isDM || meta.isDM), { isAdminUser: user.isAdmin === true, isApprovedUser: user.approved === true })) return false;
      // Public channels need gateway admission. Private/group/DM conversation names and content
      // require actual Slack membership even for an organization admin, with no stale cache.
      if (!["channel", "C"].includes(entry.type)) {
        if (!(await members(entry.channelId)).includes(userId)) return false;
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

// Explicit history actions share one bounded discovery pass. Ordinary browser refreshes stay local.
export async function discoverSlackThreadHistory(client, userId, { beforeWrite = async () => {} } = {}) {
  const release = await acquireKeyedLock("slack-thread-history", userId);
  let version = 0;
  const unsubscribe = onConfigChange(() => { version++; });
  try {
    await beforeWrite();
    const access = await accessContext(client, userId);
    const channels = (await listChannels()).filter((c) => platformOfConversation(c.channelId) === "slack");
    const byId = new Map(channels.map((c) => [c.channelId, c]));
    const candidates = slackThreadCandidates(channels);
    const hiddenChannels = new Set();
    let scanned = 0;
    let moreHistory = false;
    let unavailable = false, accessUnavailable = false;
    const mayWrite = async (candidate) => {
      const checkedVersion = version;
      const currentAccess = await accessContext(client, userId);
      const entry = await getChannelEntry(candidate.channelId);
      const allowed = await currentAccess.allows(entry && { ...entry, channelId: candidate.channelId }, candidate.threadTs);
      accessUnavailable ||= currentAccess.unavailable;
      await beforeWrite();
      if (checkedVersion !== version) { unavailable = true; return false; }
      return allowed;
    };
    for (const candidate of candidates) {
      if (scanned >= HISTORY_INDEX_BATCH) { moreHistory = true; break; }
      if (hiddenChannels.has(candidate.channelId)) continue;
      if (!await access.allows(byId.get(candidate.channelId), candidate.threadTs)) continue;
      scanned++;
      try {
        const root = await readRoot(client, candidate.channelId, candidate.threadTs);
        if (!await mayWrite(candidate)) continue;
        if (!slackThreadRootOwner(candidate.channelId, root)) skipSlackThreadCandidate(candidate);
        else indexSlackThread({ channelId: candidate.channelId, slug: candidate.slug, root, agentEngaged: true });
      } catch (error) {
        if (error.status === 401 || error.status === 403) throw error;
        if (permanentMissing(error)) {
          if (await mayWrite(candidate)) skipSlackThreadCandidate(candidate);
        }
        else if (channelUnavailable(error)) hiddenChannels.add(candidate.channelId);
        else { unavailable = true; moreHistory = true; break; } // respect transient failures/rate limits
      }
    }
    const incomplete = unavailable || access.unavailable || accessUnavailable || hiddenChannels.size > 0;
    return { scanned, moreHistory: moreHistory || incomplete, unavailable, incomplete, hiddenChannels };
  } finally { unsubscribe(); release(); }
}

export async function homeThreadsSnapshot(client, userId, requested = {}, { reader = null, discover = true, reconcile = true, force = false } = {}) {
  const view = normalizeThreadView(requested);
  const history = discover ? await discoverSlackThreadHistory(client, userId) : null;
  const access = await accessContext(client, userId);
  const byId = new Map((await listChannels()).map((c) => [c.channelId, c]));
  const hiddenChannels = history?.hiddenChannels || new Set();
  const moreHistory = history?.moreHistory ?? true;
  let unavailable = history?.unavailable || false;
  const runtime = slackThreadRuntime({ pendingApprovals: listPendingApprovals() });
  const eligible = new Map();
  for (const row of eligibleSlackThreadsForUser(userId)) {
    if (row.hidden_ms > 0) continue;
    if (hiddenChannels.has(row.channel_id)) continue;
    const entry = byId.get(row.channel_id);
    if (!await access.allows(entry, row.thread_ts)) continue;
    eligible.set(`${row.channel_id}::${row.thread_ts}`, { ...row, channelName: await activityChannelName(entry), isDM: isActivityDM(entry), status: slackThreadStatus(row, runtime), canComplete: row.starter_id === userId });
  }
  const verified = new Set();
  const verify = async (row) => {
    const key = `${row.channel_id}::${row.thread_ts}`;
    const inspected = reader
      ? await reader.inspect(client, row.channel_id, row.thread_ts, { force })
      : await inspectThreadCompletion(client, row.channel_id, row.thread_ts);
    const root = inspected.root;
    const currentAccess = await accessContext(client, userId);
    const currentEntry = await getChannelEntry(row.channel_id);
    if (!await currentAccess.allows(currentEntry && { ...currentEntry, channelId: row.channel_id }, row.thread_ts)) {
      eligible.delete(key);
      return false;
    }
    if (slackThreadRootOwner(row.channel_id, root) !== row.starter_id) {
      if (slackThreadRootOwner(row.channel_id, root)) indexSlackThread({ channelId: row.channel_id, slug: row.slug, root });
      else skipSlackThreadCandidate({ channelId: row.channel_id, slug: row.slug, threadTs: row.thread_ts });
      eligible.delete(key);
      return false;
    }
    updateSlackThreadRootCompletion(row.channel_id, root, inspected);
    const current = getSlackThread(row.channel_id, row.thread_ts);
    Object.assign(row, current, getSlackThreadParticipant(row.channel_id, row.thread_ts, userId), { status: slackThreadStatus(current, runtime) });
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
    .filter((r) => view.filter === "all" ? r.status !== "done" : view.filter === "active" ? r.status !== "later" && !(r.status === "done" && r.dismissed_ms > 0) : r.status === view.filter)
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
  return { ...view, ...(requested.bulkResult ? { bulkResult: requested.bulkResult } : {}), ...(requested.bulkBusy ? { bulkBusy: true } : {}), page, pages, total: filtered.length, rows, moreHistory, unavailable: unavailable || history?.incomplete || access.unavailable || hiddenChannels.size > 0 };
}

const liveRootReads = new WeakMap();
const LIVE_ROOT_RETRY_MS = 15_000;
const ROOT_READ_TIMED_OUT = Symbol("root read timed out");
async function awaitLiveRoot(state, timeoutMs) {
  if (!state.pending) return state.root;
  let timer;
  try {
    return await Promise.race([state.pending, new Promise((resolve) => {
      timer = setTimeout(() => resolve(ROOT_READ_TIMED_OUT), Math.max(0, timeoutMs));
    })]);
  } finally { clearTimeout(timer); }
}
// Only missing live roots need a Slack read. Coalesce simultaneous viewers and back off failures;
// indexed threads never read transcripts or permalinks during an Activity refresh.
async function discoverLiveRoots(client, userId, access, channels, now, rootReadBudgetMs) {
  let reads = liveRootReads.get(client);
  if (!reads) { reads = new Map(); liveRootReads.set(client, reads); }
  const deadline = Date.now() + rootReadBudgetMs;
  let attempted = 0, unavailable = false;
  for (const candidate of liveSlackThreadCandidates()) {
    const entry = channels.get(candidate.channelId);
    if (!await access.allows(entry, candidate.threadTs)) continue;
    const key = `${candidate.channelId}::${candidate.threadTs}`;
    let state = reads.get(key);
    if (!state?.pending && !state?.root && state?.retryAt > now()) { unavailable = true; continue; }
    if (attempted === HISTORY_BATCH) break;
    attempted++;
    if (!state?.pending && !state?.root) {
      // Keep the retry cache bounded without evicting in-flight reads.
      if (reads.size >= 1000) {
        const oldest = [...reads].find(([, value]) => !value.pending);
        if (!oldest) break;
        reads.delete(oldest[0]);
      }
      state = { pending: null, retryAt: 0, root: null };
      state.pending = readRoot(client, candidate.channelId, candidate.threadTs)
        .catch(() => null).then((root) => { state.root = root; return root; })
        .finally(() => { state.pending = null; state.retryAt = now() + LIVE_ROOT_RETRY_MS; });
      reads.set(key, state);
    }
    const root = await awaitLiveRoot(state, deadline - Date.now());
    // A slow/rate-limited root must not hold existing dashboard rows hostage. Retain the
    // coalesced request/result for a later snapshot; never start duplicate timed-out reads.
    if (root === ROOT_READ_TIMED_OUT) { unavailable = true; break; }
    const currentAccess = await accessContext(client, userId);
    access = currentAccess;
    // Root ownership is verified from Slack, never inferred from a queued run's author.
    if (root && await currentAccess.allows(entry, candidate.threadTs)) {
      if (slackThreadRootOwner(entry.channelId, root)) indexSlackThread({ channelId: entry.channelId, slug: entry.slug, root, agentEngaged: true });
      // A bot-started thread is a verified exclusion, not missing Slack activity. Retain
      // the discovery tombstone so active automation cannot consume every repair batch.
      else skipSlackThreadCandidate({ channelId: entry.channelId, slug: entry.slug, threadTs: candidate.threadTs });
      reads.delete(key);
    } else { state.root = null; unavailable = true; }
  }
  return { unavailable, attempted };
}

// Historical checks predate personal dismissal. Read only indexed, completed rows still
// missing that one-time reconciliation; ordinary refreshes stop reading once it is consumed.
const historicalCompletionReads = new WeakMap();
async function repairHistoricalCompletion(client, userId, access, now, deadline) {
  let reads = historicalCompletionReads.get(client);
  if (!reads) { reads = new Map(); historicalCompletionReads.set(client, reads); }
  let attempted = 0, unavailable = false;
  for (const row of eligibleSlackThreadsForUser(userId)) {
    if (row.historical_completion_checked || row.dismissed_ms || row.hidden_ms || !slackThreadIsDone(row)) continue;
    if (attempted >= HISTORY_BATCH || Date.now() >= deadline) break;
    const entry = await getChannelEntry(row.channel_id);
    if (!await access.allows(entry && { ...entry, channelId: row.channel_id }, row.thread_ts)) continue;
    const key = `${row.channel_id}::${row.thread_ts}`;
    let state = reads.get(key);
    if (!state?.pending && !state?.root && state?.retryAt > now()) { unavailable = true; continue; }
    attempted++;
    if (!state?.pending && !state?.root) {
      if (reads.size >= 1000) {
        const oldest = [...reads].find(([, value]) => !value.pending);
        if (!oldest) break;
        reads.delete(oldest[0]);
      }
      state ||= { pending: null, retryAt: 0, root: null, progress: {} };
      state.pending = inspectThreadCompletion(client, row.channel_id, row.thread_ts, { maxPages: 20, deadline, progress: state.progress })
        .catch(() => null).then((inspected) => {
          state.root = inspected;
          if (inspected) notifyThreadChanged({ channelId: row.channel_id, threadTs: row.thread_ts });
          return inspected;
        })
        .finally(() => { state.pending = null; state.retryAt = now() + LIVE_ROOT_RETRY_MS; });
      reads.set(key, state);
    }
    const inspected = await awaitLiveRoot(state, deadline - Date.now());
    if (inspected === ROOT_READ_TIMED_OUT) { unavailable = true; break; }
    // No side effects run in the background promise. Recheck current access before consuming
    // a completed read, even when a prior snapshot timed out or another viewer shared it.
    access = await accessContext(client, userId);
    const currentEntry = await getChannelEntry(row.channel_id);
    if (!inspected || !await access.allows(currentEntry && { ...currentEntry, channelId: row.channel_id }, row.thread_ts)) {
      unavailable = true;
      continue;
    }
    if (slackThreadRootOwner(row.channel_id, inspected.root) !== row.starter_id) {
      state.root = null;
      unavailable = true;
      continue;
    }
    updateSlackThreadRootCompletion(row.channel_id, inspected.root, inspected);
    reads.delete(key);
  }
  return { attempted, unavailable: unavailable || access.unavailable };
}

// The web feed reads local state plus bounded root/legacy-completion repairs. Open resolves
// a permalink after fresh click-time authorization.
const backgroundRootPasses = new Map(); // userId -> running pass
function backgroundRootPass(client, userId, now, rootReadBudgetMs) {
  if (backgroundRootPasses.has(userId)) return backgroundRootPasses.get(userId);
  const pass = (async () => {
    const access = await accessContext(client, userId);
    const channels = new Map((await listChannels()).map((entry) => [entry.channelId, entry]));
    const deadline = Date.now() + rootReadBudgetMs;
    await discoverLiveRoots(client, userId, access, channels, now, rootReadBudgetMs);
    await repairHistoricalCompletion(client, userId, await accessContext(client, userId), now, deadline);
  })().catch(() => {}).finally(() => { backgroundRootPasses.delete(userId); });
  backgroundRootPasses.set(userId, pass);
  return pass;
}
export function activityRootPassForTests(userId) { return backgroundRootPasses.get(userId) || Promise.resolve(); }

export async function activityThreadSnapshot(client, userId, requested = {}, { now = Date.now, rootReadBudgetMs = 2000, backgroundRootReads = false } = {}) {
  const view = requested.filter === "all-statuses" ? { ...normalizeThreadView(requested), filter: "all-statuses" } : normalizeThreadView(requested);
  const search = String(requested.search || "").trim().slice(0, 200);
  const size = Number(requested.pageSize);
  const pageSize = Number.isSafeInteger(size) && size > 0 ? Math.min(size, 1000) : 100;
  let access = await accessContext(client, userId);
  const channels = new Map((await listChannels()).map((entry) => [entry.channelId, entry]));
  let discovery = { unavailable: false }, repair = { unavailable: false };
  if (backgroundRootReads) {
    // The live dashboard renders from the database only. Slack root reads run beside it, one
    // pass per viewer at a time; what they index reaches the page through thread-change events.
    backgroundRootPass(client, userId, now, rootReadBudgetMs);
  } else {
    const repairDeadline = Date.now() + rootReadBudgetMs;
    discovery = await discoverLiveRoots(client, userId, access, channels, now, rootReadBudgetMs);
    repair = await repairHistoricalCompletion(client, userId, access, now, repairDeadline);
    // A content read may outlive membership/rank changes. Never render with its pre-read cache.
    if (discovery.attempted || repair.attempted) access = await accessContext(client, userId);
  }
  const runtime = slackThreadRuntime({ pendingApprovals: listPendingApprovals() });
  const workingSince = slackThreadWorkingSince();
  const authorized = [];
  const pinned = new Set(Array.isArray(requested.pinnedThreads) ? requested.pinnedThreads : []);
  const pinnedChannels = new Set(Array.isArray(requested.pinnedChannels) ? requested.pinnedChannels : []);
  const isPinned = (row) => !row.hidden_ms && !(row.status === "done" && row.dismissed_ms > 0)
    && (pinned.has(JSON.stringify([row.channel_id, row.thread_ts])) || pinnedChannels.has(row.channel_id));
  let ordinaryCount = 0, hiddenCount = 0, archivedCount = 0;
  let truncated = false;
  const eligibleRows = eligibleSlackThreadsForUser(userId);
  const names = new Map();
  await access.prefetch(eligibleRows.map((row) => channels.get(row.channel_id)));
  for (const row of eligibleRows) {
    if (row.hidden_ms > 0 && !requested.includeHidden) continue;
    // Shared Done stays visible until this viewer completes it personally or hides it.
    const status = slackThreadStatus(row, runtime);
    const archived = status === "done" && row.dismissed_ms > 0;
    const hidden = row.hidden_ms > 0;
    const saved = !hidden && isPinned({ ...row, status });
    // Keep saved pins reachable when newer history fills the ordinary feed's bound. Pins
    // still pass exactly the same ownership, eligibility and live access checks below.
    if ((hidden ? hiddenCount : archived ? archivedCount : ordinaryCount) === 1000 && !saved) { truncated = true; continue; }
    const entry = channels.get(row.channel_id);
    if (!await access.allows(entry, row.thread_ts)) continue;
    if (hidden) hiddenCount++; else if (archived) archivedCount++; else if (!saved) ordinaryCount++;
    // Completion does not cancel runtime work; the row keeps its shared Done state.
    const since = status === "working" ? workingSince.get(`${row.channel_id}::${row.thread_ts}`) : undefined;
    if (!names.has(row.channel_id)) names.set(row.channel_id, await activityChannelName(entry));
    authorized.push({ ...row, channelName: names.get(row.channel_id), isDM: isActivityDM(entry), status, ...(since ? { working_since_ms: since } : {}) });
  }
  const needle = search.toLocaleLowerCase();
  const filtered = authorized.filter((row) =>
    (view.filter === "all-statuses" || (view.filter === "all" ? row.status !== "done" : view.filter === "active" ? row.status !== "later" && !(row.status === "done" && row.dismissed_ms > 0) : row.status === view.filter))
    && (!needle || `${row.title} ${row.channelName}`.toLocaleLowerCase().includes(needle)))
    .sort((a, b) => Number(a.hidden_ms > 0) - Number(b.hidden_ms > 0) || Number(a.status === "done" && a.dismissed_ms > 0) - Number(b.status === "done" && b.dismissed_ms > 0) || RANK[a.status] - RANK[b.status] || b.last_message_ms - a.last_message_ms || Number(b.thread_ts) - Number(a.thread_ts));
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const page = Math.min(view.page, pages - 1);
  return { ...view, search, pageSize, page, pages, total: filtered.length,
    rows: filtered.filter((row, index) => (index >= page * pageSize && index < (page + 1) * pageSize)
      || (requested.includeHidden && row.hidden_ms > 0) || (view.filter === "all-statuses" && row.status === "done" && row.dismissed_ms > 0) || isPinned(row)), unavailable: discovery.unavailable || repair.unavailable || access.unavailable, truncated };
}

// Only local display state participates: unchanged Activity pages never poll Slack history.
export function homeThreadsRefreshKey(userId) {
  const runtime = slackThreadRuntime({ pendingApprovals: listPendingApprovals() });
  return JSON.stringify(eligibleSlackThreadsForUser(userId).map((row) => [
    row.channel_id, row.thread_ts, row.title, row.last_message_ms, row.hidden_ms, row.dismissed_ms, slackThreadStatus(row, runtime),
    runtime.get(`${row.channel_id}::${row.thread_ts}`) || "",
  ]).sort((a, b) => `${a[0]}:${a[1]}`.localeCompare(`${b[0]}:${b[1]}`)));
}

export function homeThreadBlocks(snapshot) {
  const { rows = [], filter = "active", page = 0, pages = 1, total = 0, moreHistory = false, unavailable = false } = snapshot;
  const state = { filter, page };
  const blocks = [
    { type: "divider" },
    { type: "section", text: { type: "mrkdwn", text: "*My threads* · Completing a thread removes it from your Active view. Threads completed by someone else stay visible as Done until you Hide them in Activity. Reopen your completed work from Completed." } },
    { type: "actions", elements: [
      { type: "static_select", action_id: "cg_home_threads_filter", placeholder: { type: "plain_text", text: "Status" },
        initial_option: { text: { type: "plain_text", text: LABELS[filter] }, value: filter },
        options: Object.entries(LABELS).map(([value, label]) => ({ text: { type: "plain_text", text: label }, value })) },
      button("Refresh", "refresh", state),
      ...(!snapshot.bulkBusy ? [{ ...button("Mark All Done", "doneall", state), confirm: {
        title: { type: "plain_text", text: "Mark all threads done?" },
        text: { type: "mrkdwn", text: "Mark all open tracked agent threads you started across channels as done, including other pages and filters? Hidden threads stay unchanged. A ✅ will appear on each main message. Running work continues." },
        confirm: { type: "plain_text", text: "Mark All Done" }, deny: { type: "plain_text", text: "Cancel" },
      } }] : []),
    ] },
  ];
  if (snapshot.bulkBusy) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: "Marking your open threads done…" }] });
  if (snapshot.bulkResult) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: bulkCompletionSummary(snapshot.bulkResult) }] });
  if (!rows.length) blocks.push({ type: "section", text: { type: "mrkdwn", text: "_No visible threads in this view._" } });
  for (const row of rows) {
    const title = String(row.title || "Open thread");
    const at = row.last_message_ms;
    const date = Number.isFinite(at) && at > 0
      ? `<!date^${Math.floor(at / 1000)}^{date_short_pretty} at {time}|${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC>`
      : "Unavailable";
    const done = row.status === "done";
    const selfDone = done && row.dismissed_ms > 0;
    blocks.push(
      { type: "divider" },
      { type: "section", text: { type: "mrkdwn", text: `<${row.url}|${esc(title.length > 110 ? title.slice(0, 107) + "…" : title)}>\n${esc(row.channelName)} · ${ICONS[row.status]} ${done ? "Done" : LABELS[row.status]} · Last message ${date}` },
        ...(row.canComplete !== false ? { accessory: { ...button(selfDone ? "Reopen" : "✓ Done", selfDone ? "reopen" : "done", { ...state, channelId: row.channel_id, threadTs: row.thread_ts }), ...(selfDone ? {} : { style: "primary" }) } } : {}) },
    );
  }
  const navigation = [];
  if (page > 0) navigation.push(button("Previous", "prev", { filter, page: page - 1 }));
  if (page + 1 < pages) navigation.push(button("Next", "next", { filter, page: page + 1 }));
  if (moreHistory) navigation.push(button("Load older threads", "history", state));
  if (navigation.length) blocks.push({ type: "actions", elements: navigation });
  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `Page ${page + 1} of ${pages} · ${total} indexed thread${total === 1 ? "" : "s"} in this view${moreHistory ? " · Older tracked threads are indexed in small batches; use Load older threads." : ""}${unavailable ? " · Some threads could not be verified. Refresh later." : ""}` }] });
  return blocks;
}

// Shared by authenticated Home clicks and the private browser dashboard. The target set is
// derived on the server from all indexed owned threads, never a page/filter or supplied IDs.
export async function markAllSlackThreadsDone(client, userId, { beforeWrite = async () => {} } = {}) {
  const release = await acquireKeyedLock("mark-all-threads-done", userId);
  let version = 0;
  const unsubscribe = onConfigChange(() => { version++; });
  const result = { marked: 0, skipped: 0, failed: 0 };
  try {
    const candidates = eligibleSlackThreadsForUser(userId).filter((row) => row.starter_id === userId && !row.hidden_ms && !(slackThreadIsDone(row) && row.dismissed_ms > 0));
    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index];
      try {
        await beforeWrite(candidate);
        let access = await accessContext(client, userId);
        let entry = await getChannelEntry(candidate.channel_id);
        if (!await access.allows(entry && { ...entry, channelId: candidate.channel_id }, candidate.thread_ts)) { result.skipped++; continue; }
        const root = await readRoot(client, candidate.channel_id, candidate.thread_ts);
        if (slackThreadRootOwner(candidate.channel_id, root) !== userId) { result.skipped++; continue; }
        // Root reads and membership calls can outlive revocation. Recheck the authenticated
        // session and current authorization, rejecting any configuration change during that check.
        const checkedVersion = version;
        access = await accessContext(client, userId);
        entry = await getChannelEntry(candidate.channel_id);
        const allowed = await access.allows(entry && { ...entry, channelId: candidate.channel_id }, candidate.thread_ts);
        await beforeWrite(candidate);
        const row = getSlackThread(candidate.channel_id, candidate.thread_ts);
        if (!allowed || checkedVersion !== version || row?.starter_id !== userId || getSlackThreadParticipant(row.channel_id, row.thread_ts, userId)?.hidden_ms > 0 || !isSlackThreadEligible(row) || (slackThreadIsDone(row) && getSlackThreadParticipant(row.channel_id, row.thread_ts, userId)?.dismissed_ms > 0)) { result.skipped++; continue; }
        if (!setSlackThreadDone(row.channel_id, row.thread_ts, userId, true)) { result.skipped++; continue; }
        markDone(userId, row.channel_id, row.thread_ts);
        // setSlackThreadDone durably queues root checks. The existing bounded marker worker
        // performs them without keeping bulk UI actions waiting on one reaction call per root.
        result.marked++;
      } catch (error) {
        if (error.status === 401 || error.status === 403) throw error;
        if (["ratelimited", "rate_limited", "slack_webapi_rate_limited_error"].includes(error.data?.error || error.code)) {
          result.failed += candidates.length - index; break;
        }
        result.failed++;
      }
    }
    return result;
  } finally { unsubscribe(); release(); }
}

export function bulkCompletionSummary(result) {
  return `Marked ${result.marked} thread${result.marked === 1 ? "" : "s"} done.`
    + (result.skipped ? ` ${result.skipped} skipped because they were already done or unavailable.` : "")
    + (result.failed ? ` ${result.failed} could not be updated. Please try again.` : "");
}

export function registerHomeThreadActions(app, { publishHome } = {}) {
  app.action("cg_home_threads_open", async ({ ack }) => { await ack(); });
  app.action(HOME_THREADS_ACTION, async ({ ack, body, action, client }) => {
    await ack();
    const userId = slackActorId(body);
    if (!userId) return;
    try {
      const kind = action.action_id?.split("_").at(-1);
      const value = kind === "filter" ? { filter: action.selected_option?.value } : JSON.parse(action.value || "{}");
      const view = { ...normalizeThreadView(value),
        ...(["refresh", "history"].includes(kind) ? { forceThreads: true, discoverThreads: true } : {}) };
      if (kind === "doneall") {
        await publishHome(client, userId, { ...view, bulkBusy: true });
        view.bulkResult = await markAllSlackThreadsDone(client, userId);
        view.page = 0;
      }
      if (["done", "reopen"].includes(kind)) {
        const row = getSlackThread(String(value.channelId || ""), String(value.threadTs || ""));
        if (!row || row.starter_id !== userId || !isSlackThreadEligible(row)) return;
        const access = await accessContext(client, userId);
        const entry = await getChannelEntry(row.channel_id);
        if (!await access.allows(entry && { ...entry, channelId: row.channel_id }, row.thread_ts)) return;
        const root = await readRoot(client, row.channel_id, row.thread_ts);
        if (slackThreadRootOwner(row.channel_id, root) !== userId) return;
        updateSlackThreadRootCompletion(row.channel_id, root);
        setSlackThreadDone(row.channel_id, row.thread_ts, userId, kind === "done");
        if (kind === "done") markDone(userId, row.channel_id, row.thread_ts);
        else clearDone(userId, row.channel_id, row.thread_ts);
        await syncThreadDoneMarker(client, row.channel_id, row.thread_ts);
      }
      await publishHome(client, userId, view);
    } catch (error) {
      console.error("[slack] Home threads error:", error.message);
    }
  });
}
