import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureTestEnv } from './helpers.js';

ensureTestEnv();
process.env.PATH = `${fileURLToPath(new URL('./fixtures', import.meta.url))}${path.delimiter}${process.env.PATH || ''}`;
process.env.SESSION_KEEPALIVE = '0';
process.env.PROGRESS_VIEW = 'shimmer';
const { useFakeRuntime } = await import('./runtime-fake.js');
const backend = await useFakeRuntime();
const { saveSettings } = await import('../src/config/settings.js');
const { setUser } = await import('../src/config/store.js');
const { processMessageEvent } = await import('../src/slack/message-pipeline.js');
const { postVoiceTranscripts } = await import('../src/slack/voice-transcripts.js');

test('long transcripts preserve clip order, Unicode and literal control text in bounded Slack blocks', async () => {
  const posts = [];
  const long = 'hello 😀 <@U123> <!channel> & ``` '.repeat(220);
  await postVoiceTranscripts({ chat: { async postMessage(p) { posts.push(p); } } }, {
    channel: 'D_VOICE', thread_ts: '123.456',
    transcripts: [{ name: 'first.wav', text: long }, { name: 'empty.wav', text: '' }, { name: 'last.wav', text: 'Last clip' }],
  });
  assert.ok(posts.length > 2);
  const combined = posts.map(p => p.blocks[0].text.text).join('');
  assert.equal(combined, `🎙️ Transcript — first.wav\n\n${long.trim()}🎙️ Transcript — last.wav\n\nLast clip`);
  for (const p of posts) {
    assert.equal(p.channel, 'D_VOICE'); assert.equal(p.thread_ts, '123.456');
    assert.ok(p.blocks[0].text.text.length <= 3000);
    assert.equal(p.blocks[0].text.type, 'plain_text'); assert.equal(p.parse, 'none');
    assert.equal(p.mrkdwn, false); assert.equal(p.unfurl_links, false);
    assert.doesNotMatch(p.text, /<@|<!channel>/);
    assert.equal(p.blocks[0].text.text.isWellFormed(), true);
  }
});

test('transcript notices redact token-shaped strings before chunking', async () => {
  const posts = [];
  await postVoiceTranscripts({ chat: { async postMessage(p) { posts.push(p); } } }, {
    channel: 'D_VOICE', thread_ts: '123.456', transcripts: [{ name: 'voice.wav', text: 'xoxb-fixture-secret' }],
  });
  assert.match(posts[0].blocks[0].text.text, /\[REDACTED\]/);
  assert.doesNotMatch(JSON.stringify(posts), /fixture-secret/);
});

function slack(onTranscript) {
  const posts = []; let seq = 0;
  const ok = async () => ({ ok: true });
  const client = {
    posts,
    chat: { async postMessage(p) { if (p.blocks?.[0]?.text?.type === 'plain_text') await onTranscript(p); posts.push(p); return { ok: true, ts: `bot.${++seq}` }; }, update: ok, postEphemeral: ok },
    users: { info: async ({ user }) => ({ user: { id: user, real_name: 'Voice fixture' } }), list: async () => ({ members: [], response_metadata: {} }) },
    conversations: { history: async () => ({ messages: [] }), replies: async () => ({ messages: [], response_metadata: {} }) },
    apiCall: ok,
  };
  client.chatStream = ({ channel, thread_ts }) => {
    let text = '';
    return { ts: `stream.${++seq}`, append: async ({ markdown_text = '' }) => { text += markdown_text; }, stop: async ({ markdown_text = '' } = {}) => { posts.push({ channel, thread_ts, text: text + markdown_text }); return { ok: true }; } };
  };
  return client;
}

const clip = { id: 'F_VOICE', name: 'voice.wav', mimetype: 'audio/wav', transcription: { status: 'complete', preview: { content: 'Please say hello.', has_more: false } } };

for (const engine of ['claude', 'codex']) {
  test(`${engine}: Slack awaits transcript delivery before spawning; the answer follows it in the same thread`, async () => {
    saveSettings({ engine, whisperEnabled: false, slackBotToken: 'xoxb-test-voice', composioMode: 'personal' });
    await setUser('U_VOICE', { approved: true });
    const before = backend.calls.spawn.length;
    let release; const pendingPost = new Promise(resolve => { release = resolve; });
    let arrived; const posting = new Promise(resolve => { arrived = resolve; });
    const client = slack(async () => { arrived(); await pendingPost; });
    const event = { type: 'message', channel: `D_VOICE_${engine}`, channel_type: 'im', user: 'U_VOICE', text: '', files: [clip], ts: '3000.001', thread_ts: '3000.000' };
    const turn = processMessageEvent(event, client, { botUserId: 'U_BOT' });
    try {
      await Promise.race([posting, turn.then(() => { throw new Error(`transcript not posted: ${JSON.stringify(client.posts)}`); })]);
      assert.equal(backend.calls.spawn.length, before, 'no engine starts while transcript delivery is pending');
    } finally { release(); }
    await turn;
    const transcript = client.posts.findIndex(p => p.blocks?.[0]?.text?.type === 'plain_text');
    const reply = client.posts.findIndex(p => /[Ss]tub.*reply/.test(p.text || ''));
    assert.ok(transcript >= 0); assert.ok(reply > transcript, JSON.stringify(client.posts));
    assert.match(client.posts[reply].text, engine === 'codex' ? /Codex stub reply/ : /Stub engine reply/);
    assert.equal(client.posts[transcript].thread_ts, event.thread_ts);
    assert.equal(client.posts[reply].thread_ts, event.thread_ts);
    assert.ok(backend.calls.spawn.length > before);
  });
}

test('failed Slack transcript delivery prevents engine processing and reports the failure', async () => {
  saveSettings({ whisperEnabled: false, slackBotToken: 'xoxb-test-voice' });
  await setUser('U_VOICE', { approved: true });
  const before = backend.calls.spawn.length;
  const client = slack(async () => { throw new Error('fixture delivery failure'); });
  await processMessageEvent({ type: 'message', channel: 'D_VOICE_FAILED', channel_type: 'im', user: 'U_VOICE', text: '', files: [clip], ts: '3001.001' }, client, { botUserId: 'U_BOT' });
  assert.equal(backend.calls.spawn.length, before);
  assert.ok(client.posts.some(p => /processing hasn’t started/.test(p.text || '')));
});
