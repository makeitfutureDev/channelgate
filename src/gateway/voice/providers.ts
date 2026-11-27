// The voice-call providers and their closed setting values. Dependency-free on purpose: settings,
// the admin routes, the Activity page and the call manager all read it.
//
//   gemini   — Google Gemini Live on the gateway's Gemini API key; audio relayed through the
//              gateway (works in any browser and in the iPhone app).
//   chatgpt  — OpenAI GPT-Live on a ChatGPT sign-in the gateway already holds for Codex; audio
//              flows browser ↔ OpenAI over WebRTC, the gateway holds the control channel
//              (gateway/voice/chatgpt-live.ts). Needs a browser with WebRTC.

export const VOICE_PROVIDERS = Object.freeze(["gemini", "chatgpt"]);
export type VoiceProvider = "gemini" | "chatgpt";
export const isVoiceProvider = (value: unknown): value is VoiceProvider => VOICE_PROVIDERS.includes(String(value));
export const VOICE_PROVIDER_LABELS: Readonly<Record<VoiceProvider, string>> = Object.freeze({ gemini: "Gemini", chatgpt: "ChatGPT" });

export const CHATGPT_VOICE_MODELS = Object.freeze(["gpt-live-1.1-codex", "gpt-live-1-codex"]);
export const DEFAULT_CHATGPT_VOICE_MODEL = CHATGPT_VOICE_MODELS[0];
export const isChatgptVoiceModel = (value: unknown): boolean => CHATGPT_VOICE_MODELS.includes(String(value));
// "codex" is the gateway's default Codex sign-in; anything else is a "ChatGPT sign-in" license.
export const DEFAULT_CHATGPT_VOICE_LOGIN = "codex";
export const isChatgptVoiceLogin = (value: unknown): boolean => {
  const id = String(value || "");
  return id === DEFAULT_CHATGPT_VOICE_LOGIN || /^codex-lic-[0-9a-f]{8}$/.test(id);
};
// The engine ids the usage ledger records a call under.
export const GEMINI_VOICE_ENGINE = "gemini-live";
export const CHATGPT_VOICE_ENGINE = "chatgpt-live";

export interface VoiceProviderState { gemini: boolean; chatgpt: boolean; defaultProvider: VoiceProvider }

// Which provider a call uses: the person's choice when that provider is on, else the gateway's
// default when it is on, else whichever one is. ChatGPT also needs a WebRTC-capable client; a
// client without it (the iPhone app, an old browser) falls back to Gemini when Gemini is on.
export function chooseVoiceProvider(state: VoiceProviderState, { preferred = "", webrtc = false }: { preferred?: string; webrtc?: boolean } = {}): VoiceProvider | "" {
  const usable = (id: VoiceProvider) => state[id] && (id !== "chatgpt" || webrtc);
  const order = [preferred, state.defaultProvider, "gemini", "chatgpt"].filter(isVoiceProvider);
  return order.find(usable) || "";
}
