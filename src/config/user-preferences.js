// New users opt in; migrations explicitly preserve mentions for existing users.
export function userReplyMentionsEnabled(user) {
  return user?.replyMentions === true;
}

// How the voice (gateway/voice/calls.js) talks to this person on a call. Set by the person on
// their Activity Settings page; every field is bounded and closed-set where it drives behaviour.
export const VOICE_STYLES = Object.freeze(["brief", "conversational", "thinking-partner"]);
export const VOICE_PATIENCE = Object.freeze(["quick", "normal", "patient"]);
export const VOICE_LANGUAGE_MAX = 60;
export const VOICE_INSTRUCTIONS_MAX = 2000;
const text = (value, max) => typeof value === "string" ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").trim().slice(0, max) : "";
export function userVoicePreferences(user) {
  const raw = user?.voicePreferences && typeof user.voicePreferences === "object" ? user.voicePreferences : {};
  return {
    language: text(raw.language, VOICE_LANGUAGE_MAX),
    style: VOICE_STYLES.includes(raw.style) ? raw.style : "brief",
    patience: VOICE_PATIENCE.includes(raw.patience) ? raw.patience : "normal",
    instructions: text(raw.instructions, VOICE_INSTRUCTIONS_MAX),
  };
}
