import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { ensureTestEnv } from './helpers.js';
ensureTestEnv();
const { getDb } = await import('../src/db/index.js');
const { recordTeamsFileLauncher, inspectTeamsFileLauncher, forgetTeamsFileLauncher } = await import('../src/platforms/msteams/file-launchers.js');
const state = (expires = Date.now() + 900_000) => ({
  message: { conversationId: 'teams:19:fixture', rawConversationId: '19:fixture',
    userId: '29:fixture', threadKey: 'thread-root', raw: { tenantId: 'tenant-fixture', activity: { text: 'private input' } } },
  entry: { slug: 'fixture', name: 'private channel name' }, sessionKey: 'group:original-session',
  deliveryId: '19:fixture', relative: 'report.txt', selectedFile: true, expires,
  replyCard: () => {}, meta: { private: 'not stored' }, draft: { secret: 'not stored' },
  grantUrl: 'https://fixture.invalid/file-download/private',
});

test('a new daemon process can read the original owner/source/session/file reference without private data', () => {
  const id = randomUUID(); recordTeamsFileLauncher(id, '28:fixture', state());
  const module = new URL('../src/platforms/msteams/file-launchers.js', import.meta.url).href;
  const script = `import { inspectTeamsFileLauncher } from ${JSON.stringify(module)}; console.log(JSON.stringify(inspectTeamsFileLauncher(${JSON.stringify(id)}, '28:fixture')));`;
  const restored = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: process.env }).trim());
  assert.equal(restored.state.message.userId, '29:fixture');
  assert.equal(restored.state.deliveryId, '19:fixture');
  assert.equal(restored.state.sessionKey, 'group:original-session');
  assert.equal(restored.state.relative, 'report.txt');
  assert.equal(restored.state.selectedFile, true);
  assert.equal(restored.state.message.raw.tenantId, 'tenant-fixture');
  const stored = getDb().prepare('SELECT data FROM teams_file_launchers WHERE id = ?').get(id).data;
  assert.doesNotMatch(stored, /private input|private channel|not stored|file-download|replyCard|draft/);
});

test('launcher expiry stays fixed, diagnostics are bounded, and expired rows are eventually pruned', () => {
  const id = randomUUID(); recordTeamsFileLauncher(id, '28:fixture', state(1000), 0);
  assert.ok(inspectTeamsFileLauncher(id, '28:fixture', 999).state);
  assert.equal(inspectTeamsFileLauncher(id, '28:fixture', 1001).reason, 'expired');
  assert.equal(inspectTeamsFileLauncher(id, '28:other', 999).reason, 'wrong-bot');
  assert.equal(inspectTeamsFileLauncher(randomUUID(), '28:fixture', 999).reason, 'unknown');
  assert.equal(inspectTeamsFileLauncher(undefined, '28:fixture', 999).reason, 'missing-reference');
  assert.equal(inspectTeamsFileLauncher('invalid', '28:fixture', 999).reason, 'missing-reference');
  const later = 1001 + 24 * 60 * 60_000;
  const next = randomUUID(); recordTeamsFileLauncher(next, '28:fixture', state(later + 1000), later);
  assert.equal(inspectTeamsFileLauncher(id, '28:fixture', later).reason, 'unknown');
  forgetTeamsFileLauncher(next);
  assert.equal(inspectTeamsFileLauncher(next, '28:fixture', later).reason, 'unknown');
});
