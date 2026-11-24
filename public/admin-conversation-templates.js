import { changedSettingKeys, diffSettingsPayload } from "./admin-state.js";

export const conversationTemplates = [
  { id: "channel", title: "New channel template", description: "Copied when the bot first joins a channel. Changes apply to future channels." },
  { id: "user", title: "User DM template", description: "Default for member DMs. Changes apply to DMs following this template." },
  { id: "admin", title: "Admin DM template", description: "Default for admin DMs. Changes apply to DMs following this template." },
];

export function templateConfig(settings, id) {
  return (id === "channel" ? settings.channelTemplate : settings.dmTemplates?.[id]) || {};
}

// Editors may omit unavailable catalog entries. Preserve the stored representation of every
// untouched field, and retry an unrelated settings write once against the returned version.
export async function saveConversationTemplate({ api, id, stored, version, baseline, values }) {
  const config = { ...stored, ...diffSettingsPayload(baseline, values) };
  const patch = id === "channel" ? { channelTemplate: config } : { dmTemplates: { [id]: config } };
  const write = (settingsVersion) => api("/api/settings", {
    method: "PUT", body: JSON.stringify({ ...patch, settingsVersion, connectSlack: false }),
  });
  try {
    return { previousVersion: version, settings: await write(version) };
  } catch (error) {
    if (error.status !== 409 || !error.body?.settingsVersion) throw error;
    if (changedSettingKeys(stored, templateConfig(error.body, id)).length) {
      throw new Error("This template changed elsewhere. Discard your draft to load the latest version.");
    }
    return { previousVersion: error.body.settingsVersion, settings: await write(error.body.settingsVersion) };
  }
}
