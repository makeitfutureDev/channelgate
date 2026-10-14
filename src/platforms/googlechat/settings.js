// Google Chat settings reuse the guarded shared conversation settings policy. Chat's Pub/Sub
// surface has public Cards v2, so credential entry remains in owner-authenticated browser forms.
import { createTeamsSettingsContext, buildTeamsSettings, handleTeamsSettings, TEAMS_SETTINGS_PAGES } from '../msteams/settings.js';
import { toSpaceName } from './connector.js';
import { adaptiveSettingsToChat } from './cards.js';

export const GOOGLECHAT_SETTINGS_PAGES = TEAMS_SETTINGS_PAGES;
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
  return adaptiveSettingsToChat(await handleTeamsSettings(action, data, context, stateId));
}
