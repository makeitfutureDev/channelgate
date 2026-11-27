// New users opt in; migrations explicitly preserve mentions for existing users.
export function userReplyMentionsEnabled(user) {
  return user?.replyMentions === true;
}

// Off unless the person turned it on: a voice clip they reply with in a thread the agent is
// already working in starts the agent without a mention (src/slack/voice-auto-trigger.js).
export function userVoiceAutoStartEnabled(user) {
  return user?.voiceAutoStart === true;
}

// How the voice (gateway/voice/calls.js) talks to this person on a call. Set by the person on
// their Activity Settings page; every field is bounded and closed-set where it drives behaviour.
export const VOICE_STYLES = Object.freeze(["brief", "conversational", "thinking-partner"]);
export const VOICE_PATIENCE = Object.freeze(["quick", "normal", "patient"]);
// Which voice provider the person calls with ("" = the gateway's default) and how hard the agent
// thinks on tasks spoken on a call ("quick" = low reasoning effort on the thread's own model).
export const VOICE_PROVIDER_CHOICES = Object.freeze(["", "gemini", "chatgpt"]);
export const VOICE_TASK_SPEED_CHOICES = Object.freeze(["normal", "quick"]);
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
    provider: VOICE_PROVIDER_CHOICES.includes(raw.provider) ? raw.provider : "",
    taskSpeed: VOICE_TASK_SPEED_CHOICES.includes(raw.taskSpeed) ? raw.taskSpeed : "normal",
  };
}
