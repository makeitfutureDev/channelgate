// Whisper invents text from silence and background noise: subtitle credits ("Thank you for
// watching", "Subtitles by the Amara.org community") and non-speech tags ("[BLANK_AUDIO]",
// "(music)"). A voice clip whose whole transcript is only that carried no speech, and passing it
// to the agent as if someone said it starts a turn nobody asked for. The check is strict: the
// ENTIRE transcript must be phantom material; a real sentence that happens to contain "thank you"
// is kept untouched, and so is a short real reply ("okay", "thanks", "bye"), which can be an answer
// to the agent. (List adapted from Hermes Agent's voice-mode filter, MIT.)

export const WHISPER_TAG = /\[[^\]]{0,40}\]|\((?:[^)]{0,40})\)|♪+|\*[^*]{0,30}\*/g;
const PHANTOMS = [
  "thanks for watching", "thank you for watching", "thank you so much for watching",
  "thanks for listening", "thank you for listening", "please subscribe", "subscribe", "like and subscribe", "please like and subscribe",
  "don't forget to subscribe", "see you next time", "see you in the next video", "you",
  "subtitles by the amara org community", "subtitles by", "transcription by castingwords", "captions by", "translated by",
  "silence", "music", "applause", "laughter",
  "untertitel der amara org community", "untertitel im auftrag des zdf", "sous titres réalisés par la communauté d'amara org",
  "продолжение следует", "субтитры сделал", "ご視聴ありがとうございました", "字幕由amara org社区提供",
  "mulțumesc pentru vizionare", "abonați vă",
];
const PHANTOM_SET = new Set(PHANTOMS);
// The same short credit repeated ("Thank you. Thank you. Thank you.").
const REPEATED = /^(.{1,40}?)(?: \1){1,}$/;

const norm = (text: string): string => text.toLowerCase().replace(/[’`]/g, "'").replace(/[^\p{L}\p{N}' ]+/gu, " ").replace(/\s+/g, " ").trim();

export function isWhisperPhantom(transcript: string): boolean {
  const withoutTags = String(transcript || "").replace(WHISPER_TAG, " ");
  const text = norm(withoutTags);
  if (!text) return true;
  if (PHANTOM_SET.has(text)) return true;
  const repeated = REPEATED.exec(text);
  return Boolean(repeated && PHANTOM_SET.has(repeated[1].trim()));
}

// Whisper's raw output, or "" when it is only phantom material (the caller then reports "no speech").
export function dropWhisperPhantoms(output: unknown): string {
  const text = String(output ?? "");
  return isWhisperPhantom(text) ? "" : text;
}
