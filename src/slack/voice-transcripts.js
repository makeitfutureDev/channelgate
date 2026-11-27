import { voiceTranscriptReplies } from '../gateway/voice-transcript-replies.js';

export async function postVoiceTranscripts(client, { channel, thread_ts, transcripts }) {
  for (const text of voiceTranscriptReplies(transcripts)) {
    // Transcribed speech and filenames are literal text, never mentions, links or Slack markup.
    await client.chat.postMessage({
      channel,
      thread_ts,
      text: text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
      blocks: [{ type: 'section', text: { type: 'plain_text', text, emoji: false } }],
      mrkdwn: false,
      parse: 'none',
      unfurl_links: false,
      unfurl_media: false,
    });
  }
}
