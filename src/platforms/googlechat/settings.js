// Google Chat settings reuse the guarded shared conversation settings policy. Chat's Pub/Sub
// surface has public Cards v2, so credential entry remains in owner-authenticated browser forms.
import { createTeamsSettingsContext, buildTeamsSettings, handleTeamsSettings } from '../msteams/settings.js';
import { toSpaceName } from './connector.js';
import { adaptiveSettingsToChat, SETTINGS_PAGE_INPUT } from './cards.js';

// The pages of Slack's Settings modal, in its order and under its names: [id, title, the shared
// policy page that renders it, the slice of that page]. A direct message has one member, so it
// has no Access page — exactly as in Slack.
export const GOOGLECHAT_SETTINGS_PAGES = Object.freeze([
  ['agent', 'Agent', 'general', 'agent'], ['access', 'Access', 'general', 'access'], ['mcp', 'MCP', 'mcp'],
  ['variables', 'Variables', 'secrets'], ['skills', 'Skills', 'skills'], ['schedules', 'Schedules', 'automations'],
  ['diagnostics', 'Diagnostics', 'resume', 'commands'], ['you', 'You', 'you'],
]);
export const googleChatSettingsPages = ({ isDM = false } = {}) => GOOGLECHAT_SETTINGS_PAGES.filter(([id]) => !(isDM && id === 'access'));
// Slack's You page edits a person's own connections and variables in the modal. A Chat card is
// posted into the space, so the same items live behind the private browser form instead.
function youPage(ctx, ui) {
  return { body: [ui.heading('You'), ui.text('Only your runs use these, in every conversation: your own Composio and Toolbox accounts, your custom connections, your email accounts and your personal variables.'),
    ui.text('They hold credentials, so they open in your private browser settings and are never shown in this conversation.'),
    ui.buttons([ui.execute('Open my private settings', 'settings.private', { page: 'you' }, 'none')])], actions: [] };
}
export const googleChatSettingsMember = member => ({ ...member, resourceId: member.resourceName || member.resourceId || member.id,
  id: String(member.email || member.id || '') });
const human = (member, connector) => member.selectable !== false && member.type !== 'BOT' && member.id !== connector.botUserId && member.resourceId !== connector.botUserId;

export function createGoogleChatSettingsContext(state, { connector, authorize }) {
  // Public cards always expose channel context only, including when launched in a DM. Personal
  // and admin runtime histories remain in private authenticated settings.
  state.sharedSettings = true;
  const context = createTeamsSettingsContext(state, { connector,
    authorize: async (...args) => {
      const current = await authorize(...args);
      return { ...current, members: current.members?.map(googleChatSettingsMember) };
    },
    source: 'googlechat_settings', surfaceLabel: 'Google Chat', publicCredentials: true,
    pages: googleChatSettingsPages({ isDM: Boolean(state.meta?.isDM ?? state.message?.isDM) }),
    renderPage: (page, ctx, ui) => page === 'you' ? youPage(ctx, ui) : null,
    listMembers: async () => Array.isArray(context.members) ? context.members :
      (await connector.api.listMembers(toSpaceName(state.message.conversationId))).map(googleChatSettingsMember),
    isHumanMember: member => human(member, connector),
  });
  return context;
}

export async function buildGoogleChatSettings(state, stateId, options) {
  const context = createGoogleChatSettingsContext(state, options);
  await context.authorize();
  return adaptiveSettingsToChat(await buildTeamsSettings(context, stateId));
}
export async function handleGoogleChatSettings(action, data, state, stateId, options) {
  const context = createGoogleChatSettingsContext(state, options);
  // The section dropdown submits its choice as a form input; only that one value is navigation.
  if (action === 'settings.page' && data.page === undefined && typeof data[SETTINGS_PAGE_INPUT] === 'string') data = { page: data[SETTINGS_PAGE_INPUT] };
  return adaptiveSettingsToChat(await handleTeamsSettings(action, data, context, stateId));
}
