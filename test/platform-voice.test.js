import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureTestEnv } from './helpers.js';
ensureTestEnv();
const { prepareVoiceAttachments } = await import('../src/platforms/voice.js');
const { createIngest } = await import('../src/platforms/ingest.js');
const { makeInbound } = await import('../src/platforms/inbound.js');
const { setUser } = await import('../src/config/store.js');
const { runProcess, transcribeAudioFiles } = await import('../src/gateway/transcribe.js');

const audio = (name = 'clip.wav') => ({ name, contentType: 'audio/wav', download: async () => Buffer.from('fixture audio') });

test('voice metadata follows original attachment index through download failures; files remain files', async () => {
  let seen;
  const result = await prepareVoiceAttachments({ text: 'Please summarize', attachments: [{ name: 'missing.pdf', contentType: 'application/pdf' }, audio(), { name: 'data.txt', contentType: 'text/plain' }] }, ['/fixture/2-clip.wav', '/fixture/3-data.txt'], { enabled: true, transcribe: async (files) => { seen = files; return { transcripts: [{ name: 'clip.wav', text: 'Book a meeting' }], failed: [] }; } });
  assert.equal(seen[0].path, '/fixture/2-clip.wav'); assert.deepEqual(result.paths, ['/fixture/3-data.txt']); assert.match(result.text, /Please summarize/); assert.match(result.text, /Book a meeting/);
});

test('local-only disabled, failed, missing and empty speech paths explain failure', async () => {
  const message = { text: '', attachments: [audio()] };
  const disabled = await prepareVoiceAttachments(message, ['/fixture/1-clip.wav'], { enabled: false, transcribe: async () => assert.fail('disabled must not transcribe') });
  assert.equal(disabled.hasPrompt, false); assert.deepEqual(disabled.paths, []); assert.match(disabled.failureNotice, /disabled/);
  const failed = await prepareVoiceAttachments(message, ['/fixture/1-clip.wav'], { enabled: true, transcribe: async () => { throw new Error('fixture failure'); } });
  assert.match(failed.failureNotice, /Local transcription failed/);
  const missing = await prepareVoiceAttachments(message, [], { enabled: true }); assert.match(missing.failureNotice, /could not be downloaded/);
  const empty = await prepareVoiceAttachments(message, ['/fixture/1-clip.wav'], { enabled: true, transcribe: async () => ({ transcripts: [], failed: [] }) }); assert.match(empty.failureNotice, /no speech/);
});

function connector() {
  const posts = []; const edits = [];
  return { platform: 'msteams', posts, edits, async post(p) { posts.push(p); return { messageId: String(posts.length), conversationId: p.conversationId }; }, async edit(p) { edits.push(p); }, async directory() { return null; } };
}
const inbound = (over = {}) => makeInbound({ platform: 'msteams', conversationId: '19:voice-fixture', kind: 'dm', userId: 'voice-approved', messageId: 'voice-message', attachments: [audio()], ...over });

test('unauthorized authors cannot download, transcribe or call the command hook', async () => {
  let downloaded = false; let transcribed = false; let commands = false;
  const ingest = createIngest({ connector: connector(), log: { info() {} }, voice: async () => { transcribed = true; }, onCommand: async () => { commands = true; }, run: async () => assert.fail('unauthorized engine') });
  const result = await ingest(inbound({ userId: 'voice-stranger', attachments: [{ ...audio(), download: async () => { downloaded = true; return Buffer.from('x'); } }] }));
  assert.equal(result.skipped, 'unauthorized'); assert.equal(downloaded, false); assert.equal(transcribed, false); assert.equal(commands, false);
});

test('audio-only success becomes a text request with progress before transcription, no raw audio', async () => {
  await setUser('voice-approved', { approved: true });
  const wire = connector(); let seen;
  const ingest = createIngest({ connector: wire, voice: (message, paths, options) => prepareVoiceAttachments(message, paths, { ...options, enabled: true, transcribe: async () => { assert.match(wire.posts[0].text, /voice transcription/); return { transcripts: [{ name: 'clip.wav', text: 'Say VOICE_OK' }], failed: [] }; } }), run: async (args) => { seen = args; return { content: 'VOICE_OK' }; } });
  await ingest(inbound()); assert.equal(seen.text, 'Say VOICE_OK'); assert.deepEqual(seen.attachments, []); assert.equal(wire.edits.at(-1).text, 'VOICE_OK');
});

test('standalone failed audio never invokes engine; typed fallback invokes it and reports missing transcript', async () => {
  await setUser('voice-approved', { approved: true });
  const wire = connector(); let calls = 0; let seen;
  const ingest = createIngest({ connector: wire, voice: (message, paths, options) => prepareVoiceAttachments(message, paths, { ...options, enabled: false }), run: async (args) => { calls += 1; seen = args; return { content: 'TEXT_OK' }; } });
  assert.equal((await ingest(inbound())).skipped, 'voice-unavailable'); assert.equal(calls, 0); assert.match(wire.edits.at(-1).text, /disabled/);
  await ingest(inbound({ text: 'Say TEXT_OK', messageId: 'fallback' })); assert.equal(calls, 1); assert.match(seen.text, /Say TEXT_OK/); assert.deepEqual(seen.attachments, []); assert.match(wire.edits.at(-1).text, /disabled/);
});

test('authorized native command hook runs before normal controls, downloads and engine', async () => {
  await setUser('voice-approved', { approved: true }); let hook;
  const ingest = createIngest({ connector: connector(), onCommand: async (args) => { hook = args; await args.reply('CARD_OK'); return true; }, run: async () => assert.fail('command must not run engine'), voice: async () => assert.fail('command must not transcribe') });
  const result = await ingest(inbound({ text: '/help' })); assert.equal(result.command, true); assert.ok(hook.sessionKey); assert.ok(hook.entry.slug); assert.equal(hook.message.userId, 'voice-approved');
});

test('local process abort waits for child exit; an already cancelled transcription never starts', async () => {
  const controller = new AbortController();
  const running = runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { signal: controller.signal, timeout: 5000 });
  const timer = setTimeout(() => controller.abort(), 50);
  await assert.rejects(running, { name: 'AbortError' }); clearTimeout(timer);
  await assert.rejects(transcribeAudioFiles([{ name: 'clip.wav', path: '/never-read' }], { signal: controller.signal, transcribe: async () => assert.fail('aborted') }), { name: 'AbortError' });
});
