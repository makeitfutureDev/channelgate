import { redactLogValue } from '../util/redact.js';

// Keep each notice below every surface's text cap, including Slack's plain-text block cap.
// Slice by code point so a long, single-line transcript cannot be truncated or split an emoji.
export function voiceTranscriptReplies(transcripts = []) {
  const replies = [];
  for (const transcript of transcripts) {
    const text = String(transcript?.text || '').trim();
    if (!text) continue;
    const name = String(transcript.name || 'audio').replace(/[\r\n]/g, ' ').slice(0, 120);
    const characters = Array.from(redactLogValue(`🎙️ Transcript — ${name}\n\n${text}`));
    for (let offset = 0; offset < characters.length; offset += 1400) {
      replies.push(characters.slice(offset, offset + 1400).join(''));
    }
  }
  return replies;
}
