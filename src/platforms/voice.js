// The portable audio path is local-only. Never call Slack transcript discovery for another surface.
import path from 'node:path';
import { getWhisperEnabled } from '../config/settings.js';
import { isAudioFile, transcribeAudioFiles, composeVoicePrompt } from '../gateway/transcribe.js';
import { safeFileName } from './attachments.js';

export function hasVoiceAttachments(message) {
  return (message.attachments || []).some((file) => isAudioFile({ name: file.name, mimetype: file.contentType }));
}

export async function prepareVoiceAttachments(message, paths, {
  signal, enabled = getWhisperEnabled(), transcribe = transcribeAudioFiles,
} = {}) {
  signal?.throwIfAborted();
  const pending = new Map(paths.map((file) => [path.basename(file), file]));
  const audioPaths = new Set();
  const audio = [];
  const failed = [];
  let hasVoice = false;
  // The attachment sink prefixes the ORIGINAL index, including failed downloads. Match that
  // stable index/name pair; zipping successful paths to all source metadata misclassifies files.
  for (const [index, file] of (message.attachments || []).entries()) {
    if (!isAudioFile({ name: file.name, mimetype: file.contentType })) continue;
    hasVoice = true;
    const name = safeFileName(file.name, index);
    const saved = pending.get(`${index + 1}-${name}`);
    if (saved) audioPaths.add(saved);
    if (!saved) failed.push({ name, reason: 'Audio could not be downloaded on this surface.' });
    else if (!enabled) failed.push({ name, reason: 'Local voice transcription is disabled. Ask an administrator to enable Whisper or send the message as text.' });
    else audio.push({ name, path: saved });
  }
  let transcripts = [];
  if (audio.length) {
    try {
      const result = await transcribe(audio, { signal });
      transcripts = (result.transcripts || []).filter((item) => String(item.text || '').trim());
      failed.push(...(result.failed || []));
      for (const file of audio) if (!transcripts.some((item) => item.name === file.name) && !failed.some((item) => item.name === file.name)) failed.push({ name: file.name, reason: 'Local Whisper detected no speech.' });
    } catch (error) {
      signal?.throwIfAborted();
      failed.push(...audio.map((file) => ({ name: file.name, reason: 'Local transcription failed. Ask an administrator to check the Whisper installation, or send text.' })));
    }
  }
  signal?.throwIfAborted();
  return {
    paths: paths.filter((file) => !audioPaths.has(file)),
    text: composeVoicePrompt({ text: message.text, transcripts, failed }),
    hasVoice,
    hasPrompt: Boolean(String(message.text || '').trim() || transcripts.length),
    failed,
    failureNotice: failed.length ? composeVoicePrompt({ failed }) : '',
  };
}
