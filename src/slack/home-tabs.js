// In-Home navigation: publish only the selected section and load its data on demand.
// Selection is view state, never a gateway/user setting or an authorization credential.
import { registerComposioHomeActions } from "./home-composio.js";
import { registerNudgeHomeActions } from "./home-nudges.js";
import { registerReplyMentionsHomeActions } from "./home-reply-mentions.js";
import { registerHomeThreadActions } from "./home-threads.js";
export const HOME_TAB_ACTION = /^cg_home_tab_(activity|connections|skills|channels|help)$/;
export const HOME_TABS = Object.freeze({ activity: "Activity", connections: "Connections", skills: "Skills", channels: "Channels", help: "Help & settings" });

export const normalizeHomeTab = (tab) => Object.hasOwn(HOME_TABS, tab) ? tab : "activity";

export const HOME_REFRESH_MS = 15_000;

export function createHomePublisher(render, {
  refreshKey = null, refreshMs = HOME_REFRESH_MS, maxViewers = 200,
  refreshState = (state) => state,
  setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
  const viewers = new Map();
  const writes = new Map(); // In-flight writes survive observer eviction/pause for ordering.
  const retryKey = Symbol("incomplete Activity snapshot");
  let stopped = false;
  const cancel = (viewer) => {
    if (viewer.timer) clearTimer(viewer.timer);
    viewer.timer = null;
  };
  const schedule = (client, userId, viewer) => {
    if (stopped || !refreshKey || normalizeHomeTab(viewer.state.tab) !== "activity") return;
    viewer.timer = setTimer(async () => {
      viewer.timer = null;
      const revision = viewer.revision;
      try {
        const key = await refreshKey(userId);
        if (stopped || viewers.get(userId) !== viewer || viewer.revision !== revision) return;
        if (key !== viewer.key) {
          await publish(client, userId, viewer.state);
          return;
        }
      } catch (error) {
        console.error("[slack] Home auto-refresh error:", error.message);
      }
      if (!stopped && viewers.get(userId) === viewer && viewer.revision === revision) schedule(client, userId, viewer);
    }, refreshMs);
    viewer.timer.unref?.();
  };
  const publish = async (client, userId, state = {}) => {
    if (stopped) return false;
    let viewer = viewers.get(userId);
    if (!viewer) {
      if (viewers.size >= maxViewers) {
        const oldest = viewers.keys().next().value;
        const evicted = viewers.get(oldest);
        cancel(evicted); evicted.revision++;
        viewers.delete(oldest);
      }
      viewer = { revision: 0, timer: null };
    }
    viewers.delete(userId); viewers.set(userId, viewer);
    cancel(viewer);
    viewer.state = { ...refreshState(state) };
    const revision = ++viewer.revision;
    try {
      // Capture before rendering, so a change during a slow Slack inspection is checked again.
      const key = refreshKey && normalizeHomeTab(state.tab) === "activity" ? await refreshKey(userId) : null;
      if (stopped || revision !== viewer.revision) return false;
      const view = await render(client, userId, state);
      if (stopped || revision !== viewer.revision) return false;
      // Discard obsolete renders and serialize writes even across pauses and API failures.
      const publication = (writes.get(userId) || Promise.resolve()).catch(() => {}).then(async () => {
        if (stopped || revision !== viewer.revision) return false;
        await client.views.publish({ user_id: userId, view });
        return true;
      });
      writes.set(userId, publication);
      let published;
      try { published = await publication; }
      finally { if (writes.get(userId) === publication) writes.delete(userId); }
      if (published && revision === viewer.revision) {
        let retryActivity = false;
        try { retryActivity = JSON.parse(view.private_metadata || "{}").retryActivity === true; }
        catch { /* views without navigation metadata can still be published */ }
        viewer.key = retryActivity ? retryKey : key;
      }
      return published;
    } finally {
      if (!stopped && revision === viewer.revision) {
        schedule(client, userId, viewer);
      }
    }
  };
  publish.pause = (userId) => {
    const viewer = viewers.get(userId);
    if (!viewer) return;
    cancel(viewer); viewer.revision++;
    viewers.delete(userId);
  };
  publish.stop = () => {
    stopped = true;
    for (const viewer of viewers.values()) { cancel(viewer); viewer.revision++; }
    viewers.clear();
    return Promise.allSettled([...writes.values()]);
  };
  return publish;
}

export async function buildHomeTabView({ tab, userId, role, sections, footer = [], activityActions = [], needsActivityRetry = () => false }) {
  tab = normalizeHomeTab(tab);
  const content = await sections[tab]();
  return {
    type: "home",
    private_metadata: JSON.stringify({ tab, ...(tab === "activity" && needsActivityRetry() ? { retryActivity: true } : {}) }),
    blocks: [
      { type: "header", text: { type: "plain_text", text: "ChannelGate", emoji: true } },
      { type: "section", text: { type: "mrkdwn", text: `Hi <@${userId}> — you're ${role} on this gateway.` } },
      { type: "actions", elements: [...Object.entries(HOME_TABS).map(([value, label]) => ({
        type: "button", action_id: `cg_home_tab_${value}`, value,
        text: { type: "plain_text", text: label }, ...(value === tab ? { style: "primary" } : {}),
      })), ...(tab === "activity" ? activityActions : [])] },
      ...content,
      ...(tab === "help" && footer.length ? [{ type: "context", elements: [{ type: "mrkdwn", text: footer.join("  ·  ") }] }] : []),
    ],
  };
}

export function registerHomeTabActions(app, { publishHome } = {}) {
  app.action(HOME_TAB_ACTION, async ({ ack, body, action, client }) => {
    await ack();
    const userId = body?.user?.id;
    const tab = action?.value;
    if (!userId || !Object.hasOwn(HOME_TABS, tab) || action.action_id !== `cg_home_tab_${tab}`) return;
    try { await publishHome(client, userId, { tab }); }
    catch (error) { console.error("[slack] Home tab navigation error:", error.message); }
  });
}

export function registerHomeActions(app, { publishHome }) {
  registerHomeTabActions(app, { publishHome });
  registerComposioHomeActions(app, { publishHome: (client, userId) => publishHome(client, userId, { tab: "connections" }) });
  registerNudgeHomeActions(app, { publishHome: (client, userId) => publishHome(client, userId, { tab: "help" }) });
  registerReplyMentionsHomeActions(app, { publishHome: (client, userId) => publishHome(client, userId, { tab: "help" }) });
  registerHomeThreadActions(app, { publishHome });
}
