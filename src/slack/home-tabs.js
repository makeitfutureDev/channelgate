// In-Home navigation: publish only the selected section and load its data on demand.
// Selection is view state, never a gateway/user setting or an authorization credential.
import { registerComposioHomeActions } from "./home-composio.js";
import { registerNudgeHomeActions } from "./home-nudges.js";
import { registerHomeThreadActions } from "./home-threads.js";
export const HOME_TAB_ACTION = /^cg_home_tab_(activity|connections|skills|channels)$/;
export const HOME_TABS = Object.freeze({ activity: "Activity", connections: "Connections", skills: "Skills", channels: "Channels" });

export const normalizeHomeTab = (tab) => Object.hasOwn(HOME_TABS, tab) ? tab : "activity";

export function createHomePublisher(render) {
  const viewers = new Map();
  return async (client, userId, state = {}) => {
    let viewer = viewers.get(userId);
    if (!viewer) { viewer = { revision: 0, publishing: Promise.resolve() }; viewers.set(userId, viewer); }
    const revision = ++viewer.revision;
    const view = await render(client, userId, state);
    if (revision !== viewer.revision) return false;
    // Discard slow obsolete renders and serialize network writes for THIS viewer. A request
    // already sent to Slack must settle before a newer view is sent, even across API failures.
    const publication = viewer.publishing.catch(() => {}).then(async () => {
      if (revision !== viewer.revision) return false;
      await client.views.publish({ user_id: userId, view });
      return true;
    });
    viewer.publishing = publication;
    return publication;
  };
}

export async function buildHomeTabView({ tab, userId, role, sections, footer = [] }) {
  tab = normalizeHomeTab(tab);
  const content = await sections[tab]();
  return {
    type: "home",
    private_metadata: JSON.stringify({ tab }),
    blocks: [
      { type: "header", text: { type: "plain_text", text: "ChannelGate", emoji: true } },
      { type: "section", text: { type: "mrkdwn", text: `Hi <@${userId}> — you're ${role} on this gateway.` } },
      { type: "actions", elements: Object.entries(HOME_TABS).map(([value, label]) => ({
        type: "button", action_id: `cg_home_tab_${value}`, value,
        text: { type: "plain_text", text: label }, ...(value === tab ? { style: "primary" } : {}),
      })) },
      ...content,
      { type: "context", elements: [{ type: "mrkdwn", text: footer.join("  ·  ") }] },
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
  registerNudgeHomeActions(app, { publishHome });
  registerHomeThreadActions(app, { publishHome });
}
