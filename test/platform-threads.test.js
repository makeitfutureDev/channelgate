import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureTestEnv } from './helpers.js';
ensureTestEnv();
const api = await import('../src/gateway/platform-threads.js');
const { getDb } = await import('../src/db/index.js');
const base = { platform: 'googlechat', conversationId: 'gchat:spaces/ACTIVITY', rawConversationId: 'spaces/ACTIVITY',
  threadKey: 'spaces/ACTIVITY/threads/root', userId: 'ana@example.com', text: 'Please help', trigger: 'message', kind: 'channel' };
const key = base.threadKey;
const channel = base.conversationId;
const record = (id, userId, at, extra = {}) => api.recordPlatformThreadMessage({ message: { ...base, messageId: id, userId,
  raw: { message: { createTime: new Date(at).toISOString(), threadReply: false } }, ...extra }, slug: 'activity-chat', threadKey: key });

test('index keeps opaque sessions, participants and independent visibility with replay protection', () => {
  record('root', 'ana@example.com', 1000);
  assert.equal(api.getPlatformThread(channel, key).starter_id, 'ana@example.com');
  record('reply', 'bob@example.com', 2000, { raw: { message: { createTime: new Date(2000).toISOString(), threadReply: true } } });
  assert.equal(api.isPlatformThreadParticipant(channel, key, 'bob@example.com'), true);
  assert.equal(api.isPlatformThreadParticipant(channel, key, 'outsider'), false);
  assert.equal(api.setPlatformThreadDone(channel, key, 'bob@example.com', true, 2500), false);
  api.setPlatformThreadHidden(channel, key, 'bob@example.com', true, 3000);
  api.setPlatformThreadDone(channel, key, 'ana@example.com', true, 3000);
  assert.equal(api.listPlatformThreadsForUser('ana@example.com')[0].dismissed_ms, 3000);
  record('reply', 'bob@example.com', 4000);
  assert.equal(api.listPlatformThreadsForUser('bob@example.com')[0].hidden_ms, 3000, 'duplicate id never reopens even with changed timestamp');
  record('older', 'bob@example.com', 2500);
  assert.equal(api.getPlatformThread(channel, key).status, 'done');
  record('new', 'bob@example.com', 4000);
  assert.equal(api.getPlatformThread(channel, key).status, 'idle');
  assert.equal(api.listPlatformThreadsForUser('bob@example.com')[0].hidden_ms, 0);
  assert.equal(api.listPlatformThreadsForUser('ana@example.com')[0].dismissed_ms, 3000, 'another participant does not change personal dismissal');
  assert.equal(api.platformThreadUrl(api.getPlatformThread(channel, key)), 'https://chat.google.com/room/ACTIVITY/root');
});

test('reactions and edits neither join nor reopen; unknown native root grants no owner', () => {
  assert.equal(record('reaction', 'outsider', 5000, { trigger: 'reaction' }), null);
  assert.equal(record('edit', 'outsider', 5000, { trigger: 'edit' }), null);
  const message = { ...base, conversationId: 'gchat:spaces/OTHER', rawConversationId: 'spaces/OTHER', messageId: 'observed-reply', userId: 'reader',
    raw: { message: { createTime: new Date(2000).toISOString(), threadReply: true } } };
  api.recordPlatformThreadMessage({ message, slug: 'other', threadKey: 'spaces/OTHER/threads/old' });
  assert.equal(api.getPlatformThread(message.conversationId, 'spaces/OTHER/threads/old').starter_id, '');
  assert.equal(api.listPlatformThreadsForUser('reader').length, 1);
});

test('Teams source URLs stay on official host and qualified channels isolate identical thread ids', () => {
  const message = { platform: 'msteams', conversationId: 'teams:19:channel', rawConversationId: '19:channel', messageId: 'root', threadKey: 'root',
    trigger: 'message', kind: 'channel', userId: '29:owner', text: 'Teams task', raw: { tenantId: 'tenant', teamId: 'team', activity: { timestamp: new Date(6000).toISOString() } } };
  const row = api.recordPlatformThreadMessage({ message, slug: 'teams-activity', threadKey: 'root' });
  assert.equal(row.starter_id, '29:owner');
  const url = new URL(api.platformThreadUrl(row));
  assert.equal(url.hostname, 'teams.microsoft.com');
  assert.equal(url.searchParams.get('tenantId'), 'tenant');
  assert.equal(api.platformThreadUrl({ platform: 'msteams', source_url: 'https://teams.microsoft.com.evil.test/' }), '');
  assert.equal(api.platformThreadUrl({ platform: 'googlechat', source_url: 'https://user:pass@chat.google.com/' }), '');
});

test('working status comes from active runs and stale persisted state does not stick', () => {
  api.recordPlatformThreadOutcome(channel, key, { status: 'working' });
  assert.equal(api.getPlatformThread(channel, key).status, 'idle');
  getDb().prepare('INSERT INTO active_runs(id,data) VALUES(?,?)').run('platform-test', JSON.stringify({ channelId: channel, threadKey: key, startedAt: 6500 }));
  assert.equal(api.getPlatformThread(channel, key).status, 'working');
  assert.equal(api.getPlatformThread(channel, key).working_since_ms, 6500);
  getDb().prepare('DELETE FROM active_runs WHERE id=?').run('platform-test');
  api.recordPlatformThreadOutcome(channel, key, { status: 'error', at: 7000 });
  assert.equal(api.getPlatformThread(channel, key).status, 'error');
  api.setPlatformThreadLater(channel, key, 'ana@example.com', true, 8000);
  assert.equal(api.getPlatformThread(channel, key).status, 'later');
});

test('native root discovery sets authority, runtime waiting wins over working, completion stays explicit', () => {
  const otherChannel = 'teams:19:discovery';
  const make = (messageId, userId) => ({ platform: 'msteams', conversationId: otherChannel, rawConversationId: '19:discovery',
    messageId, userId, threadKey: 'original-root', kind: 'channel', trigger: 'message', text: messageId,
    raw: { activity: { timestamp: new Date(9000).toISOString() } } });
  api.recordPlatformThreadMessage({ message: make('first-seen-reply', 'participant'), slug: 'discovery', threadKey: 'original-root' });
  assert.equal(api.getPlatformThread(otherChannel, 'original-root').starter_id, '');
  api.recordPlatformThreadMessage({ message: make('original-root', 'actual-owner'), slug: 'discovery', threadKey: 'original-root' });
  assert.equal(api.getPlatformThread(otherChannel, 'original-root').starter_id, 'actual-owner');
  assert.equal(api.getPlatformThread(otherChannel, 'original-root').title, 'original-root');
  getDb().prepare('INSERT INTO bg_jobs(id,data) VALUES(?,?)').run('discovery-job', JSON.stringify({ channelId: otherChannel, threadKey: 'original-root' }));
  getDb().prepare('INSERT INTO active_runs(id,data) VALUES(?,?)').run('discovery-wait', JSON.stringify({ channelId: otherChannel, threadKey: 'original-root', awaitingChoice: true }));
  assert.equal(api.getPlatformThread(otherChannel, 'original-root').status, 'waiting');
  api.setPlatformThreadDone(otherChannel, 'original-root', 'actual-owner', true, 10000);
  assert.equal(api.getPlatformThread(otherChannel, 'original-root').status, 'done', 'Done never cancels running work');
  getDb().prepare('DELETE FROM active_runs WHERE id=?').run('discovery-wait');
  getDb().prepare('DELETE FROM bg_jobs WHERE id=?').run('discovery-job');
});
